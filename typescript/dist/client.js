import { EtaError } from "./errors.js";
import { keyOf } from "./internal.js";
import { EtaStream } from "./stream.js";
import { VERSION } from "./version.js";
export const DEFAULT_BASE_URL = "https://api.eta.cash";
const KEY_ID = /^eta_([0-9a-f]{12})_/;
const isNode = typeof globalThis.process?.versions?.node === "string";
/** A fresh `clientId`: a random uuid, which fits eta's 1 to 64 letters, digits, `_` or `-`. */
export function newClientId() {
    return globalThis.crypto.randomUUID();
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/**
 * A client for the eta API, built from one API key.
 *
 * Every call in the Read, Post, Creator and Trade parts of the API reference has a method. Each answer is the JSON eta sends. A refused call throws {@link EtaError}.
 */
export class EtaClient {
    #key;
    baseUrl;
    timeoutMs;
    rateLimitRetries;
    rateLimitMaxWaitMs;
    networkRetries;
    #fetch;
    #sleep;
    /** The newest `X-RateLimit-*` values, or `null` before the first answer that had them. */
    rateLimit = null;
    /** The `X-Request-Id` of the newest answer. */
    lastRequestId = null;
    constructor(options) {
        const key = typeof options?.key === "string" ? options.key.trim() : "";
        if (!key)
            throw new TypeError("key: your eta API key, eta_<id>_<secret>");
        this.#key = key;
        keyOf.set(this, key);
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
        this.timeoutMs = options.timeoutMs ?? 15_000;
        this.rateLimitRetries = options.rateLimitRetries ?? 3;
        this.rateLimitMaxWaitMs = options.rateLimitMaxWaitMs ?? 60_000;
        this.networkRetries = options.networkRetries ?? 2;
        const f = options.fetch ?? globalThis.fetch;
        if (typeof f !== "function")
            throw new TypeError("fetch: none here. Use Node 20 or later, or pass one");
        this.#fetch = (input, init) => f(input, init); // never called on the client: a browser's fetch called on another object throws "Illegal invocation"
        this.#sleep = options.sleep ?? sleep;
    }
    /** The key's id, which names it and is not secret. The secret never leaves the client but in the Authorization header. */
    get keyId() {
        return KEY_ID.exec(this.#key)?.[1] ?? null;
    }
    toString() {
        return `EtaClient(${this.keyId ? `eta_${this.keyId}_...` : "..."}, ${this.baseUrl})`;
    }
    toJSON() {
        return { key: this.keyId ? `eta_${this.keyId}_...` : "...", baseUrl: this.baseUrl };
    }
    // ---------- reads ----------
    /** Your own account: cash, positions, resting orders, newest fills, notes and earnings. `GET /me` */
    me() {
        return this.#get("/me");
    }
    /** Everything the app loads when it opens. It is large: a bot that needs its own account reads `me()`. `GET /bootstrap` */
    bootstrap() {
        return this.#get("/bootstrap");
    }
    /** Every market eta lists, with its price and moves. Narratives are not in it. `GET /markets` */
    markets() {
        return this.#get("/markets");
    }
    /** A market's trades, newest first. `n`: how many, 100 by default, 5,000 at most. `GET /trades/:sym` */
    trades(sym, options = {}) {
        return this.#get(`/trades/${seg(sym)}`, { n: options.n });
    }
    /** A market's last 24 hours by kind of trader. `GET /flows/:sym` */
    flows(sym) {
        return this.#get(`/flows/${seg(sym)}`);
    }
    /** A person's newest trades, at most 200. `GET /fills/:handle` */
    fills(handle) {
        return this.#get(`/fills/${seg(handle)}`);
    }
    /** A person's PnL, volume, trades, win rate, rank and calendar. `days`: 0 (all time), 1, 7 or 30. `GET /stats/:handle` */
    stats(handle, options = {}) {
        return this.#get(`/stats/${seg(handle)}`, { days: options.days });
    }
    /** The top traders. `GET /board` */
    board(options = {}) {
        return this.#get("/board", { by: options.by, days: options.days, n: options.n });
    }
    /** A narrative's saved prices, oldest first, the price now last. `GET /narrative/:sym/history` */
    narrativeHistory(sym, options = {}) {
        return this.#get(`/narrative/${seg(sym)}/history`, { days: options.days });
    }
    /** Every version of a narrative's thesis, rule and plan, newest first. `GET /narrative/:sym/versions` */
    narrativeVersions(sym) {
        return this.#get(`/narrative/${seg(sym)}/versions`);
    }
    /** Who follows a person, and whom they follow. `GET /follows/:handle` */
    follows(handle) {
        return this.#get(`/follows/${seg(handle)}`);
    }
    /** A picture's bytes. Takes its id or the `url` an upload gave. `GET /files/:id` */
    file(id) {
        const fileId = id.replace(/\/+$/, "").split("/").pop() ?? id;
        return this.#call("GET", `/files/${seg(fileId)}`, { retry: true, raw: true });
    }
    // ---------- posts ----------
    /** Posts as your account, in a market's room (`home`) or on your profile. Scope `post`. */
    post(request) {
        return this.act({ type: "post", ...request });
    }
    /** Replies to a post (`key: "r:post:<post id>"`) or another reply. Scope `post`. */
    reply(request) {
        return this.act({ type: "reply", ...request });
    }
    /** Deletes one of your posts. Scope `post`. */
    deletePost(id) {
        return this.act({ type: "deletePost", id });
    }
    /**
     * Uploads a picture (PNG, JPEG, WebP or GIF, up to 5 MB). Put the `url` it answers in a post's `images` or a narrative's `pic`.
     * Scope `post` or `creator`.
     */
    async upload(picture, contentType) {
        const bytes = picture instanceof Uint8Array
            ? picture
            : picture instanceof ArrayBuffer
                ? new Uint8Array(picture)
                : new Uint8Array(await picture.arrayBuffer());
        return this.#call("POST", "/files", { bytes, contentType: contentType ?? sniff(bytes), retry: true });
    }
    // ---------- creator ----------
    /** Launches a narrative from markets on eta. `comps`: `[[symbol, weight], ...]`, summing to 100. Scope `creator`. */
    launch(request) {
        return this.act({ type: "launch", ...request });
    }
    /**
     * Changes what a creator changes alone on a narrative you launched (`narrEdit`). Send only what changes. `""` clears a text or
     * the picture; `voteMinutes: null` or `vetoMinutes: null` goes back to the server's own. Scope `creator`.
     */
    edit(request) {
        return this.act({ type: "narrEdit", ...request });
    }
    /** Puts a change to the legs, the bounds or the fee to the holders' vote. Scope `creator`. */
    propose(request) {
        return this.act({ type: "propose", ...request });
    }
    /** Runs a narrative you launched forward on made-up flow. Nothing is kept. Scope `creator`. */
    sim(sym, request = {}) {
        return this.#call("POST", `/sim/${seg(sym)}`, { json: request, retry: true });
    }
    // ---------- trade ----------
    /** What an order (`sym`, `side`, `usd`) or a close (`closeId`) would cost now. The `quoteId` holds 15 seconds, for one order. */
    quote(request) {
        return this.#call("POST", "/quote", { json: request, retry: true });
    }
    /**
     * Buys, sells, opens a perp, or takes a side on a prediction. With `limit` it rests.
     *
     * Every order carries a `clientId`: yours, or a new uuid. A network error, a timeout or a 5xx sends it again with the same
     * `clientId`, so it can't trade twice. Scope `trade`.
     */
    order(request) {
        return this.act({ type: "order", ...request });
    }
    /** Cancels one of your resting limit orders, by its `id` or its `clientId`. Scope `trade`. */
    cancel(order) {
        const by = typeof order === "string" ? { id: order } : order;
        if (!by || ("id" in by) === ("clientId" in by))
            throw new TypeError("cancel: id or clientId, one of the two");
        return this.act({ type: "cancel", ...by });
    }
    /** Cancels all your resting limit orders, or all on one market. Answers how many. Scope `trade`. */
    cancelAll(options = {}) {
        return this.act({ type: "cancelAll", ...options });
    }
    /** Closes all or part (`frac` or `qty`) of a position, by its `id` from `me()`. Like `order`, it always carries a `clientId`. */
    close(request) {
        return this.act({ type: "close", ...request });
    }
    // ---------- any action, the stream ----------
    /**
     * Sends one action to `POST /act` as it is, such as `{ type: "order", ... }`.
     *
     * An `order` or `close` with no `clientId` gets a new one. It is retried after a network error, a timeout or a 5xx when sending
     * it twice can't act twice: an `order` or a `close` (by its `clientId`), and a `post` or `reply` with your own `id`.
     */
    act(action) {
        if (!action || typeof action.type !== "string" || !action.type)
            throw new TypeError("action: needs a type, such as \"order\"");
        const body = { ...action };
        let clientId;
        if (body.type === "order" || body.type === "close") {
            if (!body.clientId)
                body.clientId = newClientId();
            clientId = String(body.clientId);
        }
        const retry = clientId !== undefined || ((body.type === "post" || body.type === "reply") && Boolean(body.id));
        return this.#call("POST", "/act", { json: body, retry, clientId });
    }
    /**
     * A stream of your fills, orders and record (`account`) and prices (`marks`). It connects when you start to iterate it, call
     * `on()`, or call `start()`.
     */
    stream(options = {}) {
        return new EtaStream(this, options);
    }
    // ---------- the wire ----------
    #get(path, query) {
        return this.#call("GET", path, { query, retry: true });
    }
    async #call(method, path, o) {
        let url = this.baseUrl + path;
        const q = Object.entries(o.query ?? {}).filter(([, v]) => v !== undefined && v !== null);
        if (q.length)
            url += "?" + new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString();
        const headers = { authorization: `Bearer ${this.#key}`, accept: "application/json" };
        if (isNode)
            headers["user-agent"] = `eta-api-js/${VERSION}`;
        let body;
        if (o.json !== undefined) {
            body = JSON.stringify(o.json);
            headers["content-type"] = "application/json";
        }
        else if (o.bytes !== undefined) {
            body = o.bytes;
            headers["content-type"] = o.contentType ?? "application/octet-stream";
        }
        let rateLimited = 0;
        let failed = 0;
        for (;;) {
            let res;
            let text = "";
            let bytes;
            try {
                res = await this.#fetch(url, { method, headers, body: body, signal: AbortSignal.timeout(this.timeoutMs) });
                if (o.raw && res.ok)
                    bytes = new Uint8Array(await res.arrayBuffer());
                else
                    text = await res.text();
            }
            catch (e) {
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
            if (res.status >= 400)
                throw errorOf(res, text, o.clientId);
            if (o.raw)
                return bytes;
            try {
                return JSON.parse(text);
            }
            catch {
                throw new EtaError(res.status, "not JSON", { body: text.slice(0, 500), requestId: res.headers.get("x-request-id"), clientId: o.clientId });
            }
        }
    }
    #note(res) {
        const id = res.headers.get("x-request-id");
        if (id)
            this.lastRequestId = id;
        const limit = int(res.headers.get("x-ratelimit-limit"));
        const remaining = int(res.headers.get("x-ratelimit-remaining"));
        const reset = int(res.headers.get("x-ratelimit-reset"));
        if (limit !== null && remaining !== null && reset !== null)
            this.rateLimit = { limit, remaining, reset };
    }
}
// ---------- helpers ----------
function seg(value) {
    return encodeURIComponent(String(value));
}
function int(value) {
    if (value === null || !/^\d+$/.test(value.trim()))
        return null;
    return Number(value);
}
function backoff(failed) {
    return Math.min(500 * 2 ** failed, 8_000);
}
function describe(e) {
    const err = e;
    const cause = err?.cause?.code ?? err?.cause?.message;
    return `${err?.name ?? "Error"}: ${err?.message ?? String(e)}${cause ? ` (${cause})` : ""}`.slice(0, 300);
}
/** Milliseconds to wait: `retryAfter` from the answer, else `Retry-After`, else 1 second. */
function retryAfter(res, text) {
    try {
        const answer = JSON.parse(text);
        if (typeof answer?.retryAfter === "number")
            return Math.max(answer.retryAfter, 0) * 1000;
    }
    catch {
        // not JSON: read the header
    }
    const header = int(res.headers.get("retry-after"));
    return header !== null ? header * 1000 : 1000;
}
function errorOf(res, text, clientId) {
    let body = text;
    try {
        body = JSON.parse(text);
    }
    catch {
        // plain text, such as the 404 of GET /files/:id
    }
    const requestId = res.headers.get("x-request-id");
    if (body && typeof body === "object" && typeof body.err === "string") {
        const { err, ...fields } = body;
        return new EtaError(res.status, err, { fields, requestId, clientId, body });
    }
    const words = (typeof body === "string" ? body : JSON.stringify(body)).trim().slice(0, 200);
    return new EtaError(res.status, words || `HTTP ${res.status}`, { requestId, clientId, body });
}
function sniff(b) {
    const starts = (...xs) => xs.every((x, i) => b[i] === x);
    if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))
        return "image/png";
    if (starts(0xff, 0xd8, 0xff))
        return "image/jpeg";
    if (starts(0x47, 0x49, 0x46, 0x38))
        return "image/gif";
    if (starts(0x52, 0x49, 0x46, 0x46) && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
        return "image/webp";
    return "application/octet-stream";
}
