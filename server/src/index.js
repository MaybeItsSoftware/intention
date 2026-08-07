import http from 'node:http';
import { config, assertBootConfig } from './config.js';
import { handleRequest } from './app.js';
import { logEvent, newRequestId } from './log.js';

// node:http wrapper around handleRequest. No framework: the whole surface is
// five POST routes and a health check.

const MAX_BODY_BYTES = 256 * 1024;

// The extension pages and the app WebViews are all opaque origins, so they send
// `Origin: null` or a chrome-extension:// origin. Reflecting nothing and
// allowing '*' is fine here because every authenticated route requires a bearer
// token, which browsers never attach automatically.
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, GET, OPTIONS',
  'access-control-max-age': '86400'
};

class PayloadTooLargeError extends Error {}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overLimit = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        // Drain rather than destroy: killing the socket before the response
        // is written shows the client ECONNRESET instead of the 413 JSON.
        // Truly runaway uploads still get cut off.
        overLimit = true;
        chunks.length = 0;
        if (size > MAX_BODY_BYTES * 8) req.destroy();
        return;
      }
      if (!overLimit) chunks.push(chunk);
    });
    req.on('end', () => {
      if (overLimit) reject(new PayloadTooLargeError('payload too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// The client IP for rate limiting. Counted from the END of X-Forwarded-For:
// Railway (and any sane proxy) appends the peer address it actually observed,
// so the trailing entries are trustworthy and the leading ones are whatever
// the client chose to send. trustProxyHops says how many trailing entries our
// own infrastructure adds.
function clientIp(req) {
  const raw = req.headers['x-forwarded-for'];
  if (raw) {
    const list = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    const hops = Math.max(1, config.trustProxyHops);
    if (list.length >= hops) return list[list.length - hops];
  }
  return req.socket?.remoteAddress || '';
}

// Log a few raw forwarding headers after boot so the trustProxyHops
// assumption can be checked against real traffic, then go quiet.
let xffSamplesLeft = 5;

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = clientIp(req);
  const requestId = newRequestId();
  const startedAt = Date.now();
  if (xffSamplesLeft > 0 && req.headers['x-forwarded-for']) {
    xffSamplesLeft -= 1;
    console.log(`[intention] X-Forwarded-For sample: ${JSON.stringify(req.headers['x-forwarded-for'])} -> client ip ${ip}`);
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  const reply = (status, payload) => {
    res.writeHead(status, {
      'content-type': 'application/json',
      'x-request-id': requestId,
      ...CORS_HEADERS
    });
    res.end(JSON.stringify(payload));
    // Access log: pathname only — the query string can carry the webhook
    // secret, and headers/bodies carry tokens, receipts and message content.
    logEvent('request', {
      requestId,
      method: req.method,
      path: url.pathname,
      status,
      ms: Date.now() - startedAt,
      ip
    });
  };

  let body = null;
  if (req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      reply(413, { error: 'Payload too large', code: 'bad_request' });
      return;
    }
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      reply(400, { error: 'Invalid JSON', code: 'bad_request' });
      return;
    }
  }

  const result = await handleRequest({
    method: req.method,
    path: url.pathname,
    // url.pathname discards the query string, so the ?token= form that
    // DEPLOYMENT.md documents for the Google refund webhook — and the only
    // form Pub/Sub push can actually use, since it cannot set headers — never
    // reached the handler at all.
    query: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body,
    ip
  });

  reply(result.status, result.body);
});

// Only listen when run directly, so tests can import this module freely.
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  // Fail fast rather than listen broken: with Railway's ON_FAILURE restart
  // policy, exiting keeps the previous deployment serving instead of
  // promoting one whose every /v1/chat would 401.
  if (!assertBootConfig()) {
    process.exit(1);
  }

  // A malformed request line must not crash the process, and a genuinely
  // unknown state must restart it (the store fsyncs every mutation, so an
  // abrupt exit loses no committed credit).
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  server.on('error', (err) => {
    logEvent('server_error', { error: String(err?.message || err) });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logEvent('unhandled_rejection', { error: String(reason?.stack || reason) });
  });
  process.on('uncaughtException', (err) => {
    logEvent('uncaught_exception', { error: String(err?.stack || err) });
    process.exit(1);
  });
  process.on('SIGTERM', () => {
    logEvent('shutdown', { signal: 'SIGTERM' });
    // Stop accepting, let in-flight requests finish; every store mutation is
    // already fsynced, so nothing needs flushing on the way out.
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10_000).unref();
  });

  const host = process.env.HOST || '0.0.0.0';
  server.listen(config.port, host, () => {
    console.log(`[intention] backend listening on ${host}:${config.port}`);
  });
}
