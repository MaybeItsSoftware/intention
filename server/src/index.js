import http from 'node:http';
import { config, assertBootConfig } from './config.js';
import { handleRequest } from './app.js';

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

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  let body = null;
  if (req.method === 'POST') {
    let raw;
    try {
      raw = await readBody(req);
    } catch (e) {
      res.writeHead(413, { 'content-type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: 'Payload too large', code: 'bad_request' }));
      return;
    }
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json', ...CORS_HEADERS });
      res.end(JSON.stringify({ error: 'Invalid JSON', code: 'bad_request' }));
      return;
    }
  }

  const result = await handleRequest({
    method: req.method,
    path: url.pathname,
    headers: req.headers,
    body
  });

  res.writeHead(result.status, { 'content-type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(result.body));
});

// Only listen when run directly, so tests can import this module freely.
if (process.argv[1] && process.argv[1].endsWith('index.js')) {
  assertBootConfig();
  server.listen(config.port, () => {
    console.log(`[intention] backend listening on :${config.port}`);
  });
}
