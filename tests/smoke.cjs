const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const required = [
  'electron/main.cjs',
  'electron/preload.cjs',
  'electron/frameEncode.cjs',
  'electron/shutdown.cjs',
  'electron/processTree.cjs',
  'electron/config.cjs',
  'electron/portable.cjs',
  'electron/blockoutProtocol.cjs',
  'mcp/motion-previs-mcp.mjs',
  'mcp/descriptor.mjs',
  'ASSET_MANIFEST.json',
  'src/App.tsx',
  'src/lib/pose.ts',
  'src/lib/poseVideo.ts',
  'src/lib/openpose.ts',
  'src/lib/frameEncoder.ts',
  'src/lib/cameraMotion.ts',
  'src/components/ThreePreview.tsx',
  'public/models/pose_landmarker_lite.task',
  'public/mediapipe/wasm/vision_wasm_internal.wasm'
];

let failed = false;
for (const rel of required) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) {
    console.error(`[smoke] missing ${rel}`);
    failed = true;
  } else {
    console.log(`[smoke] ok ${rel}`);
  }
}

if (failed) {
  process.exit(1);
}
