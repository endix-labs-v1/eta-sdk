# eta SDKs

The official SDKs for the [eta API](https://eta-cash.gitbook.io/api/), in Python and in TypeScript. Read your account and the
markets, post your picks, run your narratives and trade by code.

eta runs on demo money today: every account starts with $10,000 of demo cash, and the server signs nothing on any chain.

- [`python/`](python): the package `eta-api`, imported as `eta_api`. Python 3.9 or later.
- [`typescript/`](typescript): the package `eta-api`. ESM with types. Node 20 or later, or a browser.

You need an API key. Make one from a signed-in session, as the [Quick start](https://eta-cash.gitbook.io/api/quick-start)
shows. Give it only the scopes your bot needs.

## Install

Python:

```bash
pip install "git+https://github.com/endix-labs-v1/eta-sdk#subdirectory=python"
```

TypeScript or JavaScript:

```bash
npm install github:endix-labs-v1/eta-sdk
```

A git install of the TypeScript SDK reads the `package.json` at the root of this repository, which points at the built files
in `typescript/dist`. `dist/` is committed, so the install runs no build. (npm 11 can't install a git subdirectory: it drops
`#path:` from the resolved URL.)

## Quick start

Python:

```python
import os
from eta_api import EtaClient

eta = EtaClient(os.environ["ETA_KEY"])
me = eta.me()
print(me["user"]["handle"], me["user"]["cash"])

eta.post("Long $HYPE into the weekend.", home="HYPE")
quote = eta.quote("HYPE", "buy", 25)
order = eta.order("HYPE", "buy", 25, quote_id=quote["quoteId"], max_slippage_pct=1)
print(order["fill"]["price"])
```

TypeScript:

```ts
import { EtaClient } from "eta-api";

const eta = new EtaClient({ key: process.env.ETA_KEY! });
const me = await eta.me();
console.log(me.user.handle, me.user.cash);

await eta.post({ text: "Long $HYPE into the weekend.", home: "HYPE" });
const quote = await eta.quote({ sym: "HYPE", side: "buy", usd: 25 });
const order = await eta.order({ sym: "HYPE", side: "buy", usd: 25, quoteId: quote.quoteId, maxSlippagePct: 1 });
if ("fill" in order) console.log(order.fill.price);
```

Each answer is the JSON eta sends: a `dict` in Python, an object in TypeScript. The types name its fields; they come from
the API's OpenAPI spec.

## The methods

Every route a key can call has a method. Keys and sessions are not in the SDKs: you make and revoke keys from a signed-in
session, in the app or with `POST /keys`.

| What | Python | TypeScript |
|---|---|---|
| Reads | `me`, `bootstrap`, `markets`, `trades`, `flows`, `fills`, `stats`, `board`, `narrative_history`, `narrative_versions`, `follows`, `file` | the same, in camelCase: `narrativeHistory`, `narrativeVersions` |
| Posts | `post`, `reply`, `delete_post`, `upload` | `post`, `reply`, `deletePost`, `upload` |
| Creator | `launch`, `edit` (`narrEdit`), `propose`, `sim` | the same |
| Trade | `quote`, `order`, `cancel`, `cancel_all`, `close` | `quote`, `order`, `cancel`, `cancelAll`, `close` |
| Any action | `act({"type": ..., ...})` | `act({ type: ..., ... })` |
| Live updates | `stream(...)` | `stream({ ... })` |

Python takes keyword arguments in snake_case (`quote_id`, `max_slippage_pct`, `client_id`) and sends them in the API's
camelCase. TypeScript takes the API's own field names.

`edit` sends only what you pass. In Python, `vote_minutes=None` sends `null`, which puts the vote length back to the
server's own; a field you leave out is not sent.

## Safe retries

A call can time out after eta got it. Sent again, an order would trade a second time. eta stops that with a `clientId`: an
order or a close sent again with the same `clientId` does nothing new and answers what the first answered, with
`repeat: true`.

The SDKs use it for you:

- **Every order and close carries a `clientId`.** Yours if you pass one, else a new random uuid.
- **A network error, a timeout or a 5xx sends it again with the same `clientId`**, so a retry can't trade twice. It tries
  twice more by default, after 0.5 and 1 second (`network_retries` / `networkRetries`).
- **When every try fails**, the error carries the `clientId` (`error.client_id` / `error.clientId`). Look for it in your
  fills and orders in `me()`, or send the order again with it: it will never trade twice.
- **A refusal is not retried.** A `400` changed nothing; fix the order and send it again.

The same rule decides every other call. A call is sent again after a network error, a timeout or a 5xx only when sending it
twice can't do anything twice:

- **Retried:** every read, `quote`, `sim`, `upload` (the same picture gets the same URL), `order` and `close`, and `post` or
  `reply` when you give it your own `id`.
- **Not retried:** `post` and `reply` without an `id`, `delete_post`, `launch`, `edit`, `propose`, `cancel` and
  `cancel_all`. Each raises at once: with `status` 0 and `err` `"network"` after a network error or a timeout, and with
  its own status after a 5xx.

## Errors and rate limits

A refused call raises (Python) or throws (TypeScript) an `EtaError`:

- `status`: the HTTP status. 0 when no answer came.
- `err`: the API's own words, such as `"price moved"` or `"scope"`.
- `fields`: the answer's other fields, such as `{"need": "trade"}` or `{"price": 40.61, "quoted": 40.346224}`.
- `request_id` / `requestId`: the answer's `X-Request-Id`. Quote it when you ask eta about a call.
- `client_id` / `clientId`: an order's or a close's `clientId`.

```python
from eta_api import EtaError

try:
    eta.order("HYPE", "buy", 25, quote_id=quote["quoteId"], max_slippage_pct=1)
except EtaError as e:
    if e.err == "price moved":
        print("Now", e.fields["price"], "quoted", e.fields["quoted"])
    else:
        print(e.status, e.err, e.request_id)
```

A `429 too fast` is not an error you see at first. The client waits the `retryAfter` seconds the answer gives and sends the
call again, up to 3 times (`rate_limit_retries` / `rateLimitRetries`). It never waits longer than 60 seconds for one call
(`rate_limit_max_wait` / `rateLimitMaxWaitMs`); a longer wait raises the 429 with `retry_after` / `retryAfter`.

The newest `X-RateLimit-*` values are on the client: `eta.rate_limit` in Python (a `RateLimit` with `limit`, `remaining`
and `reset`), `eta.rateLimit` in TypeScript. `None` / `null` until the first answer that has them. A key may make 30
calls in 10 seconds, and all of an account's keys together 60. See
[Errors and limits](https://eta-cash.gitbook.io/api/errors-and-limits).

## The stream

A stream pushes your fills, your orders, your record and prices as they happen, so a bot doesn't read `me()` again and
again.

Python (async, with `websockets`):

```python
import asyncio, os
from eta_api import EtaClient

async def main():
    eta = EtaClient(os.environ["ETA_KEY"])
    async with eta.stream(["account", "marks"], syms=["HYPE"]) as stream:
        async for frame in stream:
            if frame["type"] == "fill":
                print("Fill", frame["fill"]["side"], frame["fill"]["qty"], frame["fill"]["sym"])
            elif frame["type"] == "marks":
                print("Prices", frame["marks"])

asyncio.run(main())
```

TypeScript (the global `WebSocket` of Node 22+ and browsers; on Node 20, `npm install ws` too):

```ts
const stream = eta.stream({ channels: ["account", "marks"], syms: ["HYPE"] });
stream.on("fill", (f) => console.log("Fill", f.fill.side, f.fill.qty, f.fill.sym));
stream.on("marks", (m) => console.log("Prices", m.marks));
stream.on("end", (error) => error && console.error(error.err));
```

Or `for await (const frame of stream)`. Breaking out of the loop closes the stream.

What it does for you:

- It sends your key in the first frame, never in the URL, then subscribes.
- It pings every 30 seconds. eta closes a stream that sends nothing for 60.
- If the stream hasn't opened and had eta's `ready` within 10 seconds, it drops it and connects again
  (`open_timeout` / `openTimeoutMs`). A handshake that never answers can't hold it for good.
- When the stream drops, it connects again after 1 second, then 2, 4, up to a minute. It reads `GET /me` to catch up, as a
  `resync` frame, then subscribes again. A stream doesn't replay what happened while it was closed.
- On close 4029 (too fast, or too many streams) it waits the `retryAfter` eta gives.
- On close 4001 (a bad or revoked key, or a session token) it stops for good: the iteration raises `EtaError` with
  `code` 4001, and TypeScript's `end` handlers get it.

Besides eta's own frames (`ready`, `subscribed`, `fill`, `order`, `me`, `marks`, `error`), it gives two of its own:
`resync` (`{ me }`, after a reconnect) and `closed` (`{ code, err, wait }`, each time the stream drops). It keeps `pong`
frames to itself. `stream.subscribe(...)` and `stream.unsubscribe(...)` change the channels, now and on every reconnect.
See [Live updates](https://eta-cash.gitbook.io/api/stream).

## Tests

Each SDK has unit tests against a local mock of the API and the stream, and integration tests against a real eta API. No
test reaches a real network unless `ETA_API` and `ETA_KEY` are both set: a net guard in each suite refuses any other host.

Python:

```bash
cd python
python3 -m venv .venv && .venv/bin/pip install -e ".[test]"
.venv/bin/python -m pytest
```

TypeScript:

```bash
cd typescript
npm install
npm test    # compiles dist/, type-checks, then runs the tests
```

The integration tests walk the quick start: `me`, a post, a quote, an order sent twice with one `clientId` (one fill),
`cancelAll`, and a stream that sees its own fill. They need a key with the `post` and `trade` scopes, and trade a few
dollars of demo money:

```bash
ETA_API=https://... ETA_KEY=eta_... .venv/bin/python -m pytest tests/test_integration.py
ETA_API=https://... ETA_KEY=eta_... node --test test/integration.test.mjs
```

`ETA_SYM` (`HYPE` by default) and `ETA_USD` (`1`) set the market and the dollars.

## Links

- The docs: https://eta-cash.gitbook.io/api/
- [Quick start](https://eta-cash.gitbook.io/api/quick-start), [Errors and limits](https://eta-cash.gitbook.io/api/errors-and-limits),
  [Live updates](https://eta-cash.gitbook.io/api/stream)
- The OpenAPI spec is in the docs, under API reference.

## License

MIT. See [LICENSE](LICENSE).
