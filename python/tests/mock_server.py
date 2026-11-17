"""A local stand-in for api.eta.cash: HTTP in a thread and the stream in asyncio, both on 127.0.0.1.

Its answers are the examples in the API's OpenAPI spec. Both halves write to one
shared log, so a test can check the order of what the client did across them.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import threading
import time
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Awaitable, Callable, Dict, List, Optional, Tuple
from urllib.parse import parse_qsl, urlsplit

from websockets.asyncio.server import serve

KEY = "eta_ea1d498e83b6_" + "TESTsecretTESTsecretTESTsecretTESTsecret123"  # made up: 43 characters, never a real key
REQUEST_ID = "5f0c2b7e-3a51-4c9e-9d0b-2f6c1e8a7b44"
PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24

FILL = {"id": "eJ29t6KS43oq", "u": "z2JISK7NrbcB", "who": "yourhandle", "sym": "HYPE", "side": "buy", "usd": 250,
        "qty": 6.174679429445602, "price": 40.34622409901657, "at": 1794544957718}
ME = {
    "fees": {"narrative": 0.0095, "spot": 0.0035, "rwa": 0.0025, "perp": 0.00045, "prediction": 0, "builder": 0.0005},
    "referred": False,
    "earnings": {"creator": {"accrued": 0, "claimed": 0, "swap": 0, "yearly": 0, "narratives": []},
                 "referral": {"accrued": 0, "claimed": 0, "uses": 0, "referees": []}},
    "reserved": 0,
    "user": {"handle": "yourhandle", "name": "Your Name", "bio": "", "code": "YOURINVITE", "cash": 9649.525,
             "showHoldings": True, "showPnl": True, "codeUses": 0, "followers": 0, "following": 0},
    "bag": {},
    "positions": [{"id": "UNNW5aZVXV63", "u": "z2JISK7NrbcB", "sym": "HYPE", "kind": "spot", "side": "buy",
                   "qty": 6.174679429445602, "entry": 40.34622409901657, "usd": 250, "at": 1794544957718}],
    "orders": [],
    "fills": [],
    "notes": [],
    "votes": [],
}
QUOTE = {"sym": "HYPE", "side": "buy", "mark": 40.295854, "quoteId": "GdCdBVBb", "expires": 1794544972298,
         "price": 40.346224, "impactPct": 0.125, "fee": 0.0035, "feeUsd": 0.875, "get": 6.174679429, "qty": 6.1746794,
         "usd": 250, "source": "estimate", "afford": True}


@dataclass
class Seen:
    """One request the mock got."""

    method: str
    path: str
    query: Dict[str, str]
    headers: Dict[str, str]
    body: bytes

    @property
    def json(self) -> Any:
        return json.loads(self.body) if self.body else None


@dataclass
class Answer:
    status: int = 200
    body: Any = None
    headers: Dict[str, str] = field(default_factory=dict)
    drop: bool = False
    """Close the connection with no answer."""
    run: bool = False
    """With ``drop``: do what the request asks first, then drop (eta got it, the answer was lost)."""
    delay: float = 0.0
    """Seconds to wait before answering."""


class Log:
    """What the client did, in order, across the HTTP and stream halves."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.events: List[str] = []

    def add(self, event: str) -> None:
        with self._lock:
            self.events.append(event)

    def snapshot(self) -> List[str]:
        with self._lock:
            return list(self.events)


class MockHttp:
    def __init__(self, log: Optional[Log] = None) -> None:
        self.log = log or Log()
        self.seen: List[Seen] = []
        self.script: List[Tuple[str, str, Answer]] = []
        self.rate: Optional[Tuple[int, int, int]] = (30, 27, 8)
        self.orders: Dict[str, Dict[str, Any]] = {}  # clientId -> first answer
        self.trades = 0
        self._lock = threading.Lock()
        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self._server.api = self  # type: ignore[attr-defined]
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._thread.start()

    @property
    def url(self) -> str:
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}"

    def respond(self, method: str, path: str, *answers: Answer) -> None:
        """The next requests to ``method path`` get these answers, in order; then the defaults."""
        with self._lock:
            for a in answers:
                self.script.append((method, path, a))

    def requests_to(self, method: str, path: str) -> List[Seen]:
        return [s for s in self.seen if s.method == method and s.path == path]

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()

    # ---------- answers ----------

    def answer(self, seen: Seen) -> Answer:
        with self._lock:
            self.seen.append(seen)
            for i, (method, path, a) in enumerate(self.script):
                if method == seen.method and path == seen.path:
                    del self.script[i]
                    if a.drop and a.run:
                        self.default(seen)
                    elif not a.drop and a.body is None:  # a slow answer: eta does it, then answers late
                        slow = self.default(seen)
                        slow.delay = a.delay
                        return slow
                    return a
        return self.default(seen)

    def default(self, s: Seen) -> Answer:
        auth = s.headers.get("authorization")
        if auth is not None and auth != f"Bearer {KEY}":
            return Answer(401, {"err": "bad key"})
        p, m = s.path, s.method
        if m == "GET":
            if p == "/me":
                return Answer(body=ME)
            if p == "/bootstrap":
                return Answer(body={"me": ME, "users": [], "posts": [], "replies": {}, "counts": {}, "tape": [FILL],
                                    "activity": {}, "proposals": [], "narratives": [], "marks": {"HYPE": 40.29},
                                    "holders": {}, "news": [], "markets": [], "limits": {"postText": 2000}})
            if p == "/markets":
                return Answer(body=[{"sym": "HYPE", "kind": "spot", "price": 40.29}])
            if p.startswith("/trades/"):
                return Answer(body=[FILL])
            if p.startswith("/flows/"):
                return Answer(body=[{"group": "creator", "bought": 250, "sold": 124, "people": 1}])
            if p.startswith("/fills/"):
                return Answer(body=[{k: FILL[k] for k in ("id", "sym", "side", "usd", "qty", "price", "at")}])
            if p.startswith("/stats/"):
                return Answer(body={"handle": "yourhandle", "days": 30, "hidden": True})
            if p == "/board":
                return Answer(body={"rows": [], "me": None, "total": 0})
            if p.endswith("/history"):
                return Answer(body=[{"t": 1794544968411, "p": 0.9986}])
            if p.endswith("/versions"):
                return Answer(body=[{"at": 1794544963073, "thesis": "My weekly picks."}])
            if p.startswith("/follows/"):
                return Answer(body={"followers": ["sage"], "following": []})
            if p.startswith("/files/"):
                if p == "/files/" + hashlib.sha256(PNG).hexdigest():
                    return Answer(body=PNG, headers={"Content-Type": "image/png"})
                return Answer(404, "404 Not Found", headers={"Content-Type": "text/plain"})
        if m == "POST":
            if p == "/act":
                return Answer(body=self.act(s.json or {}))
            if p == "/quote":
                return Answer(body=QUOTE)
            if p == "/files":
                return Answer(body={"url": "/files/" + hashlib.sha256(s.body).hexdigest()})
            if p.startswith("/sim/"):
                return Answer(body={"days": 3, "seed": 1, "sym": p.split("/")[-1], "yearlyRate": 0.005,
                                    "start": {"price": 1}, "params": {}, "events": [], "end": {"price": 1}})
        return Answer(404, {"err": "not found"})

    def act(self, a: Dict[str, Any]) -> Dict[str, Any]:
        kind = a.get("type")
        if kind in ("order", "close"):
            cid = a.get("clientId")
            if cid in self.orders:
                return {**self.orders[cid], "repeat": True}
            self.trades += 1
            if kind == "order" and a.get("limit") is not None:
                answer: Dict[str, Any] = {"ok": True, "id": f"order-{self.trades}", "open": True, "clientId": cid}
            else:
                answer = {"ok": True, "fill": {**FILL, "id": f"fill-{self.trades}", "clientId": cid}}
                if kind == "close":
                    answer["got"] = 123.75
            self.orders[cid] = answer
            return answer
        if kind == "post":
            return {"ok": True, "id": a.get("id") or "c2_g_um58aNl"}
        if kind == "launch":
            return {"ok": True, "sym": a.get("sym")}
        if kind == "propose":
            return {"ok": True, "id": "ioF8wlOIFgaE", "ends": 1794573763887, "bar": "low"}
        if kind == "cancelAll":
            return {"ok": True, "cancelled": 2}
        return {"ok": True}


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: Any) -> None:  # quiet
        pass

    def _any(self) -> None:
        api: MockHttp = self.server.api  # type: ignore[attr-defined]
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        parts = urlsplit(self.path)
        seen = Seen(self.command, parts.path, dict(parse_qsl(parts.query)),
                    {k.lower(): v for k, v in self.headers.items()}, body)
        api.log.add(f"http {self.command} {parts.path}")
        a = api.answer(seen)
        if a.delay:
            time.sleep(a.delay)
        if a.drop:
            self.close_connection = True
            return
        if isinstance(a.body, (bytes, str)):
            payload = a.body if isinstance(a.body, bytes) else a.body.encode()
            ctype = a.headers.get("Content-Type", "text/plain")
        else:
            payload = json.dumps(a.body).encode()
            ctype = "application/json"
        self.send_response(a.status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("X-Request-Id", a.headers.get("X-Request-Id", REQUEST_ID))
        has_key = (seen.headers.get("authorization") or "").startswith("Bearer eta_")
        if api.rate and has_key and a.status != 401:
            limit, remaining, reset = api.rate
            self.send_header("X-RateLimit-Limit", str(limit))
            self.send_header("X-RateLimit-Remaining", str(remaining))
            self.send_header("X-RateLimit-Reset", str(reset))
        for k, v in a.headers.items():
            if k not in ("Content-Type", "X-Request-Id"):
                self.send_header(k, v)
        self.end_headers()
        self.wfile.write(payload)

    do_GET = do_POST = do_DELETE = _any


Hook = Callable[[Any], Awaitable[None]]


class MockStream:
    """The stream half: auth, subscribe, ping, as stream.md says. Run inside the test's event loop."""

    def __init__(self, log: Log, key: str = KEY) -> None:
        self.log = log
        self.key = key
        self.connections = 0
        self.frames: List[Tuple[int, Dict[str, Any]]] = []
        self.refuse: Dict[int, Tuple[int, Dict[str, Any]]] = {}
        """Connection number -> (close code, error frame), sent at its auth frame."""
        self.after_subscribe: Dict[int, Hook] = {}
        """Connection number -> what to do after its first subscribe (push frames, close it)."""
        self.sockets: set = set()
        """The connections open now."""
        self.silent: set = set()
        """Connection numbers that open but never answer the auth frame."""
        self.handshake_delay = 0.0
        """Seconds the server waits before it answers the WebSocket upgrade."""
        self.before_ready: Dict[int, List[Dict[str, Any]]] = {}
        """Connection number -> frames sent after its auth frame, just before its answer (ready, or a refusal)."""
        self._server: Any = None

    async def start(self) -> "MockStream":
        async def slow(connection: Any, request: Any) -> None:
            if self.handshake_delay:
                await asyncio.sleep(self.handshake_delay)

        self._server = await serve(self._handler, "127.0.0.1", 0, process_request=slow)
        return self

    @property
    def url(self) -> str:
        host, port = list(self._server.sockets)[0].getsockname()[:2]
        return f"ws://{host}:{port}/stream"

    async def stop(self) -> None:
        self._server.close()
        await self._server.wait_closed()

    def received(self, kind: str) -> List[Tuple[int, Dict[str, Any]]]:
        return [(n, f) for n, f in self.frames if f.get("type") == kind]

    async def _handler(self, ws: Any) -> None:
        self.connections += 1
        n = self.connections
        self.sockets.add(ws)
        try:
            await self._frames(ws, n)
        finally:
            self.sockets.discard(ws)

    async def _frames(self, ws: Any, n: int) -> None:
        subscribed = False
        async for raw in ws:
            frame = json.loads(raw)
            self.frames.append((n, frame))
            kind = frame.get("type")
            self.log.add(f"ws{n} {kind}")
            if kind == "auth":
                if n in self.silent:
                    continue
                if n in self.refuse:
                    for early in self.before_ready.get(n, []):
                        await ws.send(json.dumps(early))
                    code, err = self.refuse[n]
                    await ws.send(json.dumps({"type": "error", **err}))
                    await ws.close(code, err["err"])
                    return
                if frame.get("key") != self.key:
                    await ws.send(json.dumps({"type": "error", "err": "bad key"}))
                    await ws.close(4001, "bad key")
                    return
                for early in self.before_ready.get(n, []):
                    await ws.send(json.dumps(early))
                await ws.send(json.dumps({"type": "ready", "handle": "yourhandle"}))
            elif kind == "subscribe":
                channels = frame["channels"]
                answer: Dict[str, Any] = {"type": "subscribed", "channels": channels}
                if "syms" in frame:
                    answer["syms"] = frame["syms"]
                await ws.send(json.dumps(answer))
                if "account" in channels:
                    await ws.send(json.dumps({"type": "me", "me": ME}))
                if "marks" in channels:
                    await ws.send(json.dumps({"type": "marks", "marks": {"HYPE": 37.7974}}))
                if not subscribed and n in self.after_subscribe:
                    subscribed = True
                    await self.after_subscribe[n](ws)
            elif kind == "unsubscribe":
                await ws.send(json.dumps({"type": "subscribed", "channels": []}))
            elif kind == "ping":
                await ws.send(json.dumps({"type": "pong"}))


async def wait_until(check: Callable[[], bool], timeout: float = 5.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not check():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.01)

