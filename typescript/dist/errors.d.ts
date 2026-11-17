export interface EtaErrorInit {
    fields?: Record<string, unknown>;
    requestId?: string | null;
    clientId?: string | null;
    code?: number | null;
    body?: unknown;
    cause?: unknown;
}
/**
 * A call eta refused, a call that got no answer, or a stream that stopped for good.
 *
 * - `status`: the HTTP status, such as 400 or 429. 0 when no answer came (a network error or a timeout), and for a stream that stopped.
 * - `err`: the API's own words, such as `"price moved"` or `"scope"`. `"network"` when no answer came.
 * - `fields`: the answer's other fields, such as `{ need: "trade" }` or `{ price: 40.61, quoted: 40.346224 }`.
 * - `requestId`: the answer's `X-Request-Id`. Quote it when you ask eta about a call.
 * - `clientId`: the `clientId` an order or close was sent with. Send the same order again with it, or look for it in `me()`.
 * - `code`: a stream's close code, such as 4001.
 * - `body`: the whole answer: the parsed JSON, or the text when it was not JSON.
 */
export declare class EtaError extends Error {
    readonly status: number;
    readonly err: string;
    readonly fields: Record<string, unknown>;
    readonly requestId: string | null;
    readonly clientId: string | null;
    readonly code: number | null;
    readonly body: unknown;
    constructor(status: number, err: string, init?: EtaErrorInit);
    /** With `too fast`: the seconds eta asked you to wait. */
    get retryAfter(): number | undefined;
}
