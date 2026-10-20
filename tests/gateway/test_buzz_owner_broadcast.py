"""Buzz channel addressing under require_mention: owner-only "@all" plus direct tags.

Buzz publishes a typed "@all" as plain kind-9 text with no p-tags, while a picked
"@Name · Designation" mention carries the recipient's p-tag. Only identities listed in
``extra.broadcast_users`` may address every agent with "@all"; anyone else's "@all"
(including another agent's, which would fan out across the fleet) stays ignored.
"""

from unittest.mock import AsyncMock

import pytest

from tests.gateway._plugin_adapter_loader import load_plugin_adapter

_buzz_mod = load_plugin_adapter("buzz")
BuzzAdapter = _buzz_mod.BuzzAdapter
hex_to_npub = _buzz_mod.hex_to_npub

SELF_PUBKEY = "9fd5c7ba6d3ef224da78f541e0fcb9c50f72cc63edb19aae76ac6a0474dfa860"
OWNER_PUBKEY = "e" * 64
PEER_AGENT_PUBKEY = "b" * 64
CHANNEL = "ccc2bc1a-7a82-5a8f-8c4e-57a070cbe7cd"


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch, tmp_path):
    for var in ("BUZZ_RELAY_URL", "BUZZ_PRIVATE_KEY", "BUZZ_CHANNELS", "BUZZ_ALLOWED_USERS",
                "BUZZ_REQUIRE_MENTION", "BUZZ_ALLOW_ALL_USERS", "BUZZ_REACTION_ONLY_USERS"):
        monkeypatch.delenv(var, raising=False)
    monkeypatch.setattr(_buzz_mod, "_DEFAULT_CREDENTIALS_DIR", tmp_path / "no-creds")


def _adapter(broadcast_users):
    from gateway.config import PlatformConfig

    extra = {"relay_url": "https://test.relay", "require_mention": True,
             "allowed_users": [OWNER_PUBKEY, PEER_AGENT_PUBKEY], "broadcast_users": broadcast_users}
    a = BuzzAdapter(PlatformConfig(enabled=True, extra=extra))
    a._self_pubkey, a._self_npub, a._display_name = SELF_PUBKEY, hex_to_npub(SELF_PUBKEY), "Chip · Coordinator"
    a._private_key = "nsec1test"
    a.set_authorization_check(lambda *_args: True)
    a._dispatched = []

    async def capture(**kwargs):
        a._dispatched.append(kwargs)

    a._dispatch_message = capture
    a._message_handler = AsyncMock()
    a._channel_state[CHANNEL] = {"chat_type": "group", "last_ts": 0, "seen": {}}
    return a


async def _deliver(adapter, content, pubkey=OWNER_PUBKEY, p_tags=()):
    event = {"id": f"e{len(adapter._channel_state[CHANNEL]['seen'])}", "pubkey": pubkey, "content": content,
             "created_at": 10, "kind": 9, "tags": [["h", CHANNEL], *(["p", p] for p in p_tags)]}
    await adapter._handle_event(CHANNEL, adapter._channel_state[CHANNEL], event)
    return len(adapter._dispatched)


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["@all hey all", "status? @ALL", "(@all) ship it", "@all, quick sync"])
async def test_owner_at_all_dispatches(content):
    assert await _deliver(_adapter([OWNER_PUBKEY]), content) == 1


@pytest.mark.asyncio
async def test_owner_listed_as_npub_dispatches():
    assert await _deliver(_adapter([hex_to_npub(OWNER_PUBKEY)]), "@all hey all") == 1


@pytest.mark.asyncio
async def test_unlisted_sender_at_all_is_ignored():
    # A peer agent is allowlisted to talk to us but must not trigger the whole fleet.
    assert await _deliver(_adapter([OWNER_PUBKEY]), "@all please reply", pubkey=PEER_AGENT_PUBKEY) == 0


@pytest.mark.asyncio
async def test_at_all_ignored_when_broadcast_unconfigured():
    assert await _deliver(_adapter([]), "@all hey all") == 0


@pytest.mark.asyncio
async def test_own_at_all_never_dispatches():
    assert await _deliver(_adapter([SELF_PUBKEY, OWNER_PUBKEY]), "@all hello team", pubkey=SELF_PUBKEY) == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("content", ["ask @allison", "mail x@all.example", "@@all", "@all-hands tomorrow", "all hands"])
async def test_at_all_token_boundaries(content):
    assert await _deliver(_adapter([OWNER_PUBKEY]), content) == 0


@pytest.mark.asyncio
async def test_unmentioned_owner_message_is_ignored():
    assert await _deliver(_adapter([OWNER_PUBKEY]), "just chatting in channel") == 0


@pytest.mark.asyncio
async def test_direct_p_tag_dispatches_with_designation_display_name():
    adapter = _adapter([OWNER_PUBKEY])
    assert await _deliver(adapter, "hey @Chip · Coordinator", p_tags=[SELF_PUBKEY]) == 1
    # A tag for someone else, even from the owner, is not addressed to us.
    assert await _deliver(adapter, "hey @Other · Lead", p_tags=[PEER_AGENT_PUBKEY]) == 1
