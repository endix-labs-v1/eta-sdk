"""The HTTP client: one method for each route a key can call."""
from __future__ import annotations

import json
import os
import re
import time
import uuid
from dataclasses import dataclass
from typing import (
    TYPE_CHECKING,
    Any,
    BinaryIO,
    Callable,
    Dict,
    Iterable,
    List,
    Mapping,
    Optional,
    Sequence,
    Union,
    cast,
)
from urllib.parse import quote as _url_quote

import requests

from ._version import __version__
from .errors import EtaError
from .types import (
    Board,
    Bootstrap,
    Bounds,
    CancelAllAnswer,
    Change,
    CloseAnswer,
    Fill,
    Flow,
    Follows,
    LaunchAnswer,
    Leg,
    Market,
    Me,
    OkAnswer,
    OrderAnswer,
    PersonFill,
    PostAnswer,
    PricePoint,
    ProposeAnswer,
    Quote,
    ReplyAnswer,
    RulesetVersion,
    SimResult,
    Stats,
    StatsHidden,
    Upload,
)

if TYPE_CHECKING:  # pragma: no cover
    from .stream import EtaStream

DEFAULT_BASE_URL = "https://api.eta.cash"


class _Unset:
    """A field left out of the request, as opposed to ``None``, which sends ``null``."""

    def __repr__(self) -> str:
        return "UNSET"

    def __bool__(self) -> bool:
        return False


UNSET: Any = _Unset()

_NO_BODY = object()
_NETWORK_ERRORS = (requests.ConnectionError, requests.Timeout, requests.exceptions.ChunkedEncodingError)
_KEY_ID = re.compile(r"^eta_([0-9a-f]{12})_")


@dataclass(frozen=True)
class RateLimit:
    """The newest ``X-RateLimit-*`` values eta sent with a call made with your key."""

    limit: int
    """How many calls the key may make in 10 seconds."""
    remaining: int
    """How many more calls you can make now before a 429, the last one counted."""
    reset: int
    """Seconds until ``remaining`` goes up."""


def new_client_id() -> str:
    """A fresh ``clientId``: a random uuid, which fits eta's 1 to 64 letters, digits, ``_`` or ``-``."""
    return str(uuid.uuid4())


class EtaClient:
    """A client for the eta API, built from one API key.

    Every call in the Read, Post, Creator and Trade parts of the API reference has a
    method. Each answer is the dict eta sends.
    A refused call raises :class:`EtaError`.

    Args:
        key: Your API key, ``eta_<id>_<secret>``.
        base_url: The API. ``https://api.eta.cash`` by default.
        timeout: Seconds to wait for an answer. 15 by default.
        rate_limit_retries: How many times a call that gets ``429 too fast`` is
            sent again, each after the ``retryAfter`` seconds the answer gives.
            3 by default. 0 raises the first 429.
        rate_limit_max_wait: The longest ``retryAfter`` the client waits out, in
            seconds. A 429 that asks for longer is raised. 60 by default.
        network_retries: How many times a call that is safe to send twice is
            sent again after a network error, a timeout or a 5xx. 2 by default.
        session: A ``requests.Session`` to send calls with. A new one by default.
        sleep: The function the client waits with. ``time.sleep`` by default.
    """

    def __init__(
        self,
        key: str,
        base_url: str = DEFAULT_BASE_URL,
        *,
        timeout: float = 15.0,
        rate_limit_retries: int = 3,
        rate_limit_max_wait: float = 60.0,
        network_retries: int = 2,
        session: Optional[requests.Session] = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        if not isinstance(key, str) or not key.strip():
            raise ValueError("key: your eta API key, eta_<id>_<secret>")
        self._key = key.strip()
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.rate_limit_retries = rate_limit_retries
        self.rate_limit_max_wait = rate_limit_max_wait
        self.network_retries = network_retries
        self._session = session if session is not None else requests.Session()
        self._sleep = sleep
        self.rate_limit: Optional[RateLimit] = None
        """The newest ``X-RateLimit-*`` values, or ``None`` before the first answer that had them."""
        self.last_request_id: Optional[str] = None
        """The ``X-Request-Id`` of the newest answer."""

    def __repr__(self) -> str:
        return f"EtaClient(key={_mask(self._key)!r}, base_url={self.base_url!r})"

    def __enter__(self) -> "EtaClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self._session.close()

    # ---------- reads ----------

    def me(self) -> Me:
        """Your own account: cash, positions, resting orders, newest fills, notes and earnings. ``GET /me``"""
        return cast(Me, self._get("/me"))

    def bootstrap(self) -> Bootstrap:
        """Everything the app loads when it opens. It is large: a bot that needs its own account reads :meth:`me`. ``GET /bootstrap``"""
        return cast(Bootstrap, self._get("/bootstrap"))

    def markets(self) -> List[Market]:
        """Every market eta lists, with its price and moves. Narratives are not in it. ``GET /markets``"""
        return cast(List[Market], self._get("/markets"))

    def trades(self, sym: str, n: Optional[int] = None) -> List[Fill]:
        """A market's trades, newest first. ``n``: how many, 100 by default, 5,000 at most. ``GET /trades/:sym``"""
        return cast(List[Fill], self._get(f"/trades/{_seg(sym)}", {"n": n}))

    def flows(self, sym: str) -> List[Flow]:
        """A market's last 24 hours by kind of trader. ``GET /flows/:sym``"""
        return cast(List[Flow], self._get(f"/flows/{_seg(sym)}"))

    def fills(self, handle: str) -> List[PersonFill]:
        """A person's newest trades, at most 200. ``GET /fills/:handle``"""
        return cast(List[PersonFill], self._get(f"/fills/{_seg(handle)}"))

    def stats(self, handle: str, days: Optional[int] = None) -> Union[Stats, StatsHidden]:
        """A person's PnL, volume, trades, win rate, rank and calendar. ``days``: 0 (all time), 1, 7 or 30. ``GET /stats/:handle``"""
        return cast(Union[Stats, StatsHidden], self._get(f"/stats/{_seg(handle)}", {"days": days}))

    def board(self, by: Optional[str] = None, days: Optional[int] = None, n: Optional[int] = None) -> Board:
        """The top traders. ``by``: ``pnl``, ``volume`` or ``winrate``. ``GET /board``"""
        return cast(Board, self._get("/board", {"by": by, "days": days, "n": n}))

    def narrative_history(self, sym: str, days: Optional[float] = None) -> List[PricePoint]:
        """A narrative's saved prices, oldest first, the price now last. ``GET /narrative/:sym/history``"""
        return cast(List[PricePoint], self._get(f"/narrative/{_seg(sym)}/history", {"days": days}))

    def narrative_versions(self, sym: str) -> List[RulesetVersion]:
        """Every version of a narrative's thesis, rule and plan, newest first. ``GET /narrative/:sym/versions``"""
        return cast(List[RulesetVersion], self._get(f"/narrative/{_seg(sym)}/versions"))

    def follows(self, handle: str) -> Follows:
        """Who follows a person, and whom they follow. ``GET /follows/:handle``"""
        return cast(Follows, self._get(f"/follows/{_seg(handle)}"))

    def file(self, id: str) -> bytes:
        """A picture's bytes. Takes its id or the ``url`` an upload gave. ``GET /files/:id``"""
        file_id = id.rstrip("/").rsplit("/", 1)[-1]
        return cast(bytes, self._request("GET", f"/files/{_seg(file_id)}", retry=True, raw=True))

    # ---------- posts ----------

    def post(
        self,
        text: Optional[str] = None,
        *,
        home: Optional[str] = None,
        thesis: Optional[bool] = None,
        id: Optional[str] = None,
        images: Optional[Iterable[str]] = None,
        gif: Optional[str] = None,
        link: Optional[str] = None,
        quote: Optional[str] = None,
        qrooms: Optional[Iterable[str]] = None,
    ) -> PostAnswer:
        """Posts as your account, in a market's room (``home``) or on your profile.

        With your own ``id``, sending the same post again makes no second one, so the
        client retries it after a network error. Scope ``post``.
        """
        body = {"type": "post", "text": text, "home": home, "thesis": thesis, "id": id, "images": _list(images),
                "gif": gif, "link": link, "quote": quote, "qrooms": _list(qrooms)}
        return cast(PostAnswer, self.act(_drop_none(body)))

    def reply(
        self,
        key: str,
        text: Optional[str] = None,
        *,
        to: Optional[str] = None,
        id: Optional[str] = None,
        images: Optional[Iterable[str]] = None,
        gif: Optional[str] = None,
        link: Optional[str] = None,
    ) -> ReplyAnswer:
        """Replies to a post (``key="r:post:<post id>"``) or another reply. Scope ``post``."""
        body = {"type": "reply", "key": key, "text": text, "to": to, "id": id, "images": _list(images),
                "gif": gif, "link": link}
        return cast(ReplyAnswer, self.act(_drop_none(body)))

    def delete_post(self, id: str) -> OkAnswer:
        """Deletes one of your posts. Scope ``post``."""
        return cast(OkAnswer, self.act({"type": "deletePost", "id": id}))

    def upload(self, picture: Union[bytes, bytearray, memoryview, str, "os.PathLike[str]", BinaryIO],
               content_type: Optional[str] = None) -> Upload:
        """Uploads a picture (PNG, JPEG, WebP or GIF, up to 5 MB): bytes, a path, or an open file.

        Put the ``url`` it answers in a post's ``images`` or a narrative's ``pic``. Scope ``post`` or ``creator``.
        """
        data = _read_bytes(picture)
        return cast(Upload, self._request("POST", "/files", data=data, content_type=content_type or _sniff(data),
                                          retry=True))

    # ---------- creator ----------

    def launch(
        self,
        sym: str,
        comps: Sequence[Leg],
        cap: float,
        *,
        name: Optional[str] = None,
        theme: Optional[str] = None,
        desc: Optional[str] = None,
        thesis: Optional[str] = None,
        rule: Optional[str] = None,
        plan: Optional[str] = None,
        bounds: Optional[Bounds] = None,
        vote_minutes: Optional[int] = None,
        veto_minutes: Optional[int] = None,
        fee: Optional[str] = None,
        tags: Optional[Iterable[str]] = None,
        links: Optional[Iterable[str]] = None,
        pic: Optional[str] = None,
        price: Optional[float] = None,
    ) -> LaunchAnswer:
        """Launches a narrative from markets on eta. ``comps``: ``[(symbol, weight), ...]``, summing to 100. Scope ``creator``."""
        body = {
            "type": "launch", "sym": sym, "comps": [list(c) for c in comps], "cap": cap, "name": name, "theme": theme,
            "desc": desc, "thesis": thesis, "rule": rule, "plan": plan,
            "bounds": {k: list(v) for k, v in bounds.items()} if bounds is not None else None,
            "voteMinutes": vote_minutes, "vetoMinutes": veto_minutes, "fee": fee, "tags": _list(tags),
            "links": _list(links), "pic": pic, "price": price,
        }
        return cast(LaunchAnswer, self.act(_drop_none(body)))

    def edit(
        self,
        sym: str,
        *,
        thesis: Any = UNSET,
        rule: Any = UNSET,
        plan: Any = UNSET,
        pic: Any = UNSET,
        fee: Any = UNSET,
        vote_minutes: Any = UNSET,
        veto_minutes: Any = UNSET,
    ) -> OkAnswer:
        """Changes what a creator changes alone on a narrative you launched (``narrEdit``).

        Send only what changes. ``""`` clears ``thesis``, ``rule``, ``plan`` or ``pic``.
        ``vote_minutes=None`` or ``veto_minutes=None`` goes back to the server's own. Scope ``creator``.
        """
        body: Dict[str, Any] = {"type": "narrEdit", "sym": sym}
        for name, value in (("thesis", thesis), ("rule", rule), ("plan", plan), ("pic", pic), ("fee", fee),
                            ("voteMinutes", vote_minutes), ("vetoMinutes", veto_minutes)):
            if value is not UNSET:
                body[name] = value
        return cast(OkAnswer, self.act(body))

    def propose(
        self,
        sym: str,
        changes: Optional[Sequence[Change]] = None,
        *,
        fee: Optional[float] = None,
        title: Optional[str] = None,
        why: Optional[str] = None,
    ) -> ProposeAnswer:
        """Puts a change to the legs, the bounds or the fee to the holders' vote.

        ``changes``: ``[(symbol, from, to), ...]`` or ``(symbol, from, to, low, high)``. Scope ``creator``.
        """
        body = {"type": "propose", "sym": sym, "changes": [list(c) for c in changes] if changes is not None else None,
                "fee": fee, "title": title, "why": why}
        return cast(ProposeAnswer, self.act(_drop_none(body)))

    def sim(
        self,
        sym: str,
        *,
        days: Optional[float] = None,
        seed: Optional[float] = None,
        volume_per_day: Optional[float] = None,
        holders: Optional[float] = None,
        aum: Optional[float] = None,
        mood: Optional[str] = None,
        referred_share: Optional[float] = None,
    ) -> SimResult:
        """Runs a narrative you launched forward on made-up flow. Nothing is kept. Scope ``creator``."""
        body = {"days": days, "seed": seed, "volumePerDay": volume_per_day, "holders": holders, "aum": aum,
                "mood": mood, "referredShare": referred_share}
        return cast(SimResult, self._request("POST", f"/sim/{_seg(sym)}", body=_drop_none(body), retry=True))

    # ---------- trade ----------

    def quote(
        self,
        sym: Optional[str] = None,
        side: Optional[str] = None,
        usd: Optional[float] = None,
        *,
        lev: Optional[float] = None,
        path: Optional[str] = None,
        close_id: Optional[str] = None,
        frac: Optional[float] = None,
        qty: Optional[float] = None,
    ) -> Quote:
        """What an order (``sym``, ``side``, ``usd``) or a close (``close_id``) would cost now.

        The ``quoteId`` holds 15 seconds, for one order. Scope ``trade``.
        """
        if close_id is not None:
            if sym is not None or side is not None or usd is not None:
                raise ValueError("quote: sym, side and usd for an order, or close_id for a close, not both")
            body = {"closeId": close_id, "frac": frac, "qty": qty}
        else:
            if sym is None or side is None or usd is None:
                raise ValueError("quote: sym, side and usd for an order, or close_id for a close")
            body = {"sym": sym, "side": side, "usd": usd, "lev": lev, "path": path}
        return cast(Quote, self._request("POST", "/quote", body=_drop_none(body), retry=True))

    def order(
        self,
        sym: str,
        side: str,
        usd: float,
        *,
        lev: Optional[float] = None,
        quote_id: Optional[str] = None,
        max_slippage_pct: Optional[float] = None,
        limit: Optional[float] = None,
        tp: Optional[float] = None,
        sl: Optional[float] = None,
        path: Optional[str] = None,
        client_id: Optional[str] = None,
    ) -> OrderAnswer:
        """Buys, sells, opens a perp, or takes a side on a prediction. With ``limit`` it rests.

        Every order carries a ``clientId``: yours, or a new uuid. A network error, a
        timeout or a 5xx sends it again with the same ``clientId``, so it can't trade
        twice. Scope ``trade``.
        """
        body = {"type": "order", "sym": sym, "side": side, "usd": usd, "lev": lev, "quoteId": quote_id,
                "maxSlippagePct": max_slippage_pct, "limit": limit, "tp": tp, "sl": sl, "path": path,
                "clientId": client_id}
        return cast(OrderAnswer, self.act(_drop_none(body)))

    def cancel(self, id: Optional[str] = None, *, client_id: Optional[str] = None) -> OkAnswer:
        """Cancels one of your resting limit orders, by its ``id`` or its ``client_id``. Scope ``trade``."""
        if (id is None) == (client_id is None):
            raise ValueError("cancel: id or client_id, one of the two")
        return cast(OkAnswer, self.act(_drop_none({"type": "cancel", "id": id, "clientId": client_id})))

    def cancel_all(self, sym: Optional[str] = None) -> CancelAllAnswer:
        """Cancels all your resting limit orders, or all on one market. Answers how many. Scope ``trade``."""
        return cast(CancelAllAnswer, self.act(_drop_none({"type": "cancelAll", "sym": sym})))

    def close(
        self,
        id: str,
        *,
        frac: Optional[float] = None,
        qty: Optional[float] = None,
        quote_id: Optional[str] = None,
        max_slippage_pct: Optional[float] = None,
        client_id: Optional[str] = None,
    ) -> CloseAnswer:
        """Closes all or part (``frac`` or ``qty``) of a position, by its ``id`` from :meth:`me`.

        Like :meth:`order`, it always carries a ``clientId`` and is retried safely. Scope ``trade``.
        """
        body = {"type": "close", "id": id, "frac": frac, "qty": qty, "quoteId": quote_id,
                "maxSlippagePct": max_slippage_pct, "clientId": client_id}
        return cast(CloseAnswer, self.act(_drop_none(body)))

    # ---------- any action, the stream ----------

    def act(self, action: Mapping[str, Any]) -> Dict[str, Any]:
        """Sends one action to ``POST /act`` as it is, such as ``{"type": "order", ...}``.

        An ``order`` or ``close`` with no ``clientId`` gets a new one. It is retried after
        a network error, a timeout or a 5xx when sending it twice can't act twice: an
        ``order`` or a ``close`` (by its ``clientId``), and a ``post`` or ``reply`` with your own ``id``.
        """
        body = dict(action)
        kind = body.get("type")
        if not isinstance(kind, str) or not kind:
            raise ValueError("action: needs a type, such as 'order'")
        client_id: Optional[str] = None
        if kind in ("order", "close"):
            if not body.get("clientId"):
                body["clientId"] = new_client_id()
            client_id = str(body["clientId"])
        retry = kind in ("order", "close") or (kind in ("post", "reply") and bool(body.get("id")))
        return cast(Dict[str, Any], self._request("POST", "/act", body=body, retry=retry, client_id=client_id))

    def stream(self, channels: Iterable[str] = ("account",), syms: Optional[Iterable[str]] = None,
               **options: Any) -> "EtaStream":
        """A stream of your fills, orders and record (``account``) and prices (``marks``).

        Use it as ``async for frame in client.stream(["account", "marks"], syms=["HYPE"])``.
        See :class:`eta_api.EtaStream` for the options.
        """
        from .stream import EtaStream

        return EtaStream(self, channels=channels, syms=syms, **options)

    # ---------- the wire ----------

    def _get(self, path: str, params: Optional[Mapping[str, Any]] = None) -> Any:
        return self._request("GET", path, params=params, retry=True)

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Mapping[str, Any]] = None,
        body: Any = _NO_BODY,
        data: Optional[bytes] = None,
        content_type: Optional[str] = None,
        retry: bool = False,
        client_id: Optional[str] = None,
        raw: bool = False,
    ) -> Any:
        url = self.base_url + path
        headers = {
            "Authorization": f"Bearer {self._key}",
            "Accept": "application/json",
            "User-Agent": f"eta-api-python/{__version__}",
        }
        payload: Optional[bytes] = None
        if body is not _NO_BODY:
            payload = json.dumps(body, separators=(",", ":"), allow_nan=False).encode()
            headers["Content-Type"] = "application/json"
        elif data is not None:
            payload = data
            headers["Content-Type"] = content_type or "application/octet-stream"
        query = {k: v for k, v in (params or {}).items() if v is not None}

        rate_limited = 0
        failed = 0
        while True:
            try:
                r = self._session.request(method, url, params=query or None, data=payload, headers=headers,
                                          timeout=self.timeout)
            except _NETWORK_ERRORS as exc:
                if retry and failed < self.network_retries:
                    self._sleep(_backoff(failed))
                    failed += 1
                    continue
                raise EtaError(0, "network", fields={"detail": _describe(exc)}, client_id=client_id) from exc
            except requests.RequestException as exc:
                raise EtaError(0, "network", fields={"detail": _describe(exc)}, client_id=client_id) from exc

            self._note(r)
            if r.status_code == 429 and rate_limited < self.rate_limit_retries:
                wait = _retry_after(r)
                if wait <= self.rate_limit_max_wait:
                    self._sleep(wait)
                    rate_limited += 1
                    continue
            if r.status_code >= 500 and retry and failed < self.network_retries:
                self._sleep(_backoff(failed))
                failed += 1
                continue
            if r.status_code >= 400:
                raise _error_of(r, client_id)
            if raw:
                return r.content
            try:
                return r.json()
            except ValueError:
                raise EtaError(r.status_code, "not JSON", body=r.text[:500], request_id=r.headers.get("X-Request-Id"),
                               client_id=client_id) from None

    def _note(self, r: requests.Response) -> None:
        request_id = r.headers.get("X-Request-Id")
        if request_id:
            self.last_request_id = request_id
        limit = _int(r.headers.get("X-RateLimit-Limit"))
        remaining = _int(r.headers.get("X-RateLimit-Remaining"))
        reset = _int(r.headers.get("X-RateLimit-Reset"))
        if limit is not None and remaining is not None and reset is not None:
            self.rate_limit = RateLimit(limit=limit, remaining=remaining, reset=reset)


# ---------- helpers ----------

def _mask(key: str) -> str:
    m = _KEY_ID.match(key)
    return f"eta_{m.group(1)}_..." if m else "..."


def _seg(value: Any) -> str:
    return _url_quote(str(value), safe="")


def _drop_none(body: Mapping[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in body.items() if v is not None}


def _list(values: Optional[Iterable[Any]]) -> Optional[List[Any]]:
    return list(values) if values is not None else None


def _int(value: Optional[str]) -> Optional[int]:
    try:
        return int(value) if value is not None else None
    except ValueError:
        return None


def _backoff(failed: int) -> float:
    return min(0.5 * (2 ** failed), 8.0)


def _describe(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {exc}"[:300]


def _retry_after(r: requests.Response) -> float:
    try:
        answer = r.json()
    except ValueError:
        answer = None
    if isinstance(answer, dict) and isinstance(answer.get("retryAfter"), (int, float)):
        return max(float(answer["retryAfter"]), 0.0)
    header = _int(r.headers.get("Retry-After"))
    return float(header) if header is not None and header >= 0 else 1.0


def _error_of(r: requests.Response, client_id: Optional[str]) -> EtaError:
    try:
        body: Any = r.json()
    except ValueError:
        body = r.text
    if isinstance(body, dict) and isinstance(body.get("err"), str):
        err = body["err"]
        fields = {k: v for k, v in body.items() if k != "err"}
    else:
        text = body if isinstance(body, str) else json.dumps(body)
        err = text.strip()[:200] or f"HTTP {r.status_code}"
        fields = {}
    return EtaError(r.status_code, err, fields=fields, request_id=r.headers.get("X-Request-Id"),
                    client_id=client_id, body=body)


def _read_bytes(picture: Any) -> bytes:
    if isinstance(picture, (bytes, bytearray, memoryview)):
        return bytes(picture)
    if isinstance(picture, (str, os.PathLike)):
        with open(picture, "rb") as f:
            return f.read()
    if hasattr(picture, "read"):
        return bytes(picture.read())
    raise TypeError("upload: bytes, a path, or a file open in binary mode")


def _sniff(data: bytes) -> str:
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return "application/octet-stream"
