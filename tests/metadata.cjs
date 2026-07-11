'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const pkg = JSON.parse(read('package.json'));
const assets = JSON.parse(read('ASSET_MANIFEST.json'));
const { metadataFor } = require('../scripts/prepare-app-metadata.cjs');

assert.equal(pkg.devDependencies.electron, '43.1.0');
assert.equal(pkg.devDependencies['electron-builder'], '26.15.3');
assert.equal(pkg.dependencies['ffmpeg-static'], undefined);
assert.equal(pkg.dependencies['@derhuerst/ffprobe-static'], undefined);
assert.equal(pkg.devDependencies['@mediapipe/tasks-vision'], assets.mediapipe.version);
for (const name of ['react', 'react-dom', 'three', '@huggingface/transformers', '@mediapipe/tasks-vision']) {
  assert.equal(pkg.dependencies[name], undefined, `${name} must not be copied as a production Node dependency`);
}
assert.deepEqual(Object.keys(pkg.dependencies), ['archiver']);
assert.equal(pkg.build.appId, 'studio.motionprevis.app.v4', 'default build must remain upstream-generic');
assert.equal(pkg.build.productName, 'Motion Previs Studio v4', 'default product name must remain upstream-generic');
assert.deepEqual(metadataFor(pkg).distribution, null);
assert.deepEqual(
  metadataFor(pkg, { extraMetadata: { distribution: { appId: 'example.community', configFolder: 'Example/control' } } }).distribution,
  { appId: 'example.community', configFolder: 'Example/control' },
  'downstream builder metadata must be copied into the packaged MCP metadata file'
);
assert.ok(pkg.scripts['package:win'].includes('verify:redistribution'));
assert.ok(pkg.scripts['package:mac'].includes('verify:redistribution'));
assert.ok(!pkg.build.files.some((entry) => entry.startsWith('public/')), 'generated web assets must only be packaged via dist');
assert.ok(!pkg.build.files.some((entry) => entry.startsWith('mcp/')), 'MCP must only be packaged outside ASAR');
assert.equal(pkg.build.asarUnpack, undefined, 'static media packages must not be unpacked');
assert.ok(!pkg.build.extraResources.some((entry) => ['models', 'mediapipe'].includes(entry.to)), 'models/wasm must not be duplicated in extraResources');
assert.ok(pkg.build.extraResources.some((entry) => entry.to === 'mcp'));

assert.equal(assets.ytDlp.version, '2026.07.04');
assert.equal(assets.ytDlp.targets.win32.sha256, '52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8');
assert.equal(assets.depthAnything.revision, '2e942621ab9f2371c1df9eb223291b5ac31475e6');
assert.equal(assets.poseModels.length, 3);
for (const asset of assets.poseModels) assert.match(asset.sha256, /^[a-f0-9]{64}$/);
assert.match(assets.mediaTools.windows.ffmpegSha256, /^[a-f0-9]{64}$/);
assert.equal(assets.mediaTools.windows.forbiddenConfigureFlags[0], '--enable-nonfree');
assert.equal(assets.mediaTools.windows.sourceArtifacts.length, 2);

assert.match(read('NOTICE'), new RegExp(`Motion Previs Studio ${pkg.version.replaceAll('.', '\\.')}\\b`));
assert.match(read('CITATION.cff'), new RegExp(`version: "${pkg.version.replaceAll('.', '\\.')}"`));
assert.doesNotMatch(read('mcp/README.md'), /\/Users\//);
assert.match(read('mcp/motion-previs-mcp.mjs'), /serverInfo: \{ name: 'motion-previs-studio', version: APP_VERSION \}/);
assert.match(read('electron/main.cjs'), /'--ffmpeg-location'/);
assert.doesNotMatch(read('electron/main.cjs'), /Motion Previs Studio v3 (Control|Prompt|Blender)/);
assert.match(read('THIRD_PARTY_NOTICES.md'), /GPL-3\.0-or-later/);
for (const bundled of ['electron', 'react-dom', 'three', 'lucide-react', '@huggingface/transformers', '@mediapipe/tasks-vision']) {
  assert.ok(read('scripts/augment-release-sbom.cjs').includes(`'${bundled}'`), `${bundled} must be inventoried as bundled runtime`);
}

console.log('verify:metadata: OK');
