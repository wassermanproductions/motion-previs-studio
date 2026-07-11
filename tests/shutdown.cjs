'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { installShutdownGate } = require('../electron/shutdown.cjs');

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.quitCalls = 0;
    this.prevented = 0;
  }

  requestQuit() {
    this.emit('before-quit', {
      preventDefault: () => {
        this.prevented += 1;
      }
    });
  }

  quit() {
    this.quitCalls += 1;
    this.requestQuit();
  }
}

async function main() {
  const app = new FakeApp();
  let resolveCleanup;
  let cleanupCalls = 0;
  const gate = installShutdownGate(app, () => {
    cleanupCalls += 1;
    return new Promise((resolve) => {
      resolveCleanup = resolve;
    });
  });

  app.requestQuit();
  app.requestQuit();
  await Promise.resolve();
  assert.equal(gate.state, 'cleaning');
  assert.equal(cleanupCalls, 1, 'cleanup must only start once');
  assert.equal(app.quitCalls, 0, 'the app must not quit before cleanup settles');
  assert.equal(app.prevented, 2, 'every quit request during cleanup must be prevented');

  resolveCleanup();
  await gate.cleanupPromise;
  assert.equal(gate.state, 'ready');
  assert.equal(cleanupCalls, 1);
  assert.equal(app.quitCalls, 1, 'cleanup completion must resume Electron quit');
  assert.equal(app.prevented, 2, 'the resumed quit must be allowed through');

  console.log('verify:shutdown: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
