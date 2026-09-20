'use strict';
// Both browser tests, one Chromium harness.
//
//   node extension/browser-test.js          end-to-end: pill -> menu -> Replace
//                                           (needs the backend running; real model call)
//   node extension/browser-test.js sites    does the pill appear? fixtures + live sites
//
//   --headful       watch it happen
//   --shot <file>   screenshot the result card (smoke only)
//   --only <name>   one case only (sites only)
//
// No dependencies: node's global WebSocket is the CDP client.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const EXT = __dirname;
const CDP_PORT = 9334;
const PAGE_PORT = 8798;
const PROFILE = path.join(os.tmpdir(), 'proofread-test-profile');
const BACKEND = 'http://127.0.0.1:8799';

const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : null);
const HEADFUL = process.argv.includes('--headful');
const SHOT = arg('--shot');
const ONLY = arg('--only');
const MODE = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'smoke';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROKEN = 'she dont likes apples very much, and dont wanted to go their yesterday';

// The shapes real editors use, reduced to the part that breaks detection, plus the
// plain textarea the end-to-end test types into.
const FIXTURES = {
  smoke: `<h1>Proofread smoke test</h1><textarea id="box" style="width:100%;height:120px;font:inherit;padding:10px"></textarea>`,
  'rich-text': `<div id="t" contenteditable="true" role="textbox" style="border:1px solid #999;padding:10px;min-height:60px"><span><span>hello there</span></span></div>`,
  'wrapper-role': `<div role="textbox" style="border:1px solid #999;padding:10px"><div contenteditable="true" id="t" style="min-height:40px">hello</div></div>`,
  'shadow-input': `<div id="host"></div><script>const r=document.getElementById('host').attachShadow({mode:'open'});r.innerHTML='<input id="t" style="width:300px;padding:8px">';<\/script>`,
  autofocused: `<textarea id="t" autofocus style="width:400px;height:80px"></textarea>`,
  'late-mount': `<div id="slot"></div><script>setTimeout(()=>{document.getElementById('slot').innerHTML='<textarea id="t" style="width:400px;height:80px"></textarea>';document.getElementById('t').focus();},2500);<\/script>`,
  'in-iframe': `<iframe id="f" style="width:500px;height:160px" srcdoc="<textarea id=t style='width:90%;height:100px'></textarea>"></iframe>`,
  'search-input': `<input id="t" type="search" placeholder="search" style="width:300px;padding:8px">`,
  'email-input': `<input id="t" type="email" style="width:300px;padding:8px">`,
  'password-skipped': `<input id="t" type="password" style="width:300px;padding:8px">`,
  'tiny-input-skipped': `<input id="t" style="width:8px;height:6px;padding:0;border:0">`,
};

const SITES = [
  { name: 'youtube', url: 'https://www.youtube.com/', pick: `document.querySelector('input#search, input[name=search_query], [role=combobox] input')` },
  { name: 'google', url: 'https://www.google.com/', pick: `document.querySelector('textarea[name=q], input[name=q]')` },
  { name: 'github', url: 'https://github.com/', pick: `deep('input[name=user_email], input[type=email], input#query-builder-test')` },
  // Reddit serves a bot wall and WhatsApp needs a login, so neither can be judged from
  // a throwaway browser - they are reported, not failed. The `rich-text` fixture above
  // is the WhatsApp composer's shape (contenteditable + role=textbox + nested spans).
  { name: 'reddit', url: 'https://www.reddit.com/', pick: `deep('input[name=q], input[type=search]')`, optional: true },
  { name: 'whatsapp', url: 'https://web.whatsapp.com/', pick: `deep('[contenteditable=true], [role=textbox], input[type=text]')`, optional: true },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/wiki/Special:Search', pick: `document.querySelector('input[name=search], input[type=search]')` },
];

// -------------------------------------------------------------- the harness

function serveFixtures() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(req.url.slice(1));
    const markup = FIXTURES[name];
    res.writeHead(markup ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(markup
      ? `<!doctype html><meta charset="utf-8"><title>${name}</title><body style="font:15px system-ui;padding:40px;max-width:680px;margin:0 auto">${markup}`
      : 'no such fixture');
  });
  return new Promise((r) => server.listen(PAGE_PORT, '127.0.0.1', () => r(server)));
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let next = 1;
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const slot = msg.id && pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.reject(new Error(`${slot.method}: ${msg.error.message}`));
    else slot.resolve(msg.result);
  });
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('cannot reach ' + wsUrl)), { once: true });
  });
  return {
    send(method, params = {}) {
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, method });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    // Evaluate in the page and hand back the plain value.
    async eval(expression) {
      const { result } = await this.send('Runtime.evaluate', { expression, returnByValue: true });
      return result.value;
    },
    close: () => ws.close(),
  };
}

async function launch(startUrl) {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const flags = [
    `--user-data-dir=${PROFILE}`,
    `--remote-debugging-port=${CDP_PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
    '--window-size=1280,900',
    startUrl,
  ];
  if (!HEADFUL) flags.unshift('--headless=new');
  const child = spawn('/usr/bin/chromium', flags, { stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try {
      const targets = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
      const page = targets.find((t) => t.type === 'page');
      if (page) {
        const cdp = await connect(page.webSocketDebuggerUrl);
        await cdp.send('Runtime.enable');
        await cdp.send('Page.enable');
        return { child, cdp };
      }
    } catch {}
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error('chromium never came up');
}

// The extension UI lives in an open shadow root.
const UI = `(() => document.querySelector('[data-proofread=ui]')?.shadowRoot)()`;

async function waitFor(cdp, expression, what, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await cdp.eval(expression);
    if (value) return value;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` - ${detail}` : ''}`);
};

// ---------------------------------------------------- end-to-end (default)

async function smoke(cdp) {
  await waitFor(cdp, `!!document.getElementById('box')`, 'the test page');

  await cdp.eval(`(() => {
    const box = document.getElementById('box');
    box.value = ${JSON.stringify(BROKEN)};
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  await waitFor(cdp, `!!${UI}?.querySelector('.pill')`, 'the pill to appear next to the caret');
  check('pill appears when a text box is focused', true);

  check('pill is anchored inside the text box, not parked in a corner', !!(await cdp.eval(`(() => {
    const layer = ${UI}.querySelector('.layer');
    const box = document.getElementById('box').getBoundingClientRect();
    const pill = layer.getBoundingClientRect();
    return pill.top > box.top && pill.top < box.bottom + 40 && pill.left > box.left - 10;
  })()`)));

  await cdp.eval(`${UI}.querySelector('.pill').click()`);
  await waitFor(cdp, `!!${UI}?.querySelector('.menu button')`, 'the action menu');
  const labels = await cdp.eval(`[...${UI}.querySelectorAll('.menu button')].map(b => b.textContent.replace('Ctrl+Shift+Y','').trim())`);
  check('menu offers "Correct grammar"', labels.includes('Correct grammar'), labels.join(', '));

  if (SHOT) {
    await sleep(400);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT.replace(/\.png$/, '-menu.png'), Buffer.from(shot.data, 'base64'));
  }

  await cdp.eval(`[...${UI}.querySelectorAll('.menu button')].find(b => b.textContent.includes('Correct grammar')).click()`);
  check('menu shows a spinner while opencode runs',
    !!(await waitFor(cdp, `!!${UI}?.querySelector('.pill.busy')`, 'the spinner', 5000).catch(() => false)));

  await waitFor(cdp, `!!${UI}?.querySelector('.body')`, 'the suggestion (opencode is slow on the free tier)', 120_000);
  const suggestion = await cdp.eval(
    `({ text: ${UI}.querySelector('.body').textContent, ins: ${UI}.querySelectorAll('.body ins').length, del: ${UI}.querySelectorAll('.body del').length })`);
  check('suggestion came back corrected', /doesn't|does not/.test(suggestion.text), suggestion.text.slice(0, 80));
  check('changed words are highlighted as a diff', suggestion.ins > 0 && suggestion.del > 0,
    `${suggestion.ins} insertions, ${suggestion.del} deletions`);

  if (SHOT) {
    await sleep(400); // let the card's entry animation finish
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`  ..   screenshot written to ${SHOT}`);
  }
  if (HEADFUL) await sleep(4000);

  await cdp.eval(`${UI}.querySelector('.actions .primary').click()`);
  const applied = await waitFor(cdp,
    `(() => { const v = document.getElementById('box').value; return v !== ${JSON.stringify(BROKEN)} ? v : false; })()`,
    'the replacement to land');
  check('Replace writes the corrected text back into the box', /doesn't like apples/i.test(applied), applied);
  check('the card closes after replacing', !(await cdp.eval(`!!${UI}?.querySelector('.card')`)));

  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  return failed;
}

// ------------------------------------------- does the pill appear? (sites)

// Injected into the page: a query that pierces open shadow roots, the way real sites
// (Reddit, YouTube) bury their search box.
const DEEP = `
window.deep = (sel, doc) => {
  doc = doc || document;
  const direct = doc.querySelector(sel);
  if (direct) return direct;
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        const hit = el.shadowRoot.querySelector(sel) || walk(el.shadowRoot);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(doc);
};`;

// Reports everything needed to tell WHY the pill is missing.
const REPORT = (pick, doc) => `(() => {
  const el = ${pick};
  const doc = ${doc};
  const host = doc.querySelector('[data-proofread=ui]');
  const root = host && host.shadowRoot;
  const pill = root && root.querySelector('.pill');
  const rect = pill ? pill.getBoundingClientRect() : null;
  const active = doc.activeElement;
  return {
    found: !!el,
    tag: el ? el.tagName.toLowerCase() + (el.type ? '[' + el.type + ']' : '') : null,
    focused: !!el && (active === el || (active && active.shadowRoot && active.shadowRoot.activeElement === el)),
    activeTag: active ? active.tagName.toLowerCase() : null,
    hostPresent: !!host,
    pillPresent: !!pill,
    pillVisible: !!(rect && rect.width > 0 && rect.height > 0),
  };
})()`;

async function sites(cdp) {
  const cases = [
    ...Object.keys(FIXTURES).filter((n) => n !== 'smoke').map((name) => ({
      name,
      url: `http://127.0.0.1:${PAGE_PORT}/${name}`,
      doc: name === 'in-iframe' ? `document.getElementById('f').contentDocument` : 'document',
      pick: name === 'in-iframe' ? `document.getElementById('f').contentDocument.getElementById('t')` : `deep('#t')`,
      expect: name.endsWith('-skipped') ? 'none' : 'pill',
      wait: name === 'late-mount' ? 4000 : 1200,
    })),
    ...SITES.map((s) => ({ ...s, doc: 'document', expect: 'pill', wait: 6000, remote: true })),
  ];

  const rows = [];
  for (const c of cases) {
    if (ONLY && c.name !== ONLY) continue;
    try {
      await cdp.send('Page.navigate', { url: c.url });
      await sleep(c.remote ? 6000 : 900);
      await cdp.eval(DEEP);
      await cdp.eval(`(() => { const el = ${c.pick}; if (el) { el.focus(); } return !!el; })()`);
      await sleep(c.wait);
      rows.push({ case: c.name, expect: c.expect, optional: !!c.optional, ...(await cdp.eval(REPORT(c.pick, c.doc))) });
    } catch (e) {
      rows.push({ case: c.name, expect: c.expect, optional: !!c.optional, error: e.message });
    }
  }

  let failed = 0;
  for (const r of rows) {
    const wantPill = r.expect === 'pill';
    const ok = r.error ? false : wantPill ? r.pillVisible : !r.pillVisible;
    if (r.optional && !ok && !r.found) {
      console.log(` --   ${r.case.padEnd(18)} ${'-'.padEnd(16)} skipped: no text box reachable without a login`);
      continue;
    }
    if (!ok) failed++;
    const why = r.error ? `error: ${r.error}`
      : ok ? (wantPill ? 'pill shown' : 'correctly ignored')
      : !r.found ? 'no text box found on the page'
      : !r.hostPresent ? 'content script never mounted'
      : !r.focused ? `focus did not land on it (active: ${r.activeTag})`
      : !r.pillPresent ? 'focused, but no pill was drawn'
      : wantPill ? 'pill drawn but invisible' : 'pill shown where it should not be';
    console.log(`${ok ? ' ok  ' : 'FAIL '} ${r.case.padEnd(18)} ${String(r.tag || '-').padEnd(16)} ${why}`);
  }
  const skipped = rows.filter((r) => r.optional && !r.found).length;
  console.log(`\n${rows.length - failed - skipped}/${rows.length - skipped} cases passed${skipped ? `, ${skipped} skipped` : ''}`);
  return failed;
}

// ------------------------------------------------------------------- main

(async () => {
  if (MODE !== 'smoke' && MODE !== 'sites') {
    console.error(`unknown mode "${MODE}" - use "smoke" or "sites"`);
    process.exit(2);
  }
  if (MODE === 'smoke') {
    const health = await fetch(`${BACKEND}/api/health`).then((r) => r.json()).catch(() => null);
    if (!health || !health.ok) {
      console.error('backend is not running: start it with `node backend/server.js`');
      process.exit(1);
    }
  }

  const server = await serveFixtures();
  const { child, cdp } = await launch(MODE === 'smoke' ? `http://127.0.0.1:${PAGE_PORT}/smoke` : 'about:blank');
  let failed = 1;
  try {
    failed = MODE === 'smoke' ? await smoke(cdp) : await sites(cdp);
  } finally {
    cdp.close();
    child.kill('SIGKILL');
    server.close();
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('browser test failed:', e.message); process.exit(1); });
