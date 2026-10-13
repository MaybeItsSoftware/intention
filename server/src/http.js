// fetch() with a hard deadline, for every outbound call this server makes.
//
// Node's fetch has no default timeout, so a peer that accepts the connection
// and then never answers holds the request — and whatever it holds — for as
// long as the socket survives. On /v1/chat that was a credit reservation; on
// /v1/entitlement/verify and the store webhooks it is a request that never
// answers the client and never lets Apple or Google retry. Each caller says
// what a timeout means in its own error vocabulary via `onTimeout`, so an
// abort reads as "upstream unavailable" (503, keep the receipt and retry)
// rather than as a 500 or, worse, as "that purchase doesn't exist".

export const DEFAULT_TIMEOUT_MS = 15_000;

export async function fetchWithTimeout(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e && e.name === 'AbortError' && onTimeout) throw onTimeout();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
