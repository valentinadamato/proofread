'use strict';
// The whole backend: a local HTTP service that turns "fix this sentence" into an
// `opencode run` on a free opencode-zen model. No dependencies, one file.
//
//   GET  /api/health   is it up, is it sandboxed, which actions exist
//   GET  /api/models   the free models opencode offers (cached)
//   POST /api/edit     { text, action, model } -> { result, ms }

const http = require('node:http');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PORT = Number(process.env.PROOFREAD_PORT || 8799);
const HOST = process.env.PROOFREAD_HOST || '127.0.0.1';
const MAX_TEXT = 8000;
const MAX_CONCURRENT = Number(process.env.PROOFREAD_CONCURRENCY || 2);
const DEFAULT_MODEL = process.env.PROOFREAD_MODEL || 'big-pickle';

const HOME = os.homedir();
const WORKSPACE = path.join(__dirname, 'workspace');

// --------------------------------------------------------------- the prompts

// One entry per menu item in the extension. The labels live in the extension
// (extension/shared.js); only the instruction matters here.
const ACTIONS = {
  grammar:
    'Correct grammar, spelling and punctuation. Change only what is actually wrong - ' +
    'keep the original wording, tone and length wherever it is already correct.',
  rephrase:
    'Rewrite this so it reads more clearly and naturally. Keep the same meaning, ' +
    'roughly the same length, and the same register.',
  shorten: 'Make this shorter and tighter. Drop filler, keep every piece of information.',
  formal: 'Rewrite this in a more formal, professional register. Keep the meaning.',
  casual: 'Rewrite this in a warmer, more casual register. Keep the meaning.',
};

// The text comes from whatever web page the user is typing in, so it is framed as
// data between markers and the agent prompt is told never to obey it.
function buildPrompt(action, text) {
  if (!ACTIONS[action]) throw new Error(`unknown action: ${action}`);
  return `INSTRUCTION: ${ACTIONS[action]}\n<<<BEGIN>>>\n${text}\n<<<END>>>`;
}

// -------------------------------------------------------------- the opencode CLI
//
// Two hard-won constraints live in here, do not "clean them up":
//
// 1. opencode zen's FREE models refuse any request that does not look like a stock
//    opencode agent ("OpenCode's free tier can only be used from within OpenCode").
//    Disabling tools in the agent frontmatter, or denying them via `permission:`,
//    trips that check. So the proofread agent keeps the default tool set and is
//    steered by its prompt only - and the process is jailed with bubblewrap instead.
// 2. The free tier is also refused over `opencode serve`'s HTTP API, so every request
//    spawns `opencode run`. `--pure` is required: an external plugin makes runs hang.

function findExecutable(candidates) {
  for (const c of candidates.filter(Boolean)) {
    try { fs.accessSync(c, fs.constants.X_OK); return c; } catch {}
  }
  return null;
}

const BIN = findExecutable([
  process.env.OPENCODE_BIN,
  path.join(HOME, '.local/share/mise/installs/opencode/latest/opencode'),
  path.join(HOME, '.opencode/bin/opencode'),
  '/usr/local/bin/opencode',
  '/usr/bin/opencode',
]);
if (!BIN) throw new Error('opencode binary not found (set OPENCODE_BIN)');

const sandboxed = () =>
  process.env.PROOFREAD_SANDBOX !== 'off' && !!findExecutable(['/usr/bin/bwrap', '/bin/bwrap']);

// The agent runs with bash/write/edit enabled (see note 1), and the text it rewrites
// comes from arbitrary web pages. Bubblewrap makes the whole filesystem read-only
// except the scratch workspace and opencode's own state, so a prompt injection that
// reaches a tool cannot modify anything that matters.
function command(args) {
  if (!sandboxed()) return { cmd: BIN, args };
  return {
    cmd: findExecutable(['/usr/bin/bwrap', '/bin/bwrap']),
    args: [
      '--ro-bind', '/', '/',
      '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp',
      '--bind', WORKSPACE, WORKSPACE,
      '--bind', path.join(HOME, '.local/share/opencode'), path.join(HOME, '.local/share/opencode'),
      '--bind', path.join(HOME, '.cache/opencode'), path.join(HOME, '.cache/opencode'),
      '--unshare-pid', '--die-with-parent', '--new-session',
      '--', BIN, ...args,
    ],
  };
}

const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

// `opencode run` prints "\e[0m\n> <agent> · <model>\n\e[0m\n" before the answer.
function stripBanner(raw) {
  const lines = raw.replace(ANSI, '').split('\n');
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^>\s\S+\s·\s\S+/.test(lines[i])) start = i + 1;
  }
  return lines.slice(start).join('\n').trim();
}

function runOpencode(args, { timeout = 90_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const { cmd, args: full } = command(args);
    const child = spawn(cmd, full, {
      cwd: WORKSPACE,
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '', done = false;
    const finish = (fn, arg) => { if (!done) { done = true; clearTimeout(timer); child.kill('SIGKILL'); fn(arg); } };
    const timer = setTimeout(() => finish(reject, new Error(`opencode timed out after ${timeout}ms`)), timeout);
    if (signal) signal.addEventListener('abort', () => finish(reject, new Error('aborted')), { once: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (done) return;
      if (code !== 0) finish(reject, new Error(stripBanner(err || out) || `opencode exited ${code}`));
      else finish(resolve, out);
    });
  });
}

// Every model opencode offers on the `opencode` provider for this account is free
// tier; we still label them so the picker can say so.
let modelCache = null;
async function models({ refresh = false } = {}) {
  if (modelCache && !refresh) return modelCache;
  const raw = await runOpencode(['models', 'opencode'], { timeout: 30_000 });
  modelCache = raw.replace(ANSI, '').split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('opencode/'))
    .map((l) => l.slice('opencode/'.length))
    .map((id) => ({
      id,
      label: id.replace(/-free$|-contributor$/, '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      free: true,
    }));
  return modelCache;
}

// ------------------------------------------------------------------ the server

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readJson(req, limit = MAX_TEXT * 4) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

let inFlight = 0;

async function handleEdit(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return send(res, 400, { error: e.message }); }

  const text = typeof body.text === 'string' ? body.text : '';
  const action = body.action || 'grammar';
  const model = body.model || DEFAULT_MODEL;

  if (!text.trim()) return send(res, 400, { error: 'no text' });
  if (text.length > MAX_TEXT) return send(res, 413, { error: `text longer than ${MAX_TEXT} characters` });
  if (!ACTIONS[action]) return send(res, 400, { error: `unknown action: ${action}` });
  if (!/^[\w.\-]+$/.test(model)) return send(res, 400, { error: 'invalid model id' });
  if (inFlight >= MAX_CONCURRENT) return send(res, 429, { error: 'busy, try again in a moment' });

  const controller = new AbortController();
  req.on('aborted', () => controller.abort());

  inFlight++;
  const started = Date.now();
  try {
    const raw = await runOpencode(
      ['run', '--pure', '--log-level', 'ERROR', '--agent', 'proofread', '-m', `opencode/${model}`, buildPrompt(action, text)],
      { signal: controller.signal },
    );
    const result = stripBanner(raw);
    if (!result) return send(res, 502, { error: 'the model returned nothing' });
    send(res, 200, { result, action, model, original: text, ms: Date.now() - started });
  } catch (e) {
    if (controller.signal.aborted) { res.destroy(); return; }
    send(res, 502, { error: String(e.message || e) });
  } finally {
    inFlight--;
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, {
      ok: true,
      binary: BIN,
      sandboxed: sandboxed(),
      defaultModel: DEFAULT_MODEL,
      actions: Object.keys(ACTIONS),
      inFlight,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/models') {
    return models({ refresh: url.searchParams.has('refresh') })
      .then((list) => send(res, 200, { models: list, default: DEFAULT_MODEL }))
      .catch((e) => send(res, 502, { error: String(e.message || e) }));
  }

  if (req.method === 'POST' && url.pathname === '/api/edit') return handleEdit(req, res);

  send(res, 404, { error: 'not found' });
});

if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`proofread backend on http://${HOST}:${PORT} (sandbox: ${sandboxed() ? 'bwrap' : 'OFF'})`);
  });
}

module.exports = { server, PORT, HOST, ACTIONS, buildPrompt, stripBanner, models };
