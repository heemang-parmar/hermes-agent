"""Buzz huddle voice: owner-invited audio bridge (huddle_voice.py + huddle_audio.py).

Behaviour contracts: real libopus encode/decode and the v2 wire bytes desktop and mobile speak; the
invitation gate fails closed; owner speech becomes one inbound turn routed to the huddle's own chat;
replies to that chat are spoken as Opus frames, never posted; barge-in stops a reply mid-sentence;
leave/teardown never rejoins. The relay socket, the CLI, STT and TTS are faked; the codec is not.
"""

import asyncio
import json
import math
import struct
import time

import pytest

from tests.gateway._plugin_adapter_loader import load_plugin_adapter

_buzz_mod = load_plugin_adapter("buzz")
BuzzAdapter = _buzz_mod.BuzzAdapter
hv = _buzz_mod._huddle_voice
audio = hv.audio

SELF = "9fd5c7ba6d3ef224da78f541e0fcb9c50f72cc63edb19aae76ac6a0474dfa860"
OWNER = "a" * 64
OTHER = "b" * 64
RELAY_SK = "00" * 31 + "05"
OTHER_SK = "00" * 31 + "07"
RELAY = hv.nostr_auth.public_key_hex(RELAY_SK)
PARENT = "ccc2bc1a-7a82-5a8f-8c4e-57a070cbe7cd"
ROOM = "0d1f6a52-63a1-4e0e-9a53-5c8d2f0e7b11"


@pytest.fixture(autouse=True)
def _no_ambient_buzz_env(monkeypatch):
    import os
    for name in [n for n in os.environ if n.startswith("BUZZ_")]:
        monkeypatch.delenv(name)
    monkeypatch.setattr(hv, "LIVENESS_RETRY_DELAYS", ())  # rejection tests need no real waiting


def _tone(seconds, amplitude=8000, freq=440):
    count = int(audio.SAMPLE_RATE * seconds)
    return b"".join(struct.pack("<h", int(amplitude * math.sin(2 * math.pi * freq * i / audio.SAMPLE_RATE)))
                    for i in range(count))


# ── codec + wire ─────────────────────────────────────────────────────────


def test_libopus_round_trip_preserves_speech_level():
    encoder, decoder = audio.OpusEncoder(), audio.OpusDecoder()
    try:
        levels = []
        for frame in audio.pcm_frames(_tone(0.2)):
            packet = encoder.encode(frame)
            assert 8 < len(packet) < audio.MAX_FRAME_BYTES
            decoded = decoder.decode(packet)
            assert len(decoded) == audio.FRAME_BYTES
            levels.append(audio.frame_level_dbov(decoded))
        assert max(levels[2:]) > -20  # past codec warm-up the tone survives at roughly its -12 dBov
    finally:
        encoder.close()
        decoder.close()


def test_wire_frame_matches_v2_layout():
    """seq u16 | ts_48k u32 | level i8 | flags u8 | opus (BE), relay prefixes peer_index (mobile/HUDDLES.md)."""
    frame = audio.pack_frame(0x1234, 960 * 3, b"OPUS", level_dbov=-30)
    assert frame == bytes.fromhex("1234") + (2880).to_bytes(4, "big") + bytes([256 - 30, 0]) + b"OPUS"
    assert audio.parse_relay_frame(b"\x05" + frame) == (5, -30, False, b"OPUS")
    assert audio.parse_relay_frame(b"\x05" + audio.pack_frame(1, 0, b"", dtx=True))[2] is True
    assert audio.parse_relay_frame(b"\x05\x00\x01") is None
    assert audio.parse_relay_frame(b"\x05" + b"\0" * (audio.MAX_FRAME_BYTES + 1)) is None


def test_segmenter_cuts_on_trailing_silence_and_drops_blips():
    seg = audio.UtteranceSegmenter()
    voiced, silent = b"\1" * audio.FRAME_BYTES, b"\0" * audio.FRAME_BYTES
    assert all(seg.push(voiced, -12, False) is None for _ in range(30))
    out = [seg.push(silent, -127, True) for _ in range(40)]
    assert out[-1] is not None and all(o is None for o in out[:-1])
    for _ in range(5):  # 100 ms: a click, not speech
        seg.push(voiced, -12, False)
    assert seg.flush() is None


# ── adapter fixtures ─────────────────────────────────────────────────────

_UNSET = object()



def _make_adapter(extra=None):
    from gateway.config import PlatformConfig
    base = {"relay_url": "https://test.relay", "huddle_voice": "true", "owner": OWNER, "relay_pubkey": RELAY}
    merged = {k: v for k, v in {**base, **(extra or {})}.items() if v is not _UNSET}
    adapter = BuzzAdapter(PlatformConfig(enabled=True, extra=merged))
    adapter._self_pubkey = SELF
    adapter._private_key = "00" * 31 + "03"
    adapter._channel_state = {PARENT: adapter._new_channel_state("group")}
    adapter._write_runtime_status_safe = lambda *a, **kw: None
    adapter.turns = []

    async def handle_message(event):
        adapter.turns.append(event)
    adapter.handle_message = handle_message
    return adapter


def _signed(event, secret):
    event["pubkey"] = hv.nostr_auth.public_key_hex(secret)
    event["id"] = hv.event_id_hex(event)
    event["sig"] = hv.nostr_auth.schnorr_sign(bytes.fromhex(event["id"]), secret).hex()
    return event


def _invite(*, actor=OWNER, p=SELF, signer=RELAY_SK, created_at=None, channel=ROOM, kind=44100, nonce=0):
    """A relay membership notification exactly as side_effects.rs builds it (signed, p + h tags)."""
    kind_type = "member_added" if kind == 44100 else "member_removed"
    # Default: one second after now, i.e. after the adapter was built (the strict fresh boundary).
    return _signed({"kind": kind, "created_at": (created_at or int(time.time()) + 1) + nonce,
                    "tags": [["p", p], ["h", channel]],
                    "content": json.dumps({"type": kind_type, "channel_id": channel, "actor": actor})}, signer)


def _lifecycle(kind, *, signer=OWNER, room=ROOM, parent=PARENT):
    return {"id": f"lc-{kind}", "kind": kind, "pubkey": signer, "created_at": int(time.time()),
            "tags": [["h", parent]], "content": json.dumps({"ephemeral_channel_id": room})}


def _cli(adapter, lifecycle_events):
    calls = []

    async def run_cli(args, **kw):
        calls.append(args)
        if args[:2] == ["messages", "get"]:
            return 0, json.dumps(lifecycle_events), ""
        if args[:2] == ["messages", "send"]:
            return 0, json.dumps({"event_id": "e" * 64, "accepted": True}), ""
        if args[:2] == ["messages", "edit"]:
            return 0, json.dumps({"event_id": "f" * 64, "accepted": True}), ""
        return 0, "[]", ""
    adapter._run_cli = run_cli
    return calls


class _FakeAudioWS:
    """The relay audio room: challenge, joined roster on auth, then scripted frames (None = relay close)."""

    def __init__(self, join_reply=None):
        self.sent, self.auth, self.closed = [], None, False
        self.inbound = asyncio.Queue()
        self.inbound.put_nowait(json.dumps({"type": "challenge", "challenge": "chal-1"}))
        self.join_reply = join_reply or {
            "type": "joined", "revision": 1, "pubkey": SELF, "peer_index": 2, "epoch": 0,
            "peers": [{"pubkey": OWNER, "peer_index": 0, "epoch": 0}, {"pubkey": OTHER, "peer_index": 1, "epoch": 0},
                      {"pubkey": SELF, "peer_index": 2, "epoch": 0}]}

    async def recv(self):
        return await self.inbound.get()

    async def send(self, data):
        self.sent.append(data)
        if isinstance(data, str) and json.loads(data).get("type") == "auth":
            self.auth = json.loads(data)
            self.inbound.put_nowait(json.dumps(self.join_reply))

    async def close(self):
        self.closed = True

    def __aiter__(self):
        return self

    async def __anext__(self):
        item = await self.inbound.get()
        if item is None:
            raise StopAsyncIteration
        return item

    def audio_frames(self):
        return [f for f in self.sent if isinstance(f, bytes)]

    def control(self):
        return [json.loads(f)["type"] for f in self.sent if isinstance(f, str)]


def _connect_to(monkeypatch, ws):
    urls = []

    async def connect(url):
        urls.append(url)
        return ws
    monkeypatch.setattr(hv, "_ws_connect", connect)
    return urls


def _speak_as(ws, peer_index, seconds, encoder, *, then_silence=True):
    for frame in audio.pcm_frames(_tone(seconds)):
        ws.inbound.put_nowait(bytes([peer_index]) + audio.pack_frame(0, 0, encoder.encode(frame), level_dbov=-12))
    if then_silence:
        for _ in range(45):
            ws.inbound.put_nowait(bytes([peer_index]) + audio.pack_frame(0, 0, b"\xf8", level_dbov=-127, dtx=True))


async def _until(predicate, what, timeout=5.0):
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.01)


@pytest.fixture
def fakes(monkeypatch):
    transcribed, synthesized = [], []

    def transcribe(path):
        import wave
        with wave.open(path) as wav:
            transcribed.append(wav.getnframes() / wav.getframerate())
        return f"utterance {len(transcribed)}"

    def synthesize(text, out_dir):
        synthesized.append(text)
        return _tone(1.5 if "long" in text else 0.2)
    monkeypatch.setattr(hv, "_transcribe", transcribe)
    monkeypatch.setattr(hv, "_synthesize", synthesize)
    return transcribed, synthesized


async def _joined(monkeypatch, adapter, ws):
    _cli(adapter, [_lifecycle(48100)])
    urls = _connect_to(monkeypatch, ws)
    adapter._note_membership_notification(_invite())
    await _until(lambda: ROOM in adapter._huddle_sessions and ws.auth is not None, "join")
    return urls


# ── invitation gate ──────────────────────────────────────────────────────


@pytest.mark.parametrize("extra,event", [
    ({"huddle_voice": _UNSET}, _invite()),                    # opt-in: absent means off
    ({"huddle_voice": "false"}, _invite()),
    ({}, _invite(actor=OTHER)),                               # added by someone else
    ({}, _invite(p=OTHER)),                                   # addressed to another agent
    ({}, _invite(created_at=int(time.time()) - 3600)),        # reconnect replay of an old add
    ({"owner": ""}, _invite()),                               # no owner known
])
@pytest.mark.asyncio
async def test_invitation_gate_rejects_without_joining(monkeypatch, extra, event):
    adapter = _make_adapter(extra)
    _connect_to(monkeypatch, None)
    adapter._note_membership_notification(event)
    assert adapter._huddle_tasks == {}


@pytest.mark.parametrize("signer,lifecycle", [
    (OTHER_SK, [_lifecycle(48100)]),                          # notification not signed by the relay
    (RELAY_SK, [_lifecycle(48100, signer=OTHER)]),            # huddle started by someone else
    (RELAY_SK, [_lifecycle(48100), _lifecycle(48103)]),       # huddle already ended
    (RELAY_SK, []),                                           # not a huddle in any watched channel
])
@pytest.mark.asyncio
async def test_unverified_invitation_never_opens_audio(monkeypatch, signer, lifecycle):
    adapter = _make_adapter()
    _cli(adapter, lifecycle)
    urls = _connect_to(monkeypatch, _FakeAudioWS())
    adapter._note_membership_notification(_invite(signer=signer))
    await asyncio.gather(*adapter._huddle_tasks.values())
    assert urls == [] and adapter._huddle_sessions == {}
    assert not adapter._huddle_owns_channel(ROOM)  # a rejected channel stays adoptable as ordinary chat


# ── join, both directions, teardown ──────────────────────────────────────


@pytest.mark.asyncio
async def test_owner_speech_becomes_a_huddle_turn_and_reply_is_spoken_not_posted(monkeypatch, fakes):
    transcribed, synthesized = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    urls = await _joined(monkeypatch, adapter, ws)
    assert urls == [f"wss://test.relay/huddle/{ROOM}/audio"]
    assert ws.auth["protocol_version"] == 2 and ws.auth["parent_channel_id"] == PARENT
    auth_event = ws.auth["event"]
    assert auth_event["kind"] == 22242 and auth_event["pubkey"] == hv.nostr_auth.public_key_hex(adapter._private_key)
    assert ["relay", "wss://test.relay"] in auth_event["tags"] and ["challenge", "chal-1"] in auth_event["tags"]
    assert adapter._huddle_owns_channel(ROOM)

    encoder = audio.OpusEncoder()
    _speak_as(ws, 1, 0.6, encoder)  # another participant: never transcribed
    _speak_as(ws, 0, 0.6, encoder)  # the owner
    await _until(lambda: adapter.turns, "owner turn")
    assert len(adapter.turns) == 1 and len(transcribed) == 1
    turn = adapter.turns[0]
    assert turn.source.chat_id == ROOM and turn.source.parent_chat_id == PARENT
    assert turn.source.user_id == OWNER and turn.text.endswith("utterance 1")

    calls = _cli(adapter, [])
    result = await adapter.send(ROOM, "Lights are on.")
    assert result.success
    await _until(lambda: len(ws.audio_frames()) >= 10, "spoken frames")
    assert synthesized == ["Lights are on."]
    assert not any(c[:2] == ["messages", "send"] for c in calls)  # never posted as kind 9
    decoder = audio.OpusDecoder()
    seqs = []
    for frame in ws.audio_frames():
        seq, ts, _level, _flags = struct.unpack(">HIbB", frame[:8])
        seqs.append((seq, ts))
        assert len(decoder.decode(frame[8:])) == audio.FRAME_BYTES
    assert seqs[:3] == [(0, 0), (1, 960), (2, 1920)]

    await adapter.send(PARENT, "normal chat")  # other chats are untouched
    assert any(c[:2] == ["messages", "send"] and PARENT in c for c in calls)
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_streamed_reply_is_spoken_once_with_its_final_text(monkeypatch, fakes):
    _, synthesized = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    first = await adapter.send(ROOM, "The wea", metadata={"expect_edits": True})
    await adapter.edit_message(ROOM, first.message_id, "The weather is")
    await adapter.edit_message(ROOM, first.message_id, "The weather is sunny.", finalize=True)
    await _until(lambda: synthesized, "speech")
    await adapter.edit_message(ROOM, first.message_id, "The weather is sunny. (edited)", finalize=True)
    assert adapter._huddle_sessions[ROOM]._replies == {}  # a spoken id schedules nothing more
    assert synthesized == ["The weather is sunny."]
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_owner_barge_in_stops_the_reply_and_is_heard(monkeypatch, fakes):
    transcribed, _ = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    await adapter.send(ROOM, "a long answer", metadata=None)
    session = adapter._huddle_sessions[ROOM]
    await _until(lambda: session._speaking and len(ws.audio_frames()) >= 10, "reply under way")
    encoder = audio.OpusEncoder()
    _speak_as(ws, 0, 0.5, encoder)  # owner talks over the agent
    await _until(lambda: adapter.turns, "interrupting turn")
    full_reply_frames = int(1.5 / audio.FRAME_SECONDS)
    assert len(ws.audio_frames()) < full_reply_frames  # playback was cut short
    assert transcribed and transcribed[0] >= 0.3  # the interruption's opening words were kept
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_owner_leaving_ends_session_and_it_is_never_rejoined(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    ws.inbound.put_nowait(json.dumps({"type": "left", "revision": 2, "pubkey": OWNER, "peer_index": 0, "epoch": 0}))
    await _until(lambda: ROOM not in adapter._huddle_tasks, "teardown")
    assert ws.control()[-1] == "leave" and ws.closed
    calls = _cli(adapter, [])
    late = await adapter.send(ROOM, "too late")  # a reply finishing after the owner left
    assert late.success and not any(c[:2] == ["messages", "send"] for c in calls)  # dropped, never posted as kind 9
    connects = _connect_to(monkeypatch, _FakeAudioWS())
    adapter._note_membership_notification(_invite(nonce=1))
    assert adapter._huddle_tasks == {} and connects == []


@pytest.mark.asyncio
async def test_disconnect_leaves_an_active_huddle(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    await adapter.disconnect()
    assert ws.control()[-1] == "leave" and ws.closed and adapter._huddle_tasks == {}


@pytest.mark.asyncio
async def test_relay_refusing_the_join_leaves_cleanly(monkeypatch, fakes):
    adapter = _make_adapter()
    ws = _FakeAudioWS(join_reply={"type": "error", "code": "room_ended", "message": "huddle has ended"})
    _cli(adapter, [_lifecycle(48100)])
    _connect_to(monkeypatch, ws)
    adapter._note_membership_notification(_invite())
    await asyncio.gather(*adapter._huddle_tasks.values())
    assert adapter._huddle_sessions == {} and ws.closed and ROOM in adapter._huddle_finished


@pytest.mark.asyncio
async def test_corrupt_owner_packet_is_a_lost_frame_not_a_dropped_huddle(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    ws.inbound.put_nowait(b"\x00" + audio.pack_frame(0, 0, b"\xff" * 3, level_dbov=-12))  # undecodable Opus
    _speak_as(ws, 0, 0.6, audio.OpusEncoder())
    await _until(lambda: adapter.turns, "owner turn after the corrupt packet")
    assert ROOM in adapter._huddle_sessions and not adapter._huddle_sessions[ROOM].closed.is_set()
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_unparseable_lifecycle_history_fails_closed(monkeypatch, fakes):
    adapter = _make_adapter()
    urls = _connect_to(monkeypatch, _FakeAudioWS())

    async def run_cli(args, **kw):
        return 0, "[not json", ""
    adapter._run_cli = run_cli
    adapter._note_membership_notification(_invite())
    results = await asyncio.gather(*adapter._huddle_tasks.values(), return_exceptions=True)
    assert results == [None] and urls == [] and not adapter._huddle_owns_channel(ROOM)


@pytest.mark.asyncio
async def test_attachments_are_never_uploaded_into_a_voice_huddle(monkeypatch, fakes, tmp_path):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    calls = _cli(adapter, [])
    clip = tmp_path / "clip.ogg"
    clip.write_bytes(b"OggS")
    result = await adapter.send_voice(ROOM, str(clip))
    assert not result.success and calls == []
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_invitation_racing_ahead_of_the_huddle_start_still_joins(monkeypatch, fakes):
    """Desktop sends the 9000 add before the 48100: the first liveness check finds nothing."""
    monkeypatch.setattr(hv, "LIVENESS_RETRY_DELAYS", (0.01, 0.01))
    adapter, ws = _make_adapter(), _FakeAudioWS()
    scans = []

    async def run_cli(args, **kw):
        scans.append(args)
        return 0, json.dumps([_lifecycle(48100)] if len(scans) > 1 else []), ""
    adapter._run_cli = run_cli
    _connect_to(monkeypatch, ws)
    adapter._note_membership_notification(_invite())
    await _until(lambda: ROOM in adapter._huddle_sessions and ws.auth is not None, "join after 48100 lands")
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_owner_removing_the_agent_makes_it_leave(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    adapter._note_membership_notification(_invite(kind=44101))
    await _until(lambda: ROOM not in adapter._huddle_tasks, "leave on removal")
    assert ws.control()[-1] == "leave" and ws.closed


@pytest.mark.asyncio
async def test_duplicate_notification_joins_once(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    adapter._note_membership_notification(_invite())  # same event replayed on resubscribe
    adapter._note_membership_notification(_invite(nonce=1))  # fresh add while already joined
    assert len(adapter._huddle_tasks) == 1
    await adapter._stop_huddle_voice()


# ── signatures, removal, live end, replay (review blockers) ──────────────


@pytest.mark.asyncio
async def test_forged_relay_signature_cannot_invite(monkeypatch, fakes):
    adapter = _make_adapter()
    _cli(adapter, [_lifecycle(48100)])
    urls = _connect_to(monkeypatch, _FakeAudioWS())
    forged = _invite()
    forged["content"] = json.dumps({"type": "member_added", "channel_id": ROOM, "actor": OWNER, "x": 1})
    forged["id"] = hv.event_id_hex(forged)  # id recomputed, signature left over from the original
    adapter._note_membership_notification(forged)
    await asyncio.gather(*adapter._huddle_tasks.values())
    assert urls == [] and not adapter._huddle_owns_channel(ROOM)


@pytest.mark.parametrize("mutate", [
    lambda e: e["tags"].__setitem__(1, ["h", PARENT]),  # h tag names another channel
    lambda e: e.__setitem__("kind", "44100"),           # malformed kind
    lambda e: e.__setitem__("content", "not json"),
    lambda e: e.__setitem__("id", "nope"),
])
@pytest.mark.asyncio
async def test_malformed_notification_is_ignored(monkeypatch, mutate):
    adapter = _make_adapter()
    event = _invite()
    mutate(event)
    adapter._note_membership_notification(event)
    assert adapter._huddle_tasks == {}


@pytest.mark.parametrize("offset,joins", [(-5, False), (0, False), (1, True)])
@pytest.mark.asyncio
async def test_fresh_invitation_boundary_is_strict(monkeypatch, fakes, offset, joins):
    """Restart 5 s after an invite, an invite in the adapter's own second: replay, never a join.
    The next second is fresh."""
    adapter = _make_adapter()
    _cli(adapter, [_lifecycle(48100)])
    urls = _connect_to(monkeypatch, _FakeAudioWS())
    adapter._note_membership_notification(_invite(created_at=adapter._huddle_accept_after + offset))
    assert (ROOM in adapter._huddle_tasks) is joins
    if joins:
        await _until(lambda: urls, "join")
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_restarted_adapter_never_revives_an_earlier_invitation(monkeypatch, fakes):
    """A fresh adapter (gateway restart) sees an invitation from 2 minutes ago: inside INVITE_MAX_AGE_S
    and for a still-live huddle, yet older than this adapter, so it is replay, never a join."""
    adapter = _make_adapter()
    _cli(adapter, [_lifecycle(48100)])
    urls = _connect_to(monkeypatch, _FakeAudioWS())
    adapter._note_membership_notification(_invite(created_at=int(time.time()) - 120))
    assert adapter._huddle_tasks == {} and urls == []


@pytest.mark.asyncio
async def test_membership_subscription_includes_removals_only_when_voice_is_on():
    for enabled, kinds in (("true", [44100, 44101]), ("false", [44100])):
        adapter = _make_adapter({"huddle_voice": enabled})
        sent = []

        class _WS:
            async def send(self, data):
                sent.append(json.loads(data))
        await adapter._subscribe_websocket(_WS())
        membership = [f for _req, sub, f in sent if sub == "hermes-buzz-membership"]
        assert membership and membership[0]["kinds"] == kinds and membership[0]["#p"] == [SELF]


@pytest.mark.asyncio
async def test_forged_removal_does_not_end_the_huddle(monkeypatch, fakes):
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    adapter._note_membership_notification(_invite(kind=44101, signer=OTHER_SK))
    await asyncio.gather(*adapter._huddle_aux_tasks)
    assert not adapter._huddle_sessions[ROOM].closed.is_set()
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_removal_while_admission_is_pending_cancels_the_join(monkeypatch, fakes):
    adapter = _make_adapter()
    urls = _connect_to(monkeypatch, _FakeAudioWS())
    gate, scanning = asyncio.Event(), asyncio.Event()

    async def run_cli(args, **kw):
        scanning.set()
        await gate.wait()
        return 0, json.dumps([_lifecycle(48100)]), ""
    adapter._run_cli = run_cli
    adapter._note_membership_notification(_invite())
    await scanning.wait()
    adapter._note_membership_notification(_invite(kind=44101))
    await asyncio.gather(*adapter._huddle_aux_tasks)
    gate.set()
    await _until(lambda: ROOM not in adapter._huddle_tasks, "admission abandoned")
    assert urls == [] and ROOM in adapter._huddle_finished


@pytest.mark.parametrize("ender,leaves", [(OWNER, True), (RELAY, True), (OTHER, False)])
@pytest.mark.asyncio
async def test_live_end_closes_the_session_only_when_owner_or_relay_ended_it(monkeypatch, fakes, ender, leaves):
    monkeypatch.setattr(hv, "LIVENESS_CHECK_S", 0.01)
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    calls = _cli(adapter, [_lifecycle(48100), _lifecycle(48103, signer=ender)])
    if leaves:
        await _until(lambda: ROOM not in adapter._huddle_tasks, "leave on 48103")
        assert ws.control()[-1] == "leave"
        assert (await adapter.send(ROOM, "after the end")).success and not any(c[:2] == ["messages", "send"] for c in calls)
    else:
        await _until(lambda: len(calls) >= 3, "several liveness checks")
        assert not adapter._huddle_sessions[ROOM].closed.is_set()
        await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_unconfirmable_liveness_leaves_after_bounded_failures(monkeypatch, fakes):
    """Control transport or CLI down: the room cannot be confirmed live, so the agent stops listening."""
    monkeypatch.setattr(hv, "LIVENESS_CHECK_S", 0.01)
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)

    async def down(args, **kw):
        return 1, "", "connection refused"
    adapter._run_cli = down
    await _until(lambda: ROOM not in adapter._huddle_tasks, "fail-closed leave")
    assert ws.closed


@pytest.mark.asyncio
async def test_draft_held_through_a_long_pause_then_final_spoken_whole(monkeypatch, fakes):
    _, synthesized = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    assert adapter.REQUIRES_EDIT_FINALIZE is True  # the consumer always delivers the finalize edit
    draft = await adapter.send(ROOM, "Let me check", metadata={"expect_edits": True})
    await adapter.edit_message(ROOM, draft.message_id, "Let me check the forecast")
    session = adapter._huddle_sessions[ROOM]
    assert synthesized == [] and session._tasks == set()  # nothing scheduled: a tool pause cannot speak a draft
    await adapter.edit_message(ROOM, draft.message_id, "Let me check the forecast. Sunny, 24 degrees.", finalize=True)
    await _until(lambda: synthesized, "final speech")
    assert synthesized == ["Let me check the forecast. Sunny, 24 degrees."]
    await adapter._stop_huddle_voice()


@pytest.mark.asyncio
async def test_unfinished_draft_is_never_spoken_on_leave(monkeypatch, fakes):
    _, synthesized = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    await adapter.send(ROOM, "Half a senten", metadata={"expect_edits": True})
    await adapter._stop_huddle_voice()
    assert synthesized == [] and ws.audio_frames() == []


@pytest.mark.asyncio
async def test_text_chat_skips_unchanged_finalize_edit_but_keeps_real_edits():
    adapter = _make_adapter()
    calls = _cli(adapter, [])
    sent = await adapter.send(PARENT, "hello there")
    await adapter.edit_message(PARENT, sent.message_id, "hello there", finalize=True)
    assert not any(c[:2] == ["messages", "edit"] for c in calls)
    await adapter.edit_message(PARENT, sent.message_id, "hello there, friend", finalize=True)
    assert any(c[:2] == ["messages", "edit"] for c in calls)
    assert _make_adapter({"huddle_voice": "false"}).REQUIRES_EDIT_FINALIZE is False


class _MainSocket:
    """The adapter's main relay WebSocket: open until ``drop`` is set, then the relay closes it."""

    def __init__(self, opened, drop):
        self.opened, self.drop = opened, drop

    async def __aenter__(self):
        self.opened.set()
        return self

    async def __aexit__(self, *exc):
        return False

    def __aiter__(self):
        return self

    async def __anext__(self):
        await self.drop.wait()
        raise StopAsyncIteration


def _drive_main_socket(monkeypatch, adapter):
    import websockets as _ws_mod
    opened, drop = asyncio.Event(), asyncio.Event()
    monkeypatch.setattr(_ws_mod, "connect", lambda *a, **kw: _MainSocket(opened, drop))

    async def nothing(*_a):
        return {}

    async def park(*_a):
        await asyncio.Event().wait()
    monkeypatch.setattr(adapter, "_authenticate_websocket", nothing)
    monkeypatch.setattr(adapter, "_subscribe_websocket", nothing)
    monkeypatch.setattr(adapter, "_ws_discovery_loop", park)
    return opened, drop, asyncio.create_task(adapter._websocket_loop())


@pytest.mark.asyncio
async def test_control_websocket_loss_leaves_voice_before_reconnect(monkeypatch, fakes):
    """A 44101 sent while the main socket is down would be missed: the real loop's teardown leaves voice."""
    _, synthesized = fakes
    adapter, ws = _make_adapter(), _FakeAudioWS()
    await _joined(monkeypatch, adapter, ws)
    opened, drop, loop = _drive_main_socket(monkeypatch, adapter)
    await opened.wait()
    drop.set()
    await _until(lambda: ROOM not in adapter._huddle_tasks, "voice left on transport loss")
    assert ws.control()[-1] == "leave" and ws.closed and not loop.done()  # the loop itself goes on to reconnect
    calls = _cli(adapter, [])
    await adapter.send(ROOM, "late answer")
    assert synthesized == [] and not any(c[:2] == ["messages", "send"] for c in calls)
    loop.cancel()
    await asyncio.gather(loop, return_exceptions=True)


@pytest.mark.asyncio
async def test_control_websocket_loss_with_voice_off_is_unaffected(monkeypatch):
    adapter = _make_adapter({"huddle_voice": "false"})
    opened, drop, loop = _drive_main_socket(monkeypatch, adapter)
    await opened.wait()
    drop.set()
    await _until(lambda: adapter._presence_transport_healthy() is False, "transport marked down")
    assert not loop.done() and adapter._huddle_tasks == {}
    loop.cancel()
    await asyncio.gather(loop, return_exceptions=True)
