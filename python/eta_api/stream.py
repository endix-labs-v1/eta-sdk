"""The stream: your fills, orders and record, and prices, pushed as they happen."""
from __future__ import annotations

import asyncio
import json
import math
from typing import TYPE_CHECKING, Any, AsyncGenerator, Awaitable, Callable, Dict, Iterable, List, Optional
from urllib.parse import urlsplit, urlunsplit

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed, WebSocketException

from ._version import __version__
from .errors import EtaError

if TYPE_CHECKING:  # pragma: no cover
    from .client import EtaClient

CHANNELS = ("account", "marks")
CLOSE_KEY = 4001
"""The key doesn't open (``bad key``, ``key revoked``, ``keys only``). The stream stops for good."""
CLOSE_LIMIT = 4029
"""Too fast, or too many streams. The stream waits ``retryAfter`` when eta gives one."""


class EtaStream:
    """A stream of your fills, orders and record (``account``) and prices (``marks``).

    Iterate it to get each frame as a dict::

        async with client.stream(["account", "marks"], syms=["HYPE"]) as stream:
            async for frame in stream:
                if frame["type"] == "fill":
                    print(frame["fill"])

    It sends your key in the first frame, subscribes, and pings every 30 seconds.
    When the stream drops, it connects again after 1 second, then 2, 4, up to a
    minute; reads ``GET /me`` to catch up (a ``resync`` frame); and subscribes
    again. Close 4001 (a bad or revoked key) stops it for good: the iteration
    raises :class:`EtaError` with ``code`` 4001.

    Besides eta's own frames (``ready``, ``subscribed``, ``fill``, ``order``, ``me``,
    ``marks``, ``error``) it yields two of its own: ``resync`` (``{"me": ...}``, after a
    reconnect) and ``closed`` (``{"code", "err", "wait"}``, each time the stream
    drops). ``pong`` frames are not passed on.

    Args:
        client: The :class:`EtaClient` whose key the stream opens with.
        channels: ``account``, ``marks`` or both. ``["account"]`` by default.
        syms: With ``marks``: only these markets' prices. Every market's by default.
        url: The stream's address. Made from the client's ``base_url`` by default.
        ping_interval: Seconds between pings. 30 by default; eta closes a stream
            that sends nothing for 60.
        open_timeout: Seconds from connecting to eta's ``ready`` (the WebSocket
            opens, eta answers the key). Past it, the stream drops the socket at
            once and connects again. 10 by default; ``None`` for no deadline. An
            ``open_timeout`` in ``connect_options`` takes its place.
        backoff: The first wait before connecting again, in seconds. 1 by default.
        max_backoff: The longest wait. 60 by default.
        resync: Read ``GET /me`` after each reconnect, when ``account`` is on. True by default.
        sleep: The coroutine function the stream waits with. ``asyncio.sleep`` by default.
        connect_options: Extra keyword arguments for ``websockets.asyncio.client.connect``.
    """

    def __init__(
        self,
        client: "EtaClient",
        channels: Iterable[str] = ("account",),
        syms: Optional[Iterable[str]] = None,
        *,
        url: Optional[str] = None,
        ping_interval: float = 30.0,
        open_timeout: Optional[float] = 10.0,
        backoff: float = 1.0,
        max_backoff: float = 60.0,
        resync: bool = True,
        sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
        connect_options: Optional[Dict[str, Any]] = None,
    ) -> None:
        wanted = _channels(channels, allow_empty=True)
        if syms is not None and "marks" not in wanted:
            raise ValueError("syms: with marks only")
        self._client = client
        self.url = url or _stream_url(client.base_url)
        self._channels: List[str] = wanted
        self._syms: Optional[List[str]] = list(syms) if syms is not None else None
        self.ping_interval = ping_interval
        self.open_timeout = _open_timeout(open_timeout, "open_timeout")
        self.backoff = backoff
        self.max_backoff = max_backoff
        self.resync = resync
        self._sleep = sleep
        self._connect_options = dict(connect_options or {})
        if "open_timeout" in self._connect_options:
            self._connect_options["open_timeout"] = _open_timeout(self._connect_options["open_timeout"],
                                                                  "connect_options open_timeout")
        self.handle: Optional[str] = None
        """Your handle, from the ``ready`` frame."""
        self._ws: Any = None
        self._live = False
        self._closed = False
        self._stop: Optional[asyncio.Event] = None
        self._gen: Optional[AsyncGenerator[Dict[str, Any], None]] = None

    @property
    def channels(self) -> List[str]:
        """The channels the stream subscribes to now."""
        return list(self._channels)

    @property
    def syms(self) -> Optional[List[str]]:
        """The markets ``marks`` sends, or ``None`` for every market."""
        return list(self._syms) if self._syms is not None else None

    def __aiter__(self) -> AsyncGenerator[Dict[str, Any], None]:
        if self._gen is None:
            self._gen = self._run()
        return self._gen

    async def __aenter__(self) -> "EtaStream":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()

    async def subscribe(self, channels: Iterable[str], syms: Optional[Iterable[str]] = None) -> None:
        """Adds channels. With ``marks``, ``syms`` replaces the markets (``None``: every market).

        Kept for each reconnect. Sent now when the stream is open.
        """
        wanted = _channels(channels)
        if syms is not None and "marks" not in wanted:
            raise ValueError("syms: with marks only")
        self._channels = [c for c in CHANNELS if c in self._channels or c in wanted]
        if "marks" in wanted:
            self._syms = list(syms) if syms is not None else None
        if self._live and self._ws is not None:
            frame: Dict[str, Any] = {"type": "subscribe", "channels": wanted}
            if "marks" in wanted and self._syms is not None:
                frame["syms"] = self._syms
            await self._ws.send(json.dumps(frame))

    async def unsubscribe(self, channels: Iterable[str]) -> None:
        """Stops channels, now and on each reconnect."""
        wanted = _channels(channels)
        self._channels = [c for c in self._channels if c not in wanted]
        if "marks" in wanted:
            self._syms = None
        if self._live and self._ws is not None:
            await self._ws.send(json.dumps({"type": "unsubscribe", "channels": wanted}))

    async def close(self) -> None:
        """Ends the stream. The iteration stops, and it does not connect again."""
        self._closed = True
        if self._stop is not None:
            self._stop.set()
        ws = self._ws
        if ws is not None:
            await ws.close()
        gen = self._gen
        if gen is not None and not gen.ag_running:
            await gen.aclose()

    # ---------- the loop ----------

    async def _run(self) -> AsyncGenerator[Dict[str, Any], None]:
        self._stop = asyncio.Event()  # made here, in the running loop (Python 3.9 binds an Event to a loop when made)
        backoff = self.backoff
        had_session = False
        options: Dict[str, Any] = {"open_timeout": self.open_timeout, "max_size": 2 ** 24,
                                   "user_agent_header": f"eta-api-python/{__version__}"}
        options.update(self._connect_options)
        loop = asyncio.get_running_loop()
        while not self._closed:
            last_error: Optional[Dict[str, Any]] = None
            dropped: Optional[str] = None
            code: Optional[int] = None
            reason = ""
            # one deadline from connecting to ready: connect's own open_timeout covers the WebSocket handshake, the watchdog the
            # wait for eta to answer the key (a server that opens and then says nothing would otherwise hold the stream for good)
            limit = options["open_timeout"]
            deadline = None if limit is None else loop.time() + limit
            timed_out: Dict[str, bool] = {}
            try:
                async with connect(self.url, **options) as ws:
                    self._ws = ws
                    pinger: Optional["asyncio.Future[None]"] = None
                    watchdog: Optional["asyncio.Future[None]"] = None
                    if deadline is not None:
                        watchdog = asyncio.ensure_future(self._open_deadline(ws, deadline - loop.time(), timed_out))
                    try:
                        await ws.send(json.dumps({"type": "auth", "key": self._client._key}))
                        async for raw in ws:
                            if timed_out:
                                break  # past the deadline: nothing more from this socket, a ready in its buffer included
                            frame = _frame(raw)
                            if frame is None:
                                continue
                            kind = frame.get("type")
                            if kind == "pong":
                                continue
                            if kind == "error":
                                last_error = frame
                            if kind != "ready":
                                yield frame
                                continue
                            # ready: the key opened. Catch up (after a drop), then subscribe.
                            if watchdog is not None:
                                watchdog.cancel()
                            self.handle = frame.get("handle")
                            backoff = self.backoff
                            yield frame
                            if had_session and self.resync and "account" in self._channels:
                                try:
                                    me = await asyncio.to_thread(self._client.me)
                                except EtaError as exc:
                                    if exc.status == 401:
                                        raise
                                    dropped = f"resync: {exc.err}"
                                    await ws.close()
                                    break
                                yield {"type": "resync", "me": me}
                            had_session = True
                            self._live = True
                            await self._send_subscription(ws)
                            if pinger is None:
                                pinger = asyncio.ensure_future(self._ping(ws))
                    finally:
                        self._live = False
                        self._ws = None
                        if watchdog is not None:
                            watchdog.cancel()
                        if pinger is not None:
                            pinger.cancel()
                    code, reason = _close_of(ws)
            except ConnectionClosed as exc:
                code, reason = (exc.rcvd.code, exc.rcvd.reason) if exc.rcvd is not None else (None, "")
            except (OSError, asyncio.TimeoutError, WebSocketException) as exc:
                code, reason = None, f"{type(exc).__name__}: {exc}"[:200]
                if isinstance(exc, (asyncio.TimeoutError, TimeoutError)):
                    timed_out["yes"] = True
            if timed_out:  # the deadline is why it dropped, whatever error frame came before it
                code, dropped, last_error = None, "open timeout", None

            if self._closed:
                return
            err = (last_error or {}).get("err") or dropped or reason or None
            if code == CLOSE_KEY:
                extra = {k: v for k, v in (last_error or {}).items() if k not in ("type", "err")}
                raise EtaError(0, err or "bad key", fields=extra, code=code)
            wait = backoff
            retry_after = (last_error or {}).get("retryAfter")
            if code == CLOSE_LIMIT and isinstance(retry_after, (int, float)):
                wait = max(wait, float(retry_after))
            yield {"type": "closed", "code": code, "err": err, "wait": wait}
            await self._pause(wait)
            backoff = min(backoff * 2, self.max_backoff)

    async def _send_subscription(self, ws: Any) -> None:
        if not self._channels:
            return
        frame: Dict[str, Any] = {"type": "subscribe", "channels": list(self._channels)}
        if "marks" in self._channels and self._syms is not None:
            frame["syms"] = self._syms
        await ws.send(json.dumps(frame))

    async def _open_deadline(self, ws: Any, seconds: float, timed_out: Dict[str, bool]) -> None:
        """Drops a connection that hasn't had ``ready`` by the deadline. Cancelled when ``ready`` comes.

        It aborts the socket rather than closing it: a peer that answers nothing would hold a close for websockets'
        ``close_timeout`` (10 more seconds) before the stream could connect again.
        """
        try:
            await asyncio.sleep(max(seconds, 0.0))
        except asyncio.CancelledError:
            return
        timed_out["yes"] = True
        transport = getattr(ws, "transport", None)
        if transport is not None:
            transport.abort()
        else:  # pragma: no cover - every websockets this package takes has the transport
            await ws.close()

    async def _ping(self, ws: Any) -> None:
        try:
            while True:
                await asyncio.sleep(self.ping_interval)
                await ws.send('{"type":"ping"}')
        except (ConnectionClosed, asyncio.CancelledError):
            return

    async def _pause(self, seconds: float) -> None:
        """Waits ``seconds``, or less when the stream is closed meanwhile."""
        assert self._stop is not None
        sleeper = asyncio.ensure_future(self._sleep(seconds))
        stopper = asyncio.ensure_future(self._stop.wait())
        try:
            await asyncio.wait({sleeper, stopper}, return_when=asyncio.FIRST_COMPLETED)
        finally:
            sleeper.cancel()
            stopper.cancel()


def _open_timeout(value: Any, name: str) -> Optional[float]:
    """Seconds above 0, or None (or infinity) for no deadline. 0 or below would drop every connection."""
    if value is None or (isinstance(value, (int, float)) and not isinstance(value, bool) and value == math.inf):
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)) or math.isnan(value) or value <= 0:
        raise ValueError(f"{name}: seconds above 0, or None for no deadline")
    return float(value)


def _channels(channels: Iterable[str], allow_empty: bool = False) -> List[str]:
    if isinstance(channels, str):
        channels = [channels]
    wanted = list(channels)
    if (not wanted and not allow_empty) or any(c not in CHANNELS for c in wanted):
        raise ValueError("channels: account, marks")
    return [c for c in CHANNELS if c in wanted]


def _stream_url(base_url: str) -> str:
    parts = urlsplit(base_url)
    scheme = {"https": "wss", "http": "ws"}.get(parts.scheme, parts.scheme)
    return urlunsplit((scheme, parts.netloc, parts.path.rstrip("/") + "/stream", "", ""))


def _close_of(ws: Any) -> Any:
    """The close code and reason. websockets 14.1 and later have them on the connection; 13.x and 14.0 on its protocol."""
    holder = ws if hasattr(ws, "close_code") else getattr(ws, "protocol", None)
    return getattr(holder, "close_code", None), getattr(holder, "close_reason", None) or ""


def _frame(raw: Any) -> Optional[Dict[str, Any]]:
    try:
        frame = json.loads(raw)
    except (TypeError, ValueError):
        return None
    return frame if isinstance(frame, dict) else None
