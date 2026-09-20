'use strict';
// Service worker. The content script never talks to the backend directly: an https
// page cannot fetch http://127.0.0.1, but the extension's own context can.

importScripts('shared.js');
const { DEFAULTS } = self.PROOFREAD;

async function settings() {
  return { ...DEFAULTS, ...(await chrome.storage.sync.get(DEFAULTS)) };
}

async function call(path, init) {
  const { backendUrl } = await settings();
  const res = await fetch(backendUrl.replace(/\/$/, '') + path, init);
  const body = await res.json().catch(() => ({ error: `backend returned ${res.status}` }));
  if (!res.ok) throw new Error(body.error || `backend returned ${res.status}`);
  return body;
}

const handlers = {
  async openOptions() {
    chrome.runtime.openOptionsPage();
    return {};
  },
  async settings() {
    return settings();
  },
  async health() {
    return call('/api/health');
  },
  async models({ refresh }) {
    return call('/api/models' + (refresh ? '?refresh=1' : ''));
  },
  async edit({ text, action }) {
    const { model } = await settings();
    return call('/api/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, action, model }),
    });
  },
};

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const handler = handlers[msg && msg.type];
  if (!handler) return false;
  handler(msg)
    .then((data) => sendResponse({ ok: true, data }))
    .catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  return true; // keep the channel open for the async reply
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'correct-grammar') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) chrome.tabs.sendMessage(tab.id, { type: 'run', action: 'grammar' }).catch(() => {});
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
