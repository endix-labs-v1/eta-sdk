import { EtaError } from "./errors.js";
import { keyOf } from "./internal.js";
import { EtaStream, type StreamOptions } from "./stream.js";
import type {
  Action,
  Board,
  Bootstrap,
  CancelAllAnswer,
  CloseAnswer,
  CloseRequest,
  EditRequest,
  Fill,
  Flow,
  Follows,
  LaunchAnswer,
  LaunchRequest,
  Market,
  Me,
  OkAnswer,
  OrderAnswer,
  OrderRequest,
  PersonFill,
  PostAnswer,
  PostRequest,
  PricePoint,
  ProposeAnswer,
  ProposeRequest,
  Quote,
  QuoteCloseRequest,
  QuoteOpenRequest,
  ReplyAnswer,
  ReplyRequest,
  RulesetVersion,
  SimRequest,
  SimResult,
  Stats,
  StatsHidden,
  Upload,
} from "./types.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://api.eta.cash";

/** The newest `X-RateLimit-*` values eta sent with a call made with your key. */
export interface RateLimit {
  /** How many calls the key may make in 10 seconds. */
  limit: number;
  /** How many more calls you can make now before a 429, the last one counted. */
  remaining: number;
  /** Seconds until `remaining` goes up. */
  reset: number;
}

export interface EtaClientOptions {
  /** Your API key, `eta_<id>_<secret>`. */
  key: string;
  /** The API. `https://api.eta.cash` by default. */
  baseUrl?: string;
  /** Milliseconds to wait for an answer. 15,000 by default. */
  timeoutMs?: number;
  /** How many times a call that gets `429 too fast` is sent again, each after the `retryAfter` the answer gives. 3 by default. */
  rateLimitRetries?: number;
  /** The longest `retryAfter` the client waits out, in milliseconds. A 429 that asks for longer is thrown. 60,000 by default. */
  rateLimitMaxWaitMs?: number;
  /** How many times a call that is safe to send twice is sent again after a network error, a timeout or a 5xx. 2 by default. */
  networkRetries?: number;
  /** The fetch to send calls with. `globalThis.fetch` by default. */
  fetch?: typeof fetch;
  /** How the client waits. A `setTimeout` promise by default. */
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | undefined>;
interface CallOptions {
  query?: Query;
  json?: unknown;
  bytes?: Uint8Array;
  contentType?: string;
  retry?: boolean;
  clientId?: string;
  raw?: boolean;
}

const KEY_ID = /^eta_([0-9a-f]{12})_/;
const isNode = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === "string";

/** A fresh `clientId`: a random uuid, which fits eta's 1 to 64 letters, digits, `_` or `-`. */
export function newClientId(): string {
  return globalThis.crypto.randomUUID();
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * A client for the eta API, built from one API key.
 *
 * Every route a key can call has a method. Each answer is the JSON eta sends. A refused call throws {@link EtaError}.
 */
export class EtaClient {
  readonly #key: string;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly rateLimitRetries: number;
  readonly rateLimitMaxWaitMs: number;
  readonly networkRetries: number;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  /** The newest `X-RateLimit-*` values, or `null` before the first answer that had them. */
  rateLimit: RateLimit | null = null;
  /** The `X-Request-Id` of the newest answer. */
  lastRequestId: string | null = null;

  constructor(options: EtaClientOptions) {
    const key = typeof options?.key === "string" ? options.key.trim() : "";
    if (!key) throw new TypeError("key: your eta API key, eta_<id>_<secret>");
    this.#key = key;
    keyOf.set(this, key);
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.rateLimitRetries = options.rateLimitRetries ?? 3;
    this.rateLimitMaxWaitMs = options.rateLimitMaxWaitMs ?? 60_000;
    this.networkRetries = options.networkRetries ?? 2;
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new TypeError("fetch: none here. Use Node 20 or later, or pass one");
    this.#fetch = (input, init) => f(input, init); // never called on the client: a browser's fetch called on another object throws "Illegal invocation"
    this.#sleep = options.sleep ?? sleep;
  }

  /** The key's id, which names it and is not secret. The secret never leaves the client but in the Authorization header. */
  get keyId(): string | null {
    return KEY_ID.exec(this.#key)?.[1] ?? null;
  }

  toString(): string {
    return `EtaClient(${this.keyId ? `eta_${this.keyId}_...` : "..."}, ${this.baseUrl})`;
  }

  toJSON(): Record<string, unknown> {
    return { key: this.keyId ? `eta_${this.keyId}_...` : "...", baseUrl: this.baseUrl };
  }

  // ---------- reads ----------

  /** Your own account: cash, positions, resting orders, newest fills, notes and earnings. `GET /me` */
  me(): Promise<Me> {
    return this.#get("/me");
  }

  /** Everything the app loads when it opens. It is large: a bot that needs its own account reads `me()`. `GET /bootstrap` */
  bootstrap(): Promise<Bootstrap> {
    return this.#get("/bootstrap");
  }

  /** Every market eta lists, with its price and moves. Narratives are not in it. `GET /markets` */
  markets(): Promise<Market[]> {
    return this.#get("/markets");
  }

  /** A market's trades, newest first. `n`: how many, 100 by default, 5,000 at most. `GET /trades/:sym` */
  trades(sym: string, options: { n?: number } = {}): Promise<Fill[]> {
    return this.#get(`/trades/${seg(sym)}`, { n: options.n });
  }

  /** A market's last 24 hours by kind of trader. `GET /flows/:sym` */
  flows(sym: string): Promise<Flow[]> {
    return this.#get(`/flows/${seg(sym)}`);
  }

  /** A person's newest trades, at most 200. `GET /fills/:handle` */
  fills(handle: string): Promise<PersonFill[]> {
    return this.#get(`/fills/${seg(handle)}`);
  }

  /** A person's PnL, volume, trades, win rate, rank and calendar. `days`: 0 (all time), 1, 7 or 30. `GET /stats/:handle` */
  stats(handle: string, options: { days?: 0 | 1 | 7 | 30 } = {}): Promise<Stats | StatsHidden> {
    return this.#get(`/stats/${seg(handle)}`, { days: options.days });
  }

  /** The top traders. `GET /board` */
  board(options: { by?: "pnl" | "volume" | "winrate"; days?: 0 | 1 | 7 | 30; n?: number } = {}): Promise<Board> {
    return this.#get("/board", { by: options.by, days: options.days, n: options.n });
  }

  /** A narrative's saved prices, oldest first, the price now last. `GET /narrative/:sym/history` */
  narrativeHistory(sym: string, options: { days?: number } = {}): Promise<PricePoint[]> {
    return this.#get(`/narrative/${seg(sym)}/history`, { days: options.days });
  }

  /** Every version of a narrative's thesis, rule and plan, newest first. `GET /narrative/:sym/versions` */
  narrativeVersions(sym: string): Promise<RulesetVersion[]> {
    return this.#get(`/narrative/${seg(sym)}/versions`);
  }

  /** Who follows a person, and whom they follow. `GET /follows/:handle` */
  follows(handle: string): Promise<Follows> {
    return this.#get(`/follows/${seg(handle)}`);
  }

  /** A picture's bytes. Takes its id or the `url` an upload gave. `GET /files/:id` */
  file(id: string): Promise<Uint8Array> {
    const fileId = id.replace(/\/+$/, "").split("/").pop() ?? id;
    return this.#call("GET", `/files/${seg(fileId)}`, { retry: true, raw: true });
  }

  // ---------- posts ----------

  /** Posts as your account, in a market's room (`home`) or on your profile. Scope `post`. */
  post(request: PostRequest): Promise<PostAnswer> {
    return this.act({ type: "post", ...request });
  }

  /** Replies to a post (`key: "r:post:<post id>"`) or another reply. Scope `post`. */
  reply(request: ReplyRequest): Promise<ReplyAnswer> {
    return this.act({ type: "reply", ...request });
  }

  /** Deletes one of your posts. Scope `post`. */
  deletePost(id: string): Promise<OkAnswer> {
    return this.act({ type: "deletePost", id });
  }

  /**
   * Uploads a picture (PNG, JPEG, WebP or GIF, up to 5 MB). Put the `url` it answers in a post's `images` or a narrative's `pic`.
   * Scope `post` or `creator`.
   */
  async upload(picture: Uint8Array | ArrayBuffer | Blob, contentType?: string): Promise<Upload> {
    const bytes =
      picture instanceof Uint8Array
        ? picture
        : picture instanceof ArrayBuffer
          ? new Uint8Array(picture)
          : new Uint8Array(await picture.arrayBuffer());
    return this.#call("POST", "/files", { bytes, contentType: contentType ?? sniff(bytes), retry: true });
  }

  // ---------- creator ----------

  /** Launches a narrative from markets on eta. `comps`: `[[symbol, weight], ...]`, summing to 100. Scope `creator`. */
  launch(request: LaunchRequest): Promise<LaunchAnswer> {
    return this.act({ type: "launch", ...request });
  }

  /**
   * Changes what a creator changes alone on a narrative you launched (`narrEdit`). Send only what changes. `""` clears a text or
   * the picture; `voteMinutes: null` or `vetoMinutes: null` goes back to the server's own. Scope `creator`.
   */
  edit(request: EditRequest): Promise<OkAnswer> {
    return this.act({ type: "narrEdit", ...request });
  }

  /** Puts a change to the legs, the bounds or the fee to the holders' vote. Scope `creator`. */
  propose(request: ProposeRequest): Promise<ProposeAnswer> {
    return this.act({ type: "propose", ...request });
  }

  /** Runs a narrative you launched forward on made-up flow. Nothing is kept. Scope `creator`. */
  sim(sym: string, request: SimRequest = {}): Promise<SimResult> {
    return this.#call("POST", `/sim/${seg(sym)}`, { json: request, retry: true });
  }

  // ---------- trade ----------

  /** What an order (`sym`, `side`, `usd`) or a close (`closeId`) would cost now. The `quoteId` holds 15 seconds, for one order. */
  quote(request: QuoteOpenRequest | QuoteCloseRequest): Promise<Quote> {
    return this.#call("POST", "/quote", { json: request, retry: true });
  }

  /**
   * Buys, sells, opens a perp, or takes a side on a prediction. With `limit` it rests.
   *
   * Every order carries a `clientId`: yours, or a new uuid. A network error, a timeout or a 5xx sends it again with the same
   * `clientId`, so it can't trade twice. Scope `trade`.
   */
  order(request: OrderRequest): Promise<OrderAnswer> {
    return this.act({ type: "order", ...request });
  }

  /** Cancels one of your resting limit orders, by its `id` or its `clientId`. Scope `trade`. */
  cancel(order: string | { id: string } | { clientId: string }): Promise<OkAnswer> {
    const by = typeof order === "string" ? { id: order } : order;
    if (!by || ("id" in by) === ("clientId" in by)) throw new TypeError("cancel: id or clientId, one of the two");
    return this.act({ type: "cancel", ...by });
  }

  /** Cancels all your resting limit orders, or all on one market. Answers how many. Scope `trade`. */
  cancelAll(options: { sym?: string } = {}): Promise<CancelAllAnswer> {
    return this.act({ type: "cancelAll", ...options });
  }

  /** Closes all or part (`frac` or `qty`) of a position, by its `id` from `me()`. Like `order`, it always carries a `clientId`. */
  close(request: CloseRequest): Promise<CloseAnswer> {
    return this.act({ type: "close", ...request });
  }

  // ---------- any action, the stream ----------

  /**
   * Sends one action to `POST /act` as it is, such as `{ type: "order", ... }`.
   *
   * An `order` or `close` with no `clientId` gets a new one. It is retried after a network error, a timeout or a 5xx when sending
   * it twice can't act twice: an `order` or a `close` (by its `clientId`), and a `post` or `reply` with your own `id`.
   */
  act<T = Record<string, unknown>>(action: Action): Promise<T> {
    if (!action || typeof action.type !== "string" || !action.type) throw new TypeError("action: needs a type, such as \"order\"");
    const body: Action = { ...action };
    let clientId: string | undefined;
    if (body.type === "order" || body.type === "close") {
      if (!body.clientId) body.clientId = newClientId();
      clientId = String(body.clientId);
    }
    const retry = clientId !== undefined || ((body.type === "post" || body.type === "reply") && Boolean(body.id));
    return this.#call("POST", "/act", { json: body, retry, clientId });
  }

  /**
   * A stream of your fills, orders and record (`account`) and prices (`marks`). It connects when you start to iterate it, call
   * `on()`, or call `start()`.
   */
  stream(options: StreamOptions = {}): EtaStream {
    return new EtaStream(this, options);
  }

  // ---------- the wire ----------

  #get<T>(path: string, query?: Query): Promise<T> {
    return this.#call("GET", path, { query, retry: true });
  }

  async #call<T>(method: string, path: string, o: CallOptions): Promise<T> {
    let url = this.baseUrl + path;
    const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== null) as [string, string | number][];
    if (q.length) url += "?" + new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString();
    const headers: Record<string, string> = { authorization: `Bearer ${this.#key}`, accept: "application/json" };
    if (isNode) headers["user-agent"] = `eta-api-js/${VERSION}`;
    let body: string | Uint8Array | undefined;
    if (o.json !== undefined) {
      body = JSON.stringify(o.json);
      headers["content-type"] = "application/json";
    } else if (o.bytes !== undefined) {
      body = o.bytes;
      headers["content-type"] = o.contentType ?? "application/octet-stream";
    }

    let rateLimited = 0;
    let failed = 0;
    for (;;) {
      let res: Response;
      let text = "";
      let bytes: Uint8Array | undefined;
      try {
        res = await this.#fetch(url, { method, headers, body: body as BodyInit | undefined, signal: AbortSignal.timeout(this.timeoutMs) });
        if (o.raw && res.ok) bytes = new Uint8Array(await res.arrayBuffer());
        else text = await res.text();
      } catch (e) {
        if (o.retry && failed < this.networkRetries) {
          await this.#sleep(backoff(failed++));
          continue;
        }
        throw new EtaError(0, "network", { fields: { detail: describe(e) }, clientId: o.clientId, cause: e });
      }
      this.#note(res);
      if (res.status === 429 && rateLimited < this.rateLimitRetries) {
        const wait = retryAfter(res, text);
        if (wait <= this.rateLimitMaxWaitMs) {
          await this.#sleep(wait);
          rateLimited++;
          continue;
        }
      }
      if (res.status >= 500 && o.retry && failed < this.networkRetries) {
        await this.#sleep(backoff(failed++));
        continue;
      }
      if (res.status >= 400) throw errorOf(res, text, o.clientId);
      if (o.raw) return bytes as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new EtaError(res.status, "not JSON", { body: text.slice(0, 500), requestId: res.headers.get("x-request-id"), clientId: o.clientId });
      }
    }
  }

  #note(res: Response): void {
    const id = res.headers.get("x-request-id");
    if (id) this.lastRequestId = id;
    const limit = int(res.headers.get("x-ratelimit-limit"));
    const remaining = int(res.headers.get("x-ratelimit-remaining"));
    const reset = int(res.headers.get("x-ratelimit-reset"));
    if (limit !== null && remaining !== null && reset !== null) this.rateLimit = { limit, remaining, reset };
  }
}

// ---------- helpers ----------

function seg(value: string): string {
  return encodeURIComponent(String(value));
}

function int(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  return Number(value);
}

function backoff(failed: number): number {
  return Math.min(500 * 2 ** failed, 8_000);
}

function describe(e: unknown): string {
  const err = e as { name?: string; message?: string; cause?: { code?: string; message?: string } };
  const cause = err?.cause?.code ?? err?.cause?.message;
  return `${err?.name ?? "Error"}: ${err?.message ?? String(e)}${cause ? ` (${cause})` : ""}`.slice(0, 300);
}

/** Milliseconds to wait: `retryAfter` from the answer, else `Retry-After`, else 1 second. */
function retryAfter(res: Response, text: string): number {
  try {
    const answer = JSON.parse(text);
    if (typeof answer?.retryAfter === "number") return Math.max(answer.retryAfter, 0) * 1000;
  } catch {
    // not JSON: read the header
  }
  const header = int(res.headers.get("retry-after"));
  return header !== null ? header * 1000 : 1000;
}

function errorOf(res: Response, text: string, clientId?: string): EtaError {
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // plain text, such as the 404 of GET /files/:id
  }
  const requestId = res.headers.get("x-request-id");
  if (body && typeof body === "object" && typeof (body as { err?: unknown }).err === "string") {
    const { err, ...fields } = body as { err: string } & Record<string, unknown>;
    return new EtaError(res.status, err, { fields, requestId, clientId, body });
  }
  const words = (typeof body === "string" ? body : JSON.stringify(body)).trim().slice(0, 200);
  return new EtaError(res.status, words || `HTTP ${res.status}`, { requestId, clientId, body });
}

function sniff(b: Uint8Array): string {
  const starts = (...xs: number[]) => xs.every((x, i) => b[i] === x);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return "application/octet-stream";
}
