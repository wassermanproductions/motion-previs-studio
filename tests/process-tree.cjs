'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const processTree = require('../electron/processTree.cjs');

function fakeChild({ closeOnSignal = null } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 4242,
    exitCode: null,
    signalCode: null,
    signals: [],
    kill(signal = 'SIGTERM') {
      this.signals.push(signal);
      if (signal === closeOnSignal) {
        this.signalCode = signal;
        queueMicrotask(() => this.emit('close', null, signal));
      }
      return true;
    }
  });
  return child;
}

async function main() {
  const graceful = fakeChild({ closeOnSignal: 'SIGTERM' });
  assert.equal(
    await processTree.terminateChildTree(graceful, processTree.waitForChildClose(graceful), {
      platform: 'linux',
      timeoutMs: 100
    }),
    true
  );
  assert.deepEqual(graceful.signals, ['SIGTERM']);

  const stuck = fakeChild();
  const started = Date.now();
  assert.equal(
    await processTree.terminateChildTree(stuck, processTree.waitForChildClose(stuck), {
      platform: 'linux',
      timeoutMs: 40
    }),
    false,
    'a child that never emits close must return a bounded failure'
  );
  assert.deepEqual(stuck.signals, ['SIGTERM', 'SIGKILL']);
  assert.ok(Date.now() - started < 1_000, 'termination exceeded its bounded deadline');

  const preclosed = fakeChild();
  preclosed.exitCode = 0;
  assert.equal(await processTree.terminateChildTree(preclosed), true);

  const exitedBeforeClose = fakeChild();
  let releaseClose;
  const trackedClose = new Promise((resolve) => { releaseClose = resolve; });
  exitedBeforeClose.exitCode = 0;
  const awaitingClose = processTree.terminateChildTree(exitedBeforeClose, trackedClose, { timeoutMs: 100 });
  let settled = false;
  awaitingClose.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'exit must not be treated as close when a close tracker exists');
  releaseClose(0);
  assert.equal(await awaitingClose, true);

  console.log('verify:process-tree: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
