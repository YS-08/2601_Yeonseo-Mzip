#!/usr/bin/env node
/* ZIP 로컬 서버 — 의존성 없음 (Node 18 이상)
 *  - 화면(index.html 등)을 http://localhost:PORT 로 제공
 *  - /api/chat 으로 들어온 요청을 OpenAI에 대신 전달 (API 키는 서버의 .env 에만 보관)
 * 실행:  node server.js
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// .env 읽기 (KEY=VALUE)
(function loadEnv() {
  try {
    fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/).forEach(function (line) {
      if (/^\s*#/.test(line)) return;
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m) return;
      let v = m[2];
      if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
      if (!(m[1] in process.env)) process.env[m[1]] = v;
    });
  } catch (e) { /* .env 없음 */ }
})();

const PORT = Number(process.env.PORT) || 3000;
const BASE = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const ROOT = __dirname;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml', '.md': 'text/markdown; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8'
};
const BLOCKED = ['server.js', 'package.json'];

function cors(req) {
  const o = req.headers.origin;
  if (!o) return {};
  const ok = o === 'null' || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o); // file:// 과 로컬 주소만 허용
  return ok ? { 'Access-Control-Allow-Origin': o, 'Vary': 'Origin', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' } : null;
}
function sendJson(req, res, status, obj) {
  const headers = Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(req) || {});
  res.writeHead(status, headers);
  res.end(typeof obj === 'string' ? obj : JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) { size += c.length; if (size > limit) { reject(new Error('요청이 너무 커요')); req.destroy(); } else chunks.push(c); });
    req.on('end', function () { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

async function upstream(messages, jsonMode) {
  const body = { model: MODEL, messages: messages };
  if (jsonMode) body.response_format = { type: 'json_object' };
  return fetch(BASE + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000)
  });
}

async function handleApi(req, res, url) {
  const allow = cors(req);
  if (allow === null) return sendJson(req, res, 403, { error: { message: '허용되지 않은 출처의 요청이에요' } });
  if (req.method === 'OPTIONS') { res.writeHead(204, allow); return res.end(); }

  if (url.pathname === '/api/status' && req.method === 'GET') {
    return sendJson(req, res, 200, { ok: true, configured: !!process.env.OPENAI_API_KEY, model: MODEL });
  }

  if (url.pathname === '/api/chat' && req.method === 'POST') {
    if (!process.env.OPENAI_API_KEY) return sendJson(req, res, 500, { error: { message: '서버에 OPENAI_API_KEY가 없어요. .env 파일을 확인해 주세요' } });
    let payload;
    try { payload = JSON.parse(await readBody(req, 300 * 1024)); } catch (e) { return sendJson(req, res, 400, { error: { message: '요청 형식이 올바르지 않아요' } }); }
    const msgs = payload && payload.messages;
    const valid = Array.isArray(msgs) && msgs.length > 0 && msgs.length <= 6 && msgs.every(function (m) {
      return m && (m.role === 'system' || m.role === 'user') && typeof m.content === 'string' && m.content.length <= 60000;
    });
    if (!valid) return sendJson(req, res, 400, { error: { message: 'messages 형식이 올바르지 않아요' } });
    try {
      let r = await upstream(msgs, true);
      if (r.status === 400) {
        const t = await r.clone().text();
        if (/response_format|json_object|json mode/i.test(t)) r = await upstream(msgs, false);
      }
      const text = await r.text();
      return sendJson(req, res, r.status, text);
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      return sendJson(req, res, 502, { error: { message: timeout ? 'OpenAI 응답이 너무 늦어요' : 'OpenAI에 연결하지 못했어요: ' + (e && e.message) } });
    }
  }
  return sendJson(req, res, 404, { error: { message: '없는 주소예요' } });
}

function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(ROOT, rel));
  const base = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const hidden = file.slice(ROOT.length).split(path.sep).some(function (p) { return p.charAt(0) === '.'; });
  if (file.indexOf(ROOT) !== 0 || hidden || BLOCKED.indexOf(base) !== -1 || !MIME[ext]) { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(file, function (err, data) {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[ext], 'Cache-Control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

const server = http.createServer(function (req, res) {
  const url = new URL(req.url, 'http://localhost');
  const run = url.pathname.indexOf('/api/') === 0 ? handleApi(req, res, url) : Promise.resolve(serveStatic(req, res, url));
  run.catch(function (e) { if (!res.headersSent) sendJson(req, res, 500, { error: { message: String((e && e.message) || e) } }); else res.end(); });
});
server.on('error', function (e) {
  console.error(e.code === 'EADDRINUSE' ? '포트 ' + PORT + '번이 이미 사용 중이에요. PORT=3001 node server.js 처럼 다른 포트로 실행해 보세요.' : e.message);
  process.exit(1);
});
server.listen(PORT, function () {
  console.log('\nZIP 서버가 켜졌어요 → http://localhost:' + PORT);
  console.log('모델: ' + MODEL + ' / API 키: ' + (process.env.OPENAI_API_KEY ? '설정됨' : '없음 (.env 에 OPENAI_API_KEY 를 넣어 주세요)') + '\n');
});
