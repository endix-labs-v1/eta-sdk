import { EtaError } from "./errors.js";
import { keyOf } from "./internal.js";
const CHANNELS = ["account", "marks"];
/** The key doesn't open (`bad key`, `key revoked`, `keys only`). The stream stops for good. */
export const CLOSE_KEY = 4001;
/** Too fast, or too many streams. The stream waits `retryAfter` when eta gives one. */
export const CLOSE_LIMIT = 4029;
/**
 * A stream of your fills, orders and record (`account`) and prices (`marks`).
 *
 * ```ts
 * const stream = eta.stream({ channels: ["account", "marks"], syms: ["HYPE"] });
 * for await (const frame of stream) {
 *   if (frame.type === "fill") console.log(frame.fill);
 * }
 * ```
 *
 * Or with handlers: `stream.on("fill", (f) => ...)`. It connects when you start to iterate it, call `on()`, or call `start()`.
 * It sends your key in the first frame, subscribes, and pings every 30 seconds. When the stream drops, it connects again after
 * 1 second, then 2, 4, up to a minute; reads `GET /me` to catch up (a `resync` frame); and subscribes again. Close 4001 (a bad
 * or revoked key) stops it for good: the iteration throws an {@link EtaError} with `code` 4001, and `end` handlers get it.
 *
 * Besides eta's own frames (`ready`, `subscribed`, `fill`, `order`, `me`, `marks`, `error`) it gives two of its own: `resync`
 * (`{ me }`, after a reconnect) and `closed` (`{ code, err, wait }`, each time the stream drops). `pong` frames are not passed on.
 */
export class EtaStream {
    url;
    /** Your handle, from the `ready` frame. */
    handle = null;
    #client;
    #key;
    #channels;
    #syms;
    #pingMs;
    #openTimeoutMs;
    #backoffMs;
    #maxBackoffMs;
    #resync;
    #WebSocket;
    #sleep;
    #ws = null;
    #backoff;
    #live = false;
    #hadSession = false;
    #started = false;
    #closed = false;
    #ended = false;
    #lastError = null;
    #dropReason = null;
    #ping;
    #openTimer;
    #cancelWait = null;
    #listeners = new Map();
    #iterating = false;
    #queue = [];
    #waiters = [];
    #endError = null;
    #done;
    #settle;
    constructor(client, options = {}) {
        const key = keyOf.get(client);
        if (!key)
            throw new TypeError("client: an EtaClient");
        this.#client = client;
        this.#key = key;
        this.#channels = channelsOf(options.channels ?? ["account"], true);
        if (options.syms && !this.#channels.includes("marks"))
            throw new TypeError("syms: with marks only");
        this.#syms = options.syms ? [...options.syms] : null;
        this.url = options.url ?? streamUrl(client.baseUrl);
        this.#pingMs = options.pingMs ?? 30_000;
        this.#openTimeoutMs = openTimeoutOf(options.openTimeoutMs);
        this.#backoffMs = options.backoffMs ?? 1_000;
        this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
        this.#resync = options.resync ?? true;
        this.#WebSocket = options.WebSocket;
        this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
        this.#backoff = this.#backoffMs;
        this.#done = new Promise((resolve, reject) => {
            this.#settle = (error) => (error ? reject(error) : resolve());
        });
        this.#done.catch(() => undefined); // a stream nobody awaits must not end the process with an unhandled rejection
    }
    /** The channels the stream subscribes to now. */
    get channels() {
        return [...this.#channels];
    }
    /** The markets `marks` sends, or `null` for every market. */
    get syms() {
        return this.#syms ? [...this.#syms] : null;
    }
    /** Resolves when you close the stream; rejects with the {@link EtaError} that stopped it (close 4001). */
    get done() {
        return this.#done;
    }
    /** Connects, if it hasn't yet. */
    start() {
        if (!this.#started) {
            this.#started = true;
            void this.#connect();
        }
        return this;
    }
    /** Calls `handler` for each frame of a type, for every frame (`"frame"`), or when the stream stops (`"end"`). Connects. */
    on(type, handler) {
        let set = this.#listeners.get(type);
        if (!set)
            this.#listeners.set(type, (set = new Set()));
        set.add(handler);
        return this.start();
    }
    off(type, handler) {
        this.#listeners.get(type)?.delete(handler);
        return this;
    }
    /** Adds channels. With `marks`, `syms` replaces the markets (`null`: every market). Kept for each reconnect; sent now when open. */
    subscribe(channels, syms) {
        const want = channelsOf(channels);
        if (syms && !want.includes("marks"))
            throw new TypeError("syms: with marks only");
        this.#channels = CHANNELS.filter((c) => this.#channels.includes(c) || want.includes(c));
        if (want.includes("marks"))
            this.#syms = syms ? [...syms] : null;
        if (this.#live && this.#ws) {
            this.#send(this.#ws, { type: "subscribe", channels: want, ...(want.includes("marks") && this.#syms ? { syms: this.#syms } : {}) });
        }
    }
    /** Stops channels, now and on each reconnect. */
    unsubscribe(channels) {
        const want = channelsOf(channels);
        this.#channels = this.#channels.filter((c) => !want.includes(c));
        if (want.includes("marks"))
            this.#syms = null;
        if (this.#live && this.#ws)
            this.#send(this.#ws, { type: "unsubscribe", channels: want });
    }
    /** Ends the stream. The iteration stops, and it does not connect again. */
    close() {
        this.#closed = true;
        this.#cancelWait?.();
        const ws = this.#ws;
        this.#ws = null;
        this.#stopPing();
        this.#stopOpenTimer();
        if (ws) {
            try {
                ws.close(1000, "bye");
            }
            catch {
                // already closing
            }
        }
        this.#end(null);
    }
    [Symbol.asyncIterator]() {
        this.#iterating = true;
        this.start();
        return {
            next: () => {
                const frame = this.#queue.shift();
                if (frame)
                    return Promise.resolve({ value: frame, done: false });
                if (this.#ended) {
                    const error = this.#endError;
                    this.#endError = null;
                    return error ? Promise.reject(error) : Promise.resolve({ value: undefined, done: true });
                }
                return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
            },
            return: () => {
                this.close();
                return Promise.resolve({ value: undefined, done: true });
            },
        };
    }
    // ---------- the loop ----------
    async #connect() {
        if (this.#closed)
            return;
        let Ctor;
        try {
            Ctor = await webSocketClass(this.#WebSocket);
        }
        catch (e) {
            this.#closed = true;
            this.#end(new EtaError(0, "no WebSocket here: use Node 22 or later, or npm install ws", { cause: e }));
            return;
        }
        if (this.#closed)
            return;
        let ws;
        try {
            ws = new Ctor(this.url);
        }
        catch (e) {
            this.#closed = true;
            this.#end(new EtaError(0, `stream: ${e?.message ?? String(e)}`, { cause: e }));
            return;
        }
        this.#ws = ws;
        this.#lastError = null;
        // a handshake that never answers (a lost SYN, a hung proxy, no ready to the key) may never fire onclose: drop it at the deadline
        this.#stopOpenTimer();
        if (this.#openTimeoutMs !== null) {
            this.#openTimer = setTimeout(() => {
                if (ws !== this.#ws)
                    return;
                this.#lastError = null; // the deadline is why it drops, whatever error frame came before it
                this.#dropReason = "open timeout";
                // the drop is reported here, once, with no close code; the socket is abandoned: it never gets the key, and if it opens late
                // it is closed (a socket closed while opening fires a close of its own, and a passed-in one may not close at all)
                const shut = () => {
                    try {
                        ws.close();
                    }
                    catch {
                        // not open yet, or a socket that can't close: it has no handlers left
                    }
                };
                ws.onopen = shut;
                ws.onclose = null;
                ws.onmessage = null;
                shut();
                this.#dropped(ws, undefined, undefined);
            }, this.#openTimeoutMs);
        }
        ws.onopen = () => this.#send(ws, { type: "auth", key: this.#key });
        ws.onmessage = (event) => this.#message(ws, event.data);
        ws.onerror = () => undefined; // a close follows
        ws.onclose = (event) => this.#dropped(ws, event.code, event.reason);
    }
    #message(ws, data) {
        if (ws !== this.#ws)
            return;
        const frame = parse(data);
        if (!frame || frame.type === "pong")
            return;
        if (frame.type === "error")
            this.#lastError = frame;
        this.#emit(frame);
        if (frame.type === "ready") {
            this.#stopOpenTimer();
            this.handle = frame.handle;
            this.#backoff = this.#backoffMs;
            void this.#afterReady(ws);
        }
    }
    /** After a drop, catch up with GET /me; then subscribe and start pinging. */
    async #afterReady(ws) {
        if (this.#closed || ws !== this.#ws)
            return; // a ready handler closed the stream
        if (this.#hadSession && this.#resync && this.#channels.includes("account")) {
            let me;
            try {
                me = await this.#client.me();
            }
            catch (e) {
                if (ws !== this.#ws)
                    return;
                if (e instanceof EtaError && e.status === 401) {
                    this.#closed = true;
                    this.#ws = null;
                    ws.close(1000, "key refused");
                    this.#end(e);
                    return;
                }
                this.#dropReason = `resync: ${e instanceof EtaError ? e.err : String(e)}`;
                ws.close(1000, "resync failed");
                return;
            }
            if (ws !== this.#ws)
                return;
            this.#emit({ type: "resync", me });
            if (this.#closed || ws !== this.#ws)
                return; // a resync handler closed the stream
        }
        this.#hadSession = true;
        this.#live = true;
        if (this.#channels.length) {
            this.#send(ws, { type: "subscribe", channels: this.#channels, ...(this.#channels.includes("marks") && this.#syms ? { syms: this.#syms } : {}) });
        }
        this.#stopPing();
        this.#ping = setInterval(() => this.#send(ws, { type: "ping" }), this.#pingMs);
    }
    #dropped(ws, code, reason) {
        if (ws !== this.#ws)
            return;
        this.#ws = null;
        this.#live = false;
        this.#stopPing();
        this.#stopOpenTimer();
        if (this.#closed)
            return this.#end(null);
        const last = this.#lastError;
        const err = last?.err ?? this.#dropReason ?? (reason || null);
        this.#dropReason = null;
        if (code === CLOSE_KEY) {
            this.#closed = true;
            const { type: _t, err: _e, ...fields } = last ?? {};
            return this.#end(new EtaError(0, err ?? "bad key", { code, fields }));
        }
        let wait = this.#backoff;
        if (code === CLOSE_LIMIT && typeof last?.retryAfter === "number")
            wait = Math.max(wait, last.retryAfter * 1000);
        this.#backoff = Math.min(this.#backoff * 2, this.#maxBackoffMs);
        this.#emit({ type: "closed", code: code ?? null, err, wait: wait / 1000 });
        void this.#reconnectAfter(wait);
    }
    async #reconnectAfter(ms) {
        await Promise.race([this.#sleep(ms), new Promise((done) => (this.#cancelWait = done))]);
        this.#cancelWait = null;
        if (!this.#closed)
            await this.#connect();
    }
    #emit(frame) {
        for (const handler of [...(this.#listeners.get(frame.type) ?? []), ...(this.#listeners.get("frame") ?? [])])
            call(handler, frame);
        if (!this.#iterating)
            return;
        const waiter = this.#waiters.shift();
        if (waiter)
            waiter.resolve({ value: frame, done: false });
        else
            this.#queue.push(frame);
    }
    #end(error) {
        if (this.#ended)
            return;
        this.#ended = true;
        this.#stopPing();
        this.#stopOpenTimer();
        this.#cancelWait?.();
        for (const handler of this.#listeners.get("end") ?? [])
            call(handler, error);
        // a waiter means the queue is empty: the first waiter gets the error; else next() gives it once the queue is read
        const waiters = this.#waiters.splice(0);
        if (waiters.length) {
            waiters.forEach((waiter, i) => (error && i === 0 ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true })));
        }
        else {
            this.#endError = error;
        }
        this.#settle(error);
    }
    #send(ws, frame) {
        try {
            ws.send(JSON.stringify(frame));
        }
        catch {
            // closing: the close handler takes it from here
        }
    }
    #stopPing() {
        if (this.#ping !== undefined)
            clearInterval(this.#ping);
        this.#ping = undefined;
    }
    #stopOpenTimer() {
        if (this.#openTimer !== undefined)
            clearTimeout(this.#openTimer);
        this.#openTimer = undefined;
    }
}
// ---------- helpers ----------
function channelsOf(channels, allowEmpty = false) {
    const list = [...channels];
    if ((!list.length && !allowEmpty) || list.some((c) => !CHANNELS.includes(c)))
        throw new TypeError("channels: account, marks");
    return CHANNELS.filter((c) => list.includes(c));
}
/** setTimeout runs a delay past 2^31 - 1 ms, Infinity included, after 1 ms: so Infinity and null mean no deadline, and past that is refused. */
function openTimeoutOf(value) {
    if (value === undefined)
        return 10_000;
    if (value === null || value === Infinity)
        return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
        throw new RangeError("openTimeoutMs: milliseconds above 0, up to 2147483647, or null (or Infinity) for no deadline");
    }
    return value;
}
function streamUrl(baseUrl) {
    const u = new URL(baseUrl);
    u.protocol = u.protocol === "http:" ? "ws:" : u.protocol === "https:" ? "wss:" : u.protocol;
    u.pathname = u.pathname.replace(/\/+$/, "") + "/stream";
    u.search = "";
    u.hash = "";
    return u.toString();
}
function parse(data) {
    try {
        const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
        const frame = JSON.parse(text);
        return frame && typeof frame === "object" && typeof frame.type === "string" ? frame : null;
    }
    catch {
        return null;
    }
}
/** A handler that throws is reported as the platform reports a throwing event listener; the stream goes on. */
function call(handler, value) {
    try {
        handler(value);
    }
    catch (e) {
        setTimeout(() => {
            throw e;
        }, 0);
    }
}
async function webSocketClass(given) {
    if (given)
        return given;
    const global = globalThis.WebSocket;
    if (typeof global === "function")
        return global;
    const name = "ws"; // a name in a variable: bundlers leave it alone, and TypeScript needs no types for it
    const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ name));
    const Ctor = mod.WebSocket ?? mod.default;
    if (typeof Ctor !== "function")
        throw new Error("ws: no WebSocket export");
    return Ctor;
}
