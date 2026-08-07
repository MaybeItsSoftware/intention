// Structured logging, no dependencies: one JSON object per line, so the
// host's log search can filter on fields.
//
// Redaction is by omission, not scrubbing: call sites only ever pass safe
// fields. Never log bearer tokens, receipts, purchase tokens, message
// content, system prompts, or query strings (the webhook secret rides in
// one). Subjects are already non-reversible hashes (tokens.js subjectFor),
// so they are safe to log and are what ties an audit trail together.

// Production-operation logs only: dev and test runs (NODE_ENV=development)
// stay readable. Decided once at import, like config.js.
const enabled = process.env.NODE_ENV !== 'development';

export function logEvent(event, fields = {}) {
  if (!enabled) return;
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

let seq = 0;

export function newRequestId() {
  return `${Date.now().toString(36)}-${(++seq).toString(36)}`;
}
