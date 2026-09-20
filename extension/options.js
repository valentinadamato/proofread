'use strict';

const { ACTIONS, DEFAULTS } = self.PROOFREAD;
const $ = (id) => document.getElementById(id);
const ask = (msg) => chrome.runtime.sendMessage(msg);

let current = { ...DEFAULTS };

function row({ type, name, value, label, checked, id }) {
  const wrap = document.createElement('label');
  wrap.className = 'row';
  const input = document.createElement('input');
  Object.assign(input, { type, name, value, checked });
  wrap.appendChild(input);
  wrap.append(label);
  if (id) {
    const tag = document.createElement('span');
    tag.className = 'id';
    tag.textContent = id;
    wrap.appendChild(tag);
  }
  return wrap;
}

function renderActions() {
  const box = $('actions');
  box.replaceChildren();
  for (const [id, label] of Object.entries(ACTIONS)) {
    box.appendChild(row({
      type: 'checkbox', name: 'action', value: id, label,
      checked: current.actions.includes(id),
    }));
  }
}

async function renderModels({ refresh = false } = {}) {
  const box = $('models');
  box.textContent = 'loading…';
  const reply = await ask({ type: 'models', refresh });
  if (!reply.ok) {
    box.textContent = `Could not reach the backend: ${reply.error}`;
    return;
  }
  box.replaceChildren();
  for (const model of reply.data.models) {
    const wrap = row({
      type: 'radio', name: 'model', value: model.id, label: model.label,
      checked: model.id === current.model, id: model.id,
    });
    if (model.free) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'free';
      wrap.insertBefore(badge, wrap.querySelector('.id'));
    }
    box.appendChild(wrap);
  }
}

async function checkHealth() {
  const reply = await ask({ type: 'health' });
  $('health').textContent = reply.ok
    ? `connected · opencode ${reply.data.sandboxed ? 'sandboxed with bubblewrap' : 'NOT sandboxed'}`
    : `not reachable: ${reply.error}`;
}

async function save() {
  const actions = [...document.querySelectorAll('input[name=action]:checked')].map((i) => i.value);
  const model = document.querySelector('input[name=model]:checked');
  current = {
    backendUrl: $('backendUrl').value.trim() || current.backendUrl,
    model: model ? model.value : current.model,
    actions: actions.length ? actions : ['grammar'],
  };
  await chrome.storage.sync.set(current);
  $('status').textContent = 'Saved';
  setTimeout(() => { $('status').textContent = ''; }, 1500);
  checkHealth();
}

(async () => {
  current = await ask({ type: 'settings' }).then((r) => (r.ok ? r.data : current));
  $('backendUrl').value = current.backendUrl;
  renderActions();
  await renderModels();
  checkHealth();
  $('save').addEventListener('click', save);
  $('reload').addEventListener('click', () => renderModels({ refresh: true }));
})();
