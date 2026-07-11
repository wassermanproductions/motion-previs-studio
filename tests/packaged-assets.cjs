'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { _electron } = require('playwright');

async function main() {
  if (process.platform !== 'win32') {
    console.log('verify:packaged-assets: skipped (Windows package gate)');
    return;
  }
  const root = path.resolve(__dirname, '..');
  const unpacked = path.join(root, 'release', 'win-unpacked');
  const executable = fs.readdirSync(unpacked)
    .filter((name) => name.toLowerCase().endsWith('.exe'))
    .map((name) => path.join(unpacked, name))
    .find((candidate) => fs.statSync(candidate).isFile());
  assert.ok(executable, 'win-unpacked application executable is missing.');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mps-packaged-assets-'));
  const requested = [];
  let electronApp;
  try {
    electronApp = await _electron.launch({
      executablePath: executable,
      env: {
        ...process.env,
        MOTION_PREVIS_CONFIG_DIR: path.join(temp, 'control'),
        MOTION_PREVIS_USER_DATA_DIR: path.join(temp, 'user data')
      }
    });
    const page = await electronApp.firstWindow();
    page.on('request', (request) => {
      if (/mediapipe|pose_landmarker/i.test(request.url())) requested.push(request.url());
    });
    await page.waitForLoadState('domcontentloaded');
    const fetched = await page.evaluate(async () => {
      const read = async (relativePath) => {
        const url = new URL(relativePath, window.location.href).href;
        const response = await fetch(url);
        const bytes = (await response.arrayBuffer()).byteLength;
        return { url, status: response.status, contentType: response.headers.get('content-type'), bytes };
      };
      return {
        location: window.location.href,
        wasm: await read('mediapipe/wasm/vision_wasm_internal.wasm'),
        model: await read('models/pose_landmarker_lite.task')
      };
    });

    assert.match(fetched.location, /^mps:\/\/app\/index\.html/);
    assert.equal(fetched.wasm.status, 200);
    assert.equal(fetched.wasm.contentType, 'application/wasm');
    assert.ok(fetched.wasm.bytes > 1_000_000, 'packaged MediaPipe WASM response is unexpectedly small.');
    assert.equal(fetched.model.status, 200);
    assert.ok(fetched.model.bytes > 1_000_000, 'packaged pose task response is unexpectedly small.');
    assert.ok(requested.some((url) => url === fetched.wasm.url), 'WASM fetch did not traverse the packaged mps:// handler.');
    assert.ok(requested.some((url) => url === fetched.model.url), 'model fetch did not traverse the packaged mps:// handler.');
    console.log(JSON.stringify(fetched));
    console.log('verify:packaged-assets: OK');
  } finally {
    await electronApp?.close().catch(() => undefined);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
