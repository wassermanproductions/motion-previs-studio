'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');
const releaseRoot = path.join(root, 'release');

function findResourceDirectories(directory, depth = 0) {
  if (!fs.existsSync(directory) || depth > 8) return [];
  if (fs.existsSync(path.join(directory, 'app.asar'))) return [directory];
  const results = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    results.push(...findResourceDirectories(path.join(directory, entry.name), depth + 1));
  }
  return results;
}

function countEnding(entries, ending) {
  return entries.filter((entry) => entry.endsWith(ending)).length;
}

function verifyResources(resources) {
  const archive = path.join(resources, 'app.asar');
  const entries = asar.listPackage(archive);
  const forbidden = [
    '/node_modules/react/',
    '/node_modules/react-dom/',
    '/node_modules/three/',
    '/node_modules/@huggingface/',
    '/node_modules/@mediapipe/',
    '/node_modules/ffmpeg-static/',
    '/node_modules/@derhuerst/ffprobe-static/',
    '/public/',
    '/runtime/',
    '/mcp/'
  ];

  assert.ok(entries.includes('/package.json'), 'app.asar must contain the sanitized runtime package.json');
  for (const prefix of forbidden) {
    assert.equal(
      entries.some((entry) => entry === prefix.slice(0, -1) || entry.startsWith(prefix)),
      false,
      `${prefix} must not be duplicated inside app.asar`
    );
  }

  for (const asset of [
    '/models/pose_landmarker_lite.task',
    '/models/pose_landmarker_full.task',
    '/models/pose_landmarker_heavy.task',
    '/mediapipe/wasm/vision_wasm_internal.wasm',
    '/mediapipe/wasm/vision_wasm_nosimd_internal.wasm'
  ]) {
    assert.equal(countEnding(entries, asset), 1, `${asset} must occur exactly once in app.asar`);
  }

  assert.ok(fs.existsSync(path.join(resources, 'mcp', 'motion-previs-mcp.mjs')), 'MCP bridge must be packaged outside ASAR');
  const ytDlp = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  assert.ok(fs.existsSync(path.join(resources, 'bin', ytDlp)), `bundled ${ytDlp} must be packaged outside ASAR`);

  const archiveBytes = fs.statSync(archive).size;
  assert.ok(archiveBytes < 160 * 1024 * 1024, `app.asar is unexpectedly large: ${archiveBytes} bytes`);
  return { resources, archiveBytes, entries: entries.length };
}

const resourceDirectories = findResourceDirectories(releaseRoot);
assert.ok(resourceDirectories.length > 0, 'no packaged app.asar found under release/; run dist:dir or a package task first');
const reports = resourceDirectories.map(verifyResources);
console.log(JSON.stringify({ ok: true, packages: reports }, null, 2));
