"""Buzz own-presence heartbeat (kind 20001 via ``buzz users set-presence``).

Presence is a function of inbound-transport health only: ``online`` while the receive path is proven
live, cleared with ``offline`` when it is lost, ``offline`` on disconnect, and opt-in per profile.
The CLI publishes over HTTP and keeps succeeding while the inbound socket is dead, so the transport
tests drive the REAL ``_websocket_loop`` / ``_poll_loop`` rather than stubbing the health flag.

No test waits on real time (sleeps are fakes gated by the test) and no test reaches a relay (the CLI
and the WebSocket are faked). Assertions are on the observable effect: which
``users set-presence --status <X>`` calls were made, in what order.
"""

import asyncio
import json
import time

import pytest

from tests.gateway._plugin_adapter_loader import load_plugin_adapter
from tests.gateway.test_buzz_websocket import _ScriptedWebSocket

_buzz_mod = load_plugin_adapter("buzz")
BuzzAdapter = _buzz_mod.BuzzAdapter
presence = _buzz_mod._presence

SELF_PUBKEY = "9fd5c7ba6d3ef224da78f541e0fcb9c50f72cc63edb19aae76ac6a0474dfa860"
CHANNEL = "ccc2bc1a-7a82-5a8f-8c4e-57a070cbe7cd"


@pytest.fixture(autouse=True)
def _no_ambient_buzz_env(monkeypatch):
    import os
    for name in [n for n in os.environ if n.startswith("BUZZ_")]:
        monkeypatch.delenv(name)


class _StopLoop(Exception):
    """Raised by the fake sleep to end ``_presence_loop`` at a known point."""


class _AsyncioWithSleep:
    """The real asyncio module for one plugin module, with ``sleep`` swapped for a test double."""

    def __init__(self, sleep):
        self.sleep = sleep

    def __getattr__(self, name):
        return getattr(asyncio, name)


def _drive_sleep(monkeypatch, *, stop_after, on_sleep=None):
    """Presence fake sleep: records each delay, optionally runs a hook, stops the loop after N sleeps."""
    delays = []

    async def fake_sleep(delay):
        delays.append(delay)
        if on_sleep is not None:
            on_sleep(len(delays))
        if len(delays) >= stop_after:
            raise _StopLoop

    monkeypatch.setattr(presence, "asyncio", _AsyncioWithSleep(fake_sleep))
    return delays


def _block_sleep(monkeypatch):
    """Presence fake sleep that parks until cancelled: the loop then only ticks when health pokes it."""

    async def parked(_delay):
        await asyncio.Event().wait()

    monkeypatch.setattr(presence, "asyncio", _AsyncioWithSleep(parked))


def _gated_sleep(monkeypatch, module):
    """Fake sleep for *module*: each call completes only when the test releases the returned semaphore."""
    gate = asyncio.Semaphore(0)
    delays = []

    async def gated(delay):
        delays.append(delay)
        await gate.acquire()

    monkeypatch.setattr(module, "asyncio", _AsyncioWithSleep(gated))
    return gate, delays


class _Cli:
    """Fake ``_run_cli``: records set-presence statuses; *results* scripts rc / exceptions per publish.

    Every other command (poll fetches, membership discovery) is answered by *other* (rc 0, ``[]`` default).
    """

    def __init__(self, results=None, other=None):
        self.statuses = []
        self.timeouts = []
        self.other_calls = []
        self._results = list(results or [])
        self._other = other or (lambda args: 0)

    async def __call__(self, args, *, input_text=None, timeout=None):
        if args[:2] != ["users", "set-presence"]:
            self.other_calls.append(list(args))
            code = self._other(args)
            return code, "[]" if code == 0 else "", "" if code == 0 else json.dumps({"error": "relay", "message": "down"})
        assert args[2] == "--status", args
        self.statuses.append(args[3])
        self.timeouts.append(timeout)
        result = self._results.pop(0) if self._results else 0
        if isinstance(result, BaseException):
            raise result
        if callable(result):
            result = await result()
        return result, "", "" if result == 0 else json.dumps({"error": "relay", "message": "unreachable"})


def _make_adapter(extra=None, *, enabled=True):
    from gateway.config import PlatformConfig

    base = {"relay_url": "https://test.relay", **({"presence": "true"} if enabled else {})}
    adapter = BuzzAdapter(PlatformConfig(enabled=True, extra={**base, **(extra or {})}))
    adapter._self_pubkey = SELF_PUBKEY
    adapter._private_key = "00" * 31 + "03"
    adapter._display_name = "Chip"
    adapter._write_runtime_status_safe = lambda *a, **kw: None  # health-map writes are not under test
    return adapter


def _healthy(adapter, value=True):
    adapter._presence_transport_healthy = lambda: value


async def _until(predicate, what="condition"):
    for _ in range(2_000):
        if predicate():
            return
        await asyncio.sleep(0)
    raise AssertionError(f"{what} not reached")


async def _settle():
    for _ in range(200):
        await asyncio.sleep(0)


def _live_presence_tasks():
    return [t for t in asyncio.all_tasks() if t.get_coro().__qualname__.endswith("_presence_loop") and not t.done()]


# ── settings: opt-in, interval ────────────────────────────────────────────


def test_presence_is_opt_in_by_default():
    adapter = _make_adapter(enabled=False)
    assert adapter.presence_enabled is False
    assert adapter.presence_interval == presence.DEFAULT_PRESENCE_INTERVAL


@pytest.mark.parametrize("value", ["false", "0", "no", "off", "", "maybe"])
def test_non_truthy_values_keep_presence_off(value):
    assert _make_adapter({"presence": value}, enabled=False).presence_enabled is False


@pytest.mark.parametrize("value", ["true", "TRUE", "1", "yes", "on", True])
def test_explicit_truthy_config_enables(value):
    assert _make_adapter({"presence": value}, enabled=False).presence_enabled is True


def test_explicit_env_enables(monkeypatch):
    monkeypatch.setenv("BUZZ_PRESENCE", "true")
    assert _make_adapter(enabled=False).presence_enabled is True


@pytest.mark.asyncio
async def test_one_profile_opting_in_never_activates_another(monkeypatch):
    """Profiles share this source; only the one that opted in may publish."""
    _block_sleep(monkeypatch)
    ariv = _make_adapter({"presence": "true"}, enabled=False)
    other = _make_adapter({"relay_url": "https://other.relay", "channels": [CHANNEL]}, enabled=False)
    ariv._run_cli, other._run_cli = (ariv_cli := _Cli()), (other_cli := _Cli())
    _healthy(ariv)
    _healthy(other)
    await ariv._start_presence()
    await other._start_presence()
    await _until(lambda: ariv_cli.statuses == ["online"])
    assert other._presence_task is None
    await ariv.disconnect()
    await other.disconnect()
    assert ariv_cli.statuses == ["online", "offline"]
    assert other_cli.statuses == []


@pytest.mark.parametrize(
    "raw, extra, expected",
    [
        ("5", {}, presence.MIN_PRESENCE_INTERVAL),
        ("600", {}, presence.MAX_PRESENCE_INTERVAL),  # never long enough for one miss to outlive the 180s TTL
        ("garbage", {}, presence.DEFAULT_PRESENCE_INTERVAL),
        ("nan", {}, presence.DEFAULT_PRESENCE_INTERVAL),
        (None, {"presence_interval": 30}, 30.0),
        (None, {}, presence.DEFAULT_PRESENCE_INTERVAL),
    ],
)
def test_interval_is_clamped_below_the_relay_ttl(raw, extra, expected):
    assert presence.resolve_interval(raw, extra) == expected
    assert presence.resolve_interval(raw, extra) * 3 <= presence.PRESENCE_TTL


def test_env_interval_overrides_config(monkeypatch):
    monkeypatch.setenv("BUZZ_PRESENCE_INTERVAL", "20")
    assert _make_adapter({"presence_interval": 45}).presence_interval == 20.0


# ── heartbeat loop (health given) ─────────────────────────────────────────


@pytest.mark.asyncio
async def test_healthy_loop_publishes_online_immediately(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    _healthy(adapter)
    delays = _drive_sleep(monkeypatch, stop_after=1)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert cli.statuses == ["online"]
    assert delays == [adapter.presence_interval]


@pytest.mark.asyncio
async def test_healthy_but_silent_stays_online(monkeypatch):
    """Silence is not unavailability: zero inbound traffic for far over 2x the interval never leaves online."""
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    _healthy(adapter)
    delays = _drive_sleep(monkeypatch, stop_after=10)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert sum(delays) >= 9 * adapter.presence_interval  # 9+ minutes of total silence
    assert cli.statuses == ["online"] * 10


@pytest.mark.asyncio
async def test_unhealthy_from_the_start_publishes_nothing(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    _healthy(adapter, False)
    delays = _drive_sleep(monkeypatch, stop_after=5)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert cli.statuses == []
    assert delays == [adapter.presence_interval] * 5  # the normal cadence, not a hot loop


@pytest.mark.asyncio
async def test_health_loss_clears_once_and_recovery_resumes(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    health = iter([True, True, False, False, False, True])
    adapter._presence_transport_healthy = lambda: next(health)
    delays = _drive_sleep(monkeypatch, stop_after=6)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert cli.statuses == ["online", "online", "offline", "online"]
    assert cli.timeouts[2] == presence.OFFLINE_TIMEOUT
    assert delays == [adapter.presence_interval] * 6


@pytest.mark.asyncio
async def test_failed_clear_is_retried_on_the_next_unhealthy_tick(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli(results=[0, 2, 0])
    health = iter([True, False, False, False])
    adapter._presence_transport_healthy = lambda: next(health)
    _drive_sleep(monkeypatch, stop_after=4)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert cli.statuses == ["online", "offline", "offline"]  # retried until the relay accepted it, then quiet


@pytest.mark.asyncio
async def test_failing_cli_never_escapes_the_loop_and_backs_off(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli(results=[2, RuntimeError("spawn failed"), OSError("no binary"), 0])
    _healthy(adapter)
    delays = _drive_sleep(monkeypatch, stop_after=4)
    with pytest.raises(_StopLoop):  # only the test's own stop signal ends the loop
        await adapter._presence_loop()
    assert len(cli.statuses) == 4
    interval = adapter.presence_interval
    assert delays == [interval, 2 * interval, 4 * interval, interval]  # backoff, then reset on success


@pytest.mark.asyncio
async def test_backoff_is_capped(monkeypatch):
    adapter = _make_adapter()
    adapter._run_cli = _Cli(results=[2] * 6)
    _healthy(adapter)
    delays = _drive_sleep(monkeypatch, stop_after=6)
    with pytest.raises(_StopLoop):
        await adapter._presence_loop()
    assert max(delays) == presence.MAX_BACKOFF_FACTOR * adapter.presence_interval


# ── real WebSocket transport: loss clears, reconnect restores ─────────────


@pytest.mark.asyncio
async def test_websocket_loss_clears_presence_and_reconnect_restores_it(monkeypatch):
    """Drives the real ``_websocket_loop``; fails against an adapter that publishes regardless of the socket."""
    import websockets as _ws_mod

    _block_sleep(monkeypatch)  # presence only ticks when transport health pokes it
    reconnect_gate, backoffs = _gated_sleep(monkeypatch, _buzz_mod)  # the loop's backoff waits for the test
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()

    async def no_discovery(_websocket, _subscriptions):
        await asyncio.Event().wait()

    monkeypatch.setattr(adapter, "_ws_discovery_loop", no_discovery)

    kill_first = asyncio.Event()
    sockets = []

    async def first_socket_frames():
        await kill_first.wait()
        raise StopAsyncIteration  # the relay closes the socket

    async def later_socket_frames():
        await asyncio.Event().wait()

    def fake_connect(*_args, **_kwargs):
        ws = _ScriptedWebSocket(first_socket_frames if not sockets else later_socket_frames)
        sockets.append(ws)
        return ws

    monkeypatch.setattr(_ws_mod, "connect", fake_connect)

    await adapter._start_presence()
    await _settle()
    assert cli.statuses == []  # before the first handshake nothing is proven: fail closed

    adapter._ws_task = asyncio.create_task(adapter._websocket_loop())
    await _until(lambda: cli.statuses == ["online"], "online after the handshake")
    assert adapter._presence_transport_healthy() is True

    kill_first.set()
    await _until(lambda: cli.statuses == ["online", "offline"], "cleared after socket loss")
    assert cli.timeouts[-1] == presence.OFFLINE_TIMEOUT
    assert backoffs == [1.0] and adapter._presence_transport_healthy() is False  # parked in reconnect backoff
    await _settle()
    assert cli.statuses == ["online", "offline"]  # no "online" while the socket is down

    reconnect_gate.release()
    await _until(lambda: cli.statuses == ["online", "offline", "online"], "online after reconnect")
    assert len(sockets) == 2 and sockets[0].exited

    await adapter.disconnect()
    assert cli.statuses == ["online", "offline", "online", "offline"]
    assert _live_presence_tasks() == []


@pytest.mark.asyncio
async def test_websocket_auth_failure_never_claims_online(monkeypatch):
    import websockets as _ws_mod

    _block_sleep(monkeypatch)
    _gate, backoffs = _gated_sleep(monkeypatch, _buzz_mod)
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()

    class _RejectingWebSocket(_ScriptedWebSocket):
        async def recv(self):
            if self.sent:
                return json.dumps(["OK", self.sent[0][1]["id"], False, "auth-required: rejected"])
            return json.dumps(["AUTH", "relay-challenge"])

    monkeypatch.setattr(_ws_mod, "connect", lambda *a, **kw: _RejectingWebSocket(lambda: asyncio.Event().wait()))
    await adapter._start_presence()
    adapter._ws_task = asyncio.create_task(adapter._websocket_loop())
    await _until(lambda: backoffs, "reconnect backoff")
    await _settle()
    assert cli.statuses == []
    await adapter.disconnect()
    assert cli.statuses == ["offline"]  # disconnect still clears once, even though the transport never came up


# ── real poll transport: proven by a recent good sweep ────────────────────


class _AdapterClock:
    """Replaces the adapter module's ``time``: controllable ``monotonic``, everything else real."""

    def __init__(self):
        self.now = 10_000.0

    def monotonic(self):
        return self.now

    def __getattr__(self, name):
        return getattr(time, name)


@pytest.mark.asyncio
async def test_poll_transport_health_gates_presence(monkeypatch):
    _gated_presence, _ = _gated_sleep(monkeypatch, presence)  # one release = one interval elapsing
    sweep_gate, _ = _gated_sleep(monkeypatch, _buzz_mod)  # one release = one poll sweep
    clock = _AdapterClock()
    monkeypatch.setattr(_buzz_mod, "time", clock)
    fetch_ok = {"value": False}
    adapter = _make_adapter({"transport": "poll"})
    adapter._run_cli = cli = _Cli(other=lambda args: 0 if fetch_ok["value"] else 2)
    adapter._channel_state[CHANNEL] = adapter._new_channel_state("group")
    adapter._channel_state[CHANNEL]["last_ts"] = 100
    staleness = max(3 * adapter.poll_interval, presence.MIN_PRESENCE_INTERVAL)

    async def sweep():
        before = len(cli.other_calls)
        sweep_gate.release()
        await _until(lambda: len(cli.other_calls) > before, "poll sweep")
        await _settle()

    async def presence_tick():
        _gated_presence.release()
        await _settle()

    adapter._poll_task = asyncio.create_task(adapter._poll_loop())
    await adapter._start_presence()
    await _settle()
    assert cli.statuses == [] and adapter._presence_transport_healthy() is False  # no sweep yet: fail closed

    await sweep()  # relay fetch fails
    await presence_tick()
    assert cli.statuses == []

    fetch_ok["value"] = True
    await sweep()  # first good sweep pokes presence straight away
    assert cli.statuses == ["online"]

    clock.now += staleness + 1  # sweeps stop landing
    await presence_tick()
    assert adapter._presence_transport_healthy() is False
    assert cli.statuses == ["online", "offline"]

    await sweep()  # the next good sweep recovers immediately
    assert cli.statuses == ["online", "offline", "online"]

    await adapter.disconnect()
    assert cli.statuses == ["online", "offline", "online", "offline"]


# ── lifecycle: stop / cancel / reconnect / disabled ───────────────────────


@pytest.mark.asyncio
async def test_disconnect_publishes_offline_with_bounded_timeout(monkeypatch):
    _block_sleep(monkeypatch)
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    _healthy(adapter)
    await adapter._start_presence()
    await _until(lambda: cli.statuses)
    await adapter.disconnect()
    assert cli.statuses == ["online", "offline"]
    assert cli.timeouts[-1] == presence.OFFLINE_TIMEOUT
    assert adapter._presence_task is None


@pytest.mark.asyncio
async def test_stop_while_publish_in_flight_cancels_cleanly(monkeypatch):
    _block_sleep(monkeypatch)
    in_flight = asyncio.Event()

    async def hanging_online():
        in_flight.set()
        await asyncio.Event().wait()  # the relay never answers this heartbeat

    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli(results=[hanging_online])
    _healthy(adapter)
    await adapter._start_presence()
    await _until(in_flight.is_set, "heartbeat in flight")
    task = adapter._presence_task
    await adapter._stop_presence()
    assert task.cancelled()
    assert _live_presence_tasks() == []
    assert cli.statuses == ["online", "offline"]  # exactly one offline
    assert cli.timeouts[-1] == presence.OFFLINE_TIMEOUT


@pytest.mark.asyncio
async def test_cancelled_cli_call_kills_its_child_process(monkeypatch):
    """A cancelled in-flight heartbeat must not leave a ``buzz`` child that could publish "online" late."""
    import tools.environments.local as local_env

    killed = []

    class _ParkedProc:
        returncode = None

        async def communicate(self, _input=None):
            await asyncio.Event().wait()

        def kill(self):
            killed.append(True)

    async def fake_spawn(*_args, **_kwargs):
        return _ParkedProc()

    monkeypatch.setattr(local_env, "hermes_subprocess_env", lambda: {"HERMES_REAL_HOME": "/nonexistent"})
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    call = asyncio.create_task(_buzz_mod._exec_buzz("buzz", ["users", "set-presence", "--status", "online"],
                                                    relay_url="https://test.relay", private_key="k"))
    await _settle()
    call.cancel()
    with pytest.raises(asyncio.CancelledError):
        await call
    assert killed == [True]


@pytest.mark.asyncio
async def test_offline_failure_is_swallowed(monkeypatch):
    _block_sleep(monkeypatch)
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli(results=[0, RuntimeError("relay gone")])
    _healthy(adapter)
    await adapter._start_presence()
    await _until(lambda: cli.statuses)
    await adapter._stop_presence()  # must not raise
    assert cli.statuses == ["online", "offline"]


@pytest.mark.asyncio
async def test_disabled_presence_never_publishes(monkeypatch):
    _block_sleep(monkeypatch)
    adapter = _make_adapter(enabled=False)
    adapter._run_cli = cli = _Cli()
    _healthy(adapter)
    await adapter._start_presence()
    assert adapter._presence_task is None
    await adapter.disconnect()
    assert cli.statuses == []


@pytest.mark.asyncio
async def test_disconnect_without_heartbeat_does_not_publish_offline():
    """A connect() that failed before the heartbeat started must not touch presence on teardown."""
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    await adapter.disconnect()
    assert cli.statuses == []


@pytest.mark.asyncio
async def test_reconnect_replaces_the_heartbeat_task(monkeypatch):
    _block_sleep(monkeypatch)
    adapter = _make_adapter()
    adapter._run_cli = cli = _Cli()
    _healthy(adapter)
    await adapter._start_presence()
    first = adapter._presence_task
    await _until(lambda: cli.statuses == ["online"])
    await adapter._start_presence()  # connect(is_reconnect=True)
    second = adapter._presence_task
    await _until(lambda: cli.statuses == ["online", "online"])
    assert first is not second
    assert first.done() and not second.done()
    assert _live_presence_tasks() == [second]
    await adapter._stop_presence()
    assert second.done()
    assert cli.statuses == ["online", "online", "offline"]
