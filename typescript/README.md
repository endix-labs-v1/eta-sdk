# eta-api for TypeScript and JavaScript

The eta API for TypeScript and JavaScript: read, post, run your narratives and trade by code. It runs on demo money today.

```bash
npm install "github:endix-labs-v1/eta-sdk#path:typescript"
```

ESM, with types. Node 20 or later, or a browser. The stream uses the global `WebSocket` (Node 22 or later, and browsers);
on Node 20, also `npm install ws`.

```ts
import { EtaClient } from "eta-api";

const eta = new EtaClient({ key: process.env.ETA_KEY! }); // your key, with the post and trade scopes
const me = await eta.me();
console.log(me.user.handle, me.user.cash);

await eta.post({ text: "Long $HYPE into the weekend.", home: "HYPE" });
const quote = await eta.quote({ sym: "HYPE", side: "buy", usd: 25 });
const order = await eta.order({ sym: "HYPE", side: "buy", usd: 25, quoteId: quote.quoteId, maxSlippagePct: 1 });
if ("fill" in order) console.log(order.fill.price, order.fill.clientId);
```

Every order and close carries a `clientId`, so a retry after a network error can't trade twice. A refused call throws
`EtaError` with `status`, `err`, `fields` and `requestId`. `eta.stream()` gives your fills, orders and prices as they
happen.

The whole guide is in the repository's README and at https://eta-cash.gitbook.io/api/.

## Build and test

```bash
npm install
npm test    # compiles dist/, type-checks, then runs the tests
```

`dist/` is committed, so a git install needs no build. Run `npm run compile` and commit `dist/` with every change to `src/`.
The unit tests run against a local mock and never reach a real network. The integration tests run only with `ETA_API` and
`ETA_KEY` set.
