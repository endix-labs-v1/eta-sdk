/**
 * The eta API for TypeScript and JavaScript: read, post, run your narratives and trade by code.
 *
 * ```ts
 * import { EtaClient } from "eta-api";
 *
 * const eta = new EtaClient({ key: process.env.ETA_KEY! });
 * console.log((await eta.me()).user.cash);
 * ```
 *
 * Docs: https://eta-cash.gitbook.io/api/
 */
export { DEFAULT_BASE_URL, EtaClient, newClientId } from "./client.js";
export { EtaError } from "./errors.js";
export { CLOSE_KEY, CLOSE_LIMIT, EtaStream } from "./stream.js";
export { VERSION } from "./version.js";
