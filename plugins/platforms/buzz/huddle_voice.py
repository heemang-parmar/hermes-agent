"""Buzz huddle voice: join a huddle's audio room on an explicit owner invitation and talk in it.

Why an audio bridge and not the native transcript route: in Buzz, speech-to-text and text-to-speech
live only in the desktop app (swarm ``desktop/src-tauri/src/huddle/stt.rs``, ``tts.rs``). Native
agents (``buzz-acp``) are text-only, and mobile carries Opus but never transcribes or speaks
(``mobile/HUDDLES.md``). A text-only agent is therefore silent to mobile users. This module joins the
relay audio room as a peer (``/huddle/{channel}/audio``, ``crates/buzz-relay/src/audio/handler.rs``),
transcribes the owner's audio with Hermes STT, and speaks the agent's reply as Opus with Hermes TTS,
so desktop and mobile both hear it.

Security boundary (all must hold, fail closed):
  * opt-in per profile (``extra.huddle_voice``, default false) and an owner is known
    (``extra.owner``, else the NIP-OA attestation's owner);
  * the invitation is a kind 44100 ``member_added`` whose BIP-340 signature verifies against the
    relay key (``extra.relay_pubkey``, else NIP-11 ``self``), ``p``-tags this agent, ``h``-tags the
    channel it names, whose ``actor`` (the kind-9000 signer, ``side_effects.rs``) is the owner, and
    which was created after this adapter started (a restart never revives an older invitation);
  * the backing channel is a live huddle the owner started: an owner-signed 48100 in a watched parent
    channel names it and no owner- or relay-signed 48103 has ended it (``handlers/ingest.rs``);
  * the relay admits the audio socket only for a member (``check_membership_for_admission``);
  * only the owner's audio is transcribed, identified by the relay's ``peer_index`` -> pubkey roster.

The relay never closes an audio socket when a huddle ends, the channel is archived or a member is
removed, so the session leaves on its own: on a verified kind 44101 removal, and on a periodic
lifecycle re-check that finds the huddle ended (or cannot confirm it is live).

Routing: a transcript becomes a normal inbound message whose chat is the huddle's backing channel
(its own session, ``parent_chat_id`` = parent channel), so huddle turns never interleave with parent
chat. Replies to that chat are spoken, never posted: a kind 9 in the backing channel would also be
spoken by every desktop (``ttsLiveMessages.ts``), doubling the voice. A streamed reply is spoken once,
on the stream's finalize edit (``REQUIRES_EDIT_FINALIZE``); a plain send is a complete message.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import shutil
import tempfile
import time
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit, urlunsplit

logger = logging.getLogger(__name__)


def _load_sibling(name: str):
    """Import a sibling loader-agnostically (the test loader imports the adapter as a bare module)."""
    import importlib
    if __package__:
        with contextlib.suppress(ImportError):
            return importlib.import_module(f"{__package__}.{name}")
    return _load_sibling_file(name)


def _load_sibling_file(name: str):
    import importlib.util
    import sys
    key = f"plugin_adapter_buzz_{name}"
    if (cached := sys.modules.get(key)) is not None:
        return cached
    spec = importlib.util.spec_from_file_location(key, Path(__file__).with_name(f"{name}.py"))
    assert spec is not None and spec.loader is not None
    module = sys.modules[key] = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


audio = _load_sibling("huddle_audio")
nostr_auth = _load_sibling("nostr_auth")

KIND_MEMBER_ADDED = 44100
KIND_MEMBER_REMOVED = 44101
KIND_HUDDLE_STARTED = 48100
KIND_HUDDLE_ENDED = 48103
LIVENESS_RETRY_DELAYS = (0.5, 1.0, 2.0, 4.0)  # waits for the starter's 48100 to follow its 9000 adds
LIVENESS_CHECK_S = 15.0  # while joined: re-read the parent's lifecycle events this often
LIVENESS_MAX_FAILURES = 2  # consecutive unreadable checks before leaving (fail closed)
INVITE_MAX_AGE_S = 600  # older notifications are history (reconnect replay), never a fresh invitation
SESSION_MAX_S = 3600  # backing channels are created with ttl=3600
# Barge-in: this much continuous owner speech while the agent talks stops the reply mid-sentence and
# is captured as the next utterance. Shorter bursts (a cough, "mm") do not interrupt. This relies on the
# owner's client cancelling the agent's own voice from their mic (desktop/mobile capture with AEC).
BARGE_IN_S = 0.3
GAP_FLUSH_S = 0.8  # DTX stops sending: a frame gap this long ends the owner's utterance
_AUTH_TIMEOUT = 5.0
_PARENT_SCAN_LIMIT = 50
_MAX_REMEMBERED = 512
_VOICE_HINT = "[Spoken in a Buzz voice huddle; your reply is read aloud: answer briefly in plain speech.]\n"


def _hex64(value: Any) -> str:
    text = str(value or "").strip().lower()
    return text if len(text) == 64 and all(c in "0123456789abcdef" for c in text) else ""


def _tag(event: dict, name: str) -> Optional[str]:
    for tag in event.get("tags") or []:
        if isinstance(tag, (list, tuple)) and len(tag) >= 2 and tag[0] == name:
            return str(tag[1])
    return None


def _json_dict(text: Any) -> dict:
    try:
        data = json.loads(text or "")
    except (TypeError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


# ── NIP-01 event verification (BIP-340 over the event id) ─────────────────


def event_id_hex(event: dict) -> str:
    payload = json.dumps([0, event["pubkey"], event["created_at"], event["kind"], event["tags"], event["content"]],
                         separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _lift_x(x: int):
    p = nostr_auth.FIELD_ORDER
    if x >= p:
        return None
    y_sq = (pow(x, 3, p) + 7) % p
    y = pow(y_sq, (p + 1) // 4, p)
    if y * y % p != y_sq:
        return None
    return x, y if y % 2 == 0 else p - y


def schnorr_verify(message: bytes, pubkey: bytes, signature: bytes) -> bool:
    n = nostr_auth.CURVE_ORDER
    point = _lift_x(int.from_bytes(pubkey, "big"))
    r, s = int.from_bytes(signature[:32], "big"), int.from_bytes(signature[32:], "big")
    if point is None or r >= nostr_auth.FIELD_ORDER or s >= n:
        return False
    e = int.from_bytes(nostr_auth._tagged_hash("BIP0340/challenge", signature[:32] + pubkey + message), "big") % n
    result = nostr_auth._point_add(nostr_auth._point_multiply(s), nostr_auth._point_multiply(n - e, point))
    return result is not None and result[1] % 2 == 0 and result[0] == r


def verify_event(event: dict) -> bool:
    """True only for a well-formed event whose id is its NIP-01 hash and whose signature verifies."""
    pubkey, sig = _hex64(event.get("pubkey")), str(event.get("sig") or "")
    if (not pubkey or len(sig) != 128 or not isinstance(event.get("created_at"), int)
            or not isinstance(event.get("kind"), int) or not isinstance(event.get("tags"), list)
            or not isinstance(event.get("content"), str)):
        return False
    try:
        digest = event_id_hex(event)
        if str(event.get("id") or "").lower() != digest:
            return False
        return schnorr_verify(bytes.fromhex(digest), bytes.fromhex(pubkey), bytes.fromhex(sig))
    except (TypeError, ValueError):
        return False


def audio_url(relay_url: str, channel_id: str) -> str:
    parsed = urlsplit(relay_url)
    return urlunsplit((parsed.scheme, parsed.netloc, f"{parsed.path.rstrip('/')}/huddle/{channel_id}/audio", "", ""))


def nip11_url(relay_ws_url: str) -> str:
    parsed = urlsplit(relay_ws_url)
    return urlunsplit(({"ws": "http", "wss": "https"}.get(parsed.scheme, parsed.scheme), parsed.netloc, parsed.path or "/", "", ""))


async def _ws_connect(url: str):
    import websockets
    return await websockets.connect(url, open_timeout=10, close_timeout=3, max_size=64 * 1024, ping_interval=20, ping_timeout=20)


async def _fetch_relay_signer(relay_ws_url: str) -> str:
    """The relay's own signing key from NIP-11 ``self`` ("" on any failure)."""
    import httpx
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(5.0), follow_redirects=False) as client:
            response = await client.get(nip11_url(relay_ws_url), headers={"Accept": "application/nostr+json"})
        data = response.json() if response.status_code == 200 else None
    except (httpx.HTTPError, OSError, ValueError) as exc:
        logger.debug("Buzz huddle: NIP-11 fetch failed: %s", exc)
        return ""
    return _hex64(data.get("self")) if isinstance(data, dict) else ""


def _scratch_dir() -> str:
    """Per-session scratch for utterance WAVs and TTS output, under the profile's cache (removed on leave)."""
    from hermes_constants import get_hermes_home
    root = Path(get_hermes_home()) / "cache" / "scratch"
    root.mkdir(parents=True, exist_ok=True)
    return tempfile.mkdtemp(prefix="buzz-huddle-", dir=root)


def _transcribe(path: str) -> str:
    from tools.transcription_tools import transcribe_audio
    result = transcribe_audio(path, source="gateway")
    if not result.get("success"):
        raise RuntimeError(str(result.get("error") or "transcription failed"))
    return str(result.get("transcript") or "").strip()


def _synthesize(text: str, out_dir: str) -> bytes:
    """Hermes TTS (the profile's configured provider) -> 48 kHz mono PCM."""
    from tools.tts_tool import text_to_speech_tool
    result = _json_dict(text_to_speech_tool(text, output_path=str(Path(out_dir) / f"reply-{uuid.uuid4().hex}.mp3")))
    if not result.get("success"):
        raise RuntimeError(str(result.get("error") or "speech synthesis failed"))
    paths = result.get("file_paths") or [result.get("file_path")]
    return b"".join(audio.file_to_pcm(p) for p in paths if p)


class HuddleVoiceSession:
    """One joined huddle: owner audio in -> transcripts out; agent replies in -> Opus out."""

    def __init__(self, adapter, channel_id: str, parent_id: str, owner: str):
        self.adapter = adapter
        self.channel_id = channel_id
        self.parent_id = parent_id
        self.owner = owner
        self.closed = asyncio.Event()
        self._ws = None
        self._peers: dict[int, str] = {}
        self._segmenter = audio.UtteranceSegmenter()
        self._decoder = None
        self._encoder = None
        self._last_owner_frame = 0.0
        self._speak_lock = asyncio.Lock()
        self._speaking = False
        self._interrupted = asyncio.Event()
        self._barge_in: list[tuple[bytes, int, bool]] = []
        self._utterances: asyncio.Queue = asyncio.Queue(maxsize=8)
        self._replies: dict[str, str] = {}  # streamed drafts awaiting their finalize edit
        self._spoken: OrderedDict[str, None] = OrderedDict()
        self._seq = 0
        self._ts = 0
        self._turn = 0
        self._tmp = _scratch_dir()
        self._tasks: set[asyncio.Task] = set()

    # ── lifecycle ─────────────────────────────────────────────────────────

    async def run(self) -> None:
        """Join, then serve until the owner leaves, the room ends, the session expires or it is closed."""
        try:
            self._decoder, self._encoder = audio.OpusDecoder(), audio.OpusEncoder()
            self._ws = await _ws_connect(audio_url(self.adapter._websocket_url(), self.channel_id))
            await self._authenticate()
            # An end or removal may have landed while the socket was authenticating.
            if self.closed.is_set() or await self.adapter._huddle_state_in(
                    self.parent_id, self.channel_id, self.owner) != "live":
                logger.info("Buzz huddle: %s ended before the join completed; leaving", self.channel_id)
                return
            logger.info("Buzz huddle: joined voice in %s (parent %s)", self.channel_id, self.parent_id)
            workers = [self._read_loop(), self._gap_loop(), self._transcribe_loop(), self._liveness_loop()]
            tasks = [asyncio.create_task(w) for w in workers] + [asyncio.create_task(self.closed.wait())]
            try:
                await asyncio.wait(tasks, timeout=SESSION_MAX_S, return_when=asyncio.FIRST_COMPLETED)
            finally:
                self.closed.set()
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Buzz huddle: voice session %s ended: %s", self.channel_id, exc, exc_info=True)
        finally:
            await self._teardown()

    async def _authenticate(self) -> None:
        challenge = _json_dict(await asyncio.wait_for(self._ws.recv(), _AUTH_TIMEOUT))
        if challenge.get("type") != "challenge" or not challenge.get("challenge"):
            raise ConnectionError("huddle audio relay sent no challenge")
        # The relay tag is the base relay URL, not the /huddle URL (handler.rs nip42_expected_relay_url).
        event = nostr_auth.build_auth_event(
            private_key=self.adapter._private_key, challenge=str(challenge["challenge"]),
            relay_url=self.adapter._websocket_url(), auth_tag_json=getattr(self.adapter, "_auth_tag", "") or "")
        await self._ws.send(json.dumps({"type": "auth", "event": event, "parent_channel_id": self.parent_id,
                                        "protocol_version": audio.PROTOCOL_VERSION}, separators=(",", ":")))
        while True:
            message = await asyncio.wait_for(self._ws.recv(), _AUTH_TIMEOUT)
            data = _json_dict(message) if isinstance(message, str) else {}
            if data.get("type") == "error":
                raise ConnectionError(f"huddle audio join refused: {data.get('code') or data.get('message')}")
            if data.get("type") == "joined" and _hex64(data.get("pubkey")) == self.adapter._self_pubkey:
                self._apply_roster(data)
                return

    def _apply_roster(self, data: dict) -> None:
        for peer in data.get("peers") or []:
            if isinstance(peer, dict) and isinstance(peer.get("peer_index"), int) and _hex64(peer.get("pubkey")):
                self._peers[peer["peer_index"]] = _hex64(peer["pubkey"])
        if isinstance(data.get("peer_index"), int) and _hex64(data.get("pubkey")):
            self._peers[data["peer_index"]] = _hex64(data["pubkey"])

    async def close(self) -> None:
        self.closed.set()

    async def _teardown(self) -> None:
        self.closed.set()
        for task in list(self._tasks):
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        self._replies.clear()  # an unfinished draft is never spoken
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._ws.send(json.dumps({"type": "leave"})), 2)
            with contextlib.suppress(Exception):
                await asyncio.wait_for(self._ws.close(), 3)
        for codec in (self._decoder, self._encoder):
            if codec is not None:
                codec.close()
        shutil.rmtree(self._tmp, ignore_errors=True)
        logger.info("Buzz huddle: left voice in %s", self.channel_id)

    async def _liveness_loop(self) -> None:
        """Leave once the parent's lifecycle shows the huddle ended, or it cannot be confirmed live."""
        failures = 0
        while True:
            await asyncio.sleep(LIVENESS_CHECK_S)
            state = await self.adapter._huddle_state_in(self.parent_id, self.channel_id, self.owner)
            if state == "live":
                failures = 0
                continue
            if state is None:
                failures += 1
                if failures < LIVENESS_MAX_FAILURES:
                    continue
            logger.info("Buzz huddle: %s is no longer live (%s); leaving", self.channel_id, state or "unreadable")
            return

    # ── inbound: owner audio -> transcript -> agent ─────────────────────────

    async def _read_loop(self) -> None:
        async for message in self._ws:
            if isinstance(message, (bytes, bytearray)):
                self._on_audio(bytes(message))
                continue
            data = _json_dict(message)
            kind = data.get("type")
            if kind == "joined":
                self._apply_roster(data)
            elif kind == "left":
                if _hex64(data.get("pubkey")) == self.owner:
                    logger.info("Buzz huddle: owner left %s; leaving", self.channel_id)
                    return
                self._peers.pop(data.get("peer_index"), None)
            elif kind == "error":
                raise ConnectionError(f"huddle audio error: {data.get('code') or data.get('message')}")

    def _on_audio(self, frame: bytes) -> None:
        if self.closed.is_set():
            return
        parsed = audio.parse_relay_frame(frame)
        if parsed is None:
            return
        peer_index, level, dtx, packet = parsed
        if self._peers.get(peer_index) != self.owner:
            return  # only the owner's voice reaches the agent
        try:
            pcm = self._decoder.decode(packet) if packet and not dtx else b"\0" * audio.FRAME_BYTES
        except RuntimeError:  # one corrupt packet is a lost frame, not the end of the huddle
            pcm = b"\0" * audio.FRAME_BYTES
            level, dtx = -127, True
        if self._speaking and not self._interrupted.is_set():
            if not self._detect_barge_in(pcm, level, dtx):
                return
            held, self._barge_in = self._barge_in, []
            for frame in held:  # the interruption's first words are the start of the next utterance
                self._segmenter.push(*frame)
            return
        self._last_owner_frame = time.monotonic()
        self._queue_utterance(self._segmenter.push(pcm, level, dtx))

    def _detect_barge_in(self, pcm: bytes, level: int, dtx: bool) -> bool:
        """While speaking: hold continuous owner speech; True (and stop the reply) once it lasts BARGE_IN_S."""
        if dtx or level <= self._segmenter.silence_dbov:
            self._barge_in.clear()
            return False
        self._barge_in.append((pcm, level, dtx))
        if len(self._barge_in) * audio.FRAME_SECONDS < BARGE_IN_S:
            return False
        logger.info("Buzz huddle: owner interrupted the reply in %s", self.channel_id)
        self._interrupted.set()
        self._last_owner_frame = time.monotonic()
        return True

    def _queue_utterance(self, pcm: Optional[bytes]) -> None:
        if pcm:
            with contextlib.suppress(asyncio.QueueFull):
                self._utterances.put_nowait(pcm)

    async def _gap_loop(self) -> None:
        while True:
            await asyncio.sleep(0.2)
            if self._last_owner_frame and time.monotonic() - self._last_owner_frame > GAP_FLUSH_S:
                self._last_owner_frame = 0.0
                self._queue_utterance(self._segmenter.flush())

    async def _transcribe_loop(self) -> None:
        while True:
            pcm = await self._utterances.get()
            path = Path(self._tmp) / f"utt-{uuid.uuid4().hex}.wav"
            audio.write_wav(path, pcm)
            try:
                text = await asyncio.to_thread(_transcribe, str(path))
            except Exception as exc:
                logger.warning("Buzz huddle: transcription failed: %s", exc, exc_info=True)
                continue
            finally:
                path.unlink(missing_ok=True)
            if self.closed.is_set():
                return  # the huddle ended while STT ran: the words never become a turn
            if text:
                self._turn += 1
                await self.adapter._dispatch_huddle_transcript(self, text, f"huddle-{self.channel_id}-{self._turn}")

    # ── outbound: agent reply -> speech ───────────────────────────────────

    def queue_reply(self, message_id: Optional[str], content: str, *, final: bool) -> str:
        """Record a reply's text; speak it once it is final. Each id is spoken at most once.

        A streamed draft (``expect_edits`` send, plain edit) is held however long the model or a tool
        pauses; only the stream's finalize edit speaks it, so a pause never cuts an answer short."""
        message_id = message_id or f"huddle-reply-{uuid.uuid4().hex[:12]}"
        if message_id in self._spoken or self.closed.is_set():
            return message_id
        if not final:
            self._replies[message_id] = content
            return message_id
        self._replies.pop(message_id, None)
        self._spoken[message_id] = None
        while len(self._spoken) > _MAX_REMEMBERED:
            self._spoken.popitem(last=False)
        self._spawn(self.speak(content))
        return message_id

    async def speak(self, text: str) -> None:
        if not text.strip() or self.closed.is_set():
            return
        async with self._speak_lock:
            try:
                pcm = await asyncio.to_thread(_synthesize, text, self._tmp)
            except Exception as exc:
                logger.warning("Buzz huddle: speech synthesis failed: %s", exc, exc_info=True)
                return
            if self.closed.is_set():
                return
            self._speaking, self._barge_in = True, []
            self._interrupted.clear()
            try:
                await self._send_pcm(pcm)
            finally:
                self._speaking = False

    async def _send_pcm(self, pcm: bytes) -> None:
        """Paced 20 ms Opus frames on an absolute clock so scheduling jitter never accumulates."""
        loop = asyncio.get_running_loop()
        start = loop.time()
        for index, frame in enumerate(audio.pcm_frames(pcm)):
            if self.closed.is_set() or self._interrupted.is_set():
                return
            packet = self._encoder.encode(frame)
            await self._ws.send(audio.pack_frame(self._seq, self._ts, packet, level_dbov=audio.frame_level_dbov(frame)))
            self._seq = (self._seq + 1) & 0xFFFF
            self._ts = (self._ts + audio.FRAME_SAMPLES) & 0xFFFFFFFF
            delay = start + (index + 1) * audio.FRAME_SECONDS - loop.time()
            if delay > 0:
                await asyncio.sleep(delay)

    def _spawn(self, coro) -> asyncio.Task:
        task = asyncio.create_task(coro)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task


class BuzzHuddleVoiceMixin:
    """``BuzzAdapter`` side: the invitation gate, session registry, transcript dispatch and reply capture."""

    def _init_huddle_voice(self, enabled: Any, owner: Optional[str], relay_pubkey: Any) -> None:
        self._huddle_voice_enabled = str(enabled).strip().lower() in ("1", "true", "yes", "on")
        self._huddle_owner = _hex64(owner)
        self._huddle_relay_signer = _hex64(relay_pubkey)
        # Strict fresh-invitation boundary: only an invitation created in a later whole second than this
        # adapter (created_at > floor(construction time)) is acted on. A restart's replay, the relay's
        # since-window, and even an invite from this same second are history and never join a live room
        # (the owner removes and re-adds the agent once the gateway is up).
        self._huddle_accept_after = int(time.time())
        self._huddle_sessions: dict[str, HuddleVoiceSession] = {}
        self._huddle_tasks: dict[str, asyncio.Task] = {}
        self._huddle_aux_tasks: set[asyncio.Task] = set()
        self._huddle_finished: OrderedDict[str, None] = OrderedDict()
        self._huddle_seen_events: OrderedDict[str, None] = OrderedDict()
        self._huddle_voiced: OrderedDict[str, None] = OrderedDict()
        self._huddle_sent_text: OrderedDict[str, str] = OrderedDict()
        if self._huddle_voice_enabled:
            # A streamed huddle reply is spoken on its finalize edit, so it must arrive even when the
            # final text equals the last draft (stream_consumer_transport._edit_existing).
            self.REQUIRES_EDIT_FINALIZE = True

    def _huddle_membership_kinds(self) -> list[int]:
        """Membership kinds to subscribe to: removals (44101) only when voice is on."""
        return [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED] if self._huddle_voice_enabled else [KIND_MEMBER_ADDED]

    def _huddle_owner_pubkey(self) -> str:
        """``extra.owner``, else the owner key of this identity's NIP-OA attestation ("" = no owner, no voice)."""
        if not self._huddle_owner:
            try:
                tag = json.loads(getattr(self, "_auth_tag", "") or "null")
            except ValueError:
                tag = None
            if isinstance(tag, list) and len(tag) == 4:
                self._huddle_owner = _hex64(tag[1])
        return self._huddle_owner

    @staticmethod
    def _remember(seen: OrderedDict, key: str) -> bool:
        """True the first time *key* is seen (bounded)."""
        if key in seen:
            return False
        seen[key] = None
        while len(seen) > _MAX_REMEMBERED:
            seen.popitem(last=False)
        return True

    def _note_membership_notification(self, event: dict) -> None:
        """A relay membership notification (44100 add / 44101 removal) from the WebSocket."""
        if not self._huddle_voice_enabled or not isinstance(event, dict):
            return
        kind = event.get("kind")
        if kind not in (KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED):
            return
        content = _json_dict(event.get("content"))
        channel_id = str(content.get("channel_id") or "")
        expected = "member_added" if kind == KIND_MEMBER_ADDED else "member_removed"
        if (not channel_id or content.get("type") != expected or _tag(event, "h") != channel_id
                or _hex64(_tag(event, "p")) != self._self_pubkey or not _hex64(event.get("id"))):
            return
        if not self._remember(self._huddle_seen_events, _hex64(event.get("id"))):
            return
        if kind == KIND_MEMBER_REMOVED:
            if channel_id in self._huddle_tasks:
                self._spawn_huddle_aux(self._handle_huddle_removal(channel_id, event))
            return
        owner = self._huddle_owner_pubkey()
        if not owner or _hex64(content.get("actor")) != owner:
            return
        created_at = event.get("created_at")
        if (not isinstance(created_at, int) or created_at <= self._huddle_accept_after
                or abs(time.time() - created_at) > INVITE_MAX_AGE_S):
            return
        if channel_id in self._huddle_tasks or channel_id in self._huddle_finished or channel_id in self._channel_state:
            return
        task = asyncio.create_task(self._accept_huddle_invitation(channel_id, event, owner))
        self._huddle_tasks[channel_id] = task
        task.add_done_callback(lambda _t, c=channel_id: self._huddle_session_done(c))

    def _spawn_huddle_aux(self, coro) -> None:
        task = asyncio.create_task(coro)
        self._huddle_aux_tasks.add(task)
        task.add_done_callback(self._huddle_aux_tasks.discard)

    async def _relay_signed(self, event: dict) -> bool:
        """The event is signed (verified BIP-340) by the relay's own key."""
        if not self._huddle_relay_signer:
            self._huddle_relay_signer = await _fetch_relay_signer(self._websocket_url())
        return bool(self._huddle_relay_signer) and _hex64(event.get("pubkey")) == self._huddle_relay_signer \
            and verify_event(event)

    async def _handle_huddle_removal(self, channel_id: str, event: dict) -> None:
        if not await self._relay_signed(event):
            logger.warning("Buzz huddle: ignoring a removal notification not signed by the relay")
            return
        logger.info("Buzz huddle: removed from %s; leaving", channel_id)
        self._end_huddle(channel_id)

    def _end_huddle(self, channel_id: str) -> None:
        """Close a joined session, or abandon an invitation still being verified or authenticated."""
        if (session := self._huddle_sessions.get(channel_id)) is not None:
            session.closed.set()
        elif (task := self._huddle_tasks.get(channel_id)) is not None:
            task.cancel()

    def _huddle_owns_channel(self, channel_id: str) -> bool:
        """A backing channel this adapter is voicing (or still verifying): never adopted as a text chat,
        or the owner's desktop transcripts (kind 9 ``p``-tagging agents, pipeline.rs) would get a second,
        text reply that every desktop then also speaks."""
        return self._huddle_voice_enabled and (channel_id in self._huddle_tasks or channel_id in self._huddle_voiced)

    def _huddle_session_done(self, channel_id: str) -> None:
        self._huddle_tasks.pop(channel_id, None)
        self._huddle_sessions.pop(channel_id, None)
        self._remember(self._huddle_finished, channel_id)  # an ended or left huddle is never rejoined

    async def _accept_huddle_invitation(self, channel_id: str, event: dict, owner: str) -> None:
        try:
            await self._verify_and_join_huddle(channel_id, event, owner)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # fail closed: an unverifiable invitation is never joined
            logger.warning("Buzz huddle: invitation to %s not joined: %s", channel_id, exc, exc_info=True)

    async def _verify_and_join_huddle(self, channel_id: str, event: dict, owner: str) -> None:
        if not await self._relay_signed(event):
            logger.warning("Buzz huddle: ignoring membership notification not signed by the relay")
            return
        # Desktop adds agents (kind 9000 -> our 44100) before it publishes the 48100
        # (swarm desktop/src-tauri/src/huddle/mod.rs start_huddle), so the link may not exist yet.
        parent = await self._live_huddle_parent(channel_id, owner)
        for delay in LIVENESS_RETRY_DELAYS:
            if parent:
                break
            await asyncio.sleep(delay)
            parent = await self._live_huddle_parent(channel_id, owner)
        if not parent:
            logger.info("Buzz huddle: %s is not a live huddle the owner started; not joining", channel_id)
            return
        self._remember(self._huddle_voiced, channel_id)
        session = HuddleVoiceSession(self, channel_id, parent, owner)
        self._huddle_sessions[channel_id] = session
        self._channel_names.setdefault(channel_id, f"voice huddle in {self._channel_names.get(parent, parent)}")
        await session.run()

    async def _huddle_state_in(self, parent: str, channel_id: str, owner: str) -> Optional[str]:
        """Lifecycle of *channel_id* in *parent*: "live", "ended", "absent", or None when unreadable.

        Only an owner-signed 48100 starts it; only an owner- or relay-signed 48103 ends it (the relay
        signs the 48103 it emits when the last peer leaves, audio/handler.rs)."""
        code, out, _ = await self._run_cli(
            ["messages", "get", "--channel", parent, "--limit", str(_PARENT_SCAN_LIMIT),
             "--kinds", f"{KIND_HUDDLE_STARTED},{KIND_HUDDLE_ENDED}"])
        if code != 0:
            return None
        try:
            events = json.loads(out)
        except ValueError:
            return None
        if not isinstance(events, list):
            return None
        ours = [e for e in events if isinstance(e, dict)
                and _json_dict(e.get("content")).get("ephemeral_channel_id") == channel_id and _tag(e, "h") == parent]
        enders = {owner, self._huddle_relay_signer} - {""}
        if any(e.get("kind") == KIND_HUDDLE_ENDED and _hex64(e.get("pubkey")) in enders for e in ours):
            return "ended"
        if any(e.get("kind") == KIND_HUDDLE_STARTED and _hex64(e.get("pubkey")) == owner for e in ours):
            return "live"
        return "absent"

    async def _live_huddle_parent(self, channel_id: str, owner: str) -> str:
        """The watched parent channel holding the owner's live 48100 for *channel_id*, "" if none."""
        for parent in list(self._channel_state):
            if parent == channel_id:
                continue
            state = await self._huddle_state_in(parent, channel_id, owner)
            if state == "live":
                return parent
            if state == "ended":
                return ""
        return ""

    async def _dispatch_huddle_transcript(self, session: HuddleVoiceSession, text: str, message_id: str) -> None:
        from gateway.platforms.event import MessageEvent, MessageType
        source = self.build_source(
            chat_id=session.channel_id, chat_name=self._channel_names.get(session.channel_id), chat_type="group",
            user_id=session.owner, user_name="owner",
            message_id=message_id, parent_chat_id=session.parent_id)
        await self.handle_message(MessageEvent(
            text=_VOICE_HINT + text, message_type=MessageType.TEXT, source=source, message_id=message_id,
            timestamp=datetime.now()))

    def _huddle_reply(self, chat_id: str, content: str, message_id: Optional[str] = None, *, final: bool = True):
        """Capture a reply addressed to a voice huddle (spoken, never posted); None for any other chat.

        A reply that lands after the session ended (the owner left mid-turn) is dropped: posted as a
        kind 9 in the backing channel it would be read aloud by every desktop still in the huddle."""
        if not self._huddle_owns_channel(str(chat_id)):
            return None
        from gateway.platforms.base import SendResult
        session = self._huddle_sessions.get(str(chat_id))
        if session is None or session.closed.is_set():
            logger.info("Buzz huddle: dropping a reply to %s; the voice session has ended", chat_id)
            return SendResult(success=True, message_id=message_id or f"huddle-dropped-{uuid.uuid4().hex[:12]}")
        return SendResult(success=True, message_id=session.queue_reply(message_id, content, final=final))

    def _huddle_refuse_media(self, chat_id: str):
        """Attachments cannot be spoken; never upload one into a voice huddle's backing channel."""
        if not self._huddle_owns_channel(str(chat_id)):
            return None
        from gateway.platforms.base import SendResult
        return SendResult(success=False, error="Attachments are not supported in a Buzz voice huddle")

    def _huddle_note_sent(self, message_id: Optional[str], content: str) -> None:
        """Remember a text chat message's last content (bounded) for ``_huddle_redundant_finalize``."""
        if self._huddle_voice_enabled and message_id:
            self._huddle_sent_text[str(message_id)] = content
            self._huddle_sent_text.move_to_end(str(message_id))
            while len(self._huddle_sent_text) > _MAX_REMEMBERED:
                self._huddle_sent_text.popitem(last=False)

    def _huddle_redundant_finalize(self, message_id: str, content: str, finalize: bool) -> bool:
        """``REQUIRES_EDIT_FINALIZE`` (set for huddles) also sends text chats an unchanged finalize edit;
        Buzz text has no in-progress state, so that edit is skipped instead of re-publishing."""
        return finalize and self._huddle_voice_enabled and self._huddle_sent_text.get(str(message_id)) == content

    async def _huddle_transport_lost(self) -> None:
        """The main relay WebSocket dropped: a 44101 removal may be missed while it is down, and the
        lifecycle poll cannot see membership, so stop listening now (bounded) rather than keep hearing
        the owner after a revocation. A left huddle is never rejoined; the owner re-adds the agent."""
        if not self._huddle_voice_enabled or not (self._huddle_tasks or self._huddle_aux_tasks):
            return
        logger.info("Buzz huddle: control WebSocket lost; leaving %d voice huddle(s)", len(self._huddle_tasks))
        await self._stop_huddle_voice()

    async def _stop_huddle_voice(self) -> None:
        """Leave every huddle (bounded) and abandon invitations still being verified."""
        for task in list(self._huddle_aux_tasks):
            task.cancel()
        tasks = list(self._huddle_tasks.values())
        for channel_id in list(self._huddle_tasks):
            self._end_huddle(channel_id)
        if tasks:
            _, pending = await asyncio.wait(tasks, timeout=5)
            for task in pending:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
