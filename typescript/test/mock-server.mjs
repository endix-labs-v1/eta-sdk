// A local stand-in for api.eta.cash: HTTP and the stream (/stream) on one port of 127.0.0.1. Its answers are the examples in the
// API's OpenAPI spec. HTTP and the stream write to one shared log, so a test can check the order of what the client did across them.
import { createHash, randomUUID } from "node:crypto";
import http from "node:http";
import { WebSocketServer } from "ws";

export const KEY = "eta_ea1d498e83b6_" + "TESTsecretTESTsecretTESTsecretTESTsecret123"; // made up: 43 characters, never a real key
export const REQUEST_ID = "5f0c2b7e-3a51-4c9e-9d0b-2f6c1e8a7b44";
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
export const FILE_ID = createHash("sha256").update(PNG).digest("hex");

export const FILL = { id: "eJ29t6KS43oq", u: "z2JISK7NrbcB", who: "yourhandle", sym: "HYPE", side: "buy", usd: 250, qty: 6.174679429445602, price: 40.34622409901657, at: 1794544957718 };
export const ME = {
  fees: { narrative: 0.0095, spot: 0.0035, rwa: 0.0025, perp: 0.00045, prediction: 0, builder: 0.0005 },
  referred: false,
  earnings: { creator: { accrued: 0, claimed: 0, swap: 0, yearly: 0, narratives: [] }, referral: { accrued: 0, claimed: 0, uses: 0, referees: [] } },
  reserved: 0,
  user: { handle: "yourhandle", name: "Your Name", bio: "", code: "YOURINVITE", cash: 9649.525, showHoldings: true, showPnl: true, codeUses: 0, followers: 0, following: 0 },
  bag: {},
  positions: [{ id: "UNNW5aZVXV63", u: "z2JISK7NrbcB", sym: "HYPE", kind: "spot", side: "buy", qty: 6.174679429445602, entry: 40.34622409901657, usd: 250, at: 1794544957718 }],
  orders: [],
  fills: [],
  notes: [],
  votes: [],
};
export const QUOTE = { sym: "HYPE", side: "buy", mark: 40.295854, quoteId: "GdCdBVBb", expires: 1794544972298, price: 40.346224, impactPct: 0.125, fee: 0.0035, feeUsd: 0.875, get: 6.174679429, qty: 6.1746794, usd: 250, source: "estimate", afford: true };

export class MockApi {
  log = [];
  seen = [];
  script = [];
  rate = [30, 27, 8];
  orders = new Map();
  trades = 0;
  // the stream half
  connections = 0;
  frames = [];
  /** connection number -> [close code, error frame], sent at its auth frame */
  refuse = new Map();
  /** connection number -> async (ws) => ..., run after its first subscribe */
  afterSubscribe = new Map();
  /** connection numbers that open but never answer the auth frame */
  silent = new Set();
  sockets = new Set();

  async start() {
    this.server = http.createServer((req, res) => void this.#http(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on("upgrade", (req, sock, head) => {
      if (new URL(req.url, "http://x").pathname !== "/stream") return sock.destroy();
      this.wss.handleUpgrade(req, sock, head, (ws) => this.#stream(ws));
    });
    await new Promise((ok) => this.server.listen(0, "127.0.0.1", ok));
    return this;
  }

  get url() {
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  /** The next requests to `method path` get these answers, in order; then the defaults. */
  respond(method, path, ...answers) {
    for (const a of answers) this.script.push([method, path, a]);
  }

  requestsTo(method, path) {
    return this.seen.filter((s) => s.method === method && s.path === path);
  }

  received(type) {
    return this.frames.filter(([, f]) => f.type === type);
  }

  async stop() {
    for (const ws of this.sockets) ws.terminate();
    this.wss.close();
    this.server.closeAllConnections();
    await new Promise((ok) => this.server.close(ok));
  }

  // ---------- HTTP ----------

  async #http(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const u = new URL(req.url, "http://x");
    const seen = { method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), headers: req.headers, body: Buffer.concat(chunks) };
    seen.json = seen.body.length && /json/.test(req.headers["content-type"] ?? "") ? JSON.parse(seen.body) : undefined;
    this.seen.push(seen);
    this.log.push(`http ${req.method} ${u.pathname}`);
    let a;
    const i = this.script.findIndex(([m, p]) => m === seen.method && p === seen.path);
    if (i >= 0) {
      a = this.script.splice(i, 1)[0][2];
      if (a.drop && a.run) this.#default(seen);
      else if (!a.drop && a.body === undefined) a = { ...this.#default(seen), delay: a.delay }; // a slow answer: eta does it, then answers late
    } else a = this.#default(seen);
    if (a.delay) await new Promise((ok) => setTimeout(ok, a.delay));
    if (a.drop) return req.socket.destroy();
    const raw = Buffer.isBuffer(a.body) || typeof a.body === "string";
    const payload = raw ? Buffer.from(a.body) : Buffer.from(JSON.stringify(a.body));
    const headers = {
      "content-type": raw ? (a.headers?.["content-type"] ?? "text/plain") : "application/json",
      "content-length": payload.length,
      "x-request-id": a.headers?.["x-request-id"] ?? REQUEST_ID,
      ...a.headers,
    };
    if (this.rate && (seen.headers.authorization ?? "").startsWith("Bearer eta_") && (a.status ?? 200) !== 401) {
      Object.assign(headers, { "x-ratelimit-limit": this.rate[0], "x-ratelimit-remaining": this.rate[1], "x-ratelimit-reset": this.rate[2] });
    }
    res.writeHead(a.status ?? 200, headers);
    res.end(payload);
  }

  #default(s) {
    const auth = s.headers.authorization;
    if (auth !== undefined && auth !== `Bearer ${KEY}`) return { status: 401, body: { err: "bad key" } };
    const { method: m, path: p } = s;
    if (m === "GET") {
      if (p === "/me") return { body: ME };
      if (p === "/bootstrap") return { body: { me: ME, users: [], posts: [], replies: {}, counts: {}, tape: [FILL], activity: {}, proposals: [], narratives: [], marks: { HYPE: 40.29 }, holders: {}, news: [], markets: [], limits: { postText: 2000 } } };
      if (p === "/markets") return { body: [{ sym: "HYPE", kind: "spot", price: 40.29 }] };
      if (p.startsWith("/trades/")) return { body: [FILL] };
      if (p.startsWith("/flows/")) return { body: [{ group: "creator", bought: 250, sold: 124, people: 1 }] };
      if (p.startsWith("/fills/")) return { body: [{ id: FILL.id, sym: FILL.sym, side: FILL.side, usd: FILL.usd, qty: FILL.qty, price: FILL.price, at: FILL.at }] };
      if (p.startsWith("/stats/")) return { body: { handle: "yourhandle", days: 30, hidden: true } };
      if (p === "/board") return { body: { rows: [], me: null, total: 0 } };
      if (p.endsWith("/history")) return { body: [{ t: 1794544968411, p: 0.9986 }] };
      if (p.endsWith("/versions")) return { body: [{ at: 1794544963073, thesis: "My weekly picks." }] };
      if (p.startsWith("/follows/")) return { body: { followers: ["sage"], following: [] } };
      if (p.startsWith("/files/")) {
        if (p === `/files/${FILE_ID}`) return { body: PNG, headers: { "content-type": "image/png" } };
        return { status: 404, body: "404 Not Found", headers: { "content-type": "text/plain" } };
      }
    }
    if (m === "POST") {
      if (p === "/act") return { body: this.#act(s.json ?? {}) };
      if (p === "/quote") return { body: QUOTE };
      if (p === "/files") return { body: { url: `/files/${createHash("sha256").update(s.body).digest("hex")}` } };
      if (p.startsWith("/sim/")) return { body: { days: 3, seed: 1, sym: p.split("/").pop(), yearlyRate: 0.005, start: { price: 1 }, params: {}, events: [], end: { price: 1 } } };
    }
    return { status: 404, body: { err: "not found" } };
  }

  #act(a) {
    if (a.type === "order" || a.type === "close") {
      if (this.orders.has(a.clientId)) return { ...this.orders.get(a.clientId), repeat: true };
      this.trades++;
      const answer =
        a.type === "order" && a.limit !== undefined
          ? { ok: true, id: `order-${this.trades}`, open: true, clientId: a.clientId }
          : { ok: true, fill: { ...FILL, id: `fill-${this.trades}`, clientId: a.clientId }, ...(a.type === "close" ? { got: 123.75 } : {}) };
      this.orders.set(a.clientId, answer);
      return answer;
    }
    if (a.type === "post") return { ok: true, id: a.id ?? "c2_g_um58aNl" };
    if (a.type === "launch") return { ok: true, sym: a.sym };
    if (a.type === "propose") return { ok: true, id: "ioF8wlOIFgaE", ends: 1794573763887, bar: "low" };
    if (a.type === "cancelAll") return { ok: true, cancelled: 2 };
    return { ok: true };
  }

  // ---------- the stream ----------

  #stream(ws) {
    const n = ++this.connections;
    this.sockets.add(ws);
    ws.on("close", () => this.sockets.delete(ws));
    let subscribed = false;
    const send = (f) => ws.send(JSON.stringify(f));
    ws.on("message", async (raw) => {
      const frame = JSON.parse(String(raw));
      this.frames.push([n, frame]);
      this.log.push(`ws${n} ${frame.type}`);
      if (frame.type === "auth") {
        if (this.silent.has(n)) return;
        if (this.refuse.has(n)) {
          const [code, err] = this.refuse.get(n);
          send({ type: "error", ...err });
          return ws.close(code, err.err);
        }
        if (frame.key !== KEY) {
          send({ type: "error", err: "bad key" });
          return ws.close(4001, "bad key");
        }
        send({ type: "ready", handle: "yourhandle" });
      } else if (frame.type === "subscribe") {
        send({ type: "subscribed", channels: frame.channels, ...(frame.syms ? { syms: frame.syms } : {}) });
        if (frame.channels.includes("account")) send({ type: "me", me: ME });
        if (frame.channels.includes("marks")) send({ type: "marks", marks: { HYPE: 37.7974 } });
        if (!subscribed && this.afterSubscribe.has(n)) {
          subscribed = true;
          await this.afterSubscribe.get(n)(ws);
        }
      } else if (frame.type === "unsubscribe") send({ type: "subscribed", channels: [] });
      else if (frame.type === "ping") send({ type: "pong" });
    });
  }
}

export function sleeps() {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  return { waits, sleep };
}

export async function waitUntil(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((ok) => setTimeout(ok, 10));
  }
}

export { randomUUID };
