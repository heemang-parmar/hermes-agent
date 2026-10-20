"""Buzz registers on a core that predates ``gateway.platforms.send_targets`` (user-dir override of an older
bundled copy): the send-target kwargs fall back to none instead of failing ``register(ctx)``."""

import importlib.util
import sys
from pathlib import Path

import pytest

_SEND_TARGETS = Path(__file__).resolve().parents[4] / "plugins" / "platforms" / "buzz" / "send_targets.py"


def _load(name: str):
    spec = importlib.util.spec_from_file_location(name, _SEND_TARGETS)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_current_core_declares_uuid_target_syntax():
    kwargs = _load("buzz_send_targets_current").SEND_ENTRY_KWARGS
    assert set(kwargs) == {"target_ref_syntax_fn"}


def test_core_without_send_targets_registers_without_target_syntax(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setitem(sys.modules, "gateway.platforms.send_targets", None)  # import raises ImportError
    assert _load("buzz_send_targets_old_core").SEND_ENTRY_KWARGS == {}
