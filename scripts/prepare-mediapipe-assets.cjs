const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const root = path.resolve(__dirname, '..');
const wasmSrc = path.join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const wasmDest = path.join(root, 'public', 'mediapipe', 'wasm');
const modelDest = path.join(root, 'public', 'models', 'pose_landmarker_lite.task');
const modelUrl =
  'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task';
const binDir = path.join(root, 'public', 'bin');

function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    console.warn(`[assets] MediaPipe wasm folder not found yet: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  console.log(`[assets] copied MediaPipe wasm assets to ${dest}`);
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1000000) {
      console.log(`[assets] pose model already present at ${outPath}`);
      resolve();
      return;
    }

    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const file = fs.createWriteStream(outPath);
    https
      .get(url, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          fs.rmSync(outPath, { force: true });
          download(response.headers.location, outPath).then(resolve, reject);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.rmSync(outPath, { force: true });
          reject(new Error(`model download failed: ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log(`[assets] downloaded pose model to ${outPath}`);
          resolve();
        });
      })
      .on('error', (error) => {
        file.close();
        fs.rmSync(outPath, { force: true });
        reject(error);
      });
  });
}

async function main() {
  copyDir(wasmSrc, wasmDest);
  try {
    await download(modelUrl, modelDest);
  } catch (error) {
    console.warn(`[assets] ${error.message}`);
    console.warn('[assets] Pose detection will prompt for asset repair until the model is downloaded.');
  }
  try {
    await prepareYtDlp();
  } catch (error) {
    console.warn(`[assets] ${error.message}`);
    console.warn('[assets] URL import will require yt-dlp to be installed on PATH until the bundled binary is downloaded.');
  }
}

main();

async function prepareYtDlp() {
  const target = ytDlpTarget();
  const outPath = path.join(binDir, target.name);
  await download(target.url, outPath);
  if (process.platform !== 'win32') {
    fs.chmodSync(outPath, 0o755);
  }
}

function ytDlpTarget() {
  if (process.platform === 'darwin') {
    return {
      name: 'yt-dlp',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos'
    };
  }
  if (process.platform === 'win32') {
    return {
      name: 'yt-dlp.exe',
      url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    };
  }
  return {
    name: 'yt-dlp',
    url: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp'
  };
}
