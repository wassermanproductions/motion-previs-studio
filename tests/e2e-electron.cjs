const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { _electron } = require('playwright');
const configPaths = require('../electron/config.cjs');

const root = path.resolve(__dirname, '..');
const outputDir = path.join(root, 'output', 'playwright');
const e2eRoot = process.env.MPS_E2E_ROOT || path.join(os.tmpdir(), 'OneDrive - Studio', "Director's Cut", 'José');
const controlConfigDir = path.join(e2eRoot, 'control config');
const userDataDir = path.join(e2eRoot, 'Motion Previs User Data');
const blockoutConfigDir = path.join(e2eRoot, 'Blockout control');
const testHome = path.join(e2eRoot, 'home');
const testAppData = path.join(e2eRoot, 'AppData', 'Roaming');
const liveBlockoutConfigDir = process.platform === 'win32'
  ? path.join(testAppData, 'Blockout')
  : path.join(testHome, '.config', 'blockout');
const controlDiscoveryFile = configPaths.motionDiscoveryFile({ env: { MOTION_PREVIS_CONFIG_DIR: controlConfigDir } });
const samplePath = process.env.MPS_SAMPLE || path.join(e2eRoot, 'source clips', 'sample clip.mp4');
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
  fs.rmSync(e2eRoot, { recursive: true, force: true });
  if (!fs.existsSync(samplePath)) {
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    await generateSampleClip(samplePath);
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const blockoutMock = await startMockBlockout();

  const port = await findOpenPort(Number(process.env.MPS_E2E_PORT || 5173));
  const rendererUrl = `http://127.0.0.1:${port}`;
  const viteCli = path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js');
  const vite = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
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
      env: {
        ...process.env,
        ELECTRON_RENDERER_URL: rendererUrl,
        MOTION_PREVIS_CONFIG_DIR: controlConfigDir,
        MOTION_PREVIS_USER_DATA_DIR: userDataDir,
        BLOCKOUT_CONFIG_DIR: blockoutConfigDir,
        HOME: testHome,
        USERPROFILE: testHome,
        APPDATA: testAppData
      }
    });
    await waitForWindow(electronApp);
    await waitForRendererText(electronApp, 'Motion Previs Studio v4');
    await captureMainWindow(electronApp, path.join(outputDir, 'electron-idle.png'));

    // Agent-control server (MCP bridge backend) end-to-end over real HTTP.
    const controlSummary = await runControlChecks(blockoutMock);

    const forbiddenPath = path.join(e2eRoot, 'unregistered input', 'secret clip.mp4');
    fs.mkdirSync(path.dirname(forbiddenPath), { recursive: true });
    fs.copyFileSync(samplePath, forbiddenPath);
    let forbiddenPrepareError = '';
    try {
      await executeInRenderer(
        electronApp,
        `window.motionPrevis.prepareAnalysis(${JSON.stringify({
          sourcePath: forbiddenPath,
          start: 0,
          end: 1,
          sampleFps: 6
        })})`
      );
    } catch (error) {
      forbiddenPrepareError = error?.message || String(error);
    }
    if (!/outside the app workspace and imported sources/i.test(forbiddenPrepareError)) {
      throw new Error(`analysis:prepare did not reject an unregistered input path: ${forbiddenPrepareError}`);
    }

    // Register the main fixture through the same import IPC used by the UI;
    // analysis IPC must never grant itself access to an arbitrary path.
    await executeInRenderer(
      electronApp,
      `window.motionPrevis.importPath(${JSON.stringify(samplePath)})`
    );

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

    let forbiddenSaveError = '';
    try {
      await executeInRenderer(
        electronApp,
        `window.motionPrevis.savePoseArtifacts(${JSON.stringify({
          outputDir: analysis.outputDir,
          referencePath: analysis.referencePath,
          depthPath: forbiddenPath,
          poseData: { fps: 6, duration: 1, frames: [] }
        })})`
      );
    } catch (error) {
      forbiddenSaveError = error?.message || String(error);
    }
    if (!/outside the app workspace and imported sources/i.test(forbiddenSaveError)) {
      throw new Error(`analysis:save-pose-artifacts did not reject an unregistered input path: ${forbiddenSaveError}`);
    }

    const exportResult = await executeInRenderer(
      electronApp,
      `(async () => {
        const analysis = ${JSON.stringify(analysis)};
        const poseData = ${JSON.stringify(poseData)};
        const cameraMotionData = ${JSON.stringify(cameraMotionData)};
        const planningData = ${JSON.stringify(planningData)};
        const { createPoseVideoBlob } = await import('/src/lib/poseVideo.ts');
        const { renderOpenPoseFrames, buildOpenPoseJson } = await import('/src/lib/openpose.ts');
        const w = analysis.frameSize.width || 1280;
        const h = analysis.frameSize.height || 720;
        const blob = await createPoseVideoBlob(poseData, w, h);
        const poseVideoBuffer = await blob.arrayBuffer();
        // v4: OpenPose/BODY_25 skeleton video + per-frame keypoints JSON.
        const openPoseBlob = await renderOpenPoseFrames(poseData, w, h);
        const openPoseVideoBuffer = await openPoseBlob.arrayBuffer();
        const openPoseKeypoints = buildOpenPoseJson(poseData, w, h);
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
          poseVideoBuffer,
          openPoseVideoBuffer,
          openPoseKeypoints
        });
      })()`
    );

    await captureMainWindow(electronApp, path.join(outputDir, 'electron-after-pipeline.png'));
    const relinkSummary = await runRelinkCheck(electronApp, analysis.referencePath, blockoutMock);
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
      exportResult.files.openPosePose,
      exportResult.files.openPoseKeypoints,
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
    if (bundleManifest.schemaVersion !== 1) throw new Error('bundle_manifest.json schemaVersion must be 1.');
    for (const value of Object.values(bundleManifest.files || {}).filter(Boolean)) {
      if (path.isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || value.includes('\\')) {
        throw new Error(`bundle_manifest.json contains a non-portable path: ${value}`);
      }
    }
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

    // v4: the OpenPose skeleton mp4 and BODY_25 keypoints JSON must land in the
    // bundle by their canonical names.
    const openPoseMp4 = path.join(exportResult.outputDir, 'openpose_pose.mp4');
    const openPoseJson = path.join(exportResult.outputDir, 'openpose_keypoints.json');
    if (!fs.existsSync(openPoseMp4)) throw new Error('openpose_pose.mp4 is missing from the bundle.');
    if (!fs.existsSync(openPoseJson)) throw new Error('openpose_keypoints.json is missing from the bundle.');
    const openPoseKeypoints = JSON.parse(fs.readFileSync(openPoseJson, 'utf8'));
    if (!Array.isArray(openPoseKeypoints) || openPoseKeypoints.length !== poseData.frames.length) {
      throw new Error('openpose_keypoints.json frame count does not match the pose track.');
    }
    const firstWithPeople = openPoseKeypoints.find((frame) => frame.people && frame.people.length);
    if (firstWithPeople) {
      const flat = firstWithPeople.people[0].pose_keypoints_2d;
      if (!Array.isArray(flat) || flat.length !== 75) {
        throw new Error('OpenPose keypoints are not BODY_25 (expected 75 numbers per person).');
      }
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
          control: controlSummary,
          relink: relinkSummary,
          specialPathRoot: e2eRoot,
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
    await blockoutMock.close();
  }
}

// ---------------------------------------------------------------------------
// Agent-control server checks — exercises electron/control.cjs + the renderer
// control handler over real localhost HTTP, the same path the MCP bridge uses.
// ---------------------------------------------------------------------------
async function runControlChecks(blockoutMock) {
  const config = await readControlConfig();
  const base = `http://127.0.0.1:${config.port}`;

  // /health is unauthenticated.
  const health = await fetch(`${base}/health`);
  if (health.status !== 200) throw new Error(`control /health returned ${health.status}`);
  const healthBody = await health.json();
  if (!healthBody.ok || healthBody.app !== 'motion-previs-studio') {
    throw new Error('control /health payload is wrong.');
  }
  if (healthBody.protocolVersion !== 1 || config.protocolVersion !== 1) {
    throw new Error('control descriptor protocol v1 was not advertised.');
  }

  // Bad token must be rejected.
  const unauthorized = await fetch(`${base}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-the-token' },
    body: JSON.stringify({ action: 'get_state' })
  });
  if (unauthorized.status !== 401) throw new Error(`control /rpc bad token returned ${unauthorized.status}, expected 401`);

  const rpc = async (action, params) => {
    const res = await fetch(`${base}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` },
      body: JSON.stringify({ action, params: params || {} })
    });
    const json = await res.json();
    return { status: res.status, json };
  };

  // get_state before any media is loaded.
  const state0 = await rpc('get_state');
  if (state0.status !== 200 || !state0.json.ok) throw new Error('control get_state failed.');
  if (state0.json.data.app !== 'motion-previs-studio') throw new Error('control get_state app name wrong.');

  // Generate a tiny 2s clip so analysis is fast and self-contained.
  const clipPath = path.join(e2eRoot, 'control inputs', "Director's control clip.mp4");
  fs.mkdirSync(path.dirname(clipPath), { recursive: true });
  await generateSampleClip(clipPath);

  const imported = await rpc('import_file', { path: clipPath });
  if (!imported.json.ok) throw new Error(`control import_file failed: ${imported.json.error}`);
  if (!imported.json.data.name) throw new Error('control import_file returned no media name.');

  const urlImported = await withMediaServer(clipPath, async (url) => rpc('import_url', { url }));
  if (!urlImported.json.ok) throw new Error(`control import_url failed: ${urlImported.json.error}`);
  if (!urlImported.json.data.name) throw new Error('control import_url returned no media name.');

  const ranged = await rpc('set_range', { startS: 0, endS: 2 });
  if (!ranged.json.ok) throw new Error(`control set_range failed: ${ranged.json.error}`);

  const moded = await rpc('set_mode', { mode: 'camera_only' });
  if (!moded.json.ok || moded.json.data.referenceMode !== 'camera-only') {
    throw new Error('control set_mode failed.');
  }

  const setSettings = await rpc('set_settings', { sampleFps: 6, resolution: 'auto' });
  if (!setSettings.json.ok) throw new Error(`control set_settings failed: ${setSettings.json.error}`);

  const started = await rpc('run_analysis');
  if (!started.json.ok || started.json.data.started !== true) throw new Error('control run_analysis did not start.');

  // Poll get_state until analysis is done (or error).
  const deadline = Date.now() + 300000;
  let status = 'running';
  while (Date.now() < deadline) {
    const poll = await rpc('get_state');
    status = poll.json.data.analysis.status;
    if (status === 'done') break;
    if (status === 'error') throw new Error('control analysis reported error status.');
    await delay(1000);
  }
  if (status !== 'done') throw new Error('control analysis did not reach done in time.');

  const exported = await rpc('export_pack');
  if (!exported.json.ok) throw new Error(`control export_pack failed: ${exported.json.error}`);
  const bundlePath = exported.json.data.bundlePath;
  const zipPath = exported.json.data.zipPath;
  if (!bundlePath || !fs.existsSync(bundlePath)) throw new Error('control export_pack bundlePath missing on disk.');
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('control export_pack zipPath missing on disk.');
  for (const name of ['bundle_manifest.json', 'reference.mp4', 'pose_landmarks.json']) {
    if (!fs.existsSync(path.join(bundlePath, name))) throw new Error(`control bundle missing ${name}.`);
  }

  const listed = await rpc('list_bundle');
  if (!listed.json.ok || !Array.isArray(listed.json.data.files) || !listed.json.data.files.length) {
    throw new Error('control list_bundle returned no files.');
  }

  const handedOff = await rpc('send_to_blockout', { which: 'reference' });
  if (!handedOff.json.ok || handedOff.json.data.handoffVersion !== 1) {
    throw new Error(`control send_to_blockout did not use handoff v1: ${JSON.stringify(handedOff.json)}`);
  }
  if (blockoutMock.calls.at(-1)?.params?.handoffVersion !== 1) {
    throw new Error('Mock Blockout did not receive handoffVersion: 1.');
  }

  const shot = await rpc('screenshot');
  if (!shot.json.ok || typeof shot.json.data.imageBase64 !== 'string' || shot.json.data.imageBase64.length < 1000) {
    throw new Error('control screenshot did not return a PNG base64 string.');
  }

  return {
    port: config.port,
    health: healthBody,
    mediaName: imported.json.data.name,
    urlMediaName: urlImported.json.data.name,
    analysisStatus: status,
    bundlePath,
    bundleFileCount: listed.json.data.files.length,
    screenshotBytes: shot.json.data.imageBase64.length
  };
}

async function withMediaServer(filePath, callback) {
  const server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/clip.mp4')) {
      res.writeHead(404).end();
      return;
    }
    const stat = fs.statSync(filePath);
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Number(range[2]) : stat.size - 1;
    res.writeHead(range ? 206 : 200, {
      'Content-Type': 'video/mp4',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stat.size}` } : {})
    });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(filePath, { start, end }).pipe(res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  try {
    return await callback(`http://127.0.0.1:${address.port}/clip.mp4`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function runRelinkCheck(electronApp, handoffVideoPath, blockoutMock) {
  const missingPath = path.join(e2eRoot, 'moved away', 'missing source.mov');
  const saved = await executeInRenderer(
    electronApp,
    `window.motionPrevis.saveSession(${JSON.stringify({
      sourcePath: missingPath,
      sourceName: 'missing source.mov',
      range: { start: 0.25, end: 1.75 },
      sampleFps: 6,
      subjectMode: 'camera-only',
      resolution: 'auto'
    })})`
  );
  if (!saved.saved) throw new Error('Could not create missing-media relink fixture.');
  await electronApp.evaluate(({ dialog }, selectedPath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selectedPath] });
  }, samplePath);
  await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.reload());
  await waitForRendererText(electronApp, 'Relink Media');
  await executeInRenderer(
    electronApp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.includes('Relink Media'));
      if (!button) throw new Error('Relink Media button not found.');
      button.click();
      return true;
    })()`
  );
  await waitForRendererText(electronApp, path.basename(samplePath));
  const session = await executeInRenderer(electronApp, 'window.motionPrevis.loadSession()');
  if (session.sourcePath !== fs.realpathSync(samplePath) || session.sourceExists !== true) {
    throw new Error('Relink did not update the machine-local session source path.');
  }
  if (session.range?.start !== 0.25 || session.range?.end !== 1.75) {
    throw new Error('Relink did not preserve the saved shot range.');
  }
  const postRestart = await executeInRenderer(
    electronApp,
    `window.motionPrevis.sendToBlockout(${JSON.stringify({ videoPath: handoffVideoPath, mode: 'ghost', opacity: 0.5 })})`
  );
  if (!postRestart.ok || postRestart.handoffVersion !== 1 || blockoutMock.calls.at(-1)?.params?.handoffVersion !== 1) {
    throw new Error('Motion to Blockout handoff v1 failed after renderer restart.');
  }
  return { sourcePath: session.sourcePath, range: session.range, postRestartHandoffVersion: postRestart.handoffVersion };
}

async function startMockBlockout() {
  const token = '0123456789abcdef0123456789abcdef';
  const calls = [];
  const server = http.createServer((req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (req.method === 'GET' && req.url === '/health') {
      send(200, { ok: true, protocolVersion: 1, app: 'blockout', appVersion: '5.0.0' });
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      if (req.headers.authorization !== `Bearer ${token}`) {
        send(401, { ok: false, error: 'unauthorized' });
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        calls.push(parsed);
        send(200, { ok: true, data: { attached: true, handoffVersion: parsed.params?.handoffVersion || 0 } });
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  // Put a valid-but-stale descriptor in the highest-priority override and the
  // live descriptor in the normal platform location. Motion must probe past
  // the stale file instead of treating its mere presence as availability.
  fs.mkdirSync(blockoutConfigDir, { recursive: true });
  fs.writeFileSync(path.join(blockoutConfigDir, 'control.json'), JSON.stringify({
    protocolVersion: 1,
    app: 'blockout',
    appVersion: '4.9.9',
    port: 1,
    token: 'stale-token',
    pid: 999999,
    startedAt: '2000-01-01T00:00:00.000Z',
    capabilities: ['health', 'rpc']
  }));
  fs.mkdirSync(liveBlockoutConfigDir, { recursive: true });
  fs.writeFileSync(path.join(liveBlockoutConfigDir, 'control.json'), JSON.stringify({
    protocolVersion: 1,
    app: 'blockout',
    appVersion: '5.0.0',
    port: address.port,
    token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    capabilities: ['health', 'rpc', 'motion-handoff-v1']
  }));
  return {
    calls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

async function readControlConfig() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const config = JSON.parse(fs.readFileSync(controlDiscoveryFile, 'utf8'));
      if (config && config.port && config.token) return config;
    } catch {
      /* not written yet */
    }
    await delay(500);
  }
  throw new Error(`control discovery file never appeared at ${controlDiscoveryFile}`);
}

function generateSampleClip(outPath) {
  const preparedWindowsFfmpeg = path.join(root, 'runtime', 'media', 'win32-x64', 'ffmpeg.exe');
  const ffmpeg = process.env.MOTION_PREVIS_FFMPEG ||
    (process.platform === 'win32' && fs.existsSync(preparedWindowsFfmpeg) ? preparedWindowsFfmpeg : 'ffmpeg');
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-y',
        '-f', 'lavfi',
        '-i', 'testsrc=size=320x240:rate=15:duration=2',
        '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        outPath
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(outPath);
      else reject(new Error(`ffmpeg sample-clip generation exited ${code}\n${stderr}`));
    });
  });
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
