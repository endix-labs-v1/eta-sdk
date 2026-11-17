// The quick start against a real eta API. Skipped unless ETA_API and ETA_KEY are set:
//
//   ETA_API=https://staging.example ETA_KEY=eta_... npm test
//
// The key needs the post and trade scopes. It trades demo money: a few $1 buys of ETA_SYM (HYPE by default; ETA_USD sets the
// dollars). The key is never printed.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { EtaClient, newClientId } from "../dist/index.js";

const API = process.env.ETA_API ?? "";
const KEY = process.env.ETA_KEY ?? "";
const SYM = process.env.ETA_SYM ?? "HYPE";
const USD = Number(process.env.ETA_USD ?? "1");
const skip = !(API && KEY) && "set ETA_API and ETA_KEY to run against a real eta API";

const eta = API && KEY ? new EtaClient({ key: KEY, baseUrl: API }) : null;

test("the quick start", { skip }, async () => {
  const me = await eta.me();
  assert.ok(me.user.handle);
  assert.ok(eta.rateLimit && eta.rateLimit.limit > 0);
  assert.ok(eta.lastRequestId);

  const post = await eta.post({ text: `Testing the eta SDK on $${SYM}.`, home: SYM, id: `sdk-test-${randomUUID().slice(0, 16)}` });
  assert.ok(post.ok && post.id);

  const quote = await eta.quote({ sym: SYM, side: "buy", usd: USD });
  assert.ok(quote.quoteId && quote.price > 0);

  const clientId = newClientId();
  const order = { sym: SYM, side: "buy", usd: USD, quoteId: quote.quoteId, maxSlippagePct: 5, clientId };
  const first = await eta.order(order);
  const again = await eta.order(order);
  assert.equal(first.fill?.clientId, clientId);
  assert.equal(again.repeat, true);
  assert.equal(again.fill.id, first.fill.id, "the same clientId twice is one fill");
  assert.equal((await eta.me()).fills.filter((f) => f.clientId === clientId).length, 1);

  const resting = await eta.order({ sym: SYM, side: "buy", usd: USD, limit: Number((quote.mark * 0.5).toFixed(6)) });
  assert.equal(resting.open, true);
  assert.ok((await eta.cancelAll({ sym: SYM })).cancelled >= 1);
  assert.equal((await eta.me()).orders.filter((o) => o.sym === SYM).length, 0);
});

test("the stream sees its own fill", { skip, timeout: 60_000 }, async () => {
  const clientId = newClientId();
  const stream = eta.stream({ channels: ["account"] });
  let ordered = false;
  let filled = false;
  try {
    for await (const frame of stream) {
      if (frame.type === "me" && !ordered) {
        ordered = true; // subscribed, with the record as it is now: trade, then wait for the fill
        await eta.order({ sym: SYM, side: "buy", usd: USD, clientId });
      }
      if (frame.type === "fill" && frame.fill.clientId === clientId) {
        assert.equal(frame.fill.sym, SYM);
        filled = true;
        break;
      }
    }
  } finally {
    stream.close();
  }
  assert.ok(ordered && filled, "the stream got the fill of its own order");
});
