"""Regression tests: model picker must honor shared root ``auth.json`` in named profiles.

The picker's section-2 overlay row builder and the explicit-only filter both call
``_auth_store_has_provider`` / ``_raw_pool_usable`` from :mod:`hermes_cli.model_switch_providers`.
Pre-fix those readers only consulted the *profile's* ``auth.json`` (the local one named by
``HERMES_HOME``) and ignored the global-root fallback. The result was that a provider
authenticated only at the root — e.g. an OAuth login shared by every named profile —
became invisible to the picker under any profile that did not also have a local entry,
and the row collapsed to a ``configured-current`` skeleton with ``authenticated: false``.

``read_credential_pool`` and ``get_provider_auth_state`` already had the per-provider
profile→global shadowing; the picker-discovery readers are aligned with them here.

These tests pin the behavior using two temp homes (root + profile) per test, with
real ``auth.json`` files written by the fixture — no copied credentials, no
symlinks, no hardcoded model lists. The actual picker behavioral assertion exercises
:func:`hermes_cli.inventory.build_model_options_payload` end-to-end (the public
path the dashboard / TUI / api-server all consume) with ``explicit_only=True`` so
only explicitly-configured rows survive.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _make_auth_store(*, pool: dict | None = None, providers: dict | None = None) -> dict:
    store: dict = {"version": 1}
    if pool is not None:
        store["credential_pool"] = pool
    if providers is not None:
        store["providers"] = providers
    return store


def _write(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2))


@pytest.fixture()
def profile_env(tmp_path, monkeypatch):
    """Set up a global root + an active profile mirroring the real named-profile layout.

    * Path.home() -> tmp_path
    * Global root -> tmp_path/.hermes                       (root auth.json lives here)
    * Profile     -> tmp_path/.hermes/profiles/picker_test  (HERMES_HOME points here)
    """
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    global_root = tmp_path / ".hermes"
    global_root.mkdir()
    profile_dir = global_root / "profiles" / "picker_test"
    profile_dir.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_dir))
    return {"global": global_root, "profile": profile_dir}


# ---------------------------------------------------------------------------
# _auth_store_has_provider — must consult the global-root fallback
# ---------------------------------------------------------------------------


def test_auth_store_has_provider_falls_back_to_global_root_when_profile_empty(profile_env):
    """Root-only OAuth provider (no profile copy) must be discoverable from a named profile.

    Pre-fix this returned False and the picker's openai-codex row was never built.
    """
    from hermes_cli.model_switch_providers import _auth_store_has_provider

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={
        "openai-codex": {"auth_mode": "chatgpt", "tokens": {"access_token": "root"}},
    }))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}))

    assert _auth_store_has_provider("openai-codex") is True
    # Case-variant lookup too — provider_registry uses lowercase but be defensive.
    assert _auth_store_has_provider("OpenAI-Codex") is True


def test_auth_store_has_provider_profile_entry_shadows_global_root(profile_env):
    """Profile-local entry wins when both stores declare the same provider (writes never
    cross; the row that exists in the profile IS the active selection for that profile).
    """
    from hermes_cli.model_switch_providers import _auth_store_has_provider

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root"}},
    }))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "profile"}},
    }))

    assert _auth_store_has_provider("openai-codex") is True


def test_auth_store_has_provider_returns_false_when_neither_store_has_it(profile_env):
    """No state in either store -> False, no spurious truthiness from the global layer."""
    from hermes_cli.model_switch_providers import _auth_store_has_provider

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={}))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}))

    assert _auth_store_has_provider("openai-codex") is False
    assert _auth_store_has_provider("openai-codex", "openai") is False
    # Empty key list -> False, not a raise / not "everything is configured".
    assert _auth_store_has_provider() is False


def test_auth_store_has_provider_any_of_keys_matches_root_only_entry(profile_env):
    """The picker passes ``(pid, hermes_slug)`` for overlays; either key matching is enough."""
    from hermes_cli.model_switch_providers import _auth_store_has_provider

    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root"}},
    }))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}))

    # "openai-codex" is the hermes slug; "github-copilot" is the models.dev id we never used.
    assert _auth_store_has_provider("github-copilot", "openai-codex") is True
    assert _auth_store_has_provider("anthropic", "nous") is False


# ---------------------------------------------------------------------------
# _raw_pool_usable — sibling reader, same profile→global shadowing
# ---------------------------------------------------------------------------


def test_raw_pool_usable_falls_back_to_global_root_when_profile_pool_empty(profile_env):
    """Section-1 only consults the pool when auth.json lists a raw entry; with the fallback,
    a root-only pool row now counts. ``_credential_pool_is_usable`` is the loadability gate
    (exhausted pools are still 'raw_pool_present' per its contract) so a row is enough.
    """
    from hermes_cli.model_switch_providers import _raw_pool_usable

    _write(profile_env["global"] / "auth.json", _make_auth_store(pool={
        "openai-codex": [{
            "id": "root-1", "auth_type": "oauth", "priority": 0,
            "source": "manual:device_code", "access_token": "x", "refresh_token": "y",
        }],
    }))
    _write(profile_env["profile"] / "auth.json", _make_auth_store(pool={"openai-codex": []}))

    assert _raw_pool_usable("openai-codex") is True
    # Unknown provider -> False, with no crash on the missing global.
    assert _raw_pool_usable("definitely-not-a-real-provider") is False


# ---------------------------------------------------------------------------
# Behavioral: actual picker payload under a named profile honors the root login
# ---------------------------------------------------------------------------


def test_picker_explicit_only_recognizes_root_oauth_under_named_profile(profile_env, monkeypatch):
    """End-to-end: ``build_model_options_payload(explicit_only=True)`` under a profile whose
    config.yaml names ``openai-codex`` as the current provider but whose local auth.json is
    empty — the row must come back authenticated (root fallback), not as a re-auth skeleton.

    Mirrors the live failure: a ``device_code`` OAuth login at the global root, shared by
    every named profile, must surface under any profile. The auth-store check is only ONE
    input to :func:`_overlay_has_creds`; when the credential pool's ``has_available`` returns
    True (or ``for_picker`` re-grants the row) the bug is masked. We force the pool-check
    off here so the auth-store fallback is the only path that can grant the row — exactly
    the shape of the live ``ayan`` failure (model cooldowns empty ``has_available``).

    Without the fix the row is emitted with ``source == "configured-current"`` and
    ``authenticated: false``; with it, the row is the full section-2 ``hermes`` overlay
    row backed by the root login.
    """
    from hermes_cli.inventory import build_model_options_payload, load_picker_context
    import hermes_cli.model_switch_providers as msp

    # Force the pool-based readers to deny openai-codex for this test. The pool may
    # auto-seed from a real singleton on the dev machine, which would mask the bug
    # (has_credentials() stays True). Mirrors the live failure where model cooldowns
    # empty has_available(); only the auth-store check can grant the row.
    monkeypatch.setattr(msp, "_credential_pool_is_usable", lambda *_a, **_k: False)
    monkeypatch.setattr(
        msp, "_pool_usable", lambda *_a, **_k: False, raising=False
    )

    # Root: the OAuth provider is in the root providers section (the input ``_auth_store_has_provider``
    # reads); no credential_pool row.
    _write(profile_env["global"] / "auth.json", _make_auth_store(providers={
        "openai-codex": {"auth_mode": "chatgpt", "tokens": {"access_token": "root"}},
    }))
    # Profile: empty — every provider in this profile is a borrowed/root login.
    _write(profile_env["profile"] / "auth.json", _make_auth_store(providers={}, pool={}))

    # Profile config must name the provider as current; the test would also be valid with
    # a different current provider, but the failure mode is the most visible when the
    # picker's *current* selection is the shared root-only OAuth login.
    (profile_env["profile"] / "config.yaml").write_text(
        "model:\n  default: gpt-6-luna\n  provider: openai-codex\n"
        "  base_url: https://chatgpt.com/backend-api/codex\n",
        encoding="utf-8",
    )

    payload = build_model_options_payload(load_picker_context(), explicit_only=True)
    codex_rows = [r for r in payload["providers"] if r["slug"] == "openai-codex"]

    assert codex_rows, "openai-codex row must be present (provider is current + configured)"
    row = codex_rows[0]
    # Pre-fix: source was "configured-current" / authenticated was False / 1 saved model.
    # Post-fix: source is the section-2 "hermes" overlay row backed by the root login.
    assert row["source"] != "configured-current", (
        f"openai-codex row should not collapse to a configured-current skeleton; got {row}")
    assert row["authenticated"] is True, (
        f"openai-codex row must reflect root OAuth as authenticated; got {row['authenticated']}")
    # And the row should also carry the model catalog (not just the saved model from
    # the re-auth skeleton, which was a single-entry rows.gpt-6-luna placeholder).
    assert row["total_models"] > 1, (
        f"root OAuth login should yield the full model catalog, not the 1-model skeleton; got "
        f"total_models={row.get('total_models')}")


# ---------------------------------------------------------------------------
# Classic mode (profile == root) — no regression
# ---------------------------------------------------------------------------


def test_auth_store_has_provider_classic_mode_still_works(tmp_path, monkeypatch):
    """When HERMES_HOME is the platform-default root, profile==root and the global fallback
    is None. The reader must keep working without raising.
    """
    from hermes_cli.model_switch_providers import _auth_store_has_provider

    # HERMES_HOME is the same as the platform default; auth._global_auth_file_path() returns None.
    monkeypatch.setenv("HERMES_HOME", str(tmp_path))
    _write(tmp_path / "auth.json", _make_auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "self"}},
    }))

    assert _auth_store_has_provider("openai-codex") is True
    assert _auth_store_has_provider("unknown") is False
