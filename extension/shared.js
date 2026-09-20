'use strict';
// Loaded by all three extension contexts (content script, service worker, options
// page) so the action list and the defaults exist in exactly one place.

self.PROOFREAD = {
  // Menu items. The matching instruction for each id lives in backend/server.js.
  ACTIONS: {
    grammar: 'Correct grammar',
    rephrase: 'Rephrase',
    shorten: 'Make it shorter',
    formal: 'More formal',
    casual: 'More casual',
  },
  DEFAULTS: {
    backendUrl: 'http://127.0.0.1:8799',
    model: 'big-pickle',
    actions: ['grammar', 'rephrase', 'shorten', 'formal', 'casual'],
  },
};
