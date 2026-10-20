"""Same-relay Buzz media references: community-private URLs the adapter must authenticate and localise."""

import re
from typing import Optional
from urllib.parse import urlsplit

# Buzz-hosted media is private to the community: same-relay URLs must be authenticated + localised for vision.
_MEDIA_URL_PATTERN = r"https?://[^\s<>\[\]()]+/media/[0-9a-f]{64}(?:\.[a-z0-9]{1,10})?(?:\?[^\s<>\[\]()]*)?"
_MARKDOWN_MEDIA_RE = re.compile(
    rf"!\[(?P<alt>[^\]]*)\]\(\s*(?P<url>{_MEDIA_URL_PATTERN})(?:\s+[\"'][^\"']*[\"'])?\s*\)", re.IGNORECASE
)
_BARE_MEDIA_RE = re.compile(_MEDIA_URL_PATTERN, re.IGNORECASE)
_MEDIA_PATH_RE = re.compile(r"^/media/(?P<sha>[0-9a-f]{64})(?P<ext>\.[a-z0-9]{1,10})?/?$", re.IGNORECASE)


def _effective_port(parsed) -> Optional[int]:
    try:
        if parsed.port is not None:
            return parsed.port
    except ValueError:
        return None
    return {"https": 443, "wss": 443, "http": 80, "ws": 80}.get(parsed.scheme)


def _is_relay_media_url(url: str, relay_url: str) -> bool:
    """Return whether *url* is a Buzz media object on the configured relay."""
    candidate, relay = urlsplit(url), urlsplit(relay_url)
    return bool(
        candidate.scheme in ("http", "https") and candidate.hostname and relay.hostname
        and candidate.hostname.lower() == relay.hostname.lower()
        and _effective_port(candidate) == _effective_port(relay) and _MEDIA_PATH_RE.fullmatch(candidate.path)
    )


def _find_relay_media_refs(text: str, relay_url: str) -> tuple[list[str], list[tuple[int, int, str]]]:
    """Find same-relay media URLs and their safe text replacements."""
    urls: list[str] = []
    replacements: list[tuple[int, int, str]] = []
    markdown_spans: list[tuple[int, int]] = []
    for match in _MARKDOWN_MEDIA_RE.finditer(text):
        url = match.group("url")
        if not _is_relay_media_url(url, relay_url):
            continue
        markdown_spans.append(match.span())
        replacements.append((*match.span(), match.group("alt").strip()))
        if url not in urls:
            urls.append(url)
    for match in _BARE_MEDIA_RE.finditer(text):
        if any(start <= match.start() and match.end() <= end for start, end in markdown_spans):
            continue
        url = match.group(0)
        if not _is_relay_media_url(url, relay_url):
            continue
        replacements.append((*match.span(), ""))
        if url not in urls:
            urls.append(url)
    return urls, replacements


def _replace_media_refs(text: str, replacements: list[tuple[int, int, str]]) -> str:
    for start, end, replacement in sorted(replacements, reverse=True):
        text = f"{text[:start]}{replacement}{text[end:]}"
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"[ \t]+\n", "\n", text)).strip()
