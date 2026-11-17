// Type-level checks of the built .d.ts files (npm run typecheck): each line compiles as a user would write it, and the lines
// marked to expect an error must stay errors. Never run.
import { EtaClient, EtaError, newClientId, type Frame, type Me, type OrderAnswer, type Quote } from "../dist/index.js";

async function usage(): Promise<void> {
  const eta = new EtaClient({ key: "eta_...", baseUrl: "https://api.eta.cash", timeoutMs: 10_000 });

  const me: Me = await eta.me();
  const cash: number = me.user.cash;
  const positionId: string = me.positions[0].id;

  const quote: Quote = await eta.quote({ sym: "HYPE", side: "buy", usd: 250 });
  const order: OrderAnswer = await eta.order({ sym: "HYPE", side: "buy", usd: 250, quoteId: quote.quoteId, maxSlippagePct: 1 });
  if ("fill" in order) {
    const clientId: string | undefined = order.fill.clientId;
  } else {
    const resting: true = order.open;
  }
  await eta.order({ sym: "BTC-PERP", side: "long", usd: 100, lev: 5, clientId: newClientId() });
  await eta.quote({ closeId: positionId, frac: 0.5 });
  await eta.close({ id: positionId, frac: 0.5 });
  await eta.cancel("P5weq-afPxzk");
  await eta.cancel({ clientId: "hype-dip-0002" });
  const cancelled: number = (await eta.cancelAll({ sym: "HYPE" })).cancelled;

  await eta.post({ text: "Long $HYPE.", home: "HYPE", id: "pick-0001" });
  await eta.reply({ key: "r:post:c2_g_um58aNl", text: "Adding on the dip." });
  await eta.launch({ sym: "PICKS", comps: [["HYPE", 60], ["PURR", 40]], cap: 70 });
  await eta.edit({ sym: "PICKS", voteMinutes: null, thesis: "" });
  await eta.propose({ sym: "PICKS", changes: [["HYPE", 60, 63], ["PURR", 40, 37]] });
  await eta.sim("PICKS", { days: 3, seed: 1 });
  const picture: Uint8Array = await eta.file("/files/abc");
  const url: string = (await eta.upload(picture)).url;

  const limit: number | undefined = eta.rateLimit?.remaining;

  try {
    await eta.me();
  } catch (e) {
    if (e instanceof EtaError) {
      const words: string = e.err;
      const status: number = e.status;
      const id: string | null = e.requestId;
    }
  }

  const stream = eta.stream({ channels: ["account", "marks"], syms: ["HYPE"] });
  stream.on("fill", (frame) => {
    const sym: string = frame.fill.sym;
  });
  stream.on("end", (error) => {
    const code: number | null | undefined = error?.code;
  });
  for await (const frame of stream) {
    const f: Frame = frame;
    if (frame.type === "marks") {
      const hype: number | undefined = frame.marks.HYPE;
    }
    if (frame.type === "closed") {
      const wait: number = frame.wait;
    }
  }

  // @ts-expect-error a side eta doesn't have
  await eta.order({ sym: "HYPE", side: "up", usd: 1 });
  // @ts-expect-error an order needs usd
  await eta.order({ sym: "HYPE", side: "buy" });
  // @ts-expect-error a channel eta doesn't have
  eta.stream({ channels: ["trades"] });
  // @ts-expect-error the key is never a public field
  eta.key;
}

void usage;
