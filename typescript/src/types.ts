/**
 * Types for eta's main objects, taken from the API's OpenAPI spec.
 *
 * Every answer is the JSON eta sends. These interfaces name its fields. Nothing checks them at run time, and a field eta adds
 * later comes through as it is.
 */

/** `buy`/`sell` for spot, real-world assets and narratives; `long`/`short` for perps; `yes`/`no` for predictions. */
export type Side = "buy" | "sell" | "long" | "short" | "yes" | "no";
export type Kind = "spot" | "perp" | "rwa" | "prediction" | "narrative";
export type NarrativePath = "mint" | "swap" | "redeem";
export type Channel = "account" | "marks";
export type Scope = "read" | "post" | "creator" | "trade";

/** `[symbol, weight]`: a market on eta (or `USDC`) and its weight in percent. */
export type Leg = [symbol: string, weight: number];
/** `[symbol, from, to]`, or `[symbol, from, to, low, high]` to set new bounds. */
export type Change = [symbol: string, from: number, to: number] | [symbol: string, from: number, to: number, low: number, high: number];
/** Each leg's bounds, as `{ "HYPE": [55, 65] }`. */
export type Bounds = Record<string, [low: number, high: number]>;

// ---------- trades ----------

/** A trade as you may see it (`GET /trades/:sym`, the `tape`). */
export interface Fill {
  id: string;
  who: string;
  sym: string;
  side: string;
  usd: number;
  qty: number;
  price: number;
  at: number;
  pnl?: number;
  close?: boolean;
  partial?: boolean;
  heldSide?: string;
  path?: string;
}

export interface FeeSplit {
  total: number;
  lp?: number;
  creator?: number;
  eta?: number;
  partner?: number;
  discount?: number;
}

/** Your fill, as an order or a close answers it. */
export interface TradeFill extends Fill {
  u: string;
  fee?: FeeSplit;
  clientId?: string;
}

/** Your fill on the stream: a trade as `GET /trades/:sym` lists it, with its `clientId`. */
export interface StreamFill extends Fill {
  clientId?: string;
}

/** A person's trade (`GET /fills/:handle`). */
export interface PersonFill {
  id: string;
  sym: string;
  side: string;
  usd: number;
  qty: number;
  price: number;
  at: number;
  close?: boolean;
  pnl?: number;
}

// ---------- your record ----------

/** One of your fills in `me()`. */
export interface MyFill {
  id: string;
  sym: string;
  side: string;
  usd: number;
  qty: number;
  price: number;
  at: number;
  cash: number;
  fee: number;
  pnl?: number;
  close?: boolean;
  partial?: boolean;
  path?: string;
  heldSide?: string;
  why?: string;
  clientId?: string;
}

/** What you hold. `id` is what `close` takes. */
export interface Position {
  id: string;
  u: string;
  sym: string;
  kind: Kind;
  side: string;
  qty: number;
  entry: number;
  usd: number;
  at: number;
  lev?: number;
  tp?: number;
  sl?: number;
}

/** A resting limit order. `id` (or `clientId`) is what `cancel` takes. */
export interface RestingOrder {
  id: string;
  sym: string;
  side: Side;
  usd: number;
  limit: number;
  at: number;
  u?: string;
  lev?: number;
  tp?: number;
  sl?: number;
  reserve?: number;
  clientId?: string;
}

export interface Note {
  kind: "trade" | "social" | "vote" | "alert";
  text: string;
  at: number;
  id?: string;
  open?: Record<string, string>;
  read?: boolean;
}

export interface Pic {
  kind: "photo" | "pixel";
  url?: string;
  traits?: unknown;
}

export interface MeUser {
  handle: string;
  name: string;
  bio: string;
  code: string;
  cash: number;
  showHoldings: boolean;
  showPnl: boolean;
  codeUses: number;
  followers: number;
  following: number;
  pic?: Pic;
  login?: string;
  persona?: string;
}

export interface Earnings {
  creator: {
    accrued: number;
    claimed: number;
    swap: number;
    yearly: number;
    narratives: { sym?: string; swap?: number; yearly?: number; volume24?: number }[];
  };
  referral: {
    accrued: number;
    claimed: number;
    uses: number;
    referees: { who?: string; volume?: number; earned?: number }[];
  };
}

/** Your own account (`GET /me`). */
export interface Me {
  fees: Record<string, number>;
  referred: boolean;
  earnings: Earnings;
  reserved: number;
  user: MeUser;
  bag: Record<string, unknown>;
  positions: Position[];
  orders: RestingOrder[];
  fills: MyFill[];
  notes: Note[];
  votes: [proposalId: string, yes: boolean][];
}

// ---------- reads ----------

export interface Flow {
  group: "creator" | "following" | "top" | "whales" | "new" | "others";
  bought: number;
  sold: number;
  people: number;
}

export interface Totals {
  trades: number;
  closed: number;
  wins: number;
  winRate: number | null;
  volume: number;
  pnl: number;
}

/** A person's numbers (`GET /stats/:handle`). */
export interface Stats extends Totals {
  handle: string;
  days: 0 | 1 | 7 | 30;
  rank: number | null;
  calendar: { day: string; pnl: number; trades: number }[];
  all: Totals;
}

/** A person who hides their PnL from you. */
export interface StatsHidden {
  handle: string;
  days: 0 | 1 | 7 | 30;
  hidden: true;
}

export interface BoardRow {
  rank: number;
  handle: string;
  pnl: number;
  volume: number;
  winRate: number | null;
  trades: number;
}

export interface Board {
  rows: BoardRow[];
  me: BoardRow | null;
  total: number;
}

export interface PricePoint {
  t: number;
  p: number;
}

export interface RulesetVersion {
  at: number;
  thesis?: string;
  rule?: string;
  plan?: string;
}

export interface Follows {
  followers: string[];
  following: string[];
}

/** A market eta lists (`GET /markets`). */
export interface Market {
  sym: string;
  kind: "spot" | "perp" | "rwa" | "prediction";
  price: number;
  name?: string;
  d24?: number;
  d1h?: number;
  d7d?: number;
  vol24?: number;
  cat?: string;
  listedAt?: number;
  logo?: string;
  chain?: string;
  address?: string;
  launchpad?: string;
  liq?: number;
  mcap?: number;
  maxLev?: number;
  funding?: number;
  oi?: number;
  underlying?: string;
  issuer?: string;
  hours?: string;
  question?: string;
  rules?: string;
  source?: string;
  ends?: string;
  endsAt?: number;
  startAt?: number;
  league?: string;
  closed?: true;
  noQuote?: string;
  quality?: boolean;
  pinned?: true;
  info?: boolean;
  own?: true;
  mark?: string;
  coin?: string;
  src?: "hl" | "gt" | "pm";
  ext?: string;
}

export interface Proposal {
  id: string;
  sym: string;
  title: string;
  why: string;
  changes: Change[];
  by: string;
  yes: number;
  no: number;
  voters: number;
  at: number;
  ends: number;
  state: "open" | "passed" | "failed";
  fee?: number;
  bar?: "low" | "high";
  minutes?: number;
}

export interface Narrative {
  sym: string;
  name: string;
  by: string;
  comps: Leg[];
  cap?: number;
  bounds?: Bounds;
  fee?: string;
  voteMinutes?: number;
  vetoMinutes?: number;
  aum?: number;
  holders?: number;
  d24?: number;
  d1h?: number;
  d7d?: number;
  thesis?: string;
  rule?: string;
  plan?: string;
  theme?: string;
  desc?: string;
  links?: string[];
  tags?: string[];
  pic?: string;
  logo?: string;
  price?: number;
  at?: number;
  versions?: number;
  pool?: { usdc?: number; narr?: number; price?: number };
  premiumPct?: number | null;
  own?: number;
  creatorFees?: number;
  lev?: Record<string, number>;
  noQuote?: { leg: string; why: string; legs: { leg: string; why: string }[] };
  gearing?: number;
  cycle?: number;
  settings?: Record<string, number>;
}

export interface Profile {
  handle: string;
  name: string;
  bio: string;
  at: number;
  followers: number;
  following: number;
  seed: boolean;
  pic?: Pic;
  pnlHidden?: true;
}

export interface Post {
  id: string;
  home: string;
  who: string;
  text: string;
  at: number;
  thesis?: boolean;
  images?: string[];
  gif?: string;
  link?: string;
  pxAt?: [symbol: string, price: number][];
  quote?: string;
  qrooms?: string[];
  qwho?: string;
  qtext?: string;
  onX?: boolean;
  backAt?: number;
}

export interface Reply {
  id: string;
  key: string;
  who: string;
  text: string;
  at: number;
  to?: string;
  images?: string[];
  gif?: string;
  link?: string;
}

export interface Counts {
  liked: number;
  saved: number;
  reposted: number;
  likes: number;
  commentReposts: number;
  replyReposts: number;
  up: number;
  down: number;
  replies: number;
  bull: number;
  bear: number;
}

export interface Holder {
  who: string;
  side: "buy" | "long" | "short" | "yes" | "no";
  qty: number;
  usd?: number;
  entry?: number;
}

export interface NewsItem {
  title: string;
  src: string;
  t: string;
  at: number;
  tags: string[];
  move: string;
  link: string;
}

/** What the app loads when it opens (`GET /bootstrap`). */
export interface Bootstrap {
  me: Me | null;
  users: Profile[];
  posts: Post[];
  replies: Record<string, Reply[]>;
  counts: Record<string, Counts>;
  tape: Fill[];
  activity: Record<string, { trades24: number; traders24: number }>;
  proposals: Proposal[];
  narratives: Narrative[];
  marks: Record<string, number>;
  holders: Record<string, Holder[]>;
  news: NewsItem[];
  markets: Market[];
  limits: Record<string, unknown>;
  reposts?: { key: string; who: string; at: number; post?: Post }[];
}

// ---------- trade, files, sim ----------

/** What an order or a close would cost now. `quoteId` holds 15 seconds, for one order. */
export interface Quote {
  sym: string;
  side: string;
  mark: number;
  quoteId: string;
  expires: number;
  price: number;
  impactPct: number;
  fee: number;
  feeUsd: number;
  get: number;
  qty: number;
  usd: number;
  source: "book" | "estimate" | "pool" | "nav";
  afford?: boolean;
  capped?: true;
  beyondBook?: true;
  path?: NarrativePath;
  nav?: number;
  premiumPct?: number | null;
  lpFeeUsd?: number;
  protocolFeeUsd?: number;
  builderFeeUsd?: number;
  pool?: { usdc?: number; narr?: number; price?: number } | null;
}

/** `url` goes in a post's `images` or a narrative's `pic`. */
export interface Upload {
  url: string;
}

export interface SimResult {
  days: number;
  seed: number;
  sym: string;
  yearlyRate: number;
  start: { price: number };
  params: Record<string, unknown>;
  events: Record<string, unknown>[];
  end: Record<string, number>;
}

// ---------- answers from POST /act ----------

export interface OkAnswer {
  ok: true;
}
export interface PostAnswer extends OkAnswer {
  id: string;
  again?: true;
}
export interface ReplyAnswer extends OkAnswer {
  id?: string;
  again?: true;
}
export interface LaunchAnswer extends OkAnswer {
  sym: string;
}
export interface ProposeAnswer extends OkAnswer {
  id: string;
  ends: number;
  bar: "low" | "high";
}
export interface OrderFilledAnswer extends OkAnswer {
  fill: TradeFill;
  repeat?: true;
}
export interface OrderRestingAnswer extends OkAnswer {
  id: string;
  open: true;
  clientId?: string;
  repeat?: true;
}
/** `fill` when it filled now; `id` and `open` when it rests (with `limit`). */
export type OrderAnswer = OrderFilledAnswer | OrderRestingAnswer;
export interface CloseAnswer extends OkAnswer {
  fill: TradeFill;
  got: number;
  repeat?: true;
}
export interface CancelAllAnswer extends OkAnswer {
  cancelled: number;
}

// ---------- requests ----------

export interface PostRequest {
  text?: string;
  home?: string;
  thesis?: boolean;
  /** Your own id: the same post again makes no second one, so the client retries it after a network error. */
  id?: string;
  images?: string[];
  gif?: string;
  link?: string;
  quote?: string;
  qrooms?: string[];
}

export interface ReplyRequest {
  /** What it answers: `r:post:<post id>` for a post. */
  key: string;
  text?: string;
  to?: string;
  id?: string;
  images?: string[];
  gif?: string;
  link?: string;
}

export interface LaunchRequest {
  sym: string;
  comps: Leg[];
  cap: number;
  name?: string;
  theme?: string;
  desc?: string;
  thesis?: string;
  rule?: string;
  plan?: string;
  bounds?: Bounds;
  voteMinutes?: number;
  vetoMinutes?: number;
  fee?: string;
  tags?: string[];
  links?: string[];
  pic?: string;
  price?: number;
}

/** `narrEdit`: send only what changes. `""` clears a text or the picture; `null` puts a window back to the server's own. */
export interface EditRequest {
  sym: string;
  thesis?: string;
  rule?: string;
  plan?: string;
  pic?: string;
  fee?: number;
  voteMinutes?: number | null;
  vetoMinutes?: number | null;
}

export interface ProposeRequest {
  sym: string;
  changes?: Change[];
  fee?: number;
  title?: string;
  why?: string;
}

export interface SimRequest {
  days?: number;
  seed?: number;
  volumePerDay?: number;
  holders?: number;
  aum?: number;
  mood?: "up" | "flat" | "down";
  referredShare?: number;
}

export interface QuoteOpenRequest {
  sym: string;
  side: Side;
  usd: number;
  lev?: number;
  path?: NarrativePath;
}

export interface QuoteCloseRequest {
  closeId: string;
  frac?: number;
  qty?: number;
}

export interface OrderRequest {
  sym: string;
  side: Side;
  usd: number;
  lev?: number;
  quoteId?: string;
  maxSlippagePct?: number;
  limit?: number;
  tp?: number;
  sl?: number;
  path?: NarrativePath;
  /** Yours, or a new uuid. A retry sends the same one, so it can't trade twice. */
  clientId?: string;
}

export interface CloseRequest {
  id: string;
  frac?: number;
  qty?: number;
  quoteId?: string;
  maxSlippagePct?: number;
  clientId?: string;
}

/** Any action for `POST /act`, as the docs show it. */
export interface Action {
  type: string;
  [field: string]: unknown;
}

// ---------- stream frames ----------

export interface ReadyFrame {
  type: "ready";
  handle: string;
}
export interface SubscribedFrame {
  type: "subscribed";
  channels: Channel[];
  syms?: string[];
}
export interface FillFrame {
  type: "fill";
  fill: StreamFill;
}
export interface OrderFrame {
  type: "order";
  event: "opened" | "cancelled" | "filled";
  order: RestingOrder;
  fill?: string;
  why?: string;
}
export interface MeFrame {
  type: "me";
  me: Me;
}
export interface MarksFrame {
  type: "marks";
  marks: Record<string, number>;
}
export interface ErrorFrame {
  type: "error";
  err: string;
  syms?: string[];
  retryAfter?: number;
  max?: number;
}
/** Made by the SDK, not eta: after a reconnect, your record read again with `GET /me`. */
export interface ResyncFrame {
  type: "resync";
  me: Me;
}
/** Made by the SDK, not eta: the stream dropped and connects again in `wait` seconds. */
export interface ClosedFrame {
  type: "closed";
  code: number | null;
  err: string | null;
  wait: number;
}
export type Frame =
  | ReadyFrame
  | SubscribedFrame
  | FillFrame
  | OrderFrame
  | MeFrame
  | MarksFrame
  | ErrorFrame
  | ResyncFrame
  | ClosedFrame;
