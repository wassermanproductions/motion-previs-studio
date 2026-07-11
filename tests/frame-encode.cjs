'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const frameEncode = require('../electron/frameEncode.cjs');
const ffmpeg = process.env.MOTION_PREVIS_FFMPEG || 'ffmpeg';

async function main() {
  const preclosed = Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null });
  await frameEncode.waitForChildClose(preclosed);
  const racing = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const raceWait = frameEncode.waitForChildClose(racing);
  queueMicrotask(() => {
    racing.exitCode = 0;
    racing.emit('close', 0);
  });
  await raceWait;

  const { sessionId } = frameEncode.beginSession(ffmpeg, { fps: 6, width: 320, height: 240 });
  const session = frameEncode._sessions.get(sessionId);
  assert.ok(session?.child?.pid, 'ffmpeg session should have a child pid');
  const tempDir = session.tmpDir;
  const result = await frameEncode.cancelSession({ sessionId });
  assert.deepEqual(result, { cancelled: true });
  assert.equal(frameEncode._sessions.has(sessionId), false);
  assert.equal(fs.existsSync(tempDir), false, 'temporary encoder directory must be removed after process close');
  assert.deepEqual(await frameEncode.cancelSession({ sessionId }), { cancelled: false });
  await frameEncode.disposeAllSessions();
  assert.throws(
    () => frameEncode.beginSession(ffmpeg, { fps: 6, width: 320, height: 240 }),
    /encoder is shutting down/,
    'shutdown must prevent a new encoder from racing the cleanup snapshot'
  );
  console.log('verify:encoder: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
