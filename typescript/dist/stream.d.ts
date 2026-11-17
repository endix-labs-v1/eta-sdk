import type { EtaClient } from "./client.js";
import { EtaError } from "./errors.js";
import type { Channel, Frame } from "./types.js";
/** The key doesn't open (`bad key`, `key revoked`, `keys only`). The stream stops for good. */
export declare const CLOSE_KEY = 4001;
/** Too fast, or too many streams. The stream waits `retryAfter` when eta gives one. */
export declare const CLOSE_LIMIT = 4029;
/**
 * A handler the stream sets on a socket. It is written as a method, which TypeScript checks both ways, so a socket class whose
 * handlers take a narrower event (ws's `WebSocket.Event`, the DOM's `Event`) still fits under `strict`. A plain function type
 * would be checked one way only (strictFunctionTypes) and refuse both.
 */
type WebSocketHandler<E> = {
    handle(event: E): void;
}["handle"];
/** What the stream needs of a WebSocket: the global one (Node 22+, browsers) and the `ws` package both fit. */
export interface WebSocketLike {
    readonly readyState: number;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    /** Destroys the socket at once, with no close handshake. The `ws` package has it; the global WebSocket doesn't. */
    terminate?(): void;
    onopen: WebSocketHandler<unknown> | null;
    onmessage: WebSocketHandler<{
        data: unknown;
    }> | null;
    onclose: WebSocketHandler<{
        code: number;
        reason: string;
    }> | null;
    onerror: WebSocketHandler<unknown> | null;
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
     *  again. 10,000 by default; `null` or `Infinity` for no deadline. */
    openTimeoutMs?: number | null;
    /** The first wait before connecting again, in milliseconds. 1,000 by default. */
    backoffMs?: number;
    /** The longest wait. 60,000 by default. */
    maxBackoffMs?: number;
    /** Read `GET /me` after each reconnect, when `account` is on. `true` by default. */
    resync?: boolean;
    /** The WebSocket class to use. The global one by default, else the `ws` package. */
    WebSocket?: WebSocketConstructor;
    /** How the stream waits before connecting again. A `setTimeout` that `close()` clears, by default. */
    sleep?: (ms: number) => Promise<void>;
}
type FrameOf<K extends Frame["type"]> = Extract<Frame, {
    type: K;
}>;
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
export declare class EtaStream implements AsyncIterable<Frame> {
    #private;
    readonly url: string;
    /** Your handle, from the `ready` frame. */
    handle: string | null;
    constructor(client: EtaClient, options?: StreamOptions);
    /** The channels the stream subscribes to now. */
    get channels(): Channel[];
    /** The markets `marks` sends, or `null` for every market. */
    get syms(): string[] | null;
    /** Resolves when you close the stream; rejects with the {@link EtaError} that stopped it (close 4001). */
    get done(): Promise<void>;
    /** Connects, if it hasn't yet. */
    start(): this;
    on<K extends Frame["type"]>(type: K, handler: (frame: FrameOf<K>) => void): this;
    on(type: "frame", handler: (frame: Frame) => void): this;
    on(type: "end", handler: (error: EtaError | null) => void): this;
    off(type: string, handler: (value: never) => void): this;
    /** Adds channels. With `marks`, `syms` replaces the markets (`null`: every market). Kept for each reconnect; sent now when open. */
    subscribe(channels: Channel[], syms?: string[] | null): void;
    /** Stops channels, now and on each reconnect. */
    unsubscribe(channels: Channel[]): void;
    /** Ends the stream. The iteration stops, and it does not connect again. */
    close(): void;
    [Symbol.asyncIterator](): AsyncIterator<Frame>;
}
export {};
