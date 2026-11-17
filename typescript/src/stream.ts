import type { EtaClient } from "./client.js";
import { EtaError } from "./errors.js";
import { keyOf } from "./internal.js";
import type { Channel, ErrorFrame, Frame, Me } from "./types.js";

const CHANNELS: readonly Channel[] = ["account", "marks"];
/** The key doesn't open (`bad key`, `key revoked`, `keys only`). The stream stops for good. */
export const CLOSE_KEY = 4001;
/** Too fast, or too many streams. The stream waits `retryAfter` when eta gives one. */
export const CLOSE_LIMIT = 4029;

/** What the stream needs of a WebSocket: the global one (Node 22+, browsers) and the `ws` package both fit. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketConstructor = new (url: string) => WebSocketLike;

export interface StreamOptions {
  /** `account`, `marks` or both. `["account"]` by default. */
  channels?: Channel[];
  /** With `marks`: only these markets' prices. Every market's by default. */
  syms?: string[];
  /** The stream's address. Made from the client's `baseUrl` by default. */
  url?: string;
  /** Milliseconds between pings. 30,000 by default; eta closes a stream that sends nothing for 60 seconds. */
  pingMs?: number;
  /** Milliseconds from connecting to eta's `ready` (the WebSocket opens, eta answers the key). Past it, the stream drops and connects
   *  again. 10,000 by default. */
  openTimeoutMs?: number;
  /** The first wait before connecting again, in milliseconds. 1,000 by default. */
  backoffMs?: number;
  /** The longest wait. 60,000 by default. */
  maxBackoffMs?: number;
  /** Read `GET /me` after each reconnect, when `account` is on. `true` by default. */
  resync?: boolean;
  /** The WebSocket class to use. The global one by default, else the `ws` package. */
  WebSocket?: WebSocketConstructor;
  /** How the stream waits before connecting again. A `setTimeout` promise by default. */
  sleep?: (ms: number) => Promise<void>;
}

type FrameOf<K extends Frame["type"]> = Extract<Frame, { type: K }>;
type Listener = (value: never) => void;
interface Waiter {
  resolve: (r: IteratorResult<Frame>) => void;
  reject: (e: unknown) => void;
}

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
export class EtaStream implements AsyncIterable<Frame> {
  readonly url: string;
  /** Your handle, from the `ready` frame. */
  handle: string | null = null;

  readonly #client: EtaClient;
  readonly #key: string;
  #channels: Channel[];
  #syms: string[] | null;
  readonly #pingMs: number;
  readonly #openTimeoutMs: number;
  readonly #backoffMs: number;
  readonly #maxBackoffMs: number;
  readonly #resync: boolean;
  readonly #WebSocket?: WebSocketConstructor;
  readonly #sleep: (ms: number) => Promise<void>;

  #ws: WebSocketLike | null = null;
  #backoff: number;
  #live = false;
  #hadSession = false;
  #started = false;
  #closed = false;
  #ended = false;
  #lastError: ErrorFrame | null = null;
  #dropReason: string | null = null;
  #ping: ReturnType<typeof setInterval> | undefined;
  #openTimer: ReturnType<typeof setTimeout> | undefined;
  #cancelWait: (() => void) | null = null;
  readonly #listeners = new Map<string, Set<Listener>>();
  #iterating = false;
  readonly #queue: Frame[] = [];
  readonly #waiters: Waiter[] = [];
  #endError: EtaError | null = null;
  readonly #done: Promise<void>;
  #settle!: (error: EtaError | null) => void;

  constructor(client: EtaClient, options: StreamOptions = {}) {
    const key = keyOf.get(client);
    if (!key) throw new TypeError("client: an EtaClient");
    this.#client = client;
    this.#key = key;
    this.#channels = channelsOf(options.channels ?? ["account"], true);
    if (options.syms && !this.#channels.includes("marks")) throw new TypeError("syms: with marks only");
    this.#syms = options.syms ? [...options.syms] : null;
    this.url = options.url ?? streamUrl(client.baseUrl);
    this.#pingMs = options.pingMs ?? 30_000;
    this.#openTimeoutMs = options.openTimeoutMs ?? 10_000;
    this.#backoffMs = options.backoffMs ?? 1_000;
    this.#maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.#resync = options.resync ?? true;
    this.#WebSocket = options.WebSocket;
    this.#sleep = options.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.#backoff = this.#backoffMs;
    this.#done = new Promise<void>((resolve, reject) => {
      this.#settle = (error) => (error ? reject(error) : resolve());
    });
    this.#done.catch(() => undefined); // a stream nobody awaits must not end the process with an unhandled rejection
  }

  /** The channels the stream subscribes to now. */
  get channels(): Channel[] {
    return [...this.#channels];
  }

  /** The markets `marks` sends, or `null` for every market. */
  get syms(): string[] | null {
    return this.#syms ? [...this.#syms] : null;
  }

  /** Resolves when you close the stream; rejects with the {@link EtaError} that stopped it (close 4001). */
  get done(): Promise<void> {
    return this.#done;
  }

  /** Connects, if it hasn't yet. */
  start(): this {
    if (!this.#started) {
      this.#started = true;
      void this.#connect();
    }
    return this;
  }

  on<K extends Frame["type"]>(type: K, handler: (frame: FrameOf<K>) => void): this;
  on(type: "frame", handler: (frame: Frame) => void): this;
  on(type: "end", handler: (error: EtaError | null) => void): this;
  /** Calls `handler` for each frame of a type, for every frame (`"frame"`), or when the stream stops (`"end"`). Connects. */
  on(type: string, handler: (value: never) => void): this {
    let set = this.#listeners.get(type);
    if (!set) this.#listeners.set(type, (set = new Set()));
    set.add(handler);
    return this.start();
  }

  off(type: string, handler: (value: never) => void): this {
    this.#listeners.get(type)?.delete(handler);
    return this;
  }

  /** Adds channels. With `marks`, `syms` replaces the markets (`null`: every market). Kept for each reconnect; sent now when open. */
  subscribe(channels: Channel[], syms?: string[] | null): void {
    const want = channelsOf(channels);
    if (syms && !want.includes("marks")) throw new TypeError("syms: with marks only");
    this.#channels = CHANNELS.filter((c) => this.#channels.includes(c) || want.includes(c));
    if (want.includes("marks")) this.#syms = syms ? [...syms] : null;
    if (this.#live && this.#ws) {
      this.#send(this.#ws, { type: "subscribe", channels: want, ...(want.includes("marks") && this.#syms ? { syms: this.#syms } : {}) });
    }
  }

  /** Stops channels, now and on each reconnect. */
  unsubscribe(channels: Channel[]): void {
    const want = channelsOf(channels);
    this.#channels = this.#channels.filter((c) => !want.includes(c));
    if (want.includes("marks")) this.#syms = null;
    if (this.#live && this.#ws) this.#send(this.#ws, { type: "unsubscribe", channels: want });
  }

  /** Ends the stream. The iteration stops, and it does not connect again. */
  close(): void {
    this.#closed = true;
    this.#cancelWait?.();
    const ws = this.#ws;
    this.#ws = null;
    this.#stopPing();
    this.#stopOpenTimer();
    if (ws) {
      try {
        ws.close(1000, "bye");
      } catch {
        // already closing
      }
    }
    this.#end(null);
  }

  [Symbol.asyncIterator](): AsyncIterator<Frame> {
    this.#iterating = true;
    this.start();
    return {
      next: () => {
        const frame = this.#queue.shift();
        if (frame) return Promise.resolve({ value: frame, done: false });
        if (this.#ended) {
          const error = this.#endError;
          this.#endError = null;
          return error ? Promise.reject(error) : Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<Frame>>((resolve, reject) => this.#waiters.push({ resolve, reject }));
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }

  // ---------- the loop ----------

  async #connect(): Promise<void> {
    if (this.#closed) return;
    let Ctor: WebSocketConstructor;
    try {
      Ctor = await webSocketClass(this.#WebSocket);
    } catch (e) {
      this.#closed = true;
      this.#end(new EtaError(0, "no WebSocket here: use Node 22 or later, or npm install ws", { cause: e }));
      return;
    }
    if (this.#closed) return;
    let ws: WebSocketLike;
    try {
      ws = new Ctor(this.url);
    } catch (e) {
      this.#closed = true;
      this.#end(new EtaError(0, `stream: ${(e as Error)?.message ?? String(e)}`, { cause: e }));
      return;
    }
    this.#ws = ws;
    this.#lastError = null;
    // a handshake that never answers (a lost SYN, a hung proxy, no ready to the key) may never fire onclose: drop it at the deadline
    this.#stopOpenTimer();
    this.#openTimer = setTimeout(() => {
      if (ws !== this.#ws) return;
      this.#dropReason = "open timeout";
      ws.onclose = null; // the drop is reported here, once, with no close code (a socket closed while opening fires a close of its own)
      ws.onmessage = null;
      try {
        ws.close();
      } catch {
        // not open yet: dropping it below is enough
      }
      this.#dropped(ws, undefined, undefined);
    }, this.#openTimeoutMs);
    ws.onopen = () => this.#send(ws, { type: "auth", key: this.#key });
    ws.onmessage = (event) => this.#message(ws, event.data);
    ws.onerror = () => undefined; // a close follows
    ws.onclose = (event) => this.#dropped(ws, event.code, event.reason);
  }

  #message(ws: WebSocketLike, data: unknown): void {
    if (ws !== this.#ws) return;
    const frame = parse(data);
    if (!frame || (frame.type as string) === "pong") return;
    if (frame.type === "error") this.#lastError = frame;
    this.#emit(frame);
    if (frame.type === "ready") {
      this.#stopOpenTimer();
      this.handle = frame.handle;
      this.#backoff = this.#backoffMs;
      void this.#afterReady(ws);
    }
  }

  /** After a drop, catch up with GET /me; then subscribe and start pinging. */
  async #afterReady(ws: WebSocketLike): Promise<void> {
    if (this.#closed || ws !== this.#ws) return; // a ready handler closed the stream
    if (this.#hadSession && this.#resync && this.#channels.includes("account")) {
      let me: Me;
      try {
        me = await this.#client.me();
      } catch (e) {
        if (ws !== this.#ws) return;
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
      if (ws !== this.#ws) return;
      this.#emit({ type: "resync", me });
      if (this.#closed || ws !== this.#ws) return; // a resync handler closed the stream
    }
    this.#hadSession = true;
    this.#live = true;
    if (this.#channels.length) {
      this.#send(ws, { type: "subscribe", channels: this.#channels, ...(this.#channels.includes("marks") && this.#syms ? { syms: this.#syms } : {}) });
    }
    this.#stopPing();
    this.#ping = setInterval(() => this.#send(ws, { type: "ping" }), this.#pingMs);
  }

  #dropped(ws: WebSocketLike, code: number | undefined, reason: string | undefined): void {
    if (ws !== this.#ws) return;
    this.#ws = null;
    this.#live = false;
    this.#stopPing();
    this.#stopOpenTimer();
    if (this.#closed) return this.#end(null);
    const last = this.#lastError;
    const err = last?.err ?? this.#dropReason ?? (reason || null);
    this.#dropReason = null;
    if (code === CLOSE_KEY) {
      this.#closed = true;
      const { type: _t, err: _e, ...fields } = last ?? ({} as Partial<ErrorFrame>);
      return this.#end(new EtaError(0, err ?? "bad key", { code, fields }));
    }
    let wait = this.#backoff;
    if (code === CLOSE_LIMIT && typeof last?.retryAfter === "number") wait = Math.max(wait, last.retryAfter * 1000);
    this.#backoff = Math.min(this.#backoff * 2, this.#maxBackoffMs);
    this.#emit({ type: "closed", code: code ?? null, err, wait: wait / 1000 });
    void this.#reconnectAfter(wait);
  }

  async #reconnectAfter(ms: number): Promise<void> {
    await Promise.race([this.#sleep(ms), new Promise<void>((done) => (this.#cancelWait = done))]);
    this.#cancelWait = null;
    if (!this.#closed) await this.#connect();
  }

  #emit(frame: Frame): void {
    for (const handler of [...(this.#listeners.get(frame.type) ?? []), ...(this.#listeners.get("frame") ?? [])]) call(handler, frame);
    if (!this.#iterating) return;
    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve({ value: frame, done: false });
    else this.#queue.push(frame);
  }

  #end(error: EtaError | null): void {
    if (this.#ended) return;
    this.#ended = true;
    this.#stopPing();
    this.#stopOpenTimer();
    this.#cancelWait?.();
    for (const handler of this.#listeners.get("end") ?? []) call(handler, error);
    // a waiter means the queue is empty: the first waiter gets the error; else next() gives it once the queue is read
    const waiters = this.#waiters.splice(0);
    if (waiters.length) {
      waiters.forEach((waiter, i) => (error && i === 0 ? waiter.reject(error) : waiter.resolve({ value: undefined, done: true })));
    } else {
      this.#endError = error;
    }
    this.#settle(error);
  }

  #send(ws: WebSocketLike, frame: object): void {
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // closing: the close handler takes it from here
    }
  }

  #stopPing(): void {
    if (this.#ping !== undefined) clearInterval(this.#ping);
    this.#ping = undefined;
  }

  #stopOpenTimer(): void {
    if (this.#openTimer !== undefined) clearTimeout(this.#openTimer);
    this.#openTimer = undefined;
  }
}

// ---------- helpers ----------

function channelsOf(channels: readonly string[], allowEmpty = false): Channel[] {
  const list = [...channels];
  if ((!list.length && !allowEmpty) || list.some((c) => !CHANNELS.includes(c as Channel))) throw new TypeError("channels: account, marks");
  return CHANNELS.filter((c) => list.includes(c));
}

function streamUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "http:" ? "ws:" : u.protocol === "https:" ? "wss:" : u.protocol;
  u.pathname = u.pathname.replace(/\/+$/, "") + "/stream";
  u.search = "";
  u.hash = "";
  return u.toString();
}

function parse(data: unknown): Frame | null {
  try {
    const text = typeof data === "string" ? data : data instanceof ArrayBuffer ? new TextDecoder().decode(data) : String(data);
    const frame = JSON.parse(text);
    return frame && typeof frame === "object" && typeof frame.type === "string" ? (frame as Frame) : null;
  } catch {
    return null;
  }
}

/** A handler that throws is reported as the platform reports a throwing event listener; the stream goes on. */
function call(handler: Listener, value: unknown): void {
  try {
    (handler as (v: unknown) => void)(value);
  } catch (e) {
    setTimeout(() => {
      throw e;
    }, 0);
  }
}

async function webSocketClass(given?: WebSocketConstructor): Promise<WebSocketConstructor> {
  if (given) return given;
  const global = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
  if (typeof global === "function") return global;
  const name = "ws"; // a name in a variable: bundlers leave it alone, and TypeScript needs no types for it
  const mod = (await import(/* webpackIgnore: true */ /* @vite-ignore */ name)) as { WebSocket?: WebSocketConstructor; default?: WebSocketConstructor };
  const Ctor = mod.WebSocket ?? mod.default;
  if (typeof Ctor !== "function") throw new Error("ws: no WebSocket export");
  return Ctor;
}
