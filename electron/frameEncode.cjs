'use strict';

/**
 * Deterministic frame-to-mp4 encoder IPC for Motion Previs Studio v4.
 *
 * Replaces the old wall-clock MediaRecorder capture path. The renderer draws
 * every frame to a canvas, serializes each to a PNG ArrayBuffer, and streams
 * them here over three channels that mirror how main.cjs already streams work:
 *
 *   analysis:encode-frames:begin  -> { fps, width, height } -> returns { sessionId }
 *   analysis:encode-frames:frame  -> { sessionId, buffer }  -> one PNG per call
 *   analysis:encode-frames:end    -> { sessionId }          -> resolves { buffer }
 *
 * Main spawns one ffmpeg per session reading `-f image2pipe -framerate <fps>`
 * from stdin and writing an H.264 mp4 to a temp file; the exact number of PNGs
 * pushed equals the exact number of frames encoded (no dropped/duplicated
 * frames, no timing jitter). On `end` the mp4 bytes are read back and returned
 * to the renderer, which hands them to savePoseArtifacts as before.
 *
 * A session may instead be told to write straight to a destination path (used
 * when main already knows where the file belongs), but the default renderer
 * flow reads the bytes back so App.tsx's Blob contract is preserved untouched.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const processTree = require('./processTree.cjs');

// sessionId -> { child, tmpOut, fps, width, height, frames, done, error, ended }
const sessions = new Map();
let acceptingSessions = true;

function fail(message) {
  throw new Error(`Invalid encode request: ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${field} must be a finite number.`);
  return n;
}

function toBuffer(value, field) {
  // ipcRenderer.invoke serializes an ArrayBuffer as a Node Buffer-like /
  // Uint8Array. Accept ArrayBuffer, TypedArray, or Buffer.
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (value && value.buffer instanceof ArrayBuffer) return Buffer.from(value.buffer);
  fail(`${field} must be an ArrayBuffer/typed array of PNG bytes.`);
  return Buffer.alloc(0);
}

/**
 * Begin an encode session. `ffmpegBin` is injected by main so this module has
 * no dependency on ffmpeg-static resolution logic.
 */
function beginSession(ffmpegBin, payload) {
  if (!acceptingSessions) fail('encoder is shutting down.');
  if (!isPlainObject(payload)) fail('begin payload must be an object.');
  const fps = clamp(requireFiniteNumber(payload.fps, 'fps'), 1, 60);
  const width = clamp(Math.round(requireFiniteNumber(payload.width, 'width')), 2, 8192);
  const height = clamp(Math.round(requireFiniteNumber(payload.height, 'height')), 2, 8192);

  const sessionId = crypto.randomBytes(12).toString('hex');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-encode-'));
  const tmpOut = path.join(tmpDir, 'out.mp4');

  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-an',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    // Guarantee even dimensions for yuv420p regardless of incoming PNG size.
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-r', String(fps),
    tmpOut
  ];

  const child = spawn(ffmpegBin, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
    if (stderr.length > 64_000) stderr = stderr.slice(-64_000);
  });

  const session = {
    sessionId,
    child,
    tmpDir,
    tmpOut,
    fps,
    width,
    height,
    frames: 0,
    ended: false,
    closed: false,
    exitCode: null,
    stderr: () => stderr,
    // Backpressure: resolve when stdin drains.
    drainPromise: Promise.resolve()
  };

  session.closePromise = new Promise((resolve) => {
    child.on('close', (code) => {
      session.closed = true;
      session.exitCode = code;
      resolve(code);
    });
  });
  child.on('error', (err) => {
    session.spawnError = err;
  });

  sessions.set(sessionId, session);
  return { sessionId };
}

/** Push one PNG frame into the session's ffmpeg stdin, with backpressure. */
async function pushFrame(payload) {
  if (!isPlainObject(payload)) fail('frame payload must be an object.');
  const sessionId = payload.sessionId;
  const session = sessions.get(sessionId);
  if (!session) fail('unknown encode sessionId.');
  if (session.ended) fail('cannot push a frame after end.');
  if (session.spawnError) throw new Error(`ffmpeg failed to start: ${session.spawnError.message}`);

  const buffer = toBuffer(payload.buffer, 'frame buffer');
  const stdin = session.child.stdin;

  await new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    stdin.once('error', onError);
    const ok = stdin.write(buffer, (err) => {
      stdin.removeListener('error', onError);
      if (err) reject(err);
    });
    if (ok) {
      resolve();
    } else {
      stdin.once('drain', () => {
        stdin.removeListener('error', onError);
        resolve();
      });
    }
  });

  session.frames += 1;
  return { frames: session.frames };
}

/** End the session: close stdin, wait for ffmpeg, read the mp4 back. */
async function endSession(payload) {
  if (!isPlainObject(payload)) fail('end payload must be an object.');
  const sessionId = payload.sessionId;
  const session = sessions.get(sessionId);
  if (!session) fail('unknown encode sessionId.');
  session.ended = true;

  try {
    session.child.stdin.end();
    const code = await session.closePromise;
    if (code !== 0) {
      throw new Error(`ffmpeg encode exited with ${code}: ${session.stderr().slice(-2000)}`);
    }
    if (!fs.existsSync(session.tmpOut)) {
      throw new Error('ffmpeg encode produced no output file.');
    }
    const bytes = fs.readFileSync(session.tmpOut);
    return { buffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), frames: session.frames };
  } finally {
    cleanup(session);
    sessions.delete(sessionId);
  }
}

/** Cancel an encode, await ffmpeg termination, then remove its temporary files. */
async function cancelSession(payload) {
  if (!isPlainObject(payload)) fail('cancel payload must be an object.');
  const session = sessions.get(payload.sessionId);
  if (!session) return { cancelled: false };
  session.ended = true;
  try {
    session.child.stdin.destroy();
    const closed = await processTree.terminateChildTree(session.child, session.closePromise);
    if (!closed) {
      throw new Error('Timed out while terminating the ffmpeg encoder process tree; temporary files were retained.');
    }
    return { cancelled: true };
  } finally {
    if (session.closed) {
      cleanup(session);
      sessions.delete(payload.sessionId);
    }
  }
}

function cleanup(session) {
  if (!session.closed) return;
  try {
    fs.rmSync(session.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

/** Kill and drop every live session (called on app shutdown). */
async function disposeAllSessions() {
  acceptingSessions = false;
  await Promise.allSettled([...sessions.keys()].map((sessionId) => cancelSession({ sessionId })));
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Wire the three IPC channels onto ipcMain. `getFfmpegPath` returns the ffmpeg
 * binary path; `validate` is electron/validate.cjs for payload guards.
 */
function register(ipcMain, getFfmpegPath) {
  ipcMain.handle('analysis:encode-frames:begin', (_event, payload) => beginSession(getFfmpegPath(), payload));
  ipcMain.handle('analysis:encode-frames:frame', (_event, payload) => pushFrame(payload));
  ipcMain.handle('analysis:encode-frames:end', (_event, payload) => endSession(payload));
  ipcMain.handle('analysis:encode-frames:cancel', (_event, payload) => cancelSession(payload));
}

module.exports = {
  register,
  beginSession,
  pushFrame,
  endSession,
  cancelSession,
  disposeAllSessions,
  waitForChildClose: processTree.waitForChildClose,
  _sessions: sessions
};
