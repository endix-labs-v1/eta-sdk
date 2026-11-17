// The stream against the local mock: auth, subscribe, ping, reconnect with a /me resync, and stop on 4001. Runs the built package.
import assert from "node:assert/strict";
import net from "node:net";
import { afterEach, beforeEach, test } from "node:test";
import { WebSocket as WsWebSocket } from "ws";
import { EtaClient, EtaError } from "../dist/index.js";
import { KEY, ME, MockApi, sleeps, waitUntil } from "./mock-server.mjs";

// every stream a test opens is closed after it, so a failed test leaves no timer or socket that keeps the run alive
const opened = new Set();
const openStream = EtaClient.prototype.stream;
EtaClient.prototype.stream = function (...args) {
  const stream = openStream.apply(this, args);
  opened.add(stream);
  return stream;
};

let api, eta;
beforeEach(async () => {
  api = await new MockApi().start();
  eta = new EtaClient({ key: KEY, baseUrl: api.url });
});
afterEach(async () => {
  for (const stream of opened) stream.close();
  opened.clear();
  await api.stop();
});

async function take(it, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = await it.next();
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const types = (frames) => frames.map((f) => f.type);
const pingsAside = (log) => log.filter((e) => !e.endsWith(" ping"));

test("it sends auth first, then subscribes", async () => {
  const stream = eta.stream({ channels: ["account", "marks"], syms: ["HYPE", "BTC-PERP"] });
  assert.equal(stream.url, api.url.replace("http:", "ws:") + "/stream");
  const frames = await take(stream[Symbol.asyncIterator](), 4);
  assert.deepEqual(types(frames), ["ready", "subscribed", "me", "marks"]);
  assert.equal(stream.handle, "yourhandle");
  assert.deepEqual(frames[2].me, ME);
  const sent = api.frames.map(([, f]) => f);
  assert.ok(sent[0].type === "auth" && sent[0].key === KEY, "the key goes in the first frame");
  assert.deepEqual(sent[1], { type: "subscribe", channels: ["account", "marks"], syms: ["HYPE", "BTC-PERP"] });
  assert.ok(!stream.url.includes(KEY), "never the key in the URL");
  stream.close();
  await stream.done;
});

test("the stream url comes from the base url", () => {
  assert.equal(new EtaClient({ key: KEY }).stream().url, "wss://api.eta.cash/stream");
  assert.equal(new EtaClient({ key: KEY, baseUrl: "http://127.0.0.1:8080/" }).stream().url, "ws://127.0.0.1:8080/stream");
});

test("it pings, and keeps pongs to itself", async () => {
  const stream = eta.stream({ pingMs: 50 });
  const seen = [];
  stream.on("frame", (f) => seen.push(f.type));
  await waitUntil(() => api.received("ping").length >= 3);
  assert.ok(api.received("ping").every(([, f]) => JSON.stringify(f) === '{"type":"ping"}'));
  assert.ok(!seen.includes("pong"));
  stream.close();
});

test("handlers get frames by type, and a fill keeps its clientId", async () => {
  const fill = { id: "UFhfFf0Dpnhf", who: "yourhandle", sym: "HYPE", side: "buy", usd: 25, qty: 0.61948238, price: 40.215026, at: 1794906600160, clientId: "hype-dip-0001" };
  api.afterSubscribe.set(1, async (ws) => {
    ws.send(JSON.stringify({ type: "fill", fill }));
    ws.send(JSON.stringify({ type: "order", event: "filled", order: { id: "NqUmtbyLpjAd" }, fill: fill.id }));
  });
  const stream = eta.stream();
  const fills = [];
  const orders = [];
  stream.on("fill", (f) => fills.push(f)).on("order", (f) => orders.push(f));
  await waitUntil(() => orders.length === 1);
  assert.deepEqual(fills, [{ type: "fill", fill }]);
  assert.equal(orders[0].event, "filled");
  stream.close();
});

test("a drop reconnects, reads /me, then subscribes again", async () => {
  api.afterSubscribe.set(1, async (ws) => {
    ws.send(JSON.stringify({ type: "error", err: "idle" }));
    ws.close(4008, "idle");
  });
  const s = sleeps();
  const stream = eta.stream({ sleep: s.sleep });
  const frames = await take(stream[Symbol.asyncIterator](), 9);
  assert.deepEqual(types(frames), ["ready", "subscribed", "me", "error", "closed", "ready", "resync", "subscribed", "me"]);
  assert.deepEqual(frames[4], { type: "closed", code: 4008, err: "idle", wait: 1 });
  assert.deepEqual(frames[6].me, ME);
  assert.deepEqual(s.waits, [1000]);
  assert.deepEqual(pingsAside(api.log), ["ws1 auth", "ws1 subscribe", "ws2 auth", "http GET /me", "ws2 subscribe"], "after a drop: connect, auth, GET /me, then subscribe");
  stream.close();
});

test("backoff doubles, and starts over after ready", async () => {
  api.refuse.set(1, [4008, { err: "no auth" }]);
  api.refuse.set(2, [4008, { err: "no auth" }]);
  api.refuse.set(3, [4013, { err: "slow reader" }]);
  api.afterSubscribe.set(4, async (ws) => ws.close(1011, "restart"));
  const s = sleeps();
  const stream = eta.stream({ sleep: s.sleep, maxBackoffMs: 3000 });
  let readies = 0;
  stream.on("ready", () => readies++);
  await waitUntil(() => readies === 2);
  assert.deepEqual(s.waits, [1000, 2000, 3000, 1000], "1, 2, then the cap; back to 1 after a stream that opened");
  stream.close();
});

test("4029 waits the retryAfter it gives", async () => {
  api.refuse.set(1, [4029, { err: "too fast", retryAfter: 7 }]);
  const s = sleeps();
  const stream = eta.stream({ sleep: s.sleep });
  const frames = await take(stream[Symbol.asyncIterator](), 3);
  assert.deepEqual(types(frames), ["error", "closed", "ready"]);
  assert.deepEqual(frames[1], { type: "closed", code: 4029, err: "too fast", wait: 7 });
  assert.deepEqual(s.waits, [7000]);
  stream.close();
});

test("4001 stops the stream for good", async () => {
  const secret = "W".repeat(43);
  const bad = new EtaClient({ key: `eta_ea1d498e83b6_${secret}`, baseUrl: api.url });
  const s = sleeps();
  const stream = bad.stream({ sleep: s.sleep });
  let ended;
  stream.on("end", (e) => (ended = e));
  const frames = [];
  const e = await (async () => {
    for await (const f of stream) frames.push(f);
  })().catch((x) => x);
  assert.ok(e instanceof EtaError);
  assert.deepEqual([e.code, e.err, e.status], [4001, "bad key", 0]);
  assert.equal(ended, e);
  await assert.rejects(stream.done, (x) => x === e);
  assert.deepEqual(types(frames), ["error"]);
  assert.equal(api.connections, 1);
  assert.deepEqual(s.waits, [], "never connects again");
  assert.ok(!e.message.includes(secret));
});

test("a revoked key on the resync stops the stream", async () => {
  api.afterSubscribe.set(1, async (ws) => ws.close(1012, "restart"));
  api.respond("GET", "/me", { status: 401, body: { err: "key revoked" } });
  const s = sleeps();
  const stream = eta.stream({ sleep: s.sleep });
  const e = await (async () => {
    for await (const _ of stream);
  })().catch((x) => x);
  assert.deepEqual([e.status, e.err], [401, "key revoked"]);
  assert.equal(api.connections, 2);
});

test("a failed resync drops and tries again", async () => {
  api.afterSubscribe.set(1, async (ws) => ws.close(1012, "restart"));
  const fail = { status: 500, body: { err: "oops" } };
  api.respond("GET", "/me", fail, fail, fail);
  const s = sleeps();
  const c = new EtaClient({ key: KEY, baseUrl: api.url, sleep: s.sleep });
  const stream = c.stream({ sleep: s.sleep });
  const frames = [];
  stream.on("frame", (f) => frames.push(f));
  await waitUntil(() => frames.some((f) => f.type === "resync"));
  assert.equal(frames.filter((f) => f.type === "closed")[1].err, "resync: oops");
  assert.equal(api.connections, 3);
  stream.close();
});

test("breaking out of for await closes the stream", async () => {
  const stream = eta.stream();
  let n = 0;
  for await (const frame of stream) {
    n++;
    if (frame.type === "me") break;
  }
  assert.equal(n, 3);
  await stream.done;
  await waitUntil(() => api.sockets.size === 0);
  assert.equal(api.connections, 1);
});

test("subscribe and unsubscribe are kept for the next connection", async () => {
  const s = sleeps();
  const stream = eta.stream({ sleep: s.sleep });
  const it = stream[Symbol.asyncIterator]();
  await take(it, 3); // ready, subscribed, me
  stream.subscribe(["marks"], ["HYPE"]);
  assert.deepEqual(types(await take(it, 2)), ["subscribed", "marks"]);
  stream.unsubscribe(["account"]);
  assert.deepEqual([stream.channels, stream.syms], [["marks"], ["HYPE"]]);
  await take(it, 1);
  for (const ws of api.sockets) ws.close(1012, "restart");
  const after = [];
  while (!after.some((f) => f.type === "subscribed")) after.push((await it.next()).value);
  assert.ok(!types(after).includes("resync"), "no account channel, no /me to catch up");
  assert.deepEqual(api.received("subscribe").at(-1)[1], { type: "subscribe", channels: ["marks"], syms: ["HYPE"] });
  stream.close();
});

test("with no global WebSocket it falls back to the ws package", async () => {
  const global = globalThis.WebSocket;
  globalThis.WebSocket = undefined;
  try {
    const stream = eta.stream();
    const frames = await take(stream[Symbol.asyncIterator](), 3);
    assert.deepEqual(types(frames), ["ready", "subscribed", "me"]);
    stream.close();
  } finally {
    globalThis.WebSocket = global;
  }
});

test("a WebSocket class can be passed in", async () => {
  let made = 0;
  class Counted extends WsWebSocket {
    constructor(url) {
      super(url);
      made++;
    }
  }
  const stream = eta.stream({ WebSocket: Counted });
  const frames = await take(stream[Symbol.asyncIterator](), 3);
  assert.deepEqual(types(frames), ["ready", "subscribed", "me"]);
  assert.equal(made, 1);
  stream.close();
});

// ---------- Bugbot on PR #1 ----------

/** A WebSocket that notes each frame the stream sends, and whether the stream was closed by then. */
function notingWebSocket(state) {
  return class extends globalThis.WebSocket {
    send(data) {
      state.sent.push({ type: JSON.parse(data).type, afterClose: state.closed });
      return super.send(data);
    }
  };
}

test("closing in a ready handler starts no ping timer and sends nothing more", async () => {
  const state = { sent: [], closed: false };
  const stream = eta.stream({ WebSocket: notingWebSocket(state), pingMs: 20 });
  stream.on("ready", () => {
    state.closed = true;
    stream.close();
  });
  await waitUntil(() => state.closed);
  await new Promise((ok) => setTimeout(ok, 150));
  assert.deepEqual(state.sent.filter((f) => f.afterClose).map((f) => f.type), [], "no subscribe and no ping after close()");
});

test("closing in a resync handler starts no ping timer and sends nothing more", async () => {
  api.afterSubscribe.set(1, async (ws) => ws.close(1012, "restart"));
  const state = { sent: [], closed: false };
  const s = sleeps();
  const stream = eta.stream({ WebSocket: notingWebSocket(state), pingMs: 20, sleep: s.sleep });
  stream.on("resync", () => {
    state.closed = true;
    stream.close();
  });
  await waitUntil(() => state.closed);
  await new Promise((ok) => setTimeout(ok, 150));
  assert.deepEqual(state.sent.filter((f) => f.afterClose).map((f) => f.type), [], "no subscribe and no ping after close()");
});

test("a handshake that never answers times out, then connects again", async () => {
  // a TCP server that takes the connection and never answers the WebSocket upgrade
  const held = new Set();
  let accepted = 0;
  const silent = net.createServer((sock) => {
    accepted++;
    held.add(sock);
  });
  await new Promise((ok) => silent.listen(0, "127.0.0.1", ok));
  try {
    const s = sleeps();
    const stream = eta.stream({ url: `ws://127.0.0.1:${silent.address().port}/stream`, openTimeoutMs: 100, sleep: s.sleep });
    const closed = [];
    stream.on("closed", (f) => closed.push(f));
    await waitUntil(() => closed.length >= 2, 3000);
    assert.deepEqual(closed[0], { type: "closed", code: null, err: "open timeout", wait: 1 });
    assert.ok(accepted >= 2, "it connected again");
    stream.close();
  } finally {
    for (const sock of held) sock.destroy();
    await new Promise((ok) => silent.close(ok));
  }
});

test("a stream that opens but never answers the key times out, then connects again", async () => {
  api.silent.add(1);
  const s = sleeps();
  const stream = eta.stream({ openTimeoutMs: 100, sleep: s.sleep });
  const frames = await take(stream[Symbol.asyncIterator](), 2);
  assert.deepEqual(frames, [{ type: "closed", code: null, err: "open timeout", wait: 1 }, { type: "ready", handle: "yourhandle" }]);
  assert.equal(api.connections, 2);
});

// ---------- Claude review of 605411c on PR #1 ----------

test("openTimeoutMs null or Infinity means no deadline", async () => {
  const quick = eta.stream({ openTimeoutMs: Infinity }); // Node runs a timer of Infinity ms after 1 ms
  assert.deepEqual(types(await take(quick[Symbol.asyncIterator](), 3)), ["ready", "subscribed", "me"]);
  quick.close();
  api.silent.add(2);
  const s = sleeps();
  const none = eta.stream({ openTimeoutMs: null, sleep: s.sleep });
  const closed = [];
  none.on("closed", (f) => closed.push(f));
  await waitUntil(() => api.received("auth").length === 2);
  await new Promise((ok) => setTimeout(ok, 200));
  assert.deepEqual(closed, [], "no deadline: a silent stream is not dropped");
  none.close();
});

test("an openTimeoutMs of 0, below 0, NaN or past setTimeout's limit is refused", () => {
  for (const bad of [0, -1, Number.NaN, 2 ** 31, "10"]) {
    assert.throws(() => eta.stream({ openTimeoutMs: bad }), RangeError, String(bad));
  }
});

test("a socket that opens after the deadline sends nothing and is closed", async () => {
  // a passed-in WebSocket that never opens by itself, whose close() throws, and which the test opens late
  const made = [];
  class Late {
    readyState = 0;
    sent = [];
    closes = 0;
    onopen = null;
    onmessage = null;
    onclose = null;
    onerror = null;
    constructor() {
      made.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.closes++;
      throw new Error("this socket can't close");
    }
  }
  const s = sleeps();
  const stream = eta.stream({ WebSocket: Late, openTimeoutMs: 50, sleep: s.sleep });
  const closed = [];
  stream.on("closed", (f) => {
    closed.push(f);
    stream.close();
  });
  await waitUntil(() => closed.length === 1);
  const late = made[0];
  late.readyState = 1;
  late.onopen?.({});
  assert.deepEqual(late.sent, [], "never the key on an abandoned socket");
  assert.ok(late.closes >= 2, "closed again when it opens late");
});

test("a timed-out drop reports the open timeout, not an error frame that came before it", async () => {
  api.silent.add(1);
  const s = sleeps();
  const stream = eta.stream({ openTimeoutMs: 100, sleep: s.sleep });
  const frames = [];
  stream.on("frame", (f) => frames.push(f));
  stream.start();
  await waitUntil(() => api.sockets.size === 1);
  for (const ws of api.sockets) ws.send(JSON.stringify({ type: "error", err: "json" }));
  await waitUntil(() => frames.some((f) => f.type === "closed"));
  assert.deepEqual(frames.find((f) => f.type === "closed"), { type: "closed", code: null, err: "open timeout", wait: 1 });
  stream.close();
});
