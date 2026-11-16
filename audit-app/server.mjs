#!/usr/bin/env node
// Local web server for the BW migration audit. Binds to 127.0.0.1 only: it has no
// authentication and talks to the BW system with the credentials of credentials.ini.
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAudit, readLatest, applyTarget } from './lib/collect.mjs';
import { targetList, getTarget } from './lib/targets.mjs';
import { chatTurn, chatBackend, resetSession } from './lib/chat.mjs';
import { closeClient } from './lib/mcp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5180);
const HOST = '127.0.0.1';

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/teamwork-logo.png': ['public/teamwork-logo.png', 'image/png'],
  '/teamwork-initials-white.png': ['public/teamwork-initials-white.png', 'image/png'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  '/vendor/marked.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.js': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8'],
};

let audit = await readLatest();
// Re-scored views of the snapshot, one per target, rebuilt after each audit run.
let views = new Map();
const auditFor = (target) => {
  if (!audit) return null;
  const key = getTarget(target).key;
  if (!views.has(key)) views.set(key, applyTarget(audit, key));
  return views.get(key);
};
let auditRun = null; // { listeners:Set, last }

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  return (event) => res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error('request too large');
  }
  return body ? JSON.parse(body) : {};
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function startAudit(target) {
  if (auditRun) return auditRun;
  const run = { listeners: new Set(), last: { step: 'start', detail: 'Starting', pct: 0 } };
  const broadcast = (e) => { run.last = e; for (const l of run.listeners) l(e); };
  auditRun = run;
  runAudit({ onProgress: broadcast, target })
    .then((a) => { audit = a; views = new Map(); broadcast({ step: 'done', detail: 'Audit complete', pct: 100, generatedAt: a.generatedAt }); })
    .catch((err) => broadcast({ step: 'error', detail: String(err.message || err), pct: 100 }))
    .finally(() => { for (const l of run.listeners) l(null); auditRun = null; });
  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Refuse cross-site requests: only same-origin pages may call the API.
  const origin = req.headers.origin;
  if (origin && origin !== `http://${HOST}:${PORT}` && origin !== `http://localhost:${PORT}`) {
    return json(res, 403, { error: 'cross-origin request refused' });
  }
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
      return res.end(await fs.readFile(path.join(here, file)));
    }
    if (req.method === 'GET' && url.pathname === '/api/audit') {
      const { backend, detail } = chatBackend();
      return json(res, 200, { audit: auditFor(url.searchParams.get('target')), targets: targetList(), running: Boolean(auditRun), chat: Boolean(backend), chatBackend: backend, chatDetail: detail });
    }
    if (req.method === 'POST' && url.pathname === '/api/audit/run') {
      const { target } = await readJson(req);
      const run = startAudit(target);
      const send = sse(res);
      send(run.last);
      const listener = (e) => (e ? send(e) : res.end());
      run.listeners.add(listener);
      req.on('close', () => run.listeners.delete(listener));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/chat') {
      const { sessionId, message, target } = await readJson(req);
      if (!message || typeof message !== 'string') return json(res, 400, { error: 'message required' });
      const send = sse(res);
      const abort = new AbortController();
      res.on('close', () => abort.abort());
      try {
        await chatTurn({ sessionId, text: message.slice(0, 20_000), audit: auditFor(target), emit: send, signal: abort.signal });
      } catch (err) {
        send({ type: 'error', message: String(err.message || err) });
      }
      return res.end();
    }
    if (req.method === 'POST' && url.pathname === '/api/chat/reset') {
      const { sessionId } = await readJson(req);
      if (sessionId) resetSession(sessionId);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`BW migration audit: http://localhost:${PORT}`);
  if (!audit) console.log('No audit snapshot yet: open the page and click "Run audit", or run npm run audit.');
  const { backend, detail } = chatBackend();
  console.log(backend ? `Chat: ${detail}` : `Chat disabled: ${detail}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => { server.close(); await closeClient(); process.exit(0); });
}
