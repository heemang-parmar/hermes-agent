"""send_message declarations for the Buzz ``PlatformEntry`` (kept out of the adapter module)."""

import re

# Buzz UUIDs are native targets the adapter accepts verbatim — explicit, never home-channel.
_SEND_UUID_RE = re.compile(r"^\s*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\s*$", re.IGNORECASE)

try:
    from gateway.platforms.send_targets import regex_stripped_parser
except ImportError:
    # A core that predates send_targets has no ``PlatformEntry.target_ref_syntax_fn`` either: register
    # without it so the adapter loads as a user-dir override there (send_message keeps that core's routing).
    SEND_ENTRY_KWARGS = {}
else:
    SEND_ENTRY_KWARGS = {"target_ref_syntax_fn": regex_stripped_parser(_SEND_UUID_RE)}
