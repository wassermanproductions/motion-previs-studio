const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output', 'playwright');
const samplePath = process.env.MPS_SAMPLE || '/tmp/codex-previs-xrefs/josh-followup.mp4';
const planningData = {
  projectTitle: 'QA Motion Previs Project',
  sceneTitle: 'Scene QA',
  shotTitle: 'Shot QA-01',
  creativeIntent: 'Preserve camera movement and timing while replacing the original subject.',
  visualStyle: 'Cinematic previsualization with controlled depth and clean blocking.',
  subjectMode: 'camera-only',
  selectedLayers: ['depth', 'ai-depth', 'pose', 'camera', 'edges', 'lineart', 'masks', 'normals'],
  exportPresets: ['seedance', 'comfyui', 'blender', 'runway', 'kling'],
  analysisSettings: {
    poseModel: 'lite',
    depthModel: 'proxy',
    detectionConfidence: 0.3,
    trackingConfidence: 0.3,
    smoothing: 0.65,
    temporalWindow: 5,
    maxPeople: 1,
    fillGaps: true,
    optimizeForExport: true
  },
  shotBible: [
    {
      id: 'shot-qa-001',
      scene: 'Scene QA',
      shot: 'Shot QA-01',
      description: 'QA export verifies shot planning metadata survives the desktop bridge.',
      duration: 2.2,
      subjectMode: 'camera-only',
      cameraIntent: 'Use solved camera motion as the authority while replacing subject content.',
      selected: true
    }
  ],
  qualityReport: {
    score: 88,
    tracking: 'Good',
    camera: 'Good',
    layers: 'Excellent',
    readiness: 'Ready',
    notes: ['Automated QA fixture']
  }
};

async function main() {
  if (!fs.existsSync(samplePath)) {
    throw new Error(`Sample video missing. Set MPS_SAMPLE to a local MP4. Tried: ${samplePath}`);
  }
  fs.mkdirSync(outputDir, { recursive: true });

  const port = await findOpenPort(Number(process.env.MPS_E2E_PORT || 5173));
  const rendererUrl = `http://127.0.0.1:${port}`;
  const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  vite.stdout.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`));
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

  let electronApp;
  try {
    await waitForUrl(rendererUrl);
    electronApp = await _electron.launch({
      args: ['.'],
      cwd: root,
      env: { ...process.env, ELECTRON_RENDERER_URL: rendererUrl }
    });
    await waitForWindow(electronApp);
    await waitForRendererText(electronApp, 'Motion Previs Studio v3');
    await captureMainWindow(electronApp, path.join(outputDir, 'electron-idle.png'));

    const analysis = await executeInRenderer(
      electronApp,
      `window.motionPrevis.prepareAnalysis(${JSON.stringify({
        sourcePath: samplePath,
        start: 0,
        end: 2.2,
        sampleFps: 6
      })})`
    );

    const poseData = await executeInRenderer(
      electronApp,
      `(async () => {
        const { analyzePoseVideo } = await import('/src/lib/pose.ts');
        return analyzePoseVideo(${JSON.stringify(analysis.referenceUrl)}, 6, ${JSON.stringify(planningData.analysisSettings)});
      })()`
    );

    if (!poseData.frames.length) throw new Error('Pose analysis returned no frames.');
    if (typeof poseData.summary.rawDetectedFrames !== 'number' || !Array.isArray(poseData.summary.diagnostics)) {
      throw new Error('Pose analysis summary did not include hardened diagnostics.');
    }

    const cameraMotionData = await executeInRenderer(
      electronApp,
      `(async () => {
        const { analyzeCameraMotionVideo } = await import('/src/lib/cameraMotion.ts');
        return analyzeCameraMotionVideo(${JSON.stringify(analysis.referenceUrl)}, 6);
      })()`
    );

    if (!cameraMotionData.frames.length) throw new Error('Camera motion analysis returned no frames.');

    const exportResult = await executeInRenderer(
      electronApp,
      `(async () => {
        const analysis = ${JSON.stringify(analysis)};
        const poseData = ${JSON.stringify(poseData)};
        const cameraMotionData = ${JSON.stringify(cameraMotionData)};
        const planningData = ${JSON.stringify(planningData)};
        const { createPoseVideoBlob } = await import('/src/lib/poseVideo.ts');
        const blob = await createPoseVideoBlob(poseData, analysis.frameSize.width, analysis.frameSize.height);
        const poseVideoBuffer = await blob.arrayBuffer();
        return window.motionPrevis.savePoseArtifacts({
          outputDir: analysis.outputDir,
          referencePath: analysis.referencePath,
          depthPath: analysis.depthPath,
          edgesPath: analysis.edgesPath,
          lineartPath: analysis.lineartPath,
          motionMaskPath: analysis.motionMaskPath,
          normalsPath: analysis.normalsPath,
          contactSheetPath: analysis.contactSheetPath,
          animaticPath: analysis.animaticPath,
          sourceName: analysis.sourceName,
          range: analysis.range,
          sampleFps: analysis.sampleFps,
          poseData,
          cameraMotionData,
          planningData,
          poseVideoBuffer
        });
      })()`
    );

    await captureMainWindow(electronApp, path.join(outputDir, 'electron-after-pipeline.png'));
    await electronApp.close();
    electronApp = null;

    const required = [
      analysis.referencePath,
      analysis.depthPath,
      analysis.edgesPath,
      analysis.lineartPath,
      analysis.motionMaskPath,
      analysis.normalsPath,
      analysis.animaticPath,
      analysis.contactSheetPath,
      exportResult.files.poseJson,
      exportResult.files.cameraMotionJson,
      exportResult.files.blenderImportScript,
      exportResult.files.blenderCameraImportScript,
      exportResult.files.blenderSceneImportScript,
      exportResult.files.comfyuiManifest,
      exportResult.files.seedancePrompt,
      exportResult.files.promptPack,
      exportResult.files.shotBible,
      exportResult.files.qualityReport,
      exportResult.files.modelPresets,
      exportResult.files.controlLayersManifest,
      exportResult.files.edges,
      exportResult.files.lineart,
      exportResult.files.motionMask,
      exportResult.files.normalsProxy,
      exportResult.files.contactSheet,
      exportResult.files.animatic,
      exportResult.manifestPath,
      exportResult.zipPath
    ].filter(Boolean);
    for (const file of required) {
      if (!fs.existsSync(file)) throw new Error(`Expected export missing: ${file}`);
    }

    const bundleManifest = JSON.parse(fs.readFileSync(exportResult.manifestPath, 'utf8'));
    if (bundleManifest.planning?.subjectMode !== 'camera-only') {
      throw new Error('Planning data was not preserved in bundle_manifest.json.');
    }
    const qualityReport = JSON.parse(fs.readFileSync(exportResult.files.qualityReport, 'utf8'));
    if (qualityReport.readiness !== 'Ready') {
      throw new Error('Quality report did not preserve QA readiness.');
    }
    const controlLayers = JSON.parse(fs.readFileSync(exportResult.files.controlLayersManifest, 'utf8'));
    if (!controlLayers.selectedLayers.includes('camera') || !controlLayers.selectedLayers.includes('lineart')) {
      throw new Error('Control layer manifest is missing selected v3 layers.');
    }
    const seedancePrompt = fs.readFileSync(exportResult.files.seedancePrompt, 'utf8');
    if (!seedancePrompt.includes('Subject mode: camera-only') || !seedancePrompt.includes('Preserve only the camera move')) {
      throw new Error('Seedance prompt did not preserve camera-only subject guidance.');
    }

    console.log(
      JSON.stringify(
        {
          analysisId: analysis.analysisId,
          frameCount: poseData.frames.length,
          detectedFrames: poseData.summary.detectedFrames,
          averageScore: poseData.summary.averageScore,
          cameraFrames: cameraMotionData.frames.length,
          cameraConfidence: cameraMotionData.summary.averageConfidence,
          planningSubjectMode: bundleManifest.planning.subjectMode,
          selectedLayers: controlLayers.selectedLayers,
          outputDir: exportResult.outputDir,
          zipPath: exportResult.zipPath,
          screenshots: [
            path.join(outputDir, 'electron-idle.png'),
            path.join(outputDir, 'electron-after-pipeline.png')
          ]
        },
        null,
        2
      )
    );
  } finally {
    if (electronApp) {
      await electronApp.close().catch(() => undefined);
    }
    vite.kill('SIGTERM');
  }
}

async function waitForWindow(electronApp) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const count = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    if (count > 0) return;
    await delay(500);
  }
  throw new Error('Timed out waiting for Electron BrowserWindow.');
}

async function waitForRendererText(electronApp, text) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const hasText = await executeInRenderer(
      electronApp,
      `Boolean(document.body && document.body.innerText && document.body.innerText.includes(${JSON.stringify(text)}))`
    ).catch(() => false);
    if (hasText) return;
    await delay(500);
  }
  throw new Error(`Timed out waiting for renderer text: ${text}`);
}

async function executeInRenderer(electronApp, expression) {
  return electronApp.evaluate(async ({ BrowserWindow }, code) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('No Electron window is available.');
    return window.webContents.executeJavaScript(code, true);
  }, expression);
}

async function captureMainWindow(electronApp, outputPath) {
  const bytes = await electronApp.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('No Electron window is available for screenshot capture.');
    const image = await window.capturePage();
    return Array.from(image.toPNG());
  });
  fs.writeFileSync(outputPath, Buffer.from(bytes));
}

async function findOpenPort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    const available = await canListen(port);
    if (available) return port;
  }
  throw new Error(`No open localhost port found from ${startPort} to ${startPort + 49}.`);
}

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, '127.0.0.1');
  });
}

async function waitForUrl(url) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await delay(300);
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
