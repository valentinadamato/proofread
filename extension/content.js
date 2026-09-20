'use strict';
// Proofread content script.
//
// Draws a small pill next to the caret whenever a text box is focused. Clicking it
// opens the action menu; picking an action sends the text to the local backend and
// shows the suggestion as a word-level diff that can be applied in place.
//
// The menu labels come from shared.js, which the manifest loads before this file.

(() => {
  if (window.__proofreadLoaded) return;
  window.__proofreadLoaded = true;

  const ACTION_LABELS = self.PROOFREAD.ACTIONS;

  // Anything that is not one of these is treated as typeable. A deny-list is the
  // only thing that survives contact with real sites: allow-listing input types
  // missed search boxes on half the web.
  const SKIP_INPUT_TYPES = new Set([
    'password', 'hidden', 'checkbox', 'radio', 'file', 'button',
    'submit', 'reset', 'image', 'range', 'color',
  ]);
  const MAX_TEXT = 8000;

  // The UI lives in a shadow root, so the page's CSS cannot reach it. Kept here
  // rather than in a separate file so the pill is never drawn unstyled.
  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; }

.layer {
  position: fixed;
  z-index: 2147483647;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: 13px;
  line-height: 1.45;
  color: var(--pr-fg);
  --pr-bg: #ffffff;
  --pr-fg: #18181b;
  --pr-muted: #71717a;
  --pr-line: #e4e4e7;
  --pr-accent: #1d4ed8;
  --pr-on-accent: #ffffff;
  --pr-add-bg: #dcfce7;
  --pr-add-fg: #14532d;
  --pr-del-fg: #b91c1c;
  --pr-shadow: 0 6px 24px rgba(15, 23, 42, .18), 0 1px 2px rgba(15, 23, 42, .1);
}
@media (prefers-color-scheme: dark) {
  .layer {
    --pr-bg: #1c1c20;
    --pr-fg: #f4f4f5;
    --pr-muted: #a1a1aa;
    --pr-line: #34343a;
    --pr-accent: #93b4ff;
    --pr-on-accent: #10131c;
    --pr-add-bg: #14532d;
    --pr-add-fg: #bbf7d0;
    --pr-del-fg: #fca5a5;
    --pr-shadow: 0 6px 24px rgba(0, 0, 0, .55);
  }
}

/* the pill that follows the caret */
.pill {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: 1px solid var(--pr-line);
  border-radius: 999px;
  background: var(--pr-bg);
  box-shadow: var(--pr-shadow);
  cursor: pointer;
  transition: transform .12s ease, opacity .12s ease;
  opacity: .82;
}
.pill:hover { opacity: 1; transform: scale(1.08); }
.pill svg { width: 14px; height: 14px; display: block; }
.pill.busy { cursor: progress; opacity: 1; }
.pill.busy svg { animation: pr-spin 900ms linear infinite; }
@keyframes pr-spin { to { transform: rotate(360deg); } }

/* shared card */
.card {
  min-width: 230px;
  max-width: 380px;
  border: 1px solid var(--pr-line);
  border-radius: 12px;
  background: var(--pr-bg);
  box-shadow: var(--pr-shadow);
  overflow: hidden;
  animation: pr-in .12s ease-out;
}
@keyframes pr-in { from { opacity: 0; transform: translateY(-4px); } }

.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--pr-line);
}
.head .title { font-weight: 600; }
.head .scope { color: var(--pr-muted); font-size: 11px; margin-left: auto; }

/* action menu */
.menu { padding: 4px; }
.menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 9px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.menu button:hover, .menu button:focus-visible { background: color-mix(in srgb, var(--pr-accent) 12%, transparent); }
.menu button .key { margin-left: auto; color: var(--pr-muted); font-size: 11px; }

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 12px;
  border-top: 1px solid var(--pr-line);
  color: var(--pr-muted);
  font-size: 11px;
}
.foot .dot { width: 6px; height: 6px; border-radius: 999px; background: #22c55e; }
.foot button {
  margin-left: auto;
  border: 0;
  background: none;
  color: var(--pr-muted);
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}

/* result */
.body {
  padding: 10px 12px;
  max-height: 220px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.body ins, .body del { border-radius: 4px; padding: 0 3px; margin: 0 1px; }
.body ins { background: var(--pr-add-bg); color: var(--pr-add-fg); text-decoration: none; }
.body del { color: var(--pr-del-fg); opacity: .8; text-decoration-thickness: 1px; }
.body.clean { color: var(--pr-muted); }

.error { padding: 10px 12px; color: var(--pr-del-fg); }

.actions {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--pr-line);
}
.actions button {
  padding: 5px 10px;
  border: 1px solid var(--pr-line);
  border-radius: 8px;
  background: var(--pr-bg);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.actions button:hover { border-color: var(--pr-accent); }
.actions button.primary {
  margin-right: auto;
  border-color: var(--pr-accent);
  background: var(--pr-accent);
  color: var(--pr-on-accent);
  font-weight: 600;
}
.actions button.primary:hover { filter: brightness(1.08); }
`;

  let settings = { model: self.PROOFREAD.DEFAULTS.model, actions: Object.keys(ACTION_LABELS) };
  let field = null;      // the editable element the pill belongs to
  let pillEl = null;     // the pill node, reused so it does not flicker
  let panel = null;      // what is currently on screen: pill | busy | menu | result | error
  let pending = null;    // { field, scope, action } while a request is in flight

  // ---------------------------------------------------------------- editables

  function isEditable(el) {
    if (!el || el.nodeType !== 1 || el.disabled || el.readOnly) return false;
    const tag = el.nodeName;
    if (tag === 'TEXTAREA') return true;
    if (tag === 'INPUT') return !SKIP_INPUT_TYPES.has((el.type || '').toLowerCase());
    if (el.isContentEditable) return true;
    // isContentEditable is false inside a design-mode-off document or before the
    // editor initialises, so trust the attribute too.
    const attr = el.getAttribute && el.getAttribute('contenteditable');
    return attr !== null && attr !== 'false';
  }

  // Real editors put focus on a child, a wrapper, or a custom element - the thing
  // holding the text is often a few levels up from whatever got focused.
  function editableFrom(node) {
    let el = node;
    while (el && el.nodeType !== 1) el = el.parentNode;
    for (let depth = 0; el && depth < 6; el = el.parentElement, depth++) {
      if (isEditable(el)) return el;
    }
    return null;
  }

  // document.activeElement stops at the shadow host, and sites like YouTube put the
  // real input several shadow roots down.
  function deepActive() {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  // Skip the invisible one-pixel inputs sites use for autofill and hotkeys.
  const bigEnough = (el) => el.offsetWidth >= 20 && el.offsetHeight >= 10;

  const isValueField = (el) => el.nodeName === 'TEXTAREA' || el.nodeName === 'INPUT';

  // What the action should operate on: the selection if there is one, else everything.
  function currentScope(el) {
    if (isValueField(el)) {
      const value = el.value || '';
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      if (end > start) return { kind: 'value', start, end, text: value.slice(start, end), whole: false };
      return { kind: 'value', start: 0, end: value.length, text: value, whole: true };
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && el.contains(sel.anchorNode)) {
      const range = sel.getRangeAt(0).cloneRange();
      return { kind: 'range', range, text: range.toString(), whole: false };
    }
    const range = document.createRange();
    range.selectNodeContents(el);
    return { kind: 'range', range, text: el.innerText || '', whole: true };
  }

  function applyText(el, scope, text) {
    el.focus();
    if (scope.kind === 'value') {
      el.setSelectionRange(scope.start, scope.end);
      // execCommand keeps the page's own undo stack and fires the events frameworks
      // listen for; the native-setter path below is the fallback when it is refused.
      if (!document.execCommand('insertText', false, text)) {
        const proto = el.nodeName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        const value = el.value.slice(0, scope.start) + text + el.value.slice(scope.end);
        setter.call(el, value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.setSelectionRange(scope.start + text.length, scope.start + text.length);
      }
      return;
    }
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(scope.range);
    if (!document.execCommand('insertText', false, text)) {
      scope.range.deleteContents();
      scope.range.insertNode(document.createTextNode(text));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  // ------------------------------------------------------------ caret anchor

  const MIRROR_PROPS = [
    'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust',
    'lineHeight', 'fontFamily', 'textAlign', 'textTransform', 'textIndent',
    'letterSpacing', 'wordSpacing', 'tabSize', 'whiteSpace', 'wordWrap', 'wordBreak',
  ];

  // input/textarea give no caret coordinates, so measure an off-screen copy of the
  // field with a marker span at the caret offset.
  function valueCaretRect(el) {
    const computed = getComputedStyle(el);
    const mirror = document.createElement('div');
    for (const prop of MIRROR_PROPS) mirror.style[prop] = computed[prop];
    Object.assign(mirror.style, {
      position: 'absolute', top: '0', left: '-9999px', visibility: 'hidden',
      whiteSpace: el.nodeName === 'INPUT' ? 'pre' : 'pre-wrap',
      wordWrap: 'break-word', overflow: 'hidden',
    });
    const index = el.selectionEnd ?? (el.value || '').length;
    mirror.textContent = (el.value || '').slice(0, index);
    const marker = document.createElement('span');
    marker.textContent = (el.value || '').slice(index) || '.';
    mirror.appendChild(marker);
    document.body.appendChild(mirror);
    const offsetTop = marker.offsetTop;
    const offsetLeft = marker.offsetLeft;
    mirror.remove();

    const box = el.getBoundingClientRect();
    const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.35;
    return {
      left: box.left + offsetLeft - el.scrollLeft,
      top: box.top + offsetTop - el.scrollTop,
      height: lineHeight,
      box,
    };
  }

  function caretRect(el) {
    if (isValueField(el)) return valueCaretRect(el);
    const box = el.getBoundingClientRect();
    const sel = window.getSelection();
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) {
      const rects = sel.getRangeAt(0).getClientRects();
      const rect = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) {
        return { left: rect.right, top: rect.top, height: rect.height, box };
      }
    }
    return { left: box.left + 8, top: box.top + 6, height: 18, box };
  }

  // ------------------------------------------------------------------- shell

  const host = document.createElement('div');
  host.setAttribute('data-proofread', 'ui');
  host.style.cssText = 'all:initial;position:absolute;top:0;left:0;width:0;height:0';
  // Open, so the UI can be driven from a smoke test; the page could see the host anyway.
  const root = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style');
  sheet.textContent = CSS;
  root.appendChild(sheet);
  const layer = document.createElement('div');
  layer.className = 'layer';
  layer.style.display = 'none';
  root.appendChild(layer);

  const attachHost = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
  attachHost();
  new MutationObserver(attachHost).observe(document.documentElement, { childList: true });

  // Clicking our UI must not blur the text box, or the selection we are about to
  // replace disappears. Cancelling mousedown keeps focus where it is; click still fires.
  layer.addEventListener('mousedown', (e) => e.preventDefault());

  function place(anchor, node) {
    layer.style.display = 'block';
    layer.style.visibility = 'hidden';
    layer.replaceChildren(node);
    const width = node.offsetWidth || 240;
    const height = node.offsetHeight || 40;
    let left = anchor.left + 4;
    let top = anchor.top + anchor.height + 6;
    left = Math.max(6, Math.min(left, window.innerWidth - width - 6));
    if (top + height > window.innerHeight - 6) top = Math.max(6, anchor.top - height - 6);
    layer.style.left = `${Math.round(left)}px`;
    layer.style.top = `${Math.round(top)}px`;
    layer.style.visibility = 'visible';
  }

  function hide() {
    layer.style.display = 'none';
    layer.replaceChildren();
    panel = null;
  }

  const PEN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="color:var(--pr-accent)"><path d="M5 19l2.5-.6 9-9a1.8 1.8 0 0 0-2.6-2.6l-9 9L5 19z"/><path d="M14 6.5l3.5 3.5"/></svg>';
  const SPIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" style="color:var(--pr-accent)"><path d="M12 3a9 9 0 1 0 9 9" /></svg>';

  function showPill(busy = false) {
    if (!field) return;
    attachHost();
    if (panel === 'pill' && !busy && pillEl && pillEl.isConnected) {
      place(caretRect(field), pillEl); // same pill, new position - no flicker
      return;
    }
    const pill = document.createElement('div');
    pill.className = busy ? 'pill busy' : 'pill';
    pill.setAttribute('role', 'button');
    pill.setAttribute('aria-label', busy ? 'Proofread is working' : 'Open Proofread menu');
    pill.tabIndex = -1;
    pill.title = busy ? 'Proofread is thinking…' : 'Proofread (Ctrl+Shift+Y)';
    pill.innerHTML = busy ? SPIN : PEN;
    if (!busy) pill.addEventListener('click', openMenu);
    pillEl = pill;
    place(caretRect(field), pill);
    panel = busy ? 'busy' : 'pill';
  }

  function openMenu() {
    if (!field) return;
    const scope = currentScope(field);
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'head';
    head.innerHTML = '<span class="title">Proofread</span>';
    const label = document.createElement('span');
    label.className = 'scope';
    label.textContent = scope.whole ? `whole field · ${scope.text.trim().length} chars` : `${scope.text.trim().length} chars selected`;
    head.appendChild(label);
    card.appendChild(head);

    const menu = document.createElement('div');
    menu.className = 'menu';
    menu.setAttribute('role', 'menu');
    for (const id of settings.actions) {
      if (!ACTION_LABELS[id]) continue;
      const item = document.createElement('button');
      item.setAttribute('role', 'menuitem');
      item.textContent = ACTION_LABELS[id];
      if (id === 'grammar') {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = 'Ctrl+Shift+Y';
        item.appendChild(key);
      }
      item.addEventListener('click', () => run(id, scope));
      menu.appendChild(item);
    }
    card.appendChild(menu);

    const foot = document.createElement('div');
    foot.className = 'foot';
    foot.innerHTML = '<span class="dot"></span>';
    foot.append(settings.model);
    const options = document.createElement('button');
    options.textContent = 'change';
    options.addEventListener('click', () => chrome.runtime.sendMessage({ type: 'openOptions' }).catch(() => {}));
    foot.appendChild(options);
    card.appendChild(foot);

    place(caretRect(field), card);
    panel = 'menu';
  }

  // -------------------------------------------------------------------- diff

  function tokenize(text) {
    return text.split(/(\s+)/).filter((t) => t !== '');
  }

  // Word-level LCS. Small inputs only - anything long is shown without highlights.
  function diff(before, after) {
    const a = tokenize(before);
    const b = tokenize(after);
    if (a.length * b.length > 1_000_000) return null;
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const parts = [];
    const push = (type, text) => {
      const last = parts[parts.length - 1];
      if (last && last.type === type) last.text += text;
      else parts.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (table[i + 1][j] >= table[i][j + 1]) { push('del', a[i]); i++; }
      else { push('add', b[j]); j++; }
    }
    while (i < a.length) push('del', a[i++]);
    while (j < b.length) push('add', b[j++]);
    return parts;
  }

  function renderDiff(container, before, after) {
    const parts = diff(before, after);
    if (!parts) { container.textContent = after; return 1; }
    let changes = 0;
    for (const part of parts) {
      if (part.type === 'same') { container.append(part.text); continue; }
      if (!part.text.trim()) { if (part.type === 'add') container.append(part.text); continue; }
      changes++;
      const el = document.createElement(part.type === 'add' ? 'ins' : 'del');
      el.textContent = part.text;
      container.appendChild(el);
    }
    return changes;
  }

  // ------------------------------------------------------------------ action

  async function run(action, scope) {
    if (!field) return;
    const text = (scope.text || '').trim();
    if (!text) { showError('Nothing to correct - the box is empty.'); return; }
    if (text.length > MAX_TEXT) { showError(`That is ${text.length} characters; the limit is ${MAX_TEXT}.`); return; }

    pending = { field, scope, action };
    showPill(true);
    const reply = await chrome.runtime.sendMessage({ type: 'edit', text: scope.text, action })
      .catch((e) => ({ ok: false, error: String(e.message || e) }));
    if (!pending || pending.action !== action) return; // cancelled meanwhile

    if (!reply || !reply.ok) {
      showError(reply && reply.error ? reply.error : 'The backend did not answer. Is it running?');
      return;
    }
    showResult(action, scope, reply.data);
  }

  function showResult(action, scope, data) {
    const card = document.createElement('div');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'head';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = ACTION_LABELS[action] || action;
    head.appendChild(title);
    const meta = document.createElement('span');
    meta.className = 'scope';
    meta.textContent = `${data.model} · ${(data.ms / 1000).toFixed(1)}s`;
    head.appendChild(meta);
    card.appendChild(head);

    const body = document.createElement('div');
    body.className = 'body';
    const changes = renderDiff(body, scope.text, data.result);
    if (!changes || data.result.trim() === scope.text.trim()) {
      body.classList.add('clean');
      body.textContent = 'Looks good already - nothing to change.';
    }
    card.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const replace = document.createElement('button');
    replace.className = 'primary';
    replace.textContent = 'Replace';
    replace.addEventListener('click', () => {
      applyText(field, scope, data.result);
      pending = null;
      hide();
    });
    const copy = document.createElement('button');
    copy.textContent = 'Copy';
    copy.addEventListener('click', () => {
      navigator.clipboard.writeText(data.result).catch(() => {});
      copy.textContent = 'Copied';
    });
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => run(action, scope));
    const dismiss = document.createElement('button');
    dismiss.textContent = 'Dismiss';
    dismiss.addEventListener('click', () => { pending = null; showPill(); });
    actions.append(replace, copy, retry, dismiss);
    card.appendChild(actions);

    place(caretRect(field), card);
    panel = 'result';
  }

  function showError(message) {
    const card = document.createElement('div');
    card.className = 'card';
    const body = document.createElement('div');
    body.className = 'error';
    body.textContent = message;
    card.appendChild(body);
    const actions = document.createElement('div');
    actions.className = 'actions';
    const close = document.createElement('button');
    close.className = 'primary';
    close.textContent = 'OK';
    close.addEventListener('click', () => { pending = null; showPill(); });
    actions.appendChild(close);
    card.appendChild(actions);
    place(caretRect(field), card);
    panel = 'error';
    pending = null;
  }

  // ------------------------------------------------------------------ events

  // Focus events alone are not enough: fields are often already focused when the
  // script loads (autofocus), and single-page apps move focus around without firing
  // anything useful. So the focused field is polled as well, and every path goes
  // through one place.
  // `reposition` is what makes the 400ms heartbeat cheap: measuring the caret forces
  // layout, so it only happens when something actually moved the caret.
  function sync(reposition = false) {
    if (pending || panel === 'busy') return;
    const found = editableFrom(deepActive());
    const next = found && bigEnough(found) ? found : null;

    if (next === field) {
      if (field && (!panel || (panel === 'pill' && reposition))) showPill();
      return;
    }
    field = next;
    if (!field) hide();
    else showPill();
  }

  const refreshPill = () => { if (panel === 'pill' || !panel) sync(true); };

  document.addEventListener('focusin', sync, true);
  document.addEventListener('focusout', () => setTimeout(sync, 80), true);
  document.addEventListener('click', () => setTimeout(sync, 0), true);
  document.addEventListener('selectionchange', refreshPill);
  document.addEventListener('keyup', (e) => { if (!e.ctrlKey && !e.metaKey) refreshPill(); }, true);
  window.addEventListener('scroll', refreshPill, true);
  window.addEventListener('resize', refreshPill);
  setInterval(() => { if (!document.hidden) sync(); }, 400);
  sync(); // the field may already be focused before this script ever ran

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (panel && panel !== 'pill') { pending = null; showPill(); }
  }, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'run' && field) run(msg.action || 'grammar', currentScope(field));
  });

  chrome.storage.sync.get({ model: settings.model, actions: settings.actions })
    .then((stored) => { settings = { ...settings, ...stored }; })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes) => {
    for (const [key, change] of Object.entries(changes)) settings[key] = change.newValue;
  });
})();
