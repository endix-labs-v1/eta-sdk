# SDKs for Python and TypeScript

eta has official SDKs in Python and in TypeScript. Each one is a client built from one of your [API keys](keys/create.md), with a method for every route in this API reference. They send your key, read the answers, and do the careful parts for you: safe retries of orders, waits on `429`, and a stream that connects again by itself.

The SDKs call the same routes as the rest of these pages, and go through the same checks.

## Install

{% tabs %}
{% tab title="Python" %}
```bash
pip install "git+https://github.com/endix-labs-v1/eta-sdk#subdirectory=python"
```

Python 3.9 or later. The package is `eta-api`; you import `eta_api`.
{% endtab %}

{% tab title="TypeScript" %}
```bash
npm install github:endix-labs-v1/eta-sdk
```

The package is `eta-api`: ESM, with types. Node.js 20 or later, or a browser. The stream uses the `WebSocket` built into Node.js 22 and later and into browsers. On Node.js 20, also `npm install ws`.
{% endtab %}
{% endtabs %}

## Quick start

Make a key with the `post` and `trade` scopes, as in the [Quick start](quick-start.md), and put it in `ETA_KEY`. This reads your account, posts a pick, and buys $25 of HYPE on a quote.

{% tabs %}
{% tab title="Python" %}
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
{% endtab %}

{% tab title="TypeScript" %}
```typescript
import { EtaClient } from "eta-api";

const eta = new EtaClient({ key: process.env.ETA_KEY! });
const me = await eta.me();
console.log(me.user.handle, me.user.cash);

await eta.post({ text: "Long $HYPE into the weekend.", home: "HYPE" });
const quote = await eta.quote({ sym: "HYPE", side: "buy", usd: 25 });
const order = await eta.order({ sym: "HYPE", side: "buy", usd: 25, quoteId: quote.quoteId, maxSlippagePct: 1 });
if ("fill" in order) console.log(order.fill.price);
```
{% endtab %}
{% endtabs %}

Each answer is the JSON eta sends, as each route's page shows it. Python takes its fields in snake_case, such as `quote_id`, and sends them as the API names them. TypeScript takes the API's own names.

## The methods

| What | Python | TypeScript |
|---|---|---|
| [Reads](read/me.md) | `me`, `bootstrap`, `markets`, `trades`, `flows`, `fills`, `stats`, `board`, `narrative_history`, `narrative_versions`, `follows`, `file` | the same names, with `narrativeHistory` and `narrativeVersions` |
| [Posts](post/post.md) | `post`, `reply`, `delete_post`, `upload` | `post`, `reply`, `deletePost`, `upload` |
| [Creator](creator/launch.md) | `launch`, `edit`, `propose`, `sim` | the same |
| [Trade](trade/order.md) | `quote`, `order`, `cancel`, `cancel_all`, `close` | `quote`, `order`, `cancel`, `cancelAll`, `close` |
| [Live updates](stream.md) | `stream` | `stream` |

`edit` is [`narrEdit`](creator/edit.md). `act` sends any action to `POST /act` as you write it. Keys and sign-in are not in the SDKs: you make and revoke keys from a signed-in session.

## Safe retries

A call can time out after eta got it. Sent again, an order would trade a second time. A `clientId` stops that: an order or a close sent again with the same `clientId` does nothing new and gets the first answer, with `"repeat": true`. See [Safe retries](errors-and-limits.md#safe-retries).

The SDKs do this for you:

* Every order and close carries a `clientId`: yours, or a new random one.
* After a network error, a timeout or a `5xx`, the SDK sends it again with the same `clientId`. A retry can't trade twice.
* When every try fails, the error carries the `clientId`. Look for it in your fills and orders in `me`, or send the order again with it.
* A `400` is not sent again. It changed nothing: fix the order and send it again yourself.

Other calls are sent again only when sending them twice can't do anything twice: every read, `quote`, `sim`, `upload`, and a post or reply with your own `id`. A cancel, a launch, an edit, a proposal and a post with no `id` are not sent again.

## Errors

A refused call raises (Python) or throws (TypeScript) an `EtaError`. It carries:

* `status`: the HTTP status. `0` when no answer came.
* `err`: the API's own words, as each route's page lists them.
* `fields`: the answer's other fields, such as `need` or `retryAfter`.
* The answer's `X-Request-Id`: `request_id` in Python, `requestId` in TypeScript. Quote it when you ask eta about a call.

{% tabs %}
{% tab title="Python" %}
```python
from eta_api import EtaError

fresh = eta.quote("HYPE", "buy", 25)  # a quote is good for one order only
try:
    eta.order("HYPE", "buy", 25, quote_id=fresh["quoteId"], max_slippage_pct=1)
except EtaError as e:
    if e.err == "price moved":
        print("Now", e.fields["price"], "quoted", e.fields["quoted"])
    else:
        print(e.status, e.err, e.request_id)
```
{% endtab %}

{% tab title="TypeScript" %}
```typescript
import { EtaError } from "eta-api";

const fresh = await eta.quote({ sym: "HYPE", side: "buy", usd: 25 }); // a quote is good for one order only
try {
  await eta.order({ sym: "HYPE", side: "buy", usd: 25, quoteId: fresh.quoteId, maxSlippagePct: 1 });
} catch (e) {
  if (e instanceof EtaError && e.err === "price moved") console.log("Now", e.fields.price, "quoted", e.fields.quoted);
  else if (e instanceof EtaError) console.log(e.status, e.err, e.requestId);
  else throw e;
}
```
{% endtab %}
{% endtabs %}

## Rate limits

On a `429`, the SDK waits the `retryAfter` seconds the answer gives, then sends the call again. It does this up to 3 times, and waits at most 60 seconds each time. A `retryAfter` longer than that, or a fourth `429`, is raised. You can change both numbers when you make the client.

The newest rate-limit headers are on the client: `eta.rate_limit` in Python, `eta.rateLimit` in TypeScript. Each has `limit`, `remaining` and `reset`, as in [Rate-limit headers](errors-and-limits.md#rate-limit-headers).

## Live updates

`stream` opens a [stream](stream.md) with your key and gives you each frame as it comes.

{% tabs %}
{% tab title="Python" %}
```python
import asyncio, os
from eta_api import EtaClient

async def main():
    eta = EtaClient(os.environ["ETA_KEY"])
    async with eta.stream(["account", "marks"], syms=["HYPE"]) as stream:
        async for frame in stream:
            if frame["type"] == "fill":
                print("Fill:", frame["fill"]["side"], frame["fill"]["qty"], frame["fill"]["sym"])
            elif frame["type"] == "marks":
                print("Prices:", frame["marks"])

asyncio.run(main())
```
{% endtab %}

{% tab title="TypeScript" %}
```typescript
const stream = eta.stream({ channels: ["account", "marks"], syms: ["HYPE"] });
stream.on("fill", (f) => console.log("Fill:", f.fill.side, f.fill.qty, f.fill.sym));
stream.on("marks", (m) => console.log("Prices:", m.marks));
stream.on("end", (error) => error && console.error(error.err));
```

Or read it with `for await (const frame of stream)`. Leaving the loop closes the stream.
{% endtab %}
{% endtabs %}

The SDK does what [Live updates](stream.md) asks of a bot:

* It sends your key in the first frame, never in the URL.
* It pings every 30 seconds.
* If the stream hasn't opened and had the `ready` frame within 10 seconds, it gives up on that socket and connects again after the usual wait: 1 second, then 2, then 4, up to a minute. Python aborts the old socket, and so does TypeScript when you pass `WebSocket` from the `ws` package: `eta.stream({ WebSocket, ... })`. Node.js's built-in `WebSocket` can't abort a socket: it closes the old one in the background, and a peer that never answers can keep it open, and keep your script from exiting, for a long time. To turn the deadline off, pass `open_timeout=None` in Python or `openTimeoutMs: null` in TypeScript.
* When the stream closes, it connects again after 1 second, then 2, then 4, up to a minute, and subscribes again. With the `account` channel on, it first reads [`GET /me`](read/me.md) to catch up.
* After `4029`, it waits the `retryAfter` eta gives.
* After `4001`, it stops for good: the key doesn't open. You get an `EtaError` with `code` 4001.

Besides eta's frames, the SDK gives two of its own. `resync` has your record from `GET /me` after it connects again, when the `account` channel is on. `closed` has the close `code`, the `err` and the seconds it `wait`s before it connects again.

## Source

The SDKs are open source, under the MIT license: [github.com/endix-labs-v1/eta-sdk](https://github.com/endix-labs-v1/eta-sdk).
