"""Types for eta's main objects, taken from the API's OpenAPI spec.

Every answer is a plain ``dict`` as eta sends it. These TypedDicts name its
fields for your editor and type checker. Nothing checks them at run time, and a
field eta adds later comes through as it is.

A class named ``_XBase`` holds the fields that are always there; ``X`` adds the
ones that may be missing.
"""
from __future__ import annotations

from typing import Any, Dict, List, Literal, Optional, Tuple, TypedDict, Union

Side = Literal["buy", "sell", "long", "short", "yes", "no"]
"""``buy``/``sell`` for spot, real-world assets and narratives; ``long``/``short`` for perps; ``yes``/``no`` for predictions."""
Kind = Literal["spot", "perp", "rwa", "prediction", "narrative"]
NarrativePath = Literal["mint", "swap", "redeem"]
Channel = Literal["account", "marks"]
Scope = Literal["read", "post", "creator", "trade"]

Leg = Tuple[str, float]
"""``[symbol, weight]``: a market on eta (or ``USDC``) and its weight in percent."""
Change = Tuple[Any, ...]
"""``[symbol, from, to]``, or ``[symbol, from, to, low, high]`` to set new bounds."""
Bounds = Dict[str, Tuple[float, float]]
"""Each leg's bounds, as ``{"HYPE": [55, 65]}``."""


# ---------- trades ----------

class _FillBase(TypedDict):
    id: str
    who: str
    sym: str
    side: str
    usd: float
    qty: float
    price: float
    at: int


class Fill(_FillBase, total=False):
    """A trade as you may see it (``GET /trades/:sym``, the ``tape``)."""
    pnl: float
    close: bool
    partial: bool
    heldSide: str
    path: str


class _FeeSplitBase(TypedDict):
    total: float


class FeeSplit(_FeeSplitBase, total=False):
    lp: float
    creator: float
    eta: float
    partner: float
    discount: float


class _TradeFillBase(Fill):
    u: str


class TradeFill(_TradeFillBase, total=False):
    """Your fill, as an order or a close answers it."""
    fee: FeeSplit
    clientId: str


class StreamFill(Fill, total=False):
    """Your fill on the stream: a trade as ``GET /trades/:sym`` lists it, with its ``clientId``."""
    clientId: str


class _PersonFillBase(TypedDict):
    id: str
    sym: str
    side: str
    usd: float
    qty: float
    price: float
    at: int


class PersonFill(_PersonFillBase, total=False):
    """A person's trade (``GET /fills/:handle``)."""
    close: bool
    pnl: float


# ---------- your record ----------

class _MyFillBase(TypedDict):
    id: str
    sym: str
    side: str
    usd: float
    qty: float
    price: float
    at: int
    cash: float
    fee: float


class MyFill(_MyFillBase, total=False):
    """One of your fills in ``me()``."""
    pnl: float
    close: bool
    partial: bool
    path: str
    heldSide: str
    why: str
    clientId: str


class _PositionBase(TypedDict):
    id: str
    u: str
    sym: str
    kind: Kind
    side: str
    qty: float
    entry: float
    usd: float
    at: int


class Position(_PositionBase, total=False):
    """What you hold. ``id`` is what ``close`` takes."""
    lev: float
    tp: float
    sl: float


class _RestingOrderBase(TypedDict):
    id: str
    sym: str
    side: Side
    usd: float
    limit: float
    at: int


class RestingOrder(_RestingOrderBase, total=False):
    """A resting limit order. ``id`` (or ``clientId``) is what ``cancel`` takes."""
    u: str
    lev: float
    tp: float
    sl: float
    reserve: float
    clientId: str


class _NoteBase(TypedDict):
    kind: Literal["trade", "social", "vote", "alert"]
    text: str
    at: int


class Note(_NoteBase, total=False):
    id: str
    open: Dict[str, str]
    read: bool


class _PicBase(TypedDict):
    kind: Literal["photo", "pixel"]


class Pic(_PicBase, total=False):
    url: str
    traits: Any


class _MeUserBase(TypedDict):
    handle: str
    name: str
    bio: str
    code: str
    cash: float
    showHoldings: bool
    showPnl: bool
    codeUses: int
    followers: int
    following: int


class MeUser(_MeUserBase, total=False):
    pic: Pic
    login: str
    persona: str


class CreatorNarrativeEarnings(TypedDict, total=False):
    sym: str
    swap: float
    yearly: float
    volume24: float


class CreatorEarnings(TypedDict):
    accrued: float
    claimed: float
    swap: float
    yearly: float
    narratives: List[CreatorNarrativeEarnings]


class Referee(TypedDict, total=False):
    who: str
    volume: float
    earned: float


class ReferralEarnings(TypedDict):
    accrued: float
    claimed: float
    uses: int
    referees: List[Referee]


class Earnings(TypedDict):
    creator: CreatorEarnings
    referral: ReferralEarnings


class Me(TypedDict):
    """Your own account (``GET /me``)."""
    fees: Dict[str, float]
    referred: bool
    earnings: Earnings
    reserved: float
    user: MeUser
    bag: Dict[str, Any]
    positions: List[Position]
    orders: List[RestingOrder]
    fills: List[MyFill]
    notes: List[Note]
    votes: List[Tuple[str, bool]]


# ---------- reads ----------

class Flow(TypedDict):
    group: Literal["creator", "following", "top", "whales", "new", "others"]
    bought: float
    sold: float
    people: int


class Totals(TypedDict):
    trades: int
    closed: int
    wins: int
    winRate: Optional[float]
    volume: float
    pnl: float


class CalendarDay(TypedDict):
    day: str
    pnl: float
    trades: int


class Stats(Totals):
    """A person's numbers (``GET /stats/:handle``)."""
    handle: str
    days: int
    rank: Optional[int]
    calendar: List[CalendarDay]
    all: Totals


class StatsHidden(TypedDict):
    """A person who hides their PnL from you."""
    handle: str
    days: int
    hidden: Literal[True]


class BoardRow(TypedDict):
    rank: int
    handle: str
    pnl: float
    volume: float
    winRate: Optional[float]
    trades: int


class Board(TypedDict):
    rows: List[BoardRow]
    me: Optional[BoardRow]
    total: int


class PricePoint(TypedDict):
    t: int
    p: float


class _RulesetVersionBase(TypedDict):
    at: int


class RulesetVersion(_RulesetVersionBase, total=False):
    thesis: str
    rule: str
    plan: str


class Follows(TypedDict):
    followers: List[str]
    following: List[str]


class _MarketBase(TypedDict):
    sym: str
    kind: Literal["spot", "perp", "rwa", "prediction"]
    price: float


class Market(_MarketBase, total=False):
    """A market eta lists (``GET /markets``)."""
    name: str
    d24: float
    d1h: float
    d7d: float
    vol24: float
    cat: str
    listedAt: int
    logo: str
    chain: str
    address: str
    launchpad: str
    liq: float
    mcap: float
    maxLev: float
    funding: float
    oi: float
    underlying: str
    issuer: str
    hours: str
    question: str
    rules: str
    source: str
    ends: str
    endsAt: int
    startAt: int
    league: str
    closed: Literal[True]
    noQuote: str
    quality: bool
    pinned: Literal[True]
    info: bool
    own: Literal[True]
    mark: str
    coin: str
    src: Literal["hl", "gt", "pm"]
    ext: str


class _ProposalBase(TypedDict):
    id: str
    sym: str
    title: str
    why: str
    changes: List[Change]
    by: str
    yes: float
    no: float
    voters: int
    at: int
    ends: int
    state: Literal["open", "passed", "failed"]


class Proposal(_ProposalBase, total=False):
    fee: float
    bar: Literal["low", "high"]
    minutes: int


class _NarrativeBase(TypedDict):
    sym: str
    name: str
    by: str
    comps: List[Leg]


class Narrative(_NarrativeBase, total=False):
    cap: float
    bounds: Bounds
    fee: str
    voteMinutes: int
    vetoMinutes: int
    aum: float
    holders: int
    d24: float
    d1h: float
    d7d: float
    thesis: str
    rule: str
    plan: str
    theme: str
    desc: str
    links: List[str]
    tags: List[str]
    pic: str
    logo: str
    price: float
    at: int
    versions: int
    pool: Dict[str, float]
    premiumPct: Optional[float]
    own: float
    creatorFees: float
    lev: Dict[str, float]
    noQuote: Dict[str, Any]
    gearing: float
    cycle: float
    settings: Dict[str, float]


class _ProfileBase(TypedDict):
    handle: str
    name: str
    bio: str
    at: int
    followers: int
    following: int
    seed: bool


class Profile(_ProfileBase, total=False):
    pic: Pic
    pnlHidden: Literal[True]


class _PostBase(TypedDict):
    id: str
    home: str
    who: str
    text: str
    at: int


class Post(_PostBase, total=False):
    thesis: bool
    images: List[str]
    gif: str
    link: str
    pxAt: List[Tuple[str, float]]
    quote: str
    qrooms: List[str]
    qwho: str
    qtext: str
    onX: bool
    backAt: int


class _ReplyBase(TypedDict):
    id: str
    key: str
    who: str
    text: str
    at: int


class Reply(_ReplyBase, total=False):
    to: str
    images: List[str]
    gif: str
    link: str


class Counts(TypedDict):
    liked: int
    saved: int
    reposted: int
    likes: int
    commentReposts: int
    replyReposts: int
    up: int
    down: int
    replies: int
    bull: int
    bear: int


class _HolderBase(TypedDict):
    who: str
    side: Literal["buy", "long", "short", "yes", "no"]
    qty: float


class Holder(_HolderBase, total=False):
    usd: float
    entry: float


class NewsItem(TypedDict):
    title: str
    src: str
    t: str
    at: int
    tags: List[str]
    move: str
    link: str


class Activity(TypedDict):
    trades24: int
    traders24: int


class _RepostBase(TypedDict):
    key: str
    who: str
    at: int


class Repost(_RepostBase, total=False):
    post: Post


class _BootstrapBase(TypedDict):
    me: Optional[Me]
    users: List[Profile]
    posts: List[Post]
    replies: Dict[str, List[Reply]]
    counts: Dict[str, Counts]
    tape: List[Fill]
    activity: Dict[str, Activity]
    proposals: List[Proposal]
    narratives: List[Narrative]
    marks: Dict[str, float]
    holders: Dict[str, List[Holder]]
    news: List[NewsItem]
    markets: List[Market]
    limits: Dict[str, Any]


class Bootstrap(_BootstrapBase, total=False):
    """What the app loads when it opens (``GET /bootstrap``)."""
    reposts: List[Repost]


# ---------- trade, files, sim ----------

class _QuoteBase(TypedDict):
    sym: str
    side: str
    mark: float
    quoteId: str
    expires: int
    price: float
    impactPct: float
    fee: float
    feeUsd: float
    get: float
    qty: float
    usd: float
    source: Literal["book", "estimate", "pool", "nav"]


class Quote(_QuoteBase, total=False):
    """What an order or a close would cost now. ``quoteId`` holds 15 seconds, for one order."""
    afford: bool
    capped: Literal[True]
    beyondBook: Literal[True]
    path: NarrativePath
    nav: float
    premiumPct: Optional[float]
    lpFeeUsd: float
    protocolFeeUsd: float
    builderFeeUsd: float
    pool: Optional[Dict[str, float]]


class Upload(TypedDict):
    """``url`` goes in a post's ``images`` or a narrative's ``pic``."""
    url: str


class SimResult(TypedDict):
    days: int
    seed: int
    sym: str
    yearlyRate: float
    start: Dict[str, float]
    params: Dict[str, Any]
    events: List[Dict[str, Any]]
    end: Dict[str, float]


# ---------- answers from POST /act ----------

class OkAnswer(TypedDict):
    ok: Literal[True]


class _PostAnswerBase(OkAnswer):
    id: str


class PostAnswer(_PostAnswerBase, total=False):
    again: Literal[True]


class ReplyAnswer(OkAnswer, total=False):
    id: str
    again: Literal[True]


class LaunchAnswer(OkAnswer):
    sym: str


class ProposeAnswer(OkAnswer):
    id: str
    ends: int
    bar: Literal["low", "high"]


class _OrderFilledBase(OkAnswer):
    fill: TradeFill


class OrderFilledAnswer(_OrderFilledBase, total=False):
    repeat: Literal[True]


class _OrderRestingBase(OkAnswer):
    id: str
    open: Literal[True]


class OrderRestingAnswer(_OrderRestingBase, total=False):
    clientId: str
    repeat: Literal[True]


OrderAnswer = Union[OrderFilledAnswer, OrderRestingAnswer]
"""``fill`` when it filled now; ``id`` and ``open`` when it rests (with ``limit``)."""


class _CloseAnswerBase(OkAnswer):
    fill: TradeFill
    got: float


class CloseAnswer(_CloseAnswerBase, total=False):
    repeat: Literal[True]


class CancelAllAnswer(OkAnswer):
    cancelled: int


# ---------- stream frames ----------

class ReadyFrame(TypedDict):
    type: Literal["ready"]
    handle: str


class _SubscribedFrameBase(TypedDict):
    type: Literal["subscribed"]
    channels: List[Channel]


class SubscribedFrame(_SubscribedFrameBase, total=False):
    syms: List[str]


class FillFrame(TypedDict):
    type: Literal["fill"]
    fill: StreamFill


class _OrderFrameBase(TypedDict):
    type: Literal["order"]
    event: Literal["opened", "cancelled", "filled"]
    order: RestingOrder


class OrderFrame(_OrderFrameBase, total=False):
    fill: str
    why: str


class MeFrame(TypedDict):
    type: Literal["me"]
    me: Me


class MarksFrame(TypedDict):
    type: Literal["marks"]
    marks: Dict[str, float]


class _ErrorFrameBase(TypedDict):
    type: Literal["error"]
    err: str


class ErrorFrame(_ErrorFrameBase, total=False):
    syms: List[str]
    retryAfter: int
    max: int


class ResyncFrame(TypedDict):
    """Made by the SDK, not eta: after a reconnect, your record read again with ``GET /me``."""
    type: Literal["resync"]
    me: Me


class ClosedFrame(TypedDict):
    """Made by the SDK, not eta: the stream dropped and connects again in ``wait`` seconds."""
    type: Literal["closed"]
    code: Optional[int]
    err: Optional[str]
    wait: float


Frame = Union[
    ReadyFrame, SubscribedFrame, FillFrame, OrderFrame, MeFrame, MarksFrame, ErrorFrame, ResyncFrame, ClosedFrame
]
