'use strict';

const assert = require('node:assert/strict');
const protocol = require('../electron/blockoutProtocol.cjs');

assert.deepEqual(
  protocol.buildSetReferenceParams('C:\\pack\\reference.mp4', 'ghost', 0.5),
  { path: 'C:\\pack\\reference.mp4', mode: 'ghost', opacity: 0.5, handoffVersion: 1 }
);
assert.equal(protocol.shouldRetryLegacyHandoff(400, 'unknown field handoffVersion'), true);
assert.equal(protocol.shouldRetryLegacyHandoff(200, 'unsupported handoff version'), true);
assert.equal(protocol.shouldRetryLegacyHandoff(500, 'render failed'), false);
assert.deepEqual(
  protocol.buildSetReferenceParams('/pack/reference.mp4', 'ghost', 0.5, false),
  { path: '/pack/reference.mp4', mode: 'ghost', opacity: 0.5 }
);
console.log('verify:blockout: OK');
