'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'ASSET_MANIFEST.json'), 'utf8'));
const recipe = manifest.mediaTools.macos;
const arch = process.arch;

async function main() {
  if (process.platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    throw new Error('The pinned native FFmpeg recipe supports macOS arm64/x64 only.');
  }
  const outDir = path.join(root, 'runtime', 'media', `darwin-${arch}`);
  if (pairIsCurrent(outDir)) {
    auditPair(outDir);
    console.log(`[ffmpeg-mac] verified cached darwin-${arch} media pair`);
    return;
  }

  const prebuilt = recipe.prebuilt && recipe.prebuilt[arch];
  if (prebuilt && !process.argv.includes('--build-from-source')) {
    const mediaDir = path.join(root, 'runtime', 'media');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-ffmpeg-mac-prebuilt-'));
    try {
      const archive = path.join(work, prebuilt.name);
      run('curl', ['-fL', '--retry', '3', '--user-agent', 'motion-previs-ffmpeg-build/1', '-o', archive, prebuilt.url]);
      if (!matches(archive, prebuilt.sha256)) {
        throw new Error(`SHA-256 mismatch for ${prebuilt.name} (got ${sha256(archive)})`);
      }
      fs.mkdirSync(mediaDir, { recursive: true });
      fs.rmSync(outDir, { recursive: true, force: true });
      run('tar', ['-xzf', archive, '-C', mediaDir]);
      if (!pairIsCurrent(outDir)) {
        throw new Error(`${prebuilt.name} failed provenance validation against the pinned manifest`);
      }
      auditPair(outDir);
      console.log(`[ffmpeg-mac] downloaded and audited darwin-${arch} media pair`);
      return;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }

  preflight();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-ffmpeg-mac-'));
  const cache = path.join(root, 'work', 'ffmpeg-source-cache');
  fs.mkdirSync(cache, { recursive: true });
  try {
    const buildArchive = path.join(cache, recipe.sourceArtifacts[0].name);
    await ensureDownload(recipe.sourceArtifacts[0], buildArchive);
    const source = path.join(temp, 'build-script');
    fs.mkdirSync(source, { recursive: true });
    run('tar', ['-xzf', buildArchive, '-C', source, '--strip-components=1']);
    run('patch', ['-p1', '-i', path.join(root, recipe.patch)], { cwd: source });

    const packages = path.join(source, 'packages');
    fs.mkdirSync(packages, { recursive: true });
    for (const asset of recipe.sourceArtifacts.slice(1)) {
      const cached = path.join(cache, asset.name);
      await ensureDownload(asset, cached);
      fs.copyFileSync(cached, path.join(packages, buildScriptFilename(asset.name)));
    }

    run('bash', ['build-ffmpeg', '--build'], {
      cwd: source,
      env: { ...process.env, NUMJOBS: '' },
      stdio: 'inherit'
    });

    fs.mkdirSync(outDir, { recursive: true });
    for (const name of ['ffmpeg', 'ffprobe']) {
      fs.copyFileSync(path.join(source, 'workspace', 'bin', name), path.join(outDir, name));
      fs.chmodSync(path.join(outDir, name), 0o755);
    }
    const license = path.join(packages, 'FFmpeg-release-7.1.5-portable-gpl.1', 'COPYING.GPLv3');
    if (!fs.existsSync(license)) throw new Error('FFmpeg GPLv3 license was not found in the pinned source tree.');
    fs.copyFileSync(license, path.join(outDir, 'LICENSE.txt'));
    const audit = auditPair(outDir);
    fs.writeFileSync(
      path.join(outDir, 'PROVENANCE.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        platform: 'darwin',
        arch,
        buildRepositoryCommit: recipe.buildRepositoryCommit,
        ffmpegCommit: recipe.ffmpegCommit,
        patch: recipe.patch,
        sourceArtifacts: recipe.sourceArtifacts,
        ffmpegSha256: sha256(path.join(outDir, 'ffmpeg')),
        ffprobeSha256: sha256(path.join(outDir, 'ffprobe')),
        ...audit
      }, null, 2)}\n`
    );
    console.log(`[ffmpeg-mac] built and audited darwin-${arch} media pair`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function buildScriptFilename(name) {
  if (name.startsWith('FFmpeg-')) return 'FFmpeg-release-7.1.5-portable-gpl.1.tar.gz';
  return name;
}

function pairIsCurrent(outDir) {
  try {
    const provenance = JSON.parse(fs.readFileSync(path.join(outDir, 'PROVENANCE.json'), 'utf8'));
    return provenance.buildRepositoryCommit === recipe.buildRepositoryCommit
      && provenance.ffmpegCommit === recipe.ffmpegCommit
      && provenance.arch === arch
      && sha256(path.join(outDir, 'ffmpeg')) === provenance.ffmpegSha256
      && sha256(path.join(outDir, 'ffprobe')) === provenance.ffprobeSha256;
  } catch {
    return false;
  }
}

function auditPair(outDir) {
  const outputs = {};
  for (const name of ['ffmpeg', 'ffprobe']) {
    const binary = path.join(outDir, name);
    const version = run(binary, ['-version'], { capture: true });
    for (const flag of recipe.requiredConfigureFlags) {
      if (!version.includes(flag)) throw new Error(`${name} is missing required configure flag ${flag}`);
    }
    for (const flag of recipe.forbiddenConfigureFlags) {
      if (version.includes(flag)) throw new Error(`${name} contains forbidden configure flag ${flag}`);
    }
    const linked = run('otool', ['-L', binary], { capture: true });
    const nonSystem = linked.split('\n').slice(1).map((line) => line.trim().split(' ')[0]).filter(Boolean)
      .filter((library) => !library.startsWith('/usr/lib/') && !library.startsWith('/System/Library/'));
    if (nonSystem.length) throw new Error(`${name} links non-system libraries: ${nonSystem.join(', ')}`);
    outputs[`${name}Version`] = version.split('\n')[0];
    outputs[`${name}LinkedLibraries`] = linked.split('\n').slice(1).map((line) => line.trim()).filter(Boolean);
  }

  const smokeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-ffmpeg-smoke-'));
  try {
    const sample = path.join(smokeDir, 'h264-aac.mp4');
    run(path.join(outDir, 'ffmpeg'), [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=12:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sample
    ]);
    const probe = run(path.join(outDir, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'json', sample], { capture: true });
    const codecs = JSON.parse(probe).streams.map((stream) => stream.codec_name);
    if (!codecs.includes('h264') || !codecs.includes('aac')) throw new Error(`H.264/AAC smoke failed: ${codecs.join(', ')}`);
    outputs.smokeCodecs = codecs;
  } finally {
    fs.rmSync(smokeDir, { recursive: true, force: true });
  }
  return outputs;
}

function preflight() {
  for (const command of ['bash', 'tar', 'patch', 'make', 'g++', 'curl', 'pkg-config', 'cmake', 'meson', 'ninja', 'yasm', 'nasm', 'python3', 'otool']) {
    const result = spawnSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    if (result.status !== 0) throw new Error(`Missing macOS FFmpeg build prerequisite: ${command}`);
  }
}

async function ensureDownload(asset, destination) {
  if (matches(destination, asset.sha256)) return;
  const temp = `${destination}.${process.pid}.download`;
  try {
    await download(asset.url, temp, 0);
    if (!matches(temp, asset.sha256)) throw new Error(`SHA-256 mismatch for ${asset.name}`);
    fs.renameSync(temp, destination);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

function matches(file, expected) {
  try { return sha256(file) === expected; } catch { return false; }
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, outPath, redirects) {
  if (redirects > 8) return Promise.reject(new Error(`Too many redirects for ${url}`));
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': 'motion-previs-ffmpeg-build/1' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        resolve(download(new URL(res.headers.location, url).href, outPath, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
      res.on('error', reject);
    });
    req.setTimeout(180_000, () => req.destroy(new Error(`Timed out downloading ${url}`)));
    req.on('error', reject);
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: options.capture ? 'utf8' : undefined,
    stdio: options.stdio || (options.capture ? 'pipe' : 'inherit')
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${result.error?.message || result.stderr || ''}`);
  }
  return options.capture ? `${result.stdout || ''}${result.stderr || ''}` : '';
}

main().catch((error) => {
  console.error(`[ffmpeg-mac] ${error.message}`);
  process.exitCode = 1;
});
