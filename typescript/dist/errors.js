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
export class EtaError extends Error {
    status;
    err;
    fields;
    requestId;
    clientId;
    code;
    body;
    constructor(status, err, init = {}) {
        const fields = { ...(init.fields ?? {}) };
        super(message(status, err, fields, init), init.cause === undefined ? undefined : { cause: init.cause });
        this.name = "EtaError";
        this.status = status;
        this.err = err;
        this.fields = fields;
        this.requestId = init.requestId ?? null;
        this.clientId = init.clientId ?? null;
        this.code = init.code ?? null;
        this.body = init.body;
    }
    /** With `too fast`: the seconds eta asked you to wait. */
    get retryAfter() {
        const v = this.fields.retryAfter;
        return typeof v === "number" ? v : undefined;
    }
}
function message(status, err, fields, init) {
    let head = status ? `${status} ${err}` : err;
    if (init.code != null)
        head = `stream closed ${init.code}: ${err}`;
    const parts = [head];
    const keys = Object.keys(fields);
    if (keys.length)
        parts.push(`(${keys.map((k) => `${k}: ${typeof fields[k] === "string" ? fields[k] : JSON.stringify(fields[k])}`).join(", ")})`);
    if (init.clientId)
        parts.push(`[clientId ${init.clientId}]`);
    if (init.requestId)
        parts.push(`[X-Request-Id ${init.requestId}]`);
    return parts.join(" ");
}
