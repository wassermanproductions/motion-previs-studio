'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../electron/config.cjs');
const portable = require('../electron/portable.cjs');
const security = require('../electron/security.cjs');
const canonicalPath = (value) => fs.realpathSync.native ? fs.realpathSync.native(value) : fs.realpathSync(value);

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-platform-'));
try {
  const allowed = path.join(temp, "OneDrive - Studio", "Director's Cut", 'José');
  const outside = path.join(temp, 'outside');
  fs.mkdirSync(allowed, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  const clip = path.join(allowed, 'reference clip.mp4');
  const secret = path.join(outside, 'secret.mp4');
  fs.writeFileSync(clip, 'clip');
  fs.writeFileSync(secret, 'secret');

  security.allowRoot(allowed);
  assert.equal(security.isAllowedPath(clip), true);
  assert.equal(security.canonicalAllowedFile(clip), canonicalPath(clip));
  assert.equal(security.canonicalAllowedFile(secret), null, 'unregistered input files must not be readable by analysis IPC');
  assert.equal(security.canonicalAllowedDirectory(allowed), canonicalPath(allowed));
  assert.equal(security.canonicalAllowedDirectory(outside), null);
  const mediaUrl = security.toAppUrl(clip);
  assert.equal(security.urlToPath(mediaUrl), canonicalPath(clip));
  assert.match(mediaUrl, /^mps:\/\/media\/file\?path=/);

  if (process.platform !== 'win32') {
    const escape = path.join(allowed, 'junction-escape');
    fs.symlinkSync(outside, escape, 'dir');
    assert.equal(security.isAllowedPath(path.join(escape, 'secret.mp4')), false, 'realpath must reject a symlink/junction escape');
  }

  assert.equal(
    security.isPathWithinRoot('C:\\Users\\ALICE\\OneDrive - Studio\\Project\\clip.mp4', 'c:\\users\\alice\\onedrive - studio', 'win32'),
    true,
    'Windows path checks must be case-insensitive'
  );
  assert.equal(
    security.isPathWithinRoot('C:\\Users\\Alice2\\clip.mp4', 'C:\\Users\\Alice', 'win32'),
    false,
    'sibling prefixes must not pass the root check'
  );

  for (const windowsPath of [
    "C:\\Users\\José\\OneDrive - Studio\\Director's Cut\\clip.mov",
    '\\\\render-server\\production share\\José\\clip.mov'
  ]) {
    const url = new URL('mps://media/file');
    url.searchParams.set('path', windowsPath);
    assert.equal(security.urlToPath(url.href, 'win32'), path.win32.normalize(windowsPath));
  }

  const bundle = 'C:\\Users\\Alice\\OneDrive - Studio\\Production Pack';
  assert.deepEqual(
    portable.portableBundleFiles(bundle, {
      reference: path.win32.join(bundle, 'controls', 'reference.mp4'),
      missing: null
    }, 'win32'),
    { reference: 'controls/reference.mp4', missing: null }
  );
  assert.throws(
    () => portable.portableBundleFiles(bundle, { escape: 'C:\\Users\\Alice\\secret.mp4' }, 'win32'),
    /outside the production pack/
  );
  assert.equal(portable.basenameAnyPlatform('C:\\shots\\take-01.mov'), 'take-01.mov');
  assert.equal(portable.basenameAnyPlatform('/shots/take-02.mov'), 'take-02.mov');

  const winOptions = { platform: 'win32', env: { APPDATA: 'D:\\Profiles\\Alice\\Roaming' }, home: 'C:\\Users\\Alice' };
  assert.equal(
    config.motionDiscoveryFile(winOptions),
    'D:\\Profiles\\Alice\\Roaming\\Motion Previs Studio\\v4\\control.json'
  );
  assert.equal(
    config.motionDiscoveryFile({ ...winOptions, env: { MOTION_PREVIS_CONFIG_DIR: 'E:\\mps-ci' } }),
    'E:\\mps-ci\\control.json'
  );
  assert.ok(config.blockoutControlFiles(winOptions).some((file) => file.endsWith('Blockout\\control.json')));

  console.log('verify:platform: OK');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
