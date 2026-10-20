"""Regression tests: shared Codex catalog under a named profile must match the global root.

The picker-discovery auth fallback (:func:`hermes_cli.model_switch_providers._auth_store_has_provider`
/ :func:`_raw_pool_usable`) made ``authenticated: true`` work for shared accounts. Pre-fix the
*catalog* still collapsed to the curated fallback under any profile whose ``provider_models_cache.json``
was cold — even when the global root had a fresh entry for the same ChatGPT principal. The picker
then showed 15 ``DEFAULT_CODEX_MODELS`` slugs, missing every account-only model the root listed.

These tests pin the catalog behavior using two temp homes (root + profile) per test, with real
``auth.json`` + ``provider_models_cache.json`` files written by the fixture. No copied credentials,
no symlinks, no hardcoded model lists. The picker behavioral assertion exercises
:func:`hermes_cli.inventory.build_model_options_payload` end-to-end (the public path the dashboard
/ TUI / api-server all consume) with ``explicit_only=True`` so only explicitly-configured rows
survive.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest


def _auth_store(*, pool: dict | None = None, providers: dict | None = None) -> dict:
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
    * HOME -> elsewhere                          (so the pytest seat belt on _load_global_auth_store
                                                 does not collapse the global read into the profile
                                                 root; the real auth.json must stay reachable)
    * Global root -> tmp_path/.hermes                       (root auth.json + cache live here)
    * Profile     -> tmp_path/.hermes/profiles/catalog_test  (HERMES_HOME points here)

    Also clears the auth-store memo and hermes-home memo so earlier tests in this module cannot
    leak a wrong-path store into this fixture, and yields a cleanup that drops any leftover
    ``provider_models_cache.json`` an earlier SWR refresh thread wrote to the profile dir.
    """
    other_home = tmp_path.parent / "real_home"
    other_home.mkdir(exist_ok=True)
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    monkeypatch.setenv("HOME", str(other_home))
    global_root = tmp_path / ".hermes"
    global_root.mkdir()
    profile_dir = global_root / "profiles" / "catalog_test"
    profile_dir.mkdir(parents=True)
    monkeypatch.setenv("HERMES_HOME", str(profile_dir))
    # Pickers/auth-store loaders memo by (path, mtime); clear between tests so each fixture starts
    # cold.
    try:
        import hermes_cli.auth as auth_mod
        monkeypatch.setattr(auth_mod, "_global_auth_store_cache", None, raising=False)
        monkeypatch.setattr(auth_mod, "_auth_store_cache", None, raising=False)
    except Exception:
        pass
    try:
        import hermes_constants
        monkeypatch.setattr(hermes_constants, "_default_hermes_root_memo", None, raising=False)
    except Exception:
        pass
    yield {"global": global_root, "profile": profile_dir}
    # Drop a stale cache the prior test's SWR refresh thread may have written into this profile.
    leftover = profile_dir / "provider_models_cache.json"
    if leftover.exists():
        try:
            leftover.unlink()
        except OSError:
            pass


def _ensure_clean_profile_cache(profile_dir: Path) -> None:
    """Delete any stale ``provider_models_cache.json`` left by a prior SWR refresh.

    Tests that exercise ``cached_provider_model_ids(non_blocking=True)`` schedule an SWR refresh
    in a daemon thread. The thread writes into the profile cache using the (no-credential) curated
    fallback as its discovery answer; the next test's picker would then read the stale curated
    row instead of the inherited root row this fix is supposed to surface. The teardown drop
    above fires AFTER the next test has already run, so we also clear BEFORE every test starts.
    """
    leftover = profile_dir / "provider_models_cache.json"
    if leftover.exists():
        try:
            leftover.unlink()
        except OSError:
            pass


# ---------------------------------------------------------------------------
# _inherited_global_cache_entry — read-only same-fp root fallback
# ---------------------------------------------------------------------------


def test_inherited_global_cache_returns_root_entry_when_profile_cache_cold(profile_env, monkeypatch):
    """A profile whose cache is empty but whose credential is borrowed from the root gets the root's
    same-fingerprint cache entry. Codex's fingerprint is the ChatGPT principal, so the same shared
    login produces the same hash and the inherited entry passes the validation check.
    """
    from hermes_cli import models as msp
    from hermes_cli.codex_models import codex_catalog_credential_identity
    from hermes_cli.models import (
        _credential_fingerprint,
        _inherited_global_cache_entry,
        _cache_entry,
    )

    # Anchor the test: fix the principal identity so the fingerprint matches the row we write.
    fake_id = "test-account/test-sub"
    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity", lambda: fake_id
    )
    fp = _credential_fingerprint("openai-codex")

    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root-token"}},
    }))
    _write(profile_env["profile"] / "auth.json", _auth_store(providers={}, pool={}))
    # Root cache holds a fresh same-fp row (write the file directly so we don't go through the
    # current-profile cache writer).
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, [
            "gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]),
    })

    entry = _inherited_global_cache_entry("openai-codex", fp)
    assert entry is not None
    assert "gpt-6.1-sol" in entry["models"]
    assert "gpt-6-astra" in entry["models"]


def test_inherited_global_cache_returns_none_when_profile_has_own_pool(profile_env, monkeypatch):
    """A profile that owns its own credential pool entry must NEVER borrow the root's — the
    credentials fingerprint differently and would resolve to a different catalog.
    """
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint, _inherited_global_cache_entry,
    )

    fake_id = "shared-account/test-sub"
    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity", lambda: fake_id
    )
    fp = _credential_fingerprint("openai-codex")

    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root-token"}},
    }))
    # Profile has its own pool row for openai-codex — even if empty creds, the row keeps the
    # profile's own credential precedence. The "providers" entry is the safer gate (always set),
    # but the pool row must also short-circuit the inherited read.
    _write(profile_env["profile"] / "auth.json", _auth_store(providers={}, pool={
        "openai-codex": [{"id": "profile-1", "auth_type": "oauth", "priority": 0,
                          "source": "manual:device_code", "access_token": "p-tok", "refresh_token": "r"}],
    }))
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, ["gpt-6.1-sol"])})

    assert _inherited_global_cache_entry("openai-codex", fp) is None


def test_inherited_global_cache_returns_none_when_fingerprint_mismatches(profile_env, monkeypatch):
    """Different principal -> different fingerprint -> the root entry is NOT the same catalog;
    rejecting it is the whole point of the same-fp check.
    """
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint, _inherited_global_cache_entry,
    )

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity",
        lambda: "principal-A/sub-A",
    )
    fp_a = _credential_fingerprint("openai-codex")
    # Root has an entry under principal A; profile resolves to principal B (different fingerprint).
    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root-token"}},
    }))
    _write(profile_env["profile"] / "auth.json", _auth_store(providers={}, pool={}))
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp_a, ["gpt-6.1-sol"])})

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity",
        lambda: "principal-B/sub-B",
    )
    fp_b = _credential_fingerprint("openai-codex")
    assert fp_a != fp_b
    assert _inherited_global_cache_entry("openai-codex", fp_b) is None


def test_inherited_global_cache_returns_none_when_neither_root_has_provider(profile_env, monkeypatch):
    """No auth.json entry in either store -> no credential -> no inherited catalog.
    Prevents the fallback from leaking a stale catalog into an unconfigured profile.
    """
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint, _inherited_global_cache_entry,
    )

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity", lambda: "shared-account/test-sub"
    )
    fp = _credential_fingerprint("openai-codex")

    _write(profile_env["global"] / "auth.json", _auth_store())
    _write(profile_env["profile"] / "auth.json", _auth_store())
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, ["gpt-6.1-sol"])})

    assert _inherited_global_cache_entry("openai-codex", fp) is None


def test_inherited_global_cache_returns_none_when_classic_mode(profile_env, monkeypatch):
    """When HERMES_HOME is the platform-default root, profile==root and the inherited read is a no-op.
    """
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint, _inherited_global_cache_entry,
    )

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity", lambda: "shared-account/test-sub"
    )
    fp = _credential_fingerprint("openai-codex")

    monkeypatch.setenv("HERMES_HOME", str(profile_env["global"]))
    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "self"}},
    }))
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, ["gpt-6.1-sol"])})

    assert _inherited_global_cache_entry("openai-codex", fp) is None


# ---------------------------------------------------------------------------
# cached_provider_model_ids — cold-cache read picks up inherited root catalog
# ---------------------------------------------------------------------------


def test_cached_provider_model_ids_inherits_root_catalog_in_non_blocking(profile_env, monkeypatch):
    """The non-blocking read path (GUI picker) serves the inherited root catalog when the profile
    cache is cold AND the credential is borrowed from the root. Same principal -> same fingerprint
    -> Astra and account-only models are advertised without a probe.
    """
    _ensure_clean_profile_cache(profile_env["profile"])
    from hermes_cli.codex_models import codex_catalog_credential_identity
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint, cached_provider_model_ids,
    )

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity",
        lambda: "shared-account/test-sub",
    )
    fp = _credential_fingerprint("openai-codex")

    # Root has a fresh cache entry for the same principal.
    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root-token"}},
    }))
    _write(profile_env["profile"] / "auth.json", _auth_store(providers={}, pool={}))
    root_models = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra-900k",
                   "gpt-6-sol", "gpt-6-sol-900k", "gpt-6-luna"]
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, root_models)})

    # Profile has NO cache file at all -> cold-start.
    assert not (profile_env["profile"] / "provider_models_cache.json").exists()

    # Direct call (non-blocking, no force-refresh) -> inherited root catalog.
    served = cached_provider_model_ids("openai-codex", non_blocking=True)
    assert "gpt-6.1-sol" in served
    assert "gpt-6-astra" in served, (
        f"Astra must be advertised from the inherited root entry (same principal); got {served}")
    assert "gpt-6-astra-900k" in served


def test_picker_payload_matches_root_catalog_under_named_profile(profile_env, monkeypatch):
    """End-to-end: ``build_model_options_payload(explicit_only=True)`` under a profile whose
    config.yaml names ``openai-codex`` as the current provider but whose local auth.json AND
    cache are empty — the catalog must come from the global root's same-fingerprint entry,
    matching the root's picker output exactly.

    Pre-fix this returned the 15-slug curated fallback under every profile.
    """
    _ensure_clean_profile_cache(profile_env["profile"])
    # Disable the SWR background refresh: a daemon thread would race the assertion by saving the
    # curated fallback into the profile cache while the picker call is in flight. Also force the
    # local cache to read empty so a stale SWR write from an earlier test cannot shadow the
    # inherited root entry under the same principal fingerprint.
    import hermes_cli.models as msp
    monkeypatch.setattr(msp, "_spawn_swr_refresh", lambda *_a, **_k: None)
    monkeypatch.setattr(msp, "_load_provider_models_cache", lambda: {})
    from hermes_cli.inventory import build_model_options_payload, load_picker_context
    from hermes_cli.models import (
        _cache_entry, _credential_fingerprint,
    )

    monkeypatch.setattr(
        "hermes_cli.codex_models.codex_catalog_credential_identity",
        lambda: "shared-account/test-sub",
    )
    fp = _credential_fingerprint("openai-codex")

    _write(profile_env["global"] / "auth.json", _auth_store(providers={
        "openai-codex": {"tokens": {"access_token": "root-token"}},
    }))
    _write(profile_env["profile"] / "auth.json", _auth_store(providers={}, pool={}))
    account_models = [
        "gpt-6.1-sol", "gpt-6-astra", "gpt-6-astra-900k",
        "gpt-6-sol", "gpt-6-sol-900k", "gpt-6-luna", "gpt-6-luna-900k",
        "gpt-5.6-sol", "gpt-5.6-sol-900k", "gpt-5.6-terra", "gpt-5.6-terra-900k",
        "gpt-5.6-luna", "gpt-5.6-luna-900k"]
    _write(profile_env["global"] / "provider_models_cache.json", {
        "openai-codex": _cache_entry(fp, account_models)})

    (profile_env["profile"] / "config.yaml").write_text(
        "model:\n  default: gpt-6-luna\n  provider: openai-codex\n"
        "  base_url: https://chatgpt.com/backend-api/codex\n",
        encoding="utf-8",
    )

    payload = build_model_options_payload(load_picker_context(), explicit_only=True)
    codex_rows = [r for r in payload["providers"] if r["slug"] == "openai-codex"]
    assert codex_rows, "openai-codex row must be present (provider is current + configured)"
    row = codex_rows[0]
    assert row["authenticated"] is True
    # The full account-only catalog must be present — same as the root, not the 15-slug curated
    # fallback the pre-fix picker emitted.
    served = list(row["models"])
    assert "gpt-6.1-sol" in served, f"missing account-only model: {served}"
    assert "gpt-6-astra" in served, f"missing Astra: {served}"
    assert "gpt-6-astra-900k" in served, f"missing Astra-900k: {served}"
    assert row["total_models"] == len(account_models), (
        f"profile picker must mirror root catalog exactly; got {row['total_models']} vs "
        f"{len(account_models)}")
    assert served == account_models, (
        f"profile picker order/content must match root catalog; got {served} vs {account_models}")