"""``profiles.list`` reports an ``avatar_rev`` that moves whenever the stored avatar is replaced.

A desktop caches avatar images locally. Without a revision it cannot tell that another machine
replaced the avatar through ``profiles.set_asset``, so the first copy it cached is shown forever.
"""
from __future__ import annotations

import base64
from pathlib import Path

import pytest

import tui_gateway.server as srv
from tui_gateway import profile_roster_cache as cache

PNG = b"\x89PNG\r\n\x1a\n"


@pytest.fixture(autouse=True)
def _clear_memo():
    cache.invalidate()
    yield
    cache.invalidate()


@pytest.fixture
def home(tmp_path, monkeypatch) -> Path:
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    (tmp_path / "config.yaml").write_text("model:\n  provider: openai\n", encoding="utf-8")
    bob = tmp_path / "profiles" / "bob"
    bob.mkdir(parents=True)
    (bob / "config.yaml").write_text("model:\n  provider: openai\n", encoding="utf-8")
    return tmp_path


def _row():
    envelope = srv._methods["profiles.list"](1, {"include_sessions": False})
    return next(p for p in envelope["result"]["profiles"] if p["name"] == "bob")


def _set_avatar(payload: bytes):
    envelope = srv._methods["profiles.set_asset"](2, {
        "name": "bob", "asset": "avatar", "data": base64.b64encode(payload).decode("ascii")})
    assert envelope["result"]["ok"] is True


def test_no_avatar_has_an_empty_rev(home):
    row = _row()
    assert row["has_avatar"] is False
    assert row["avatar_rev"] == ""


def test_replacing_the_avatar_moves_the_rev(home):
    _set_avatar(PNG + b"first")
    first = _row()
    assert first["has_avatar"] is True
    assert first["avatar_rev"]

    assert _row()["avatar_rev"] == first["avatar_rev"]

    _set_avatar(PNG + b"second, longer")
    assert _row()["avatar_rev"] != first["avatar_rev"]
