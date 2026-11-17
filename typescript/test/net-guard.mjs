// Loaded before every test file (npm test: node --import ./test/net-guard.mjs). No test reaches a real network unless ETA_API and
// ETA_KEY are both set (the integration tests): a fetch or a WebSocket to any host but this machine fails, and says so.
const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const hostOf = (input) => {
  try {
    return new URL(String(input instanceof Request ? input.url : input)).hostname;
  } catch {
    return "";
  }
};
const refused = (host) => `test: real network refused ${host}`;

if (!(process.env.ETA_API && process.env.ETA_KEY) && !globalThis.__etaNetGuard) {
  globalThis.__etaNetGuard = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const host = hostOf(input);
    return LOCAL.has(host) ? realFetch(input, init) : Promise.reject(new TypeError(refused(host)));
  };
  const RealWebSocket = globalThis.WebSocket;
  if (RealWebSocket) {
    globalThis.WebSocket = class extends RealWebSocket {
      constructor(url, ...rest) {
        const host = hostOf(url);
        if (!LOCAL.has(host)) throw new TypeError(refused(host));
        super(url, ...rest);
      }
    };
  }
}
