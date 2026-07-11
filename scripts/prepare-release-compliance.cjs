'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const release = path.join(root, 'release');
const assetManifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
fs.mkdirSync(release, { recursive: true });

if (!['win32', 'darwin'].includes(process.platform)) throw new Error('Release compliance packaging is supported only for audited Windows/macOS media pairs.');
const packages = process.platform === 'win32' ? windowsTools() : macTools();
const platformRecipe = process.platform === 'win32' ? assetManifest.mediaTools.windows : assetManifest.mediaTools.macos;
const provenance = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sourceArtifacts: platformRecipe.sourceArtifacts,
  tools: []
};

for (const item of packages) {
  if (item.license && fs.existsSync(item.license)) {
    fs.copyFileSync(item.license, path.join(release, `${item.name.toUpperCase()}_LICENSE.txt`));
  }
  if (item.readme && fs.existsSync(item.readme)) {
    fs.copyFileSync(item.readme, path.join(release, `${item.name.toUpperCase()}_README.txt`));
  }
  const version = spawnSync(item.binary, ['-version'], { encoding: 'utf8', windowsHide: true });
  provenance.tools.push({
    name: item.name,
    package: item.package,
    sha256: sha256(item.binary),
    versionOutput: `${version.stdout || ''}${version.stderr || ''}`.trim()
  });
}

fs.writeFileSync(path.join(release, 'MEDIA_BINARY_PROVENANCE.json'), JSON.stringify(provenance, null, 2));
console.log('[compliance] wrote media licenses, READMEs, and binary provenance to release/');

function windowsTools() {
  const dir = path.join(root, 'runtime', 'media', 'win32-x64');
  const license = path.join(dir, 'LICENSE.txt');
  return [
    { name: 'ffmpeg', package: 'BtbN FFmpeg-Builds autobuild-2026-06-30-13-34', binary: path.join(dir, 'ffmpeg.exe'), license },
    { name: 'ffprobe', package: 'BtbN FFmpeg-Builds autobuild-2026-06-30-13-34', binary: path.join(dir, 'ffprobe.exe'), license }
  ];
}

function macTools() {
  const dir = path.join(root, 'runtime', 'media', `darwin-${process.arch}`);
  const license = path.join(dir, 'LICENSE.txt');
  return [
    { name: 'ffmpeg', package: 'mifi/ffmpeg-build-script portable GPL recipe', binary: path.join(dir, 'ffmpeg'), license },
    { name: 'ffprobe', package: 'mifi/ffmpeg-build-script portable GPL recipe', binary: path.join(dir, 'ffprobe'), license }
  ];
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
