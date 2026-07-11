'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const extractZip = require('extract-zip');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDest = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDir = path.join(root, 'public', 'models');
const binDir = path.join(root, 'runtime', 'bin');
const mediaDir = path.join(root, 'runtime', 'media');
const verifyOnly = process.argv.includes('--verify-only');

async function main() {
  if (!verifyOnly) {
    copyDir(wasmSrc, wasmDest);
    for (const asset of manifest.poseModels) {
      await downloadVerified(asset, path.join(modelDir, asset.name));
    }
    const ytDlp = ytDlpTarget();
    await downloadVerified(ytDlp, path.join(binDir, ytDlp.name));
    if (process.platform !== 'win32') fs.chmodSync(path.join(binDir, ytDlp.name), 0o755);
    if (process.platform === 'win32') await prepareWindowsMediaTools();
  }

  verifyAssets();
  console.log(`[assets] ${verifyOnly ? 'verified' : 'prepared'} pinned assets for ${process.platform}`);
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`MediaPipe wasm source is missing: ${src}. Run npm ci first.`);
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}

async function downloadVerified(asset, outPath) {
  if (fs.existsSync(outPath) && sha256(outPath) === asset.sha256) {
    console.log(`[assets] verified ${path.relative(root, outPath)}`);
    return;
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tempPath = `${outPath}.${process.pid}.download`;
  fs.rmSync(tempPath, { force: true });
  try {
    await download(asset.url, tempPath, 0);
    const actual = sha256(tempPath);
    if (actual !== asset.sha256) {
      throw new Error(`SHA-256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${actual}`);
    }
    fs.renameSync(tempPath, outPath);
    console.log(`[assets] downloaded and verified ${path.relative(root, outPath)}`);
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function download(url, outPath, redirects) {
  if (redirects > 8) return Promise.reject(new Error(`Too many redirects downloading ${url}`));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers: { 'User-Agent': 'motion-previs-studio-assets/1' } }, (response) => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        const next = new URL(response.headers.location, url).href;
        resolve(download(next, outPath, redirects + 1));
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed for ${url}: HTTP ${response.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(outPath, { flags: 'w' });
      response.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
      response.on('error', reject);
    });
    request.setTimeout(120_000, () => request.destroy(new Error(`Timed out downloading ${url}`)));
    request.on('error', reject);
  });
}

function verifyAssets() {
  for (const name of manifest.mediapipe.requiredWasmFiles) {
    requireNonEmpty(path.join(wasmDest, name), 10_000);
  }
  for (const asset of manifest.poseModels) {
    verifyHash(path.join(modelDir, asset.name), asset.sha256);
  }
  const ytDlp = ytDlpTarget();
  verifyHash(path.join(binDir, ytDlp.name), ytDlp.sha256);
  verifyMediaTools();
}

function verifyMediaTools() {
  if (process.platform === 'win32') {
    const target = manifest.mediaTools.windows;
    const folder = path.join(mediaDir, 'win32-x64');
    verifyHash(path.join(folder, 'ffmpeg.exe'), target.ffmpegSha256);
    verifyHash(path.join(folder, 'ffprobe.exe'), target.ffprobeSha256);
    verifyHash(path.join(folder, 'LICENSE.txt'), target.licenseSha256, 1_000);
    requireNonEmpty(path.join(folder, 'PROVENANCE.json'), 100);
    return;
  }
  // macOS/Linux use explicit runtime overrides or PATH during development.
  // Packaging is separately blocked until audited native assets are supplied.
}

async function prepareWindowsMediaTools() {
  const target = manifest.mediaTools.windows;
  const folder = path.join(mediaDir, 'win32-x64');
  const filesValid = [
    ['ffmpeg.exe', target.ffmpegSha256, 100_000],
    ['ffprobe.exe', target.ffprobeSha256, 100_000],
    ['LICENSE.txt', target.licenseSha256, 1_000]
  ].every(([name, hash, min]) => fileMatches(path.join(folder, name), hash, min));

  if (!filesValid) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-btbn-'));
    try {
      const archive = path.join(temp, target.archiveName);
      await downloadVerified({ name: target.archiveName, url: target.archiveUrl, sha256: target.archiveSha256 }, archive);
      const extracted = path.join(temp, 'extracted');
      fs.mkdirSync(extracted, { recursive: true });
      await extractZip(archive, { dir: extracted });
      fs.mkdirSync(folder, { recursive: true });
      for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt']) {
        const source = findFile(extracted, name);
        if (!source) throw new Error(`BtbN archive does not contain ${name}`);
        fs.copyFileSync(source, path.join(folder, name));
      }
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }

  verifyHash(path.join(folder, 'ffmpeg.exe'), target.ffmpegSha256);
  verifyHash(path.join(folder, 'ffprobe.exe'), target.ffprobeSha256);
  verifyHash(path.join(folder, 'LICENSE.txt'), target.licenseSha256, 1_000);
  fs.writeFileSync(
    path.join(folder, 'PROVENANCE.json'),
    `${JSON.stringify({ schemaVersion: 1, ...target }, null, 2)}\n`
  );
}

function findFile(folder, name) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const candidate = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const nested = findFile(candidate, name);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === name.toLowerCase()) {
      return candidate;
    }
  }
  return null;
}

function fileMatches(file, expected, minBytes) {
  try {
    return fs.statSync(file).size >= minBytes && sha256(file) === expected;
  } catch {
    return false;
  }
}

function requireNonEmpty(file, minBytes) {
  if (!fs.existsSync(file) || fs.statSync(file).size < minBytes) {
    throw new Error(`Required runtime asset is missing or incomplete: ${path.relative(root, file)}`);
  }
}

function verifyHash(file, expected, minBytes = 100_000) {
  requireNonEmpty(file, minBytes);
  const actual = sha256(file);
  if (actual !== expected) {
    throw new Error(`SHA-256 mismatch for ${path.relative(root, file)}: expected ${expected}, got ${actual}`);
  }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function ytDlpTarget() {
  const target = manifest.ytDlp.targets[process.platform] || manifest.ytDlp.targets.linux;
  if (!target) throw new Error(`No yt-dlp asset is configured for ${process.platform}`);
  return target;
}

main().catch((error) => {
  console.error(`[assets] ${error.message}`);
  process.exitCode = 1;
});
