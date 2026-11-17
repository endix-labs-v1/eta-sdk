// The HTTP client against the local mock: routes, errors, 429s and safe retries. Runs the built package (dist/).
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { EtaClient, EtaError, VERSION, newClientId } from "../dist/index.js";
import { FILE_ID, KEY, MockApi, PNG, REQUEST_ID, sleeps } from "./mock-server.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY = Symbol("a fresh uuid");

let api, eta, waits;
beforeEach(async () => {
  api = await new MockApi().start();
  const s = sleeps();
  waits = s.waits;
  eta = new EtaClient({ key: KEY, baseUrl: api.url, sleep: s.sleep });
});
afterEach(() => api.stop());

// [name, call, method, path, query, body]. body undefined: no body. clientId ANY: a fresh uuid.
const ROUTES = [
  // reads
  ["me", (c) => c.me(), "GET", "/me", {}],
  ["bootstrap", (c) => c.bootstrap(), "GET", "/bootstrap", {}],
  ["markets", (c) => c.markets(), "GET", "/markets", {}],
  ["trades", (c) => c.trades("BTC-PERP", { n: 5 }), "GET", "/trades/BTC-PERP", { n: "5" }],
  ["trades default", (c) => c.trades("HYPE"), "GET", "/trades/HYPE", {}],
  ["flows", (c) => c.flows("HYPE"), "GET", "/flows/HYPE", {}],
  ["fills", (c) => c.fills("mira.eth"), "GET", "/fills/mira.eth", {}],
  ["stats", (c) => c.stats("yourhandle", { days: 7 }), "GET", "/stats/yourhandle", { days: "7" }],
  ["board", (c) => c.board({ by: "volume", days: 1, n: 10 }), "GET", "/board", { by: "volume", days: "1", n: "10" }],
  ["narrative history", (c) => c.narrativeHistory("PICKS", { days: 3 }), "GET", "/narrative/PICKS/history", { days: "3" }],
  ["narrative versions", (c) => c.narrativeVersions("PICKS"), "GET", "/narrative/PICKS/versions", {}],
  ["follows", (c) => c.follows("yourhandle"), "GET", "/follows/yourhandle", {}],
  ["file", (c) => c.file(`/files/${FILE_ID}`), "GET", `/files/${FILE_ID}`, {}],
  ["path segment encoded", (c) => c.fills("a b/c"), "GET", "/fills/a%20b%2Fc", {}],
  // posts
  ["post", (c) => c.post({ text: "Long $HYPE.", home: "HYPE", thesis: true, id: "pick-2026-11-13-hype" }), "POST", "/act", {},
    { type: "post", text: "Long $HYPE.", home: "HYPE", thesis: true, id: "pick-2026-11-13-hype" }],
  ["reply", (c) => c.reply({ key: "r:post:c2_g_um58aNl", text: "Adding on the dip.", to: "sage" }), "POST", "/act", {},
    { type: "reply", key: "r:post:c2_g_um58aNl", text: "Adding on the dip.", to: "sage" }],
  ["deletePost", (c) => c.deletePost("YfIdGyGrcIRT"), "POST", "/act", {}, { type: "deletePost", id: "YfIdGyGrcIRT" }],
  // creator
  ["launch", (c) => c.launch({ sym: "PICKS", comps: [["HYPE", 60], ["PURR", 40]], cap: 70, thesis: "My picks.", voteMinutes: 1440 }), "POST", "/act", {},
    { type: "launch", sym: "PICKS", comps: [["HYPE", 60], ["PURR", 40]], cap: 70, thesis: "My picks.", voteMinutes: 1440 }],
  ["narrEdit", (c) => c.edit({ sym: "PICKS", thesis: "Rebalanced on Sundays.", vetoMinutes: 480 }), "POST", "/act", {},
    { type: "narrEdit", sym: "PICKS", thesis: "Rebalanced on Sundays.", vetoMinutes: 480 }],
  ["narrEdit null and empty", (c) => c.edit({ sym: "PICKS", pic: "", voteMinutes: null }), "POST", "/act", {},
    { type: "narrEdit", sym: "PICKS", pic: "", voteMinutes: null }],
  ["propose", (c) => c.propose({ sym: "PICKS", changes: [["HYPE", 60, 63], ["PURR", 40, 37]], why: "PURR volume thinned out." }), "POST", "/act", {},
    { type: "propose", sym: "PICKS", changes: [["HYPE", 60, 63], ["PURR", 40, 37]], why: "PURR volume thinned out." }],
  ["sim", (c) => c.sim("PICKS", { days: 3, seed: 1, volumePerDay: 1000 }), "POST", "/sim/PICKS", {}, { days: 3, seed: 1, volumePerDay: 1000 }],
  ["sim defaults", (c) => c.sim("PICKS"), "POST", "/sim/PICKS", {}, {}],
  // trade
  ["quote", (c) => c.quote({ sym: "HYPE", side: "buy", usd: 250 }), "POST", "/quote", {}, { sym: "HYPE", side: "buy", usd: 250 }],
  ["quote a close", (c) => c.quote({ closeId: "UNNW5aZVXV63", frac: 0.5 }), "POST", "/quote", {}, { closeId: "UNNW5aZVXV63", frac: 0.5 }],
  ["order", (c) => c.order({ sym: "HYPE", side: "buy", usd: 250, quoteId: "GdCdBVBb", maxSlippagePct: 1 }), "POST", "/act", {},
    { type: "order", sym: "HYPE", side: "buy", usd: 250, quoteId: "GdCdBVBb", maxSlippagePct: 1, clientId: ANY }],
  ["order with your clientId", (c) => c.order({ sym: "HYPE", side: "buy", usd: 250, limit: 38.2, clientId: "hype-dip-0001" }), "POST", "/act", {},
    { type: "order", sym: "HYPE", side: "buy", usd: 250, limit: 38.2, clientId: "hype-dip-0001" }],
  ["cancel", (c) => c.cancel("P5weq-afPxzk"), "POST", "/act", {}, { type: "cancel", id: "P5weq-afPxzk" }],
  ["cancel by clientId", (c) => c.cancel({ clientId: "hype-dip-0002" }), "POST", "/act", {}, { type: "cancel", clientId: "hype-dip-0002" }],
  ["cancelAll", (c) => c.cancelAll(), "POST", "/act", {}, { type: "cancelAll" }],
  ["cancelAll on one market", (c) => c.cancelAll({ sym: "HYPE" }), "POST", "/act", {}, { type: "cancelAll", sym: "HYPE" }],
  ["close", (c) => c.close({ id: "UNNW5aZVXV63", frac: 0.5 }), "POST", "/act", {}, { type: "close", id: "UNNW5aZVXV63", frac: 0.5, clientId: ANY }],
  ["act", (c) => c.act({ type: "order", sym: "HYPE", side: "sell", usd: 10 }), "POST", "/act", {}, { type: "order", sym: "HYPE", side: "sell", usd: 10, clientId: ANY }],
];

describe("each route sends its method, path, body and headers", () => {
  for (const [name, call, method, path, query, body] of ROUTES) {
    test(name, async () => {
      await call(eta);
      assert.equal(api.seen.length, 1);
      const seen = api.seen[0];
      assert.deepEqual([seen.method, seen.path, seen.query], [method, path, query]);
      assert.ok(seen.headers.authorization === `Bearer ${KEY}`, "the key goes in the Authorization header");
      assert.equal(seen.headers["user-agent"], `eta-api-js/${VERSION}`);
      if (body === undefined) return assert.equal(seen.body.length, 0);
      assert.equal(seen.headers["content-type"], "application/json");
      const expected = { ...body };
      if (expected.clientId === ANY) {
        assert.match(seen.json.clientId, UUID);
        expected.clientId = seen.json.clientId;
      }
      assert.deepEqual(seen.json, expected);
    });
  }
});

test("answers come back as eta sends them", async () => {
  assert.equal((await eta.me()).user.handle, "yourhandle");
  assert.equal((await eta.quote({ sym: "HYPE", side: "buy", usd: 250 })).quoteId, "GdCdBVBb");
  assert.equal((await eta.cancelAll()).cancelled, 2);
  assert.equal((await eta.order({ sym: "HYPE", side: "buy", usd: 250, clientId: "mine-1" })).fill.clientId, "mine-1");
  assert.deepEqual(Buffer.from(await eta.file(FILE_ID)), PNG);
});

test("upload sends the bytes with their type", async () => {
  for (const picture of [new Uint8Array(PNG), PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length), new Blob([PNG])]) {
    assert.equal((await eta.upload(picture)).url, `/files/${FILE_ID}`);
  }
  for (const seen of api.seen) {
    assert.deepEqual([seen.method, seen.path, seen.body], ["POST", "/files", PNG]);
    assert.equal(seen.headers["content-type"], "image/png");
  }
});

test("fetch is never called on the client (a browser's fetch would throw Illegal invocation)", async () => {
  const receivers = [];
  const fetchSpy = function (input, init) {
    receivers.push(this);
    return globalThis.fetch(input, init);
  };
  const c = new EtaClient({ key: KEY, baseUrl: api.url, fetch: fetchSpy });
  await c.me();
  assert.deepEqual(receivers, [undefined]);
});

test("each order gets a new clientId", async () => {
  await eta.order({ sym: "HYPE", side: "buy", usd: 25 });
  await eta.order({ sym: "HYPE", side: "buy", usd: 25 });
  assert.notEqual(api.seen[0].json.clientId, api.seen[1].json.clientId);
  assert.match(newClientId(), UUID);
});

test("bad arguments are refused before sending", () => {
  assert.throws(() => eta.cancel({}), TypeError);
  assert.throws(() => eta.cancel({ id: "a", clientId: "b" }), TypeError);
  assert.throws(() => eta.act({ sym: "HYPE" }), TypeError);
  assert.throws(() => new EtaClient({ key: "" }), TypeError);
  assert.throws(() => eta.stream({ channels: ["trades"] }), TypeError);
  assert.equal(api.seen.length, 0);
});

// ---------- errors ----------

test("an error carries status, err, fields and the request id", async () => {
  api.respond("POST", "/act", { status: 403, body: { err: "scope", need: "trade" }, headers: { "x-request-id": "req-403" } });
  const e = await eta.cancelAll().catch((x) => x);
  assert.ok(e instanceof EtaError);
  assert.deepEqual([e.status, e.err, e.fields, e.requestId], [403, "scope", { need: "trade" }, "req-403"]);
  assert.deepEqual(e.body, { err: "scope", need: "trade" });
  assert.match(e.message, /403 scope/);
  assert.match(e.message, /req-403/);
});

test("a refused order carries its fields and clientId, and is not retried", async () => {
  api.respond("POST", "/act", { status: 400, body: { err: "price moved", price: 40.61, quoted: 40.346224 } });
  const e = await eta.order({ sym: "HYPE", side: "buy", usd: 250, quoteId: "GdCdBVBb", clientId: "hype-0007" }).catch((x) => x);
  assert.deepEqual([e.status, e.err, e.fields], [400, "price moved", { price: 40.61, quoted: 40.346224 }]);
  assert.deepEqual([e.clientId, e.requestId], ["hype-0007", REQUEST_ID]);
  assert.equal(api.seen.length, 1);
});

test("an answer that is not JSON still makes an EtaError", async () => {
  const e = await eta.file("nope").catch((x) => x);
  assert.deepEqual([e.status, e.err, e.requestId], [404, "404 Not Found", REQUEST_ID]);
});

test("a bad key is 401, and the key is never in the error or the client's text", async () => {
  const secret = "W".repeat(43);
  const bad = new EtaClient({ key: `eta_ea1d498e83b6_${secret}`, baseUrl: api.url });
  const e = await bad.me().catch((x) => x);
  assert.deepEqual([e.status, e.err], [401, "bad key"]);
  for (const text of [e.message, e.stack, JSON.stringify(e), String(bad), JSON.stringify(bad), JSON.stringify(Object.entries(bad))]) {
    assert.ok(!text.includes(secret), "no secret in the text");
  }
  assert.equal(String(bad), `EtaClient(eta_ea1d498e83b6_..., ${api.url})`);
  assert.equal(bad.keyId, "ea1d498e83b6");
});

test("a network error is an EtaError with status 0", async () => {
  const c = new EtaClient({ key: KEY, baseUrl: "http://127.0.0.1:9", networkRetries: 0 });
  const e = await c.me().catch((x) => x);
  assert.deepEqual([e.status, e.err], [0, "network"]);
  assert.ok(e.cause instanceof Error);
});

// ---------- rate limits ----------

test("rate-limit headers are kept", async () => {
  assert.equal(eta.rateLimit, null);
  await eta.me();
  assert.deepEqual(eta.rateLimit, { limit: 30, remaining: 27, reset: 8 });
  assert.equal(eta.lastRequestId, REQUEST_ID);
  api.rate = [30, 12, 3];
  await eta.markets();
  assert.deepEqual(eta.rateLimit, { limit: 30, remaining: 12, reset: 3 });
});

test("an answer without rate-limit headers keeps the last values", async () => {
  await eta.me();
  api.respond("GET", "/me", { status: 401, body: { err: "key revoked" } });
  await assert.rejects(eta.me(), EtaError);
  assert.deepEqual(eta.rateLimit, { limit: 30, remaining: 27, reset: 8 });
});

test("a 429 waits retryAfter, then sends again", async () => {
  api.respond("POST", "/act", { status: 429, body: { err: "too fast", retryAfter: 4 }, headers: { "retry-after": "4" } });
  const answer = await eta.order({ sym: "HYPE", side: "buy", usd: 25, clientId: "hype-0429" });
  assert.equal(answer.ok, true);
  assert.deepEqual(waits, [4000]);
  const bodies = api.requestsTo("POST", "/act").map((s) => s.json);
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0], bodies[1]);
});

test("a 429 with only the header waits the header", async () => {
  api.respond("GET", "/me", { status: 429, body: { err: "too fast" }, headers: { "retry-after": "2" } });
  await eta.me();
  assert.deepEqual(waits, [2000]);
});

test("429s past the cap throw", async () => {
  const s = sleeps();
  const c = new EtaClient({ key: KEY, baseUrl: api.url, sleep: s.sleep, rateLimitRetries: 2 });
  const tooFast = { status: 429, body: { err: "too fast", retryAfter: 3 }, headers: { "retry-after": "3" } };
  api.respond("GET", "/me", tooFast, tooFast, tooFast);
  const e = await c.me().catch((x) => x);
  assert.deepEqual([e.status, e.err, e.retryAfter], [429, "too fast", 3]);
  assert.deepEqual(s.waits, [3000, 3000]);
  assert.equal(api.requestsTo("GET", "/me").length, 3);
});

test("a 429 longer than the max wait throws at once", async () => {
  api.respond("POST", "/act", { status: 429, body: { err: "too fast", retryAfter: 120 } });
  const e = await eta.post({ text: "hello" }).catch((x) => x);
  assert.equal(e.retryAfter, 120);
  assert.deepEqual(waits, []);
});

// ---------- safe retries ----------

test("an order whose answer was lost is sent again with the same clientId", async () => {
  api.respond("POST", "/act", { drop: true, run: true }); // eta trades, then the connection drops
  const answer = await eta.order({ sym: "HYPE", side: "buy", usd: 250 });
  const sent = api.requestsTo("POST", "/act").map((s) => s.json);
  assert.equal(sent.length, 2);
  assert.equal(sent[0].clientId, sent[1].clientId);
  assert.match(sent[0].clientId, UUID);
  assert.equal(answer.repeat, true);
  assert.equal(answer.fill.clientId, sent[0].clientId);
  assert.equal(api.trades, 1, "one fill, not two");
  assert.equal(waits.length, 1);
});

test("an order that got a 5xx is sent again with the same clientId", async () => {
  api.respond("POST", "/act", { status: 502, body: "<html>Bad Gateway</html>", headers: { "content-type": "text/html" } });
  await eta.order({ sym: "HYPE", side: "buy", usd: 250, clientId: "hype-0502" });
  assert.deepEqual(api.requestsTo("POST", "/act").map((s) => s.json.clientId), ["hype-0502", "hype-0502"]);
});

test("a close that timed out is sent again with the same clientId", async () => {
  const s = sleeps();
  const c = new EtaClient({ key: KEY, baseUrl: api.url, sleep: s.sleep, timeoutMs: 300 });
  api.respond("POST", "/act", { delay: 1000 });
  const answer = await c.close({ id: "UNNW5aZVXV63" });
  const sent = api.requestsTo("POST", "/act").map((x) => x.json.clientId);
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(answer.got, 123.75);
  assert.equal(answer.repeat, true);
  assert.equal(api.trades, 1, "eta closed once: the slow first try, then the retry got its answer");
});

test("an order that never got an answer throws with its clientId", async () => {
  api.respond("POST", "/act", { drop: true }, { drop: true }, { drop: true });
  const e = await eta.order({ sym: "HYPE", side: "buy", usd: 250, clientId: "hype-lost" }).catch((x) => x);
  assert.deepEqual([e.status, e.err, e.clientId], [0, "network", "hype-lost"]);
  assert.equal(api.requestsTo("POST", "/act").length, 3, "the first try and 2 retries");
});

describe("a write that could act twice is not retried", () => {
  const calls = {
    cancel: (c) => c.cancel("P5weq-afPxzk"),
    cancelAll: (c) => c.cancelAll(),
    "post without id": (c) => c.post({ text: "no id of my own" }),
    propose: (c) => c.propose({ sym: "PICKS", fee: 2 }),
    launch: (c) => c.launch({ sym: "PICKS", comps: [["HYPE", 50], ["PURR", 50]], cap: 60 }),
  };
  for (const [name, call] of Object.entries(calls)) {
    test(name, async () => {
      api.respond("POST", "/act", { drop: true });
      const e = await call(eta).catch((x) => x);
      assert.equal(e.status, 0);
      assert.equal(api.requestsTo("POST", "/act").length, 1);
    });
  }
});

test("a post with its own id and a read are retried", async () => {
  api.respond("POST", "/act", { drop: true, run: true });
  assert.equal((await eta.post({ text: "pick", id: "pick-0001" })).id, "pick-0001");
  assert.equal(api.requestsTo("POST", "/act").length, 2);
  api.respond("GET", "/me", { status: 503, body: { err: "starting" } });
  assert.equal((await eta.me()).user.handle, "yourhandle");
  assert.equal(api.requestsTo("GET", "/me").length, 2);
});

test("the net guard refuses a real host", { skip: Boolean(process.env.ETA_API && process.env.ETA_KEY) }, async () => {
  await assert.rejects(fetch("https://example.com"), /real network refused example.com/);
});
