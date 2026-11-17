import { EtaStream, type StreamOptions } from "./stream.js";
import type { Action, Board, Bootstrap, CancelAllAnswer, CloseAnswer, CloseRequest, EditRequest, Fill, Flow, Follows, LaunchAnswer, LaunchRequest, Market, Me, OkAnswer, OrderAnswer, OrderRequest, PersonFill, PostAnswer, PostRequest, PricePoint, ProposeAnswer, ProposeRequest, Quote, QuoteCloseRequest, QuoteOpenRequest, ReplyAnswer, ReplyRequest, RulesetVersion, SimRequest, SimResult, Stats, StatsHidden, Upload } from "./types.js";
export declare const DEFAULT_BASE_URL = "https://api.eta.cash";
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
/** A fresh `clientId`: a random uuid, which fits eta's 1 to 64 letters, digits, `_` or `-`. */
export declare function newClientId(): string;
/**
 * A client for the eta API, built from one API key.
 *
 * Every call in the Read, Post, Creator and Trade parts of the API reference has a method. Each answer is the JSON eta sends. A refused call throws {@link EtaError}.
 */
export declare class EtaClient {
    #private;
    readonly baseUrl: string;
    readonly timeoutMs: number;
    readonly rateLimitRetries: number;
    readonly rateLimitMaxWaitMs: number;
    readonly networkRetries: number;
    /** The newest `X-RateLimit-*` values, or `null` before the first answer that had them. */
    rateLimit: RateLimit | null;
    /** The `X-Request-Id` of the newest answer. */
    lastRequestId: string | null;
    constructor(options: EtaClientOptions);
    /** The key's id, which names it and is not secret. The secret never leaves the client but in the Authorization header. */
    get keyId(): string | null;
    toString(): string;
    toJSON(): Record<string, unknown>;
    /** Your own account: cash, positions, resting orders, newest fills, notes and earnings. `GET /me` */
    me(): Promise<Me>;
    /** Everything the app loads when it opens. It is large: a bot that needs its own account reads `me()`. `GET /bootstrap` */
    bootstrap(): Promise<Bootstrap>;
    /** Every market eta lists, with its price and moves. Narratives are not in it. `GET /markets` */
    markets(): Promise<Market[]>;
    /** A market's trades, newest first. `n`: how many, 100 by default, 5,000 at most. `GET /trades/:sym` */
    trades(sym: string, options?: {
        n?: number;
    }): Promise<Fill[]>;
    /** A market's last 24 hours by kind of trader. `GET /flows/:sym` */
    flows(sym: string): Promise<Flow[]>;
    /** A person's newest trades, at most 200. `GET /fills/:handle` */
    fills(handle: string): Promise<PersonFill[]>;
    /** A person's PnL, volume, trades, win rate, rank and calendar. `days`: 0 (all time), 1, 7 or 30. `GET /stats/:handle` */
    stats(handle: string, options?: {
        days?: 0 | 1 | 7 | 30;
    }): Promise<Stats | StatsHidden>;
    /** The top traders. `GET /board` */
    board(options?: {
        by?: "pnl" | "volume" | "winrate";
        days?: 0 | 1 | 7 | 30;
        n?: number;
    }): Promise<Board>;
    /** A narrative's saved prices, oldest first, the price now last. `GET /narrative/:sym/history` */
    narrativeHistory(sym: string, options?: {
        days?: number;
    }): Promise<PricePoint[]>;
    /** Every version of a narrative's thesis, rule and plan, newest first. `GET /narrative/:sym/versions` */
    narrativeVersions(sym: string): Promise<RulesetVersion[]>;
    /** Who follows a person, and whom they follow. `GET /follows/:handle` */
    follows(handle: string): Promise<Follows>;
    /** A picture's bytes. Takes its id or the `url` an upload gave. `GET /files/:id` */
    file(id: string): Promise<Uint8Array>;
    /** Posts as your account, in a market's room (`home`) or on your profile. Scope `post`. */
    post(request: PostRequest): Promise<PostAnswer>;
    /** Replies to a post (`key: "r:post:<post id>"`) or another reply. Scope `post`. */
    reply(request: ReplyRequest): Promise<ReplyAnswer>;
    /** Deletes one of your posts. Scope `post`. */
    deletePost(id: string): Promise<OkAnswer>;
    /**
     * Uploads a picture (PNG, JPEG, WebP or GIF, up to 5 MB). Put the `url` it answers in a post's `images` or a narrative's `pic`.
     * Scope `post` or `creator`.
     */
    upload(picture: Uint8Array | ArrayBuffer | Blob, contentType?: string): Promise<Upload>;
    /** Launches a narrative from markets on eta. `comps`: `[[symbol, weight], ...]`, summing to 100. Scope `creator`. */
    launch(request: LaunchRequest): Promise<LaunchAnswer>;
    /**
     * Changes what a creator changes alone on a narrative you launched (`narrEdit`). Send only what changes. `""` clears a text or
     * the picture; `voteMinutes: null` or `vetoMinutes: null` goes back to the server's own. Scope `creator`.
     */
    edit(request: EditRequest): Promise<OkAnswer>;
    /** Puts a change to the legs, the bounds or the fee to the holders' vote. Scope `creator`. */
    propose(request: ProposeRequest): Promise<ProposeAnswer>;
    /** Runs a narrative you launched forward on made-up flow. Nothing is kept. Scope `creator`. */
    sim(sym: string, request?: SimRequest): Promise<SimResult>;
    /** What an order (`sym`, `side`, `usd`) or a close (`closeId`) would cost now. The `quoteId` holds 15 seconds, for one order. */
    quote(request: QuoteOpenRequest | QuoteCloseRequest): Promise<Quote>;
    /**
     * Buys, sells, opens a perp, or takes a side on a prediction. With `limit` it rests.
     *
     * Every order carries a `clientId`: yours, or a new uuid. A network error, a timeout or a 5xx sends it again with the same
     * `clientId`, so it can't trade twice. Scope `trade`.
     */
    order(request: OrderRequest): Promise<OrderAnswer>;
    /** Cancels one of your resting limit orders, by its `id` or its `clientId`. Scope `trade`. */
    cancel(order: string | {
        id: string;
    } | {
        clientId: string;
    }): Promise<OkAnswer>;
    /** Cancels all your resting limit orders, or all on one market. Answers how many. Scope `trade`. */
    cancelAll(options?: {
        sym?: string;
    }): Promise<CancelAllAnswer>;
    /** Closes all or part (`frac` or `qty`) of a position, by its `id` from `me()`. Like `order`, it always carries a `clientId`. */
    close(request: CloseRequest): Promise<CloseAnswer>;
    /**
     * Sends one action to `POST /act` as it is, such as `{ type: "order", ... }`.
     *
     * An `order` or `close` with no `clientId` gets a new one. It is retried after a network error, a timeout or a 5xx when sending
     * it twice can't act twice: an `order` or a `close` (by its `clientId`), and a `post` or `reply` with your own `id`.
     */
    act<T = Record<string, unknown>>(action: Action): Promise<T>;
    /**
     * A stream of your fills, orders and record (`account`) and prices (`marks`). It connects when you start to iterate it, call
     * `on()`, or call `start()`.
     */
    stream(options?: StreamOptions): EtaStream;
}
