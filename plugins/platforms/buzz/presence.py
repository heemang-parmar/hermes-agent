"""Buzz own-presence heartbeat (kind 20001) for ``BuzzAdapter``.

Published through ``buzz users set-presence --status online|offline`` (the CLI signs the ephemeral
event; nothing here hand-rolls Nostr signing). The relay stores it as
``SET buzz:presence:{pubkey} {status} EX 180``: the 180s TTL is 3x the 60s heartbeat, so one missed
beat never flaps presence. An unclean exit (crash, SIGKILL) is therefore left to expire on the relay
within 180s; do not work around that with a longer local timer, and never stretch the interval past
TTL/3.

Status is purely a function of inbound-transport health, which the host adapter owns and answers
through ``_presence_transport_healthy()``: ``online`` while the receive path is proven live, cleared
with ``offline`` the moment it is lost, ``offline`` on disconnect. Silence is not unavailability, so
there is no activity/idle heuristic. The CLI publishes over HTTP and keeps succeeding while the inbound
socket is dead, which is exactly why a successful publish alone proves nothing.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
from typing import Any, Optional

from gateway.platforms.helpers import cancel_task

logger = logging.getLogger(__name__)

PRESENCE_TTL = 180.0
DEFAULT_PRESENCE_INTERVAL = 60.0
MIN_PRESENCE_INTERVAL = 15.0
MAX_PRESENCE_INTERVAL = PRESENCE_TTL / 3
# Repeated failures stretch the retry delay up to this multiple of the interval (log/CLI spam bound).
MAX_BACKOFF_FACTOR = 4
# An "offline" publish (health loss or disconnect) waits at most this long.
OFFLINE_TIMEOUT = 5.0
HEARTBEAT_TIMEOUT = 20.0


def resolve_interval(raw: Any, extra: dict) -> float:
    """Heartbeat seconds from the scoped setting, then ``extra``; clamped to [15s, TTL/3], garbage -> 60s."""
    try:
        value = float(raw if raw is not None else extra.get("presence_interval", DEFAULT_PRESENCE_INTERVAL))
    except (TypeError, ValueError):
        value = DEFAULT_PRESENCE_INTERVAL
    if value != value:  # NaN
        value = DEFAULT_PRESENCE_INTERVAL
    return min(MAX_PRESENCE_INTERVAL, max(MIN_PRESENCE_INTERVAL, value))


def _is_enabled(raw: Any) -> bool:
    return str(raw).strip().lower() in ("true", "1", "yes", "on")


def _failure_detail(stderr: str, code: int) -> str:
    text = (stderr or "").strip()
    return f"{text[:300]} (exit {code})" if text else f"exit {code}"


class BuzzPresenceMixin:
    """Presence heartbeat lifecycle; the host adapter supplies ``_run_cli`` and ``_presence_transport_healthy``."""

    def _init_presence(self, enabled_raw: Any, interval_raw: Any, extra: dict) -> None:
        self.presence_enabled = _is_enabled(enabled_raw)
        self.presence_interval = resolve_interval(interval_raw, extra)
        self._presence_task: Optional[asyncio.Task] = None
        self._presence_status: Optional[str] = None  # last status the relay accepted
        self._presence_wake = asyncio.Event()
        self._last_presence_error = ""

    def _presence_transport_healthy(self) -> bool:
        """Overridden by the adapter; fail closed: never claim a receive path nobody vouched for."""
        return False

    def _presence_poke(self) -> None:
        """Health changed: tick now instead of at the next interval (the adapter calls this on transitions)."""
        self._presence_wake.set()

    async def _publish_presence(self, status: str, *, timeout: float = HEARTBEAT_TIMEOUT) -> bool:
        """One ``set-presence`` call; never raises (cancellation excepted)."""
        try:
            code, _out, err = await self._run_cli(["users", "set-presence", "--status", status], timeout=timeout)
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a failed heartbeat is reported via status, never raised into the loop
            logger.debug("Buzz: presence publish raised", exc_info=True)
            code, err = -1, f"{type(exc).__name__}: {exc}"
        if code == 0:
            self._presence_status = status
            return True
        self._last_presence_error = _failure_detail(err, code)
        return False

    async def _publish_offline(self) -> bool:
        """Bounded, best-effort ``offline``; never raises (cancellation excepted)."""
        with contextlib.suppress(Exception):
            return await asyncio.wait_for(self._publish_presence("offline", timeout=OFFLINE_TIMEOUT), OFFLINE_TIMEOUT + 1)
        return False

    async def _presence_sleep(self, delay: float) -> None:
        """Sleep *delay*, or less if a health transition pokes the loop."""
        sleeper = asyncio.ensure_future(asyncio.sleep(delay))
        waker = asyncio.ensure_future(self._presence_wake.wait())
        try:
            done, _ = await asyncio.wait({sleeper, waker}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            sleeper.cancel()
            waker.cancel()
        self._presence_wake.clear()
        if sleeper in done:
            sleeper.result()

    async def _presence_loop(self) -> None:
        """``online`` every interval while the transport is healthy; clear to ``offline`` once when it is not."""
        failures = 0
        while True:
            if self._presence_transport_healthy():
                if await self._publish_presence("online"):
                    if failures:
                        logger.info("Buzz: presence heartbeat recovered after %d failure(s)", failures)
                    failures = 0
                else:
                    failures += 1
                    # First failure warns; the rest stay at debug so a relay outage doesn't flood the log.
                    log = logger.warning if failures == 1 else logger.debug
                    log("Buzz: presence heartbeat failed — %s", self._last_presence_error)
                delay = self.presence_interval * min(2 ** max(failures - 1, 0), MAX_BACKOFF_FACTOR)
            else:
                failures = 0
                if self._presence_status == "online":
                    # Never let the relay say "online" while nothing is being received; retried each tick until it lands.
                    if await self._publish_offline():
                        logger.info("Buzz: inbound transport unhealthy; presence cleared")
                    else:
                        logger.debug("Buzz: could not clear presence — %s", self._last_presence_error)
                delay = self.presence_interval
            await self._presence_sleep(delay)

    async def _start_presence(self) -> None:
        """(Re)start the heartbeat after connect; a reconnect replaces the old task, never duplicates it."""
        await cancel_task(self._presence_task)
        self._presence_task = None
        if not self.presence_enabled:
            return
        self._presence_wake.clear()
        self._presence_task = asyncio.create_task(self._presence_loop())

    async def _stop_presence(self) -> None:
        """Cancel the heartbeat and, if it ran, say ``offline`` once (bounded) instead of waiting out the TTL."""
        task, self._presence_task = self._presence_task, None
        if task is None:
            return
        await cancel_task(task)
        if not await self._publish_offline():
            logger.debug("Buzz: could not publish offline presence — %s", self._last_presence_error)
