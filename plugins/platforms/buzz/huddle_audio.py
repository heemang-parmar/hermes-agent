"""Buzz huddle audio plumbing: v2 wire framing, libopus (ctypes), PCM <-> file conversion, utterance cuts.

Wire format (swarm ``crates/buzz-relay/src/audio/wire.rs``, ``mobile/HUDDLES.md``): every client frame is
an 8-byte big-endian header ``seq u16 | ts_48k u32 | level_dbov i8 | flags u8`` (flags bit 0 = DTX) and
one Opus packet; the relay prefixes ``peer_index u8`` on fan-out (protocol v1/v2). Audio is 48 kHz mono,
20 ms (960-sample) frames, which is what desktop and mobile both speak (protocol_version 2).

Opus goes through the system libopus via ctypes (no Python binding is installed); file conversion
goes through ffmpeg. Both are located from the ffmpeg already resolved for STT, so nothing is
installed or vendored here.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import struct
import subprocess
import wave
from pathlib import Path
from typing import Optional

PROTOCOL_VERSION = 2
SAMPLE_RATE = 48_000
FRAME_SAMPLES = 960  # 20 ms
FRAME_SECONDS = FRAME_SAMPLES / SAMPLE_RATE
FRAME_BYTES = FRAME_SAMPLES * 2  # s16le mono
MAX_FRAME_BYTES = 4096  # relay drops anything larger (handler.rs MAX_AUDIO_FRAME)
FLAG_DTX = 0x01
_HEADER = struct.Struct(">HIbB")
_OPUS_APPLICATION_VOIP = 2048
_MAX_DECODE_SAMPLES = 5760  # 120 ms, the longest Opus frame


def pack_frame(seq: int, ts: int, opus: bytes, *, level_dbov: int = -20, dtx: bool = False) -> bytes:
    """Client -> relay frame (no peer prefix)."""
    level = max(-127, min(0, int(level_dbov)))
    return _HEADER.pack(seq & 0xFFFF, ts & 0xFFFFFFFF, level, FLAG_DTX if dtx else 0) + opus


def parse_relay_frame(data: bytes) -> Optional[tuple[int, int, bool, bytes]]:
    """Relay -> client frame as ``(peer_index, level_dbov, dtx, opus)``; None when malformed."""
    if len(data) < 1 + _HEADER.size or len(data) > 1 + MAX_FRAME_BYTES:
        return None
    _seq, _ts, level, flags = _HEADER.unpack_from(data, 1)
    return data[0], level, bool(flags & FLAG_DTX), bytes(data[1 + _HEADER.size:])


def frame_level_dbov(pcm: bytes) -> int:
    """Peak level of one s16le frame in dBov (-127 for digital silence)."""
    import math
    count = len(pcm) // 2
    if not count:
        return -127
    peak = max(abs(v) for v in struct.unpack(f"<{count}h", pcm[: count * 2]))
    return -127 if peak == 0 else max(-127, int(20 * math.log10(peak / 32768)))


def find_ffmpeg() -> Optional[str]:
    from tools.transcription_audio import _find_ffmpeg_binary
    return _find_ffmpeg_binary()


def find_libopus() -> Optional[str]:
    """System libopus: the loader's search path, else the lib dir of the prefix ffmpeg is installed under."""
    found = ctypes.util.find_library("opus")
    if found:
        return found
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        return None
    lib_dir = Path(ffmpeg).parent.parent / "lib"
    for name in ("libopus.dylib", "libopus.so.0", "libopus.so"):
        if (lib_dir / name).is_file():
            return str(lib_dir / name)
    return None


class OpusUnavailable(RuntimeError):
    pass


class _Lib:
    _cdll: Optional[ctypes.CDLL] = None

    @classmethod
    def get(cls) -> ctypes.CDLL:
        if cls._cdll is None:
            path = find_libopus()
            if not path:
                raise OpusUnavailable("libopus not found (needs the system Opus library next to ffmpeg)")
            lib = ctypes.CDLL(path)
            lib.opus_encoder_create.restype = ctypes.c_void_p
            lib.opus_encoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
            lib.opus_encode.restype = ctypes.c_int32
            lib.opus_encode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_int32]
            lib.opus_encoder_destroy.argtypes = [ctypes.c_void_p]
            lib.opus_decoder_create.restype = ctypes.c_void_p
            lib.opus_decoder_create.argtypes = [ctypes.c_int32, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
            lib.opus_decode.restype = ctypes.c_int
            lib.opus_decode.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int32, ctypes.c_char_p, ctypes.c_int, ctypes.c_int]
            lib.opus_decoder_destroy.argtypes = [ctypes.c_void_p]
            cls._cdll = lib
        return cls._cdll


class OpusEncoder:
    """48 kHz mono VOIP encoder at libopus' default bitrate.

    ``opus_encoder_ctl`` is variadic, and ctypes cannot pass variadic arguments correctly on Apple
    arm64 (they belong on the stack): calling it there corrupts the encoder into 1-byte packets.
    The default VOIP bitrate is close to the desktop's 32 kbps, so no ctl is issued.
    """

    def __init__(self):
        self._lib = _Lib.get()
        err = ctypes.c_int()
        self._state = self._lib.opus_encoder_create(SAMPLE_RATE, 1, _OPUS_APPLICATION_VOIP, ctypes.byref(err))
        if err.value != 0 or not self._state:
            raise OpusUnavailable(f"opus_encoder_create failed ({err.value})")

    def encode(self, pcm: bytes) -> bytes:
        if len(pcm) != FRAME_BYTES:
            pcm = pcm[:FRAME_BYTES].ljust(FRAME_BYTES, b"\0")
        out = ctypes.create_string_buffer(MAX_FRAME_BYTES - _HEADER.size)
        size = self._lib.opus_encode(self._state, pcm, FRAME_SAMPLES, out, len(out))
        if size < 0:
            raise RuntimeError(f"opus_encode failed ({size})")
        return out.raw[:size]

    def close(self) -> None:
        if self._state:
            self._lib.opus_encoder_destroy(self._state)
            self._state = None


class OpusDecoder:
    def __init__(self):
        self._lib = _Lib.get()
        err = ctypes.c_int()
        self._state = self._lib.opus_decoder_create(SAMPLE_RATE, 1, ctypes.byref(err))
        if err.value != 0 or not self._state:
            raise OpusUnavailable(f"opus_decoder_create failed ({err.value})")

    def decode(self, packet: bytes) -> bytes:
        out = ctypes.create_string_buffer(_MAX_DECODE_SAMPLES * 2)
        samples = self._lib.opus_decode(self._state, packet, len(packet), out, _MAX_DECODE_SAMPLES, 0)
        if samples < 0:
            raise RuntimeError(f"opus_decode failed ({samples})")
        return out.raw[: samples * 2]

    def close(self) -> None:
        if self._state:
            self._lib.opus_decoder_destroy(self._state)
            self._state = None


def write_wav(path: Path, pcm: bytes) -> None:
    with wave.open(str(path), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(SAMPLE_RATE)
        out.writeframes(pcm)


def file_to_pcm(path: str, *, timeout: float = 60.0) -> bytes:
    """Decode any ffmpeg-readable audio file to 48 kHz mono s16le."""
    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise RuntimeError("ffmpeg not found")
    proc = subprocess.run(
        [ffmpeg, "-nostdin", "-hide_banner", "-loglevel", "error", "-i", path,
         "-f", "s16le", "-ac", "1", "-ar", str(SAMPLE_RATE), "pipe:1"],
        capture_output=True, timeout=timeout, check=False)
    if proc.returncode != 0:
        raise RuntimeError(f"ffmpeg decode failed: {proc.stderr.decode('utf-8', 'replace')[:300]}")
    return proc.stdout


def pcm_frames(pcm: bytes) -> list[bytes]:
    """Split PCM into 20 ms frames, zero-padding the last."""
    return [pcm[i:i + FRAME_BYTES].ljust(FRAME_BYTES, b"\0") for i in range(0, len(pcm), FRAME_BYTES)]


class UtteranceSegmenter:
    """Cut one speaker's decoded frames into utterances on trailing silence (DTX or quiet frames).

    ``push`` returns a finished utterance's PCM, ``flush`` ends one on a frame gap (DTX stops sending
    entirely). Too-short bursts (coughs, clicks) are discarded; long monologues are cut at ``max_seconds``.
    """

    def __init__(self, *, silence_dbov: int = -45, end_silence_s: float = 0.8,
                 min_voiced_s: float = 0.3, max_seconds: float = 30.0):
        self.silence_dbov = silence_dbov
        self._end_frames = round(end_silence_s / FRAME_SECONDS)
        self._min_voiced = round(min_voiced_s / FRAME_SECONDS)
        self._max_frames = round(max_seconds / FRAME_SECONDS)
        self._frames: list[bytes] = []
        self._voiced = 0
        self._trailing = 0

    def push(self, pcm: bytes, level_dbov: int, dtx: bool) -> Optional[bytes]:
        voiced = not dtx and level_dbov > self.silence_dbov
        if not self._frames and not voiced:
            return None
        self._frames.append(pcm)
        if voiced:
            self._voiced += 1
            self._trailing = 0
        else:
            self._trailing += 1
        if self._trailing >= self._end_frames or len(self._frames) >= self._max_frames:
            return self.flush()
        return None

    def flush(self) -> Optional[bytes]:
        frames, voiced = self._frames, self._voiced
        self._frames, self._voiced, self._trailing = [], 0, 0
        return b"".join(frames) if voiced >= self._min_voiced else None

    def reset(self) -> None:
        self._frames, self._voiced, self._trailing = [], 0, 0
