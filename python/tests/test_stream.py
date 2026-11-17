"""The stream against the local mock: auth, subscribe, ping, reconnect with a /me resync, and stop on 4001."""
from __future__ import annotations

import asyncio
import json
from typing import Any, Awaitable, Callable, Dict, List

import pytest
from mock_server import KEY, ME, Answer, Log, MockHttp, MockStream, wait_until

from eta_api import EtaClient, EtaError


class AsyncSleeps:
    """Stands in for asyncio.sleep in the stream: notes each wait and returns at once."""

    def __init__(self) -> None:
        self.waits: List[float] = []

    async def __call__(self, seconds: float) -> None:
        self.waits.append(seconds)
        await asyncio.sleep(0)


def run(test: Callable[[MockStream], Awaitable[None]], log: Log) -> None:
    async def main() -> None:
        ws = await MockStream(log).start()
        try:
            await asyncio.wait_for(test(ws), timeout=10)
        finally:
            await ws.stop()

    asyncio.run(main())


async def take(it: Any, n: int) -> List[Dict[str, Any]]:
    return [await it.__anext__() for _ in range(n)]


def make(client: EtaClient, ws: MockStream, sleeps: AsyncSleeps, **options: Any) -> Any:
    options.setdefault("channels", ["account"])
    return client.stream(url=ws.url, sleep=sleeps, **options)


def test_it_sends_auth_first_then_subscribes(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        stream = make(client, ws, AsyncSleeps(), channels=["account", "marks"], syms=["HYPE", "BTC-PERP"])
        it = stream.__aiter__()
        frames = await take(it, 4)
        assert [f["type"] for f in frames] == ["ready", "subscribed", "me", "marks"]
        assert frames[0]["handle"] == "yourhandle" and stream.handle == "yourhandle"
        assert frames[2]["me"] == ME
        sent = [f for _, f in ws.frames]
        assert sent[0]["type"] == "auth" and sent[0]["key"] == KEY, "the key goes in the first frame"
        assert sent[1] == {"type": "subscribe", "channels": ["account", "marks"], "syms": ["HYPE", "BTC-PERP"]}
        assert "?" not in stream.url and KEY not in stream.url, "never the key in the URL"
        await stream.close()

    run(test, log)


def test_the_stream_url_comes_from_the_base_url() -> None:
    assert EtaClient(KEY).stream().url == "wss://api.eta.cash/stream"
    assert EtaClient(KEY, "http://127.0.0.1:8080/").stream().url == "ws://127.0.0.1:8080/stream"


def test_it_pings_and_keeps_pongs_to_itself(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        stream = make(client, ws, AsyncSleeps(), ping_interval=0.05)
        seen: List[str] = []

        async def read() -> None:
            async for frame in stream:
                seen.append(frame["type"])

        reader = asyncio.ensure_future(read())
        await wait_until(lambda: len(ws.received("ping")) >= 3)
        assert all(f == {"type": "ping"} for _, f in ws.received("ping"))
        assert "pong" not in seen
        await stream.close()
        await reader

    run(test, log)


def test_a_fill_on_the_account_channel_comes_through(client: EtaClient, log: Log) -> None:
    fill = {"id": "UFhfFf0Dpnhf", "who": "yourhandle", "sym": "HYPE", "side": "buy", "usd": 25, "qty": 0.61948238,
            "price": 40.215026, "at": 1794906600160, "clientId": "hype-dip-0001"}

    async def push(sock: Any) -> None:
        await sock.send(json.dumps({"type": "fill", "fill": fill}))
        await sock.send(json.dumps({"type": "order", "event": "filled", "order": {"id": "NqUmtbyLpjAd"}, "fill": "UFhfFf0Dpnhf"}))

    async def test(ws: MockStream) -> None:
        ws.after_subscribe[1] = push
        stream = make(client, ws, AsyncSleeps())
        frames = await take(stream.__aiter__(), 5)
        assert [f["type"] for f in frames] == ["ready", "subscribed", "me", "fill", "order"]
        assert frames[3]["fill"] == fill and frames[3]["fill"]["clientId"] == "hype-dip-0001"
        await stream.close()

    run(test, log)


def test_a_drop_reconnects_reads_me_then_subscribes_again(client: EtaClient, api: MockHttp, log: Log) -> None:
    async def idle(sock: Any) -> None:
        await sock.send(json.dumps({"type": "error", "err": "idle"}))
        await sock.close(4008, "idle")

    async def test(ws: MockStream) -> None:
        ws.after_subscribe[1] = idle
        sleeps = AsyncSleeps()
        stream = make(client, ws, sleeps)
        frames = await take(stream.__aiter__(), 9)
        assert [f["type"] for f in frames] == [
            "ready", "subscribed", "me", "error", "closed", "ready", "resync", "subscribed", "me"]
        assert frames[4] == {"type": "closed", "code": 4008, "err": "idle", "wait": 1.0}
        assert frames[6]["me"] == ME
        assert sleeps.waits == [1.0]
        events = [e for e in log.snapshot() if e != "ws1 ping" and e != "ws2 ping"]
        assert events == ["ws1 auth", "ws1 subscribe", "ws2 auth", "http GET /me", "ws2 subscribe"], \
            "after a drop: connect, auth, GET /me, then subscribe"
        assert len(api.requests_to("GET", "/me")) == 1
        await stream.close()

    run(test, log)


def test_backoff_doubles_and_starts_over_after_ready(client: EtaClient, log: Log) -> None:
    async def gone(sock: Any) -> None:
        await sock.close(1011, "restart")

    async def test(ws: MockStream) -> None:
        ws.refuse[1] = (4008, {"err": "no auth"})
        ws.refuse[2] = (4008, {"err": "no auth"})
        ws.refuse[3] = (4013, {"err": "slow reader"})
        ws.after_subscribe[4] = gone
        sleeps = AsyncSleeps()
        stream = make(client, ws, sleeps, max_backoff=3)
        it = stream.__aiter__()
        frames: List[Dict[str, Any]] = []
        while len([f for f in frames if f["type"] == "ready"]) < 2:
            frames.append(await it.__anext__())
        assert sleeps.waits == [1.0, 2.0, 3.0, 1.0], "1, 2, then the cap; back to 1 after a stream that opened"
        await stream.close()

    run(test, log)


def test_4029_waits_the_retry_after_it_gives(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        ws.refuse[1] = (4029, {"err": "too fast", "retryAfter": 7})
        sleeps = AsyncSleeps()
        stream = make(client, ws, sleeps)
        frames = await take(stream.__aiter__(), 3)
        assert [f["type"] for f in frames] == ["error", "closed", "ready"]
        assert frames[1] == {"type": "closed", "code": 4029, "err": "too fast", "wait": 7.0}
        assert sleeps.waits == [7.0]
        await stream.close()

    run(test, log)


def test_4001_stops_the_stream_for_good(api: MockHttp, log: Log) -> None:
    client = EtaClient("eta_ea1d498e83b6_" + "W" * 43, api.url)

    async def test(ws: MockStream) -> None:
        sleeps = AsyncSleeps()
        stream = client.stream(url=ws.url, sleep=sleeps)
        frames: List[Dict[str, Any]] = []
        with pytest.raises(EtaError) as caught:
            async for frame in stream:
                frames.append(frame)
        assert (caught.value.code, caught.value.err, caught.value.status) == (4001, "bad key", 0)
        assert [f["type"] for f in frames] == ["error"]
        assert ws.connections == 1 and sleeps.waits == [], "never connects again"
        assert "W" * 43 not in str(caught.value)

    run(test, log)


def test_a_revoked_key_on_the_resync_stops_the_stream(client: EtaClient, api: MockHttp, log: Log) -> None:
    async def drop(sock: Any) -> None:
        await sock.close(1012, "restart")

    async def test(ws: MockStream) -> None:
        ws.after_subscribe[1] = drop
        api.respond("GET", "/me", Answer(401, {"err": "key revoked"}))
        stream = make(client, ws, AsyncSleeps())
        with pytest.raises(EtaError) as caught:
            async for _ in stream:
                pass
        assert (caught.value.status, caught.value.err) == (401, "key revoked")
        assert ws.connections == 2

    run(test, log)


def test_a_failed_resync_drops_and_tries_again(client: EtaClient, api: MockHttp, log: Log) -> None:
    async def drop(sock: Any) -> None:
        await sock.close(1012, "restart")

    async def test(ws: MockStream) -> None:
        ws.after_subscribe[1] = drop
        api.respond("GET", "/me", *[Answer(500, {"err": "oops"})] * 3)
        sleeps = AsyncSleeps()
        stream = make(client, ws, sleeps)
        it = stream.__aiter__()
        frames: List[Dict[str, Any]] = []
        while not any(f["type"] == "resync" for f in frames):
            frames.append(await it.__anext__())
        closed = [f for f in frames if f["type"] == "closed"]
        assert closed[1]["err"] == "resync: oops"
        assert ws.connections == 3
        await stream.close()

    run(test, log)


def test_close_inside_the_loop_ends_it(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        stream = make(client, ws, AsyncSleeps())
        n = 0
        async for frame in stream:
            n += 1
            if frame["type"] == "me":
                await stream.close()
        assert n == 3
        assert ws.connections == 1

    run(test, log)


def test_subscribe_and_unsubscribe_are_kept_for_the_next_connection(client: EtaClient, log: Log) -> None:
    async def later(sock: Any) -> None:
        pass

    async def test(ws: MockStream) -> None:
        sleeps = AsyncSleeps()
        async with make(client, ws, sleeps) as stream:
            it = stream.__aiter__()
            await take(it, 3)  # ready, subscribed, me
            await stream.subscribe(["marks"], syms=["HYPE"])
            frames = await take(it, 2)
            assert [f["type"] for f in frames] == ["subscribed", "marks"]
            await stream.unsubscribe(["account"])
            assert stream.channels == ["marks"] and stream.syms == ["HYPE"]
            await take(it, 1)
            await ws_close_current(ws)
            frames = []
            while not any(f["type"] == "subscribed" for f in frames):
                frames.append(await it.__anext__())
            assert "resync" not in [f["type"] for f in frames], "no account channel, no /me to catch up"
        subscribes = [f for _, f in ws.received("subscribe")]
        assert subscribes[-1] == {"type": "subscribe", "channels": ["marks"], "syms": ["HYPE"]}

    run(test, log)


async def ws_close_current(ws: MockStream) -> None:
    for conn in list(ws.sockets):
        await conn.close(1012, "restart")


# ---------- Bugbot on PR #1 (found in the TypeScript stream; checked here too) ----------

def frames_of(ws: MockStream, n: int) -> List[str]:
    return [f["type"] for m, f in ws.frames if m == n]


def test_closing_on_ready_starts_no_ping_and_sends_nothing_more(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        stream = make(client, ws, AsyncSleeps(), ping_interval=0.02)
        async for frame in stream:
            if frame["type"] == "ready":
                await stream.close()
        await asyncio.sleep(0.2)
        assert frames_of(ws, 1) == ["auth"], "no subscribe and no ping after close()"

    run(test, log)


def test_closing_on_resync_starts_no_ping_and_sends_nothing_more(client: EtaClient, log: Log) -> None:
    async def drop(sock: Any) -> None:
        await sock.close(1012, "restart")

    async def test(ws: MockStream) -> None:
        ws.after_subscribe[1] = drop
        stream = make(client, ws, AsyncSleeps(), ping_interval=0.02)
        async for frame in stream:
            if frame["type"] == "resync":
                await stream.close()
        await asyncio.sleep(0.2)
        assert frames_of(ws, 2) == ["auth"], "no subscribe and no ping after close()"

    run(test, log)


def test_a_handshake_that_never_answers_times_out_then_connects_again(client: EtaClient, log: Log) -> None:
    async def test(_: MockStream) -> None:
        held: List[Any] = []

        async def hold(reader: Any, writer: Any) -> None:  # takes the TCP connection, never answers the upgrade
            held.append(writer)
            await asyncio.sleep(30)

        silent = await asyncio.start_server(hold, "127.0.0.1", 0)
        port = silent.sockets[0].getsockname()[1]
        try:
            stream = client.stream(url=f"ws://127.0.0.1:{port}/stream", sleep=AsyncSleeps(),
                                   connect_options={"open_timeout": 0.2})
            frames = await asyncio.wait_for(take(stream.__aiter__(), 2), timeout=3)
            assert frames[0] == {"type": "closed", "code": None, "err": "open timeout", "wait": 1.0}
            assert frames[1]["type"] == "closed" and len(held) >= 2, "it connected again"
            await stream.close()
        finally:
            for w in held:
                w.close()
            silent.close()

    run(test, log)


def test_a_stream_that_opens_but_never_answers_the_key_times_out(client: EtaClient, log: Log) -> None:
    async def test(ws: MockStream) -> None:
        ws.silent.add(1)
        stream = make(client, ws, AsyncSleeps(), connect_options={"open_timeout": 0.2})
        frames = await asyncio.wait_for(take(stream.__aiter__(), 2), timeout=3)
        assert frames == [{"type": "closed", "code": None, "err": "open timeout", "wait": 1.0},
                          {"type": "ready", "handle": "yourhandle"}]
        assert ws.connections == 2
        await stream.close()

    run(test, log)
