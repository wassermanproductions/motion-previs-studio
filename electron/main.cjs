const { app, BrowserWindow, dialog, ipcMain, shell, protocol, Menu } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const archiver = require('archiver');
const security = require('./security.cjs');
const validate = require('./validate.cjs');
const frameEncode = require('./frameEncode.cjs');
const control = require('./control.cjs');
const config = require('./config.cjs');
const portable = require('./portable.cjs');
const blockoutProtocol = require('./blockoutProtocol.cjs');
const shutdown = require('./shutdown.cjs');
const processTree = require('./processTree.cjs');
const quality = require('../shared/quality.cjs');
const pkg = require('../package.json');

const DISTRIBUTION = pkg.distribution || {};
const APP_NAME = DISTRIBUTION.displayName || pkg.build?.productName || pkg.productName || 'Motion Previs Studio v4';
const APP_VERSION = pkg.version;
const APP_ID = DISTRIBUTION.appId || pkg.build?.appId || 'studio.motionprevis.app.v4';

let mainWindow;
const activeProcesses = new Set();
let isShuttingDown = false;

if (process.env.MOTION_PREVIS_USER_DATA_DIR) {
  app.setPath('userData', path.resolve(process.env.MOTION_PREVIS_USER_DATA_DIR));
} else if (process.platform === 'win32' && DISTRIBUTION.userDataFolder) {
  app.setPath('userData', path.join(app.getPath('appData'), DISTRIBUTION.userDataFolder));
}
if (!process.env.MOTION_PREVIS_CONFIG_DIR && process.platform === 'win32' && DISTRIBUTION.configFolder) {
  process.env.MOTION_PREVIS_CONFIG_DIR = path.join(app.getPath('appData'), DISTRIBUTION.configFolder);
}

// Register the privileged mps:// scheme before app is ready.
security.registerPrivilegedScheme(protocol);

function appRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function rendererRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : appRoot();
}

function ffmpegPath() {
  if (process.env.MOTION_PREVIS_FFMPEG) return path.resolve(process.env.MOTION_PREVIS_FFMPEG);
  const bundled = mediaToolPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
  if (bundled) return bundled;
  return resolveCommandOnPath('ffmpeg') || 'ffmpeg';
}

function ffprobePath() {
  if (process.env.MOTION_PREVIS_FFPROBE) return path.resolve(process.env.MOTION_PREVIS_FFPROBE);
  const bundled = mediaToolPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  if (bundled) return bundled;
  return resolveCommandOnPath('ffprobe') || 'ffprobe';
}

function mediaToolPath(name) {
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, 'media', name)
    : path.join(appRoot(), 'runtime', 'media', `${process.platform}-${process.arch}`, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function resolveCommandOnPath(command) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const folder of String(process.env.PATH || '').split(path.delimiter)) {
    if (!folder) continue;
    for (const extension of extensions) {
      const candidate = path.join(folder, process.platform === 'win32' ? `${command}${extension}` : command);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        // Continue through PATH.
      }
    }
  }
  return null;
}

function ytDlpPath() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const resourceCandidate = path.join(process.resourcesPath || '', 'bin', exe);
  if (app.isPackaged && fs.existsSync(resourceCandidate)) return resourceCandidate;
  const developmentCandidate = path.join(appRoot(), 'runtime', 'bin', exe);
  if (fs.existsSync(developmentCandidate)) return developmentCandidate;
  return exe;
}

function workspaceRoot() {
  const dir = path.join(app.getPath('userData'), 'projects');
  fs.mkdirSync(dir, { recursive: true });
  // The workspace holds all app-generated media/exports; always loadable.
  security.allowRoot(dir);
  return dir;
}

function safeName(input) {
  return String(input || 'clip')
    .replace(/\.[^.]+$/, '')
    .replace(/[^a-z0-9-_]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .toLowerCase() || 'clip';
}

// Build an mps:// URL for an allowlisted file (replaces raw file:// URLs).
function fileUrl(filePath) {
  return security.toAppUrl(filePath);
}

async function openExternalUrl(url) {
  const parsed = new URL(String(url || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('External links must use http or https.');
  }
  await shell.openExternal(parsed.href);
}

function run(bin, args, options = {}) {
  if (isShuttingDown) return Promise.reject(new Error('Motion Previs Studio is shutting down.'));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || appRoot(),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const entry = {
      child,
      cancelled: false,
      closePromise: new Promise((resolve) => child.once('close', resolve))
    };
    activeProcesses.add(entry);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    const abort = () => {
      entry.cancelled = true;
      void processTree.terminateChildTree(child, entry.closePromise);
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    child.on('error', (error) => {
      activeProcesses.delete(entry);
      options.signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      activeProcesses.delete(entry);
      options.signal?.removeEventListener('abort', abort);
      if (entry.cancelled || options.signal?.aborted) {
        reject(abortError());
        return;
      }
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = `${path.basename(bin)} exited with ${code}\n${stderr || stdout}`;
        reject(new Error(message));
      }
    });
    if (options.signal?.aborted) abort();
  });
}

function abortError() {
  const error = new Error('Analysis cancelled.');
  error.name = 'AbortError';
  return error;
}

async function cancelActiveProcesses() {
  const entries = [...activeProcesses];
  for (const entry of entries) entry.cancelled = true;
  const results = await Promise.allSettled(
    entries.map((entry) => processTree.terminateChildTree(entry.child, entry.closePromise))
  );
  const timedOut = results.filter((result) => result.status === 'fulfilled' && !result.value).length;
  if (timedOut) console.warn(`[motion-previs] ${timedOut} child process tree(s) did not close before the cancellation deadline.`);
  return { cancelled: entries.length };
}

async function probe(filePath) {
  const { stdout } = await run(ffprobePath(), [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  const data = JSON.parse(stdout);
  const video = data.streams.find((stream) => stream.codec_type === 'video');
  const audio = data.streams.find((stream) => stream.codec_type === 'audio');
  const duration = Number(data.format?.duration || video?.duration || 0);
  const frameRate = parseFrameRate(video?.avg_frame_rate || video?.r_frame_rate);
  return {
    filePath,
    url: fileUrl(filePath),
    name: path.basename(filePath),
    duration,
    width: Number(video?.width || 0),
    height: Number(video?.height || 0),
    frameRate,
    videoCodec: video?.codec_name || 'unknown',
    audioCodec: audio?.codec_name || null,
    sizeBytes: Number(data.format?.size || 0)
  };
}

function parseFrameRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [num, den] = rate.split('/').map(Number);
  return den ? num / den : Number(rate);
}

async function openMediaFile() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Import source media',
    properties: ['openFile'],
    filters: [
      { name: 'Media', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'wav', 'mp3', 'm4a', 'aac'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePaths.length) return null;
  // User explicitly chose this file: record it so mps:// can serve it and
  // shell:open/reveal can target it.
  const canonical = security.allowImportSource(result.filePaths[0]);
  if (!canonical) throw new Error('The selected media path could not be resolved.');
  return probe(canonical);
}

// Import a specific media file by absolute path (agent-control entry point;
// mirrors openMediaFile but skips the dialog). The path is validated to exist
// and registered on the security allowlist so mps:// can serve it, exactly as a
// user-chosen file would be.
async function importMediaPath(sourcePath) {
  const clean = validate.requireString(sourcePath, 'path');
  const canonical = security.normalizeAbsolute(clean, { mustExist: true });
  if (!canonical) {
    throw new Error(`No file at "${clean}".`);
  }
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) {
    throw new Error(`Path "${clean}" is not a file.`);
  }
  security.allowImportSource(canonical);
  return probe(canonical);
}

async function importUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Please enter a valid http or https video URL.');
  }

  const dir = path.join(workspaceRoot(), 'imports', `${Date.now()}-${safeName(url)}`);
  fs.mkdirSync(dir, { recursive: true });
  security.allowRoot(dir);
  const outputTemplate = path.join(dir, '%(title).120B-%(id)s.%(ext)s');

  await run(ytDlpPath(), [
    '--ffmpeg-location',
    ffmpegPath(),
    '--output',
    outputTemplate,
    '--format',
    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--restrict-filenames',
    // Terminate option parsing so the URL can never be treated as a flag.
    '--',
    url
  ]);

  const candidates = fs
    .readdirSync(dir)
    .filter((file) => /\.(mp4|mov|mkv|webm|m4v)$/i.test(file))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);

  if (!candidates.length) {
    throw new Error('URL import completed but no video file was found.');
  }

  return probe(candidates[0]);
}

async function createPreviewFrame(input, outPath) {
  await run(ffmpegPath(), ['-y', '-ss', '0', '-i', input, '-frames:v', '1', '-q:v', '3', outPath]);
}

async function createControlVideo(inputPath, outPath, filter, fps) {
  await run(ffmpegPath(), [
    '-y',
    '-i',
    inputPath,
    '-vf',
    filter,
    '-r',
    String(fps),
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    outPath
  ]);
}

async function prepareAnalysis(payload) {
  const sourcePath = requireAllowedInputFile(payload.sourcePath, 'source media');

  const meta = await probe(sourcePath);
  if (!meta.width || !meta.height) {
    throw new Error('This source does not contain a video stream. Audio-only files can be attached for sync, but pose/depth analysis needs video.');
  }

  const resolution = validate.validateResolution(payload.resolution);
  const fps = clamp(Number(payload.sampleFps || 12), 4, 30);
  // A trustworthy duration if ffprobe reported one; otherwise fall back to a
  // modest window so the end clamp never blows out to a bogus +60s span.
  const hasDuration = Number.isFinite(meta.duration) && meta.duration > 0;
  const rawStart = Number(payload.start || 0);
  const start = clamp(rawStart, 0, hasDuration ? Math.max(meta.duration - 0.1, 0) : Math.max(rawStart, 0));
  const effectiveDuration = hasDuration ? meta.duration : start + 8;
  const requestedEnd = Number(
    payload.end !== undefined && payload.end !== null ? payload.end : Math.min(effectiveDuration, start + 8)
  );
  const end = clamp(requestedEnd, start + 0.1, effectiveDuration);
  const duration = end - start;
  const slug = safeName(meta.name);
  const analysisId = `${Date.now()}-${slug}`;
  const outDir = path.join(workspaceRoot(), 'analyses', analysisId);
  fs.mkdirSync(outDir, { recursive: true });

  const referencePath = path.join(outDir, 'reference.mp4');
  const depthPath = path.join(outDir, 'depth.mp4');
  const edgesPath = path.join(outDir, 'edges.mp4');
  const lineartPath = path.join(outDir, 'lineart.mp4');
  const motionMaskPath = path.join(outDir, 'motion_mask.mp4');
  const normalsPath = path.join(outDir, 'normals_proxy.mp4');
  const animaticPath = path.join(outDir, 'animatic.mp4');
  const contactSheetPath = path.join(outDir, 'contact_sheet.jpg');
  const previewPath = path.join(outDir, 'preview.jpg');
  const landscape = meta.width >= meta.height;
  // In 720p (Seedance) mode, scale so the SHORT edge is 720 with even dims;
  // otherwise keep the v3 'auto' long-edge behavior.
  const referenceScale = resolution === '720p'
    ? (landscape ? 'scale=-2:720' : 'scale=720:-2')
    : (landscape ? 'scale=1280:-2' : 'scale=-2:1280');
  const depthScale = resolution === '720p'
    ? (landscape ? 'scale=-2:720' : 'scale=720:-2')
    : (landscape ? 'scale=960:-2' : 'scale=-2:960');

  await run(ffmpegPath(), [
    '-y',
    '-ss',
    String(start),
    '-t',
    String(duration),
    '-i',
    sourcePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-vf',
    referenceScale,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '18',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    referencePath
  ]);

  // depth, edges, lineart, motion_mask are independent passes off reference.mp4.
  // normals depends on depth, so it runs after depth completes. Run the
  // independent passes through a small concurrency pool (3) to speed prep up
  // without flooding the CPU or interleaving logs unreadably.
  await runPool(
    3,
    [
      { label: 'depth', task: () => createControlVideo(referencePath, depthPath, `fps=${fps},${depthScale},format=gray,eq=contrast=1.45:brightness=0.03,boxblur=2:1`, fps) },
      { label: 'edges', task: () => createControlVideo(referencePath, edgesPath, `fps=${fps},${depthScale},edgedetect=low=0.08:high=0.28,format=gray,eq=contrast=1.35`, fps) },
      { label: 'lineart', task: () => createControlVideo(referencePath, lineartPath, `fps=${fps},${depthScale},format=gray,sobel,negate,eq=contrast=1.2`, fps) },
      { label: 'motion_mask', task: () => createControlVideo(referencePath, motionMaskPath, `fps=${fps},${depthScale},tblend=all_mode=difference,format=gray,eq=contrast=3.2:brightness=0.02,boxblur=1:1`, fps) }
    ]
  );
  // Depends on depth.mp4 produced above.
  await createControlVideo(depthPath, normalsPath, `fps=${fps},format=gray,sobel,eq=contrast=1.7`, fps);

  await run(ffmpegPath(), [
    '-y',
    '-i',
    referencePath,
    '-vf',
    'fps=1,scale=240:-2,tile=5x2',
    '-frames:v',
    '1',
    contactSheetPath
  ]);

  await run(ffmpegPath(), [
    '-y',
    '-i',
    referencePath,
    '-vf',
    'fps=2,scale=960:-2,setpts=1.4*PTS',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    animaticPath
  ]);

  await createPreviewFrame(referencePath, previewPath);
  const referenceMeta = await probe(referencePath);

  const manifest = {
    analysisId,
    createdAt: new Date().toISOString(),
    sourcePath,
    sourceName: meta.name,
    range: { start, end, duration },
    sampleFps: fps,
    outputDir: outDir,
    referencePath,
    referenceUrl: fileUrl(referencePath),
    depthPath,
    depthUrl: fileUrl(depthPath),
    edgesPath,
    edgesUrl: fileUrl(edgesPath),
    lineartPath,
    lineartUrl: fileUrl(lineartPath),
    motionMaskPath,
    motionMaskUrl: fileUrl(motionMaskPath),
    normalsPath,
    normalsUrl: fileUrl(normalsPath),
    animaticPath,
    animaticUrl: fileUrl(animaticPath),
    contactSheetPath,
    contactSheetUrl: fileUrl(contactSheetPath),
    previewPath,
    previewUrl: fileUrl(previewPath),
    frameSize: { width: referenceMeta.width, height: referenceMeta.height },
    status: 'prepared'
  };

  const persistedManifest = {
    schemaVersion: 1,
    analysisId,
    createdAt: manifest.createdAt,
    sourceName: meta.name,
    range: manifest.range,
    sampleFps: fps,
    outputDir: '.',
    frameSize: manifest.frameSize,
    status: manifest.status,
    files: {
      reference: 'reference.mp4',
      depth: 'depth.mp4',
      edges: 'edges.mp4',
      lineart: 'lineart.mp4',
      motionMask: 'motion_mask.mp4',
      normals: 'normals_proxy.mp4',
      animatic: 'animatic.mp4',
      contactSheet: 'contact_sheet.jpg',
      preview: 'preview.jpg'
    }
  };
  fs.writeFileSync(path.join(outDir, 'analysis_manifest.json'), JSON.stringify(persistedManifest, null, 2));
  return manifest;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Run labeled async jobs with a bounded concurrency. Logs one clean line per
 * job start/finish so parallel ffmpeg passes stay readable. Rejects on the
 * first job error (after in-flight jobs settle).
 */
async function runPool(concurrency, jobs) {
  const limit = Math.max(1, Math.min(concurrency, jobs.length || 1));
  let index = 0;
  let firstError = null;

  async function worker() {
    while (index < jobs.length && !firstError) {
      const current = index++;
      const { label, task } = jobs[current];
      const started = Date.now();
      console.log(`[control-layer] start ${label}`);
      try {
        await task();
        console.log(`[control-layer] done  ${label} (${Date.now() - started}ms)`);
      } catch (error) {
        if (!firstError) firstError = error;
        console.warn(`[control-layer] fail  ${label}: ${error.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  if (firstError) throw firstError;
}

async function savePoseArtifacts(payload) {
  const analysisDir = security.canonicalAllowedDirectory(payload.outputDir);
  if (!analysisDir) {
    throw new Error('Analysis output folder is outside the app workspace.');
  }
  // Canonicalize every renderer-supplied input before any output is written.
  // This prevents a compromised renderer from making ffmpeg read an arbitrary
  // local file while still allowing the app-managed analysis assets.
  payload = {
    ...payload,
    outputDir: analysisDir,
    referencePath: requireAllowedInputFile(payload.referencePath, 'reference video'),
    depthPath: requireAllowedInputFile(payload.depthPath, 'depth video'),
    edgesPath: optionalAllowedInputFile(payload.edgesPath, 'edge video'),
    lineartPath: optionalAllowedInputFile(payload.lineartPath, 'line-art video'),
    motionMaskPath: optionalAllowedInputFile(payload.motionMaskPath, 'motion-mask video'),
    normalsPath: optionalAllowedInputFile(payload.normalsPath, 'normals video'),
    contactSheetPath: optionalAllowedInputFile(payload.contactSheetPath, 'contact sheet'),
    animaticPath: optionalAllowedInputFile(payload.animaticPath, 'animatic video')
  };
  // resolution is validated upstream; retained for parity with the prepare step.
  const resolution = validate.validateResolution(payload.resolution);
  void resolution;

  const poseJsonPath = path.join(analysisDir, 'pose_landmarks.json');
  const cameraMotionJsonPath = path.join(analysisDir, 'camera_motion.json');
  const poseWebmPath = path.join(analysisDir, 'pose_high_contrast.webm');
  const poseMp4Path = path.join(analysisDir, 'pose_high_contrast.mp4');
  const openPoseMp4Path = path.join(analysisDir, 'openpose_pose.mp4');
  const openPoseWebmPath = path.join(analysisDir, 'openpose_pose.webm');
  const openPoseKeypointsPath = path.join(analysisDir, 'openpose_keypoints.json');
  const aiDepthWebmPath = path.join(analysisDir, 'ai_depth.webm');
  const aiDepthMp4Path = path.join(analysisDir, 'ai_depth.mp4');
  const combinedPath = path.join(analysisDir, 'combined_reference_depth_pose.mp4');
  const blenderScriptPath = path.join(analysisDir, 'blender_import_pose.py');
  const blenderCameraScriptPath = path.join(analysisDir, 'blender_import_camera.py');
  const blenderSceneScriptPath = path.join(analysisDir, 'blender_import_scene.py');
  const comfyPath = path.join(analysisDir, 'comfyui_manifest.json');
  const seedancePath = path.join(analysisDir, 'seedance_prompt.md');
  const promptPackPath = path.join(analysisDir, 'prompt_pack.md');
  const shotBiblePath = path.join(analysisDir, 'shot_bible.json');
  const qualityReportPath = path.join(analysisDir, 'quality_report.json');
  const modelPresetsPath = path.join(analysisDir, 'model_presets.json');
  const controlLayersPath = path.join(analysisDir, 'control_layers_manifest.json');
  const manifestPath = path.join(analysisDir, 'bundle_manifest.json');
  const zipPath = `${analysisDir}.zip`;

  fs.writeFileSync(poseJsonPath, JSON.stringify(payload.poseData, null, 2));
  if (payload.cameraMotionData) {
    fs.writeFileSync(cameraMotionJsonPath, JSON.stringify(payload.cameraMotionData, null, 2));
  }
  fs.writeFileSync(blenderScriptPath, blenderImportScript());
  fs.writeFileSync(blenderCameraScriptPath, blenderCameraImportScript());
  fs.writeFileSync(blenderSceneScriptPath, blenderSceneImportScript());
  fs.writeFileSync(comfyPath, JSON.stringify(comfyManifest(payload), null, 2));
  fs.writeFileSync(seedancePath, seedancePrompt(payload));
  fs.writeFileSync(promptPackPath, promptPack(payload));
  fs.writeFileSync(shotBiblePath, JSON.stringify(payload.planningData?.shotBible || defaultShotBible(payload), null, 2));
  fs.writeFileSync(qualityReportPath, JSON.stringify(payload.planningData?.qualityReport || defaultQualityReport(payload), null, 2));
  fs.writeFileSync(modelPresetsPath, JSON.stringify(modelPresets(payload), null, 2));
  fs.writeFileSync(controlLayersPath, JSON.stringify(controlLayerManifest(payload), null, 2));

  // The v4 deterministic encoder (electron/frameEncode.cjs) already returns an
  // H.264 mp4; the legacy MediaRecorder path returned a WebM that needed a
  // transcode. Detect which we got and write/transcode accordingly so both the
  // new renderer and any old caller keep producing pose_high_contrast.mp4.
  if (payload.poseVideoBuffer) {
    await writeVideoArtifact(Buffer.from(payload.poseVideoBuffer), poseMp4Path, poseWebmPath);
  }

  if (payload.aiDepthVideoBuffer) {
    await writeVideoArtifact(Buffer.from(payload.aiDepthVideoBuffer), aiDepthMp4Path, aiDepthWebmPath);
  }

  // v4: optional OpenPose/BODY_25 render produced by the same deterministic
  // encoder, plus the per-frame OpenPose keypoints JSON.
  if (payload.openPoseVideoBuffer) {
    await writeVideoArtifact(Buffer.from(payload.openPoseVideoBuffer), openPoseMp4Path, openPoseWebmPath);
  }
  if (payload.openPoseKeypoints) {
    fs.writeFileSync(openPoseKeypointsPath, JSON.stringify(payload.openPoseKeypoints, null, 2));
  }

  const depthForCombined = fs.existsSync(aiDepthMp4Path) ? aiDepthMp4Path : payload.depthPath;

  if (fs.existsSync(payload.referencePath) && fs.existsSync(depthForCombined) && fs.existsSync(poseMp4Path)) {
    try {
      await run(ffmpegPath(), [
        '-y',
        '-i',
        payload.referencePath,
        '-i',
        depthForCombined,
        '-i',
        poseMp4Path,
        '-filter_complex',
        `[0:v]scale=640:-2,setpts=PTS-STARTPTS[a];[1:v]scale=640:-2,setpts=PTS-STARTPTS[b];[2:v]scale=640:-2,setpts=PTS-STARTPTS[c];[a][b][c]hstack=inputs=3,fps=${payload.poseData?.fps || payload.sampleFps || 12}[v]`,
        '-map',
        '[v]',
        '-t',
        String(payload.poseData?.duration || payload.range?.duration || 30),
        '-r',
        String(payload.poseData?.fps || payload.sampleFps || 12),
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        combinedPath
      ]);
    } catch (error) {
      console.warn(error.message);
    }
  }

  const files = {
    reference: payload.referencePath,
    depth: payload.depthPath,
    aiDepthWebm: fs.existsSync(aiDepthWebmPath) ? aiDepthWebmPath : null,
    aiDepthMp4: fs.existsSync(aiDepthMp4Path) ? aiDepthMp4Path : null,
    edges: payload.edgesPath || findSibling(analysisDir, 'edges.mp4'),
    lineart: payload.lineartPath || findSibling(analysisDir, 'lineart.mp4'),
    motionMask: payload.motionMaskPath || findSibling(analysisDir, 'motion_mask.mp4'),
    normalsProxy: payload.normalsPath || findSibling(analysisDir, 'normals_proxy.mp4'),
    contactSheet: payload.contactSheetPath || findSibling(analysisDir, 'contact_sheet.jpg'),
    animatic: payload.animaticPath || findSibling(analysisDir, 'animatic.mp4'),
    poseJson: poseJsonPath,
    cameraMotionJson: fs.existsSync(cameraMotionJsonPath) ? cameraMotionJsonPath : null,
    poseWebm: fs.existsSync(poseWebmPath) ? poseWebmPath : null,
    poseMp4: fs.existsSync(poseMp4Path) ? poseMp4Path : null,
    openPosePose: fs.existsSync(openPoseMp4Path) ? openPoseMp4Path : null,
    openPoseKeypoints: fs.existsSync(openPoseKeypointsPath) ? openPoseKeypointsPath : null,
    combined: fs.existsSync(combinedPath) ? combinedPath : null,
    blenderImportScript: blenderScriptPath,
    blenderCameraImportScript: blenderCameraScriptPath,
    blenderSceneImportScript: blenderSceneScriptPath,
    comfyuiManifest: comfyPath,
    seedancePrompt: seedancePath,
    promptPack: promptPackPath,
    shotBible: shotBiblePath,
    qualityReport: qualityReportPath,
    modelPresets: modelPresetsPath,
    controlLayersManifest: controlLayersPath
  };

  const manifest = {
    schemaVersion: 1,
    app: APP_NAME,
    version: APP_VERSION,
    createdAt: new Date().toISOString(),
    sourceName: payload.sourceName,
    range: payload.range,
    sampleFps: payload.poseData?.fps || payload.sampleFps,
    frameCount: payload.poseData?.frames?.length || 0,
    cameraMoveFrames: payload.cameraMotionData?.frames?.length || 0,
    analysisSettings: payload.poseData?.summary?.settings || payload.planningData?.analysisSettings || null,
    poseDiagnostics: payload.poseData?.summary?.diagnostics || [],
    planning: payload.planningData || null,
    files: portable.portableBundleFiles(analysisDir, files)
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  await zipDirectory(analysisDir, zipPath);
  return {
    outputDir: analysisDir,
    zipPath,
    manifestPath,
    files,
    zipUrl: fileUrl(zipPath)
  };
}

function findSibling(folder, name) {
  const filePath = path.join(folder, name);
  return fs.existsSync(filePath) ? filePath : null;
}

function requireAllowedInputFile(filePath, label) {
  const canonical = security.canonicalAllowedFile(filePath);
  if (!canonical) {
    throw new Error(`${label} is missing or outside the app workspace and imported sources.`);
  }
  return canonical;
}

function optionalAllowedInputFile(filePath, label) {
  return filePath === undefined || filePath === null
    ? undefined
    : requireAllowedInputFile(filePath, label);
}

/**
 * Write an encoded video artifact to `mp4Path`. If `buffer` already holds an
 * mp4 (the v4 deterministic encoder), write it straight through. Otherwise it
 * is a legacy WebM: persist it at `webmPath` and transcode to mp4.
 */
async function writeVideoArtifact(buffer, mp4Path, webmPath) {
  if (isMp4Buffer(buffer)) {
    fs.writeFileSync(mp4Path, buffer);
    return;
  }
  fs.writeFileSync(webmPath, buffer);
  try {
    await run(ffmpegPath(), ['-y', '-i', webmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', mp4Path]);
  } catch (error) {
    console.warn(error.message);
  }
}

// mp4/ISO-BMFF files start with a size box then the 'ftyp' brand at bytes 4-7.
function isMp4Buffer(buffer) {
  return buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
}

function zipDirectory(sourceDir, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

function comfyManifest(payload) {
  return {
    name: `Motion Previs Studio v${APP_VERSION} Control Reference Bundle`,
    source: payload.sourceName,
    range: payload.range,
    recommendedInputs: [
      { role: 'reference_video', file: 'reference.mp4' },
      { role: 'depth_control', file: 'ai_depth.mp4', note: 'Use when present for AI monocular depth conditioning.' },
      { role: 'fast_depth_proxy', file: 'depth.mp4', note: 'Always present fast local proxy depth pass.' },
      { role: 'pose_control', file: 'pose_high_contrast.mp4', note: 'Use with OpenPose/DWPose-style control workflows.' },
      { role: 'camera_move', file: 'camera_motion.json', note: 'Use to recreate shot camera pan, tilt, zoom, and roll without preserving the subject.' },
      { role: 'edge_control', file: 'edges.mp4', note: 'Use for composition, silhouettes, and line fidelity.' },
      { role: 'lineart_control', file: 'lineart.mp4', note: 'Use for strong graphic line guidance.' },
      { role: 'mask_motion_proxy', file: 'motion_mask.mp4', note: 'Use as a motion/foreground proxy mask.' },
      { role: 'normals_proxy', file: 'normals_proxy.mp4', note: 'Use as a depth-gradient normals proxy.' },
      { role: 'combined_review', file: 'combined_reference_depth_pose.mp4' }
    ],
    comfyuiNotes: [
      'Load reference.mp4, ai_depth.mp4 or depth.mp4, and pose_high_contrast.mp4 as separate conditioning sources when possible.',
      'If a workflow only accepts one control movie, start with ai_depth.mp4 when present, otherwise depth.mp4, then test pose_high_contrast.mp4.',
      'pose_landmarks.json preserves MediaPipe landmark coordinates for custom nodes or retiming.',
      'camera_motion.json contains global camera move keyframes for subject-independent camera recreation.',
      'edges.mp4, lineart.mp4, motion_mask.mp4, and normals_proxy.mp4 provide extra control-layer options for precision workflows.'
    ]
  };
}

function seedancePrompt(payload) {
  const planning = payload.planningData || {};
  const subjectMode = planning.subjectMode || 'full-scene';
  const poseInstruction =
    subjectMode === 'camera-only'
      ? '- `pose_high_contrast.mp4` only if you decide to reintroduce body-motion guidance; keep it optional for camera-only remixes.'
      : '- `pose_high_contrast.mp4` as the human/object motion control input.';

  return [
    '# Seedance / AI Video Reference Notes',
    '',
    `Source: ${payload.sourceName || 'Imported clip'}`,
    `Shot range: ${payload.range?.start?.toFixed?.(2) || 0}s to ${payload.range?.end?.toFixed?.(2) || ''}s`,
    `Subject mode: ${subjectMode}`,
    '',
    'Use the attached reference assets according to the selected subject mode.',
    subjectModeInstruction(subjectMode),
    '',
    'Suggested inputs:',
    '- `reference.mp4` for composition, staging, timing, and camera feel.',
    '- `ai_depth.mp4` as the primary AI monocular depth control input when present.',
    '- `depth.mp4` as the fast local proxy depth control input.',
    poseInstruction,
    '- `camera_motion.json` to recreate the camera pan, tilt, zoom, and roll without reusing the original character, car, or object motion.',
    '- `edges.mp4`, `lineart.mp4`, `motion_mask.mp4`, and `normals_proxy.mp4` as optional precision control layers.',
    '- `blender_import_camera.py` to build an animated Blender camera from the solved camera move.',
    '- `blender_import_scene.py` to assemble a Blender scene with camera, pose, and reference plates.',
    '- `combined_reference_depth_pose.mp4` for a quick visual review plate.',
    '',
    'Prompt starter:',
    'Create a new shot that follows the same camera move, depth rhythm, and timing as the reference. Do not copy the original subject or objects unless requested; use the camera_motion.json / camera reference to preserve the movement of the camera independently from the scene content.'
  ].join(os.EOL);
}

function promptPack(payload) {
  const planning = payload.planningData || {};
  const quality = planning.qualityReport || defaultQualityReport(payload);
  const subjectMode = planning.subjectMode || 'full-scene';
  const scene = planning.sceneTitle || 'Scene';
  const shot = planning.shotTitle || 'Shot';
  const intent = planning.creativeIntent || 'Preserve the reference timing, camera language, and shot rhythm while replacing the creative subject and world.';
  const style = planning.visualStyle || 'Professional cinematic AI-film shot with controlled camera blocking and coherent previsualization.';

  return [
    `# Motion Previs Studio v${APP_VERSION} Prompt Pack`,
    '',
    `Project: ${planning.projectTitle || 'Motion Previs Project'}`,
    `Scene: ${scene}`,
    `Shot: ${shot}`,
    `Subject mode: ${subjectMode}`,
    `Quality score: ${quality.score}/100 (${quality.readiness})`,
    '',
    '## Creative Intent',
    intent,
    '',
    '## Visual Style',
    style,
    '',
    '## Universal Camera Instruction',
    'Use the supplied camera_motion.json and reference timing to preserve camera movement, lens rhythm, pan/tilt/zoom, and shot duration. Do not copy the original subject unless the subject mode explicitly asks for it.',
    '',
    '## Subject Handling',
    subjectModeInstruction(subjectMode),
    '',
    '## Seedance',
    'Use reference.mp4 for timing, ai_depth.mp4 or depth.mp4 for depth structure, pose_high_contrast.mp4 only when subject motion should be retained, and camera_motion.json as the camera-move authority.',
    '',
    '## ComfyUI',
    'Load separate control inputs where possible: depth/ai_depth, pose, edges, lineart, motion_mask, and camera_motion.json. Disable pose when using Camera only mode.',
    '',
    '## Runway / Kling',
    'Use the reference clip for camera/timing, but phrase the prompt around new subjects and environments. Use camera-only wording when replacing the source subject.',
    '',
    '## Negative Guidance',
    'Do not drift from the camera move. Do not inherit unwanted faces, wardrobe, props, cars, or background objects unless requested. Avoid inconsistent lens changes, sudden perspective jumps, and unmotivated speed ramps.'
  ].join(os.EOL);
}

function subjectModeInstruction(subjectMode) {
  switch (subjectMode) {
    case 'camera-only':
      return 'Preserve only the camera move and timing. Replace the character, car, object, and environment freely.';
    case 'actor-motion':
      return 'Preserve the actor body motion and camera movement. Replace identity, wardrobe, styling, and environment.';
    case 'object-motion':
      return 'Preserve the motion path of the main object or vehicle plus camera movement. Replace design, surface, and world.';
    default:
      return 'Preserve camera, blocking, subject motion, and depth rhythm as a full-scene reference.';
  }
}

function defaultShotBible(payload) {
  return [
    {
      id: 'shot-001',
      scene: payload.planningData?.sceneTitle || 'Scene 01',
      shot: payload.planningData?.shotTitle || 'Shot 01A',
      description: payload.planningData?.creativeIntent || 'Reference-derived AI-film previs shot.',
      duration: payload.range?.duration || payload.poseData?.duration || 0,
      subjectMode: payload.planningData?.subjectMode || 'full-scene',
      cameraIntent: 'Camera move extracted from reference shot.',
      selected: true
    }
  ];
}

// Single source of truth for the score: shared/quality.cjs. This fallback is
// only used when the renderer does not supply planningData.qualityReport.
function defaultQualityReport(payload) {
  const rawDetected = payload.poseData?.summary?.rawDetectedFrames ?? payload.poseData?.summary?.detectedFrames ?? 0;
  const filled = payload.poseData?.summary?.filledFrames || 0;
  const total = payload.poseData?.frames?.length || 0;
  const tracking = quality.trackingScore(rawDetected, filled, total);
  const camera = payload.cameraMotionData?.summary?.averageConfidence || 0;
  const selectedLayers = payload.planningData?.selectedLayers;
  const layerCount = Array.isArray(selectedLayers)
    ? selectedLayers.length
    : quality.LAYER_TARGET_COUNT; // assume full set of layers were generated
  const layers = quality.layerScore(layerCount);
  const cameraActive = Boolean(payload.cameraMotionData);
  return quality.computeQualityReport({
    tracking,
    camera,
    layers,
    cameraActive,
    rawDetectedFrames: rawDetected,
    totalFrames: total,
    filledFrames: filled
  });
}

function modelPresets(payload) {
  const selected = payload.planningData?.exportPresets || ['seedance', 'comfyui', 'blender'];
  return {
    selected,
    analysisSettings: payload.poseData?.summary?.settings || payload.planningData?.analysisSettings || null,
    poseDiagnostics: payload.poseData?.summary?.diagnostics || [],
    presets: {
      seedance: {
        primaryInputs: ['reference.mp4', 'ai_depth.mp4', 'depth.mp4', 'pose_high_contrast.mp4', 'camera_motion.json'],
        guidance: 'Use separate depth and pose controls when available. Use camera-only prompt language when replacing subjects.'
      },
      comfyui: {
        primaryInputs: ['depth.mp4', 'edges.mp4', 'lineart.mp4', 'motion_mask.mp4', 'pose_high_contrast.mp4'],
        guidance: 'Wire control videos as separate conditioning branches. Start with depth + camera, then add pose only if needed.'
      },
      blender: {
        primaryInputs: ['blender_import_scene.py', 'blender_import_camera.py', 'blender_import_pose.py'],
        guidance: 'Run blender_import_scene.py from Blender Text Editor or Python console with the bundle folder as the script location.'
      },
      runway: {
        primaryInputs: ['reference.mp4', 'prompt_pack.md', 'camera_motion.json'],
        guidance: 'Use the prompt pack language to preserve camera while replacing subject and world.'
      },
      kling: {
        primaryInputs: ['reference.mp4', 'depth.mp4', 'prompt_pack.md'],
        guidance: 'Use reference video for timing and depth/video controls for structure when available.'
      }
    }
  };
}

function controlLayerManifest(payload) {
  const planning = payload.planningData || {};
  return {
    selectedLayers: planning.selectedLayers || ['depth', 'pose', 'camera', 'edges', 'masks'],
    layers: [
      { key: 'depth', file: 'depth.mp4', purpose: 'Fast structural/depth proxy.' },
      { key: 'ai-depth', file: 'ai_depth.mp4', purpose: 'Optional AI monocular depth pass.' },
      { key: 'pose', file: 'pose_high_contrast.mp4', purpose: 'Human pose and motion control.' },
      { key: 'camera', file: 'camera_motion.json', purpose: 'Subject-independent camera move.' },
      { key: 'edges', file: 'edges.mp4', purpose: 'Composition and silhouette edges.' },
      { key: 'lineart', file: 'lineart.mp4', purpose: 'High-contrast line control.' },
      { key: 'masks', file: 'motion_mask.mp4', purpose: 'Motion/foreground proxy mask (frame-difference).' },
      { key: 'normals', file: 'normals_proxy.mp4', purpose: 'Depth-gradient normals proxy.' }
    ]
  };
}

function blenderCameraImportScript() {
  return String.raw`import json
import math
import os
import bpy

def load_camera_motion():
    folder = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(folder, "camera_motion.json"), "r", encoding="utf-8") as f:
        return json.load(f)

def main():
    data = load_camera_motion()
    frames = data.get("frames", [])
    fps = int(data.get("fps", 12))

    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = max(1, len(frames))
    bpy.context.scene.render.fps = fps

    camera_data = bpy.data.cameras.new("Motion Previs Solved Camera")
    camera = bpy.data.objects.new("Motion Previs Solved Camera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera

    camera.location = (0, -6, 1.6)
    camera.rotation_euler = (math.radians(78), 0, 0)
    camera_data.lens = 35

    for index, item in enumerate(frames, start=1):
        move = item.get("cameraMove", {})
        pan = float(move.get("pan", 0.0))
        tilt = float(move.get("tilt", 0.0))
        zoom = max(0.2, float(move.get("dollyZoom", 1.0)))
        roll = float(move.get("roll", 0.0))

        bpy.context.scene.frame_set(index)
        camera.location.x = pan * 3.5
        camera.location.z = 1.6 + tilt * 2.2
        camera.location.y = -6 / zoom
        camera.rotation_euler = (math.radians(78) + tilt * 0.22, pan * 0.18, roll)
        camera_data.lens = 35 * zoom
        camera.keyframe_insert(data_path="location", frame=index)
        camera.keyframe_insert(data_path="rotation_euler", frame=index)
        camera_data.keyframe_insert(data_path="lens", frame=index)

    if camera.animation_data and camera.animation_data.action:
        for fcurve in camera.animation_data.action.fcurves:
            for keyframe in fcurve.keyframe_points:
                keyframe.interpolation = "BEZIER"

    if camera_data.animation_data and camera_data.animation_data.action:
        for fcurve in camera_data.animation_data.action.fcurves:
            for keyframe in fcurve.keyframe_points:
                keyframe.interpolation = "BEZIER"

    print(f"Imported {len(frames)} camera move frames from Motion Previs Studio v${APP_VERSION}.")

if __name__ == "__main__":
    main()
`;
}

function blenderSceneImportScript() {
  return String.raw`import json
import math
import os
import runpy
import bpy

FOLDER = os.path.dirname(os.path.abspath(__file__))

def run_if_exists(name):
    path = os.path.join(FOLDER, name)
    if os.path.exists(path):
        runpy.run_path(path, run_name="__main__")

def make_movie_plane(name, movie_file, location, scale=(3.2, 1.8, 1.0)):
    path = os.path.join(FOLDER, movie_file)
    if not os.path.exists(path):
        return None
    bpy.ops.mesh.primitive_plane_add(size=1, location=location, rotation=(math.radians(90), 0, 0))
    plane = bpy.context.object
    plane.name = name
    plane.scale = scale
    material = bpy.data.materials.new(name + " Material")
    material.use_nodes = True
    image = bpy.data.images.load(path)
    image.source = "MOVIE"
    nodes = material.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    tex = nodes.new("ShaderNodeTexImage")
    tex.image = image
    material.node_tree.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])
    plane.data.materials.append(material)
    return plane

def main():
    run_if_exists("blender_import_camera.py")
    run_if_exists("blender_import_pose.py")
    make_movie_plane("Reference Plate", "reference.mp4", (0, 1.8, 1.0), (3.2, 1.8, 1.0))
    make_movie_plane("Depth Plate", "depth.mp4", (-3.5, 2.0, 1.0), (1.25, 1.25, 1.0))
    make_movie_plane("Edges Plate", "edges.mp4", (3.5, 2.0, 1.0), (1.25, 1.25, 1.0))
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(FOLDER, "motion_previs_scene.blend"))
    print("Built Motion Previs Studio v${APP_VERSION} Blender scene with camera, pose, and reference plates.")

if __name__ == "__main__":
    main()
`;
}

function blenderImportScript() {
  return String.raw`import json
import math
import os
import bpy

LANDMARK_NAMES = [
    "nose", "left_eye_inner", "left_eye", "left_eye_outer", "right_eye_inner", "right_eye",
    "right_eye_outer", "left_ear", "right_ear", "mouth_left", "mouth_right", "left_shoulder",
    "right_shoulder", "left_elbow", "right_elbow", "left_wrist", "right_wrist", "left_pinky",
    "right_pinky", "left_index", "right_index", "left_thumb", "right_thumb", "left_hip",
    "right_hip", "left_knee", "right_knee", "left_ankle", "right_ankle", "left_heel",
    "right_heel", "left_foot_index", "right_foot_index"
]

def load_pose():
    folder = os.path.dirname(os.path.abspath(__file__))
    with open(os.path.join(folder, "pose_landmarks.json"), "r", encoding="utf-8") as f:
        return json.load(f)

def clear_collection(name):
    existing = bpy.data.collections.get(name)
    if existing:
        for obj in list(existing.objects):
            bpy.data.objects.remove(obj, do_unlink=True)
        bpy.data.collections.remove(existing)

def make_joint(collection, name):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.035)
    obj = bpy.context.object
    obj.name = name
    collection.objects.link(obj)
    try:
        bpy.context.collection.objects.unlink(obj)
    except Exception:
        pass
    return obj

def main():
    data = load_pose()
    frames = data.get("frames", [])
    fps = data.get("fps", 12)
    clear_collection("Motion Previs Pose")
    collection = bpy.data.collections.new("Motion Previs Pose")
    bpy.context.scene.collection.children.link(collection)
    bpy.context.scene.frame_start = 1
    bpy.context.scene.frame_end = max(1, len(frames))
    bpy.context.scene.render.fps = int(fps)

    joints = [make_joint(collection, f"{i:02d}_{LANDMARK_NAMES[i] if i < len(LANDMARK_NAMES) else 'joint'}") for i in range(33)]

    for frame_index, frame in enumerate(frames, start=1):
        points = frame.get("worldLandmarks") or frame.get("landmarks") or []
        bpy.context.scene.frame_set(frame_index)
        for idx, obj in enumerate(joints):
            if idx >= len(points) or not points[idx]:
                continue
            point = points[idx]
            x = float(point.get("x", 0))
            y = float(point.get("y", 0))
            z = float(point.get("z", 0))
            obj.location = (x * 2.5, -z * 2.5, -y * 2.5)
            obj.keyframe_insert(data_path="location", frame=frame_index)

    for obj in joints:
        if obj.animation_data and obj.animation_data.action:
            for fcurve in obj.animation_data.action.fcurves:
                for keyframe in fcurve.keyframe_points:
                    keyframe.interpolation = "LINEAR"

    print(f"Imported {len(frames)} pose frames from Motion Previs Studio v${APP_VERSION}.")

if __name__ == "__main__":
    main()
`;
}

// ---------------------------------------------------------------------------
// Project session save / restore
// ---------------------------------------------------------------------------
// A single session.json lives at the workspace root and captures the last
// imported media path, trim range, analysis settings, subjectMode, and last
// bundle path so the app can offer to restore state on relaunch.

function sessionPath() {
  return path.join(workspaceRoot(), 'session.json');
}

function saveSession(session) {
  if (!validate.isPlainObject(session)) {
    throw new Error('Invalid request: session must be an object.');
  }
  // Only persist a known, JSON-safe shape; never trust arbitrary renderer input
  // to be written verbatim beyond these fields.
  const clean = {
    version: APP_VERSION,
    savedAt: new Date().toISOString(),
    sourcePath: typeof session.sourcePath === 'string' ? session.sourcePath : null,
    sourceName: typeof session.sourceName === 'string' ? session.sourceName : null,
    range: validate.isPlainObject(session.range) ? session.range : null,
    sampleFps: Number.isFinite(Number(session.sampleFps)) ? Number(session.sampleFps) : null,
    subjectMode: typeof session.subjectMode === 'string' ? session.subjectMode : null,
    poseSettings: validate.isPlainObject(session.poseSettings) ? session.poseSettings : null,
    useCameraMove: typeof session.useCameraMove === 'boolean' ? session.useCameraMove : null,
    selectedLayers: Array.isArray(session.selectedLayers) ? session.selectedLayers : null,
    exportPresets: Array.isArray(session.exportPresets) ? session.exportPresets : null,
    resolution: session.resolution === '720p' ? '720p' : 'auto',
    planning: validate.isPlainObject(session.planning) ? session.planning : null,
    lastBundlePath: typeof session.lastBundlePath === 'string' ? session.lastBundlePath : null
  };
  fs.writeFileSync(sessionPath(), JSON.stringify(clean, null, 2));
  return { saved: true, path: sessionPath() };
}

function loadSession() {
  const file = sessionPath();
  if (!fs.existsSync(file)) return null;
  try {
    const session = JSON.parse(fs.readFileSync(file, 'utf8'));
    // If the recorded source still exists, re-allow it so mps:// can serve it.
    if (session && typeof session.sourcePath === 'string' && fs.existsSync(session.sourcePath)) {
      security.allowImportSource(session.sourcePath);
      session.sourceUrl = fileUrl(session.sourcePath);
      session.sourceExists = true;
    } else if (session) {
      session.sourceExists = false;
    }
    return session;
  } catch (error) {
    console.warn(`Could not read session.json: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Send to Blockout (cross-app handoff)
// ---------------------------------------------------------------------------
// Blockout writes a control descriptor to ~/.config/blockout/control.json with
// the local control server's { port, token }. We read it (main-process only,
// never the renderer) and POST a set_reference control action.

function readBlockoutControls() {
  const descriptors = [];
  for (const file of config.blockoutControlFiles({ distribution: DISTRIBUTION })) {
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') continue;
      const port = Number(parsed.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      if (parsed.protocolVersion !== undefined && parsed.protocolVersion !== 1) continue;
      if (parsed.app && !String(parsed.app).toLowerCase().includes('blockout')) continue;
      descriptors.push({ ...parsed, port, descriptorFile: file });
    } catch {
      // Try the next platform/legacy descriptor location.
    }
  }
  return descriptors;
}

async function probeBlockout(controlDescriptor) {
  if (!controlDescriptor) return false;
  try {
    const host = localControlHost(controlDescriptor.host);
    const response = await fetch(`http://${host}:${controlDescriptor.port}/health`, {
      signal: AbortSignal.timeout(1500)
    });
    if (!response.ok) return false;
    const health = await response.json();
    return Boolean(health?.ok && (!health.app || String(health.app).toLowerCase().includes('blockout')));
  } catch {
    return false;
  }
}

async function findLiveBlockoutControl() {
  // A crashed or upgraded installation may leave a syntactically valid stale
  // descriptor in the first candidate location. Probe every compatible
  // descriptor in priority order instead of treating that first stale file as
  // authoritative and hiding a live upstream/community installation.
  for (const descriptor of readBlockoutControls()) {
    if (await probeBlockout(descriptor)) return descriptor;
  }
  return null;
}

function localControlHost(host) {
  const value = String(host || '127.0.0.1').toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(value)) {
    throw new Error('Blockout control descriptor must point to localhost.');
  }
  return value === '::1' ? '[::1]' : value;
}

async function sendToBlockout(payload) {
  if (!validate.isPlainObject(payload)) throw new Error('Invalid request: payload must be an object.');
  const videoPath = validate.requireString(payload.videoPath, 'videoPath');
  // The file must be inside our own workspace/imports allowlist — we never hand
  // Blockout an arbitrary path the renderer made up.
  if (!security.isAllowedPath(videoPath) || !fs.existsSync(videoPath)) {
    throw new Error('Reference file is missing or outside the app workspace.');
  }
  const mode = payload.mode === 'pip' ? 'pip' : 'ghost';
  const opacity = Number.isFinite(Number(payload.opacity)) ? clamp(Number(payload.opacity), 0, 1) : 0.5;

  const control = await findLiveBlockoutControl();
  if (!control) {
    const error = new Error('Blockout is not running. Open a Blockout project first, then try again.');
    error.code = 'BLOCKOUT_UNAVAILABLE';
    throw error;
  }

  const host = localControlHost(control.host);
  const base = `http://${host}:${control.port}`;
  // Blockout's control server exposes POST /rpc with a bearer token and a
  // { action, params } body; set_reference takes { path, mode, opacity }.
  const headers = { 'Content-Type': 'application/json' };
  if (control.token) headers.Authorization = `Bearer ${control.token}`;

  let result = await postBlockoutReference(base, headers, blockoutProtocol.buildSetReferenceParams(videoPath, mode, opacity));
  let handoffVersion = blockoutProtocol.HANDOFF_VERSION;
  const rejection = result.json?.error || (result.json?.ok === false ? result.text : '');
  if (blockoutProtocol.shouldRetryLegacyHandoff(result.response.status, rejection)) {
    result = await postBlockoutReference(base, headers, blockoutProtocol.buildSetReferenceParams(videoPath, mode, opacity, false));
    handoffVersion = 0;
  }
  const { response, text, json } = result;
  if (!response.ok) throw new Error(`Blockout rejected the reference (${response.status}): ${json?.error || text || 'unknown error'}`);
  // The control server wraps the handler result as { ok, data } | { ok, error }.
  if (json && json.ok === false) {
    throw new Error(`Blockout could not attach the reference: ${json.error || 'unknown error'}`);
  }
  return { ok: true, mode, opacity, handoffVersion, result: json && json.data !== undefined ? json.data : json };
}

async function postBlockoutReference(base, headers, params) {
  const body = JSON.stringify({ action: 'set_reference', params });
  let response;
  try {
    response = await fetch(`${base}/rpc`, { method: 'POST', headers, body });
  } catch (error) {
    const wrapped = new Error(`Could not reach Blockout control server: ${error.message}`);
    wrapped.code = 'BLOCKOUT_UNAVAILABLE';
    throw wrapped;
  }
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON response */ }
  return { response, text, json };
}

async function isBlockoutRunning() {
  const control = await findLiveBlockoutControl();
  const available = Boolean(control);
  return {
    available,
    protocolVersion: available ? Number(control.protocolVersion || 0) : null,
    appVersion: available ? control.appVersion || control.version || null : null
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: APP_NAME,
    backgroundColor: '#101214',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Media now loads over the privileged mps:// scheme (see security.cjs),
      // so we can keep the renderer sandbox locked down.
      webSecurity: true
    }
  });

  if (process.platform === 'win32') mainWindow.setMenuBarVisibility(false);

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(rendererRoot(), 'dist', 'index.html'));
  }
}

// Gate a shell:open/reveal target to allowlisted app/import paths only.
function requireAllowedFsPath(targetPath, action) {
  const clean = validate.requireString(targetPath, `${action} path`);
  if (!security.isAllowedPath(clean)) {
    throw new Error(`${action} refused: path is outside the app workspace and imported sources.`);
  }
  return clean;
}

app.whenReady().then(() => {
  if (process.platform === 'win32') {
    app.setAppUserModelId(APP_ID);
    Menu.setApplicationMenu(null);
  }
  // Serve allowlisted files over mps:// (must be after 'ready').
  security.installProtocolHandler(protocol);
  // Ensure the workspace root is registered even before the first import.
  workspaceRoot();

  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    copyright: 'Developed and created by Sam Wasserman (Wasserman Productions / Wasserman.ai).',
    credits: [
      'Developed and created by Sam Wasserman. WassermanProductions.com / Wasserman.ai.',
      DISTRIBUTION.isCommunityBuild && DISTRIBUTION.maintainer
        ? `Windows port maintained by ${DISTRIBUTION.maintainer}. Unofficial community build.`
        : ''
    ].filter(Boolean).join(' ')
  });

  ipcMain.handle('dialog:open-media', () => openMediaFile());
  ipcMain.handle('media:import-path', (_event, sourcePath) => importMediaPath(sourcePath));
  ipcMain.handle('media:import-url', (_event, url) => importUrl(validate.requireString(url, 'url')));
  ipcMain.handle('analysis:prepare', (_event, payload) => prepareAnalysis(validate.validatePreparePayload(payload)));
  ipcMain.handle('analysis:save-pose-artifacts', (_event, payload) => savePoseArtifacts(validate.validateSavePosePayload(payload)));
  ipcMain.handle('analysis:cancel', () => cancelActiveProcesses());
  // Deterministic PNG-stream -> H.264 encoder (replaces MediaRecorder).
  frameEncode.register(ipcMain, ffmpegPath);
  ipcMain.handle('shell:open-path', (_event, targetPath) => shell.openPath(requireAllowedFsPath(targetPath, 'open-path')));
  ipcMain.handle('shell:reveal-path', (_event, targetPath) => {
    shell.showItemInFolder(requireAllowedFsPath(targetPath, 'reveal-path'));
  });
  ipcMain.handle('shell:open-external', (_event, url) => openExternalUrl(validate.requireString(url, 'url')));
  ipcMain.handle('project:save-session', (_event, session) => saveSession(session));
  ipcMain.handle('project:load-session', () => loadSession());
  ipcMain.handle('blockout:send-reference', (_event, payload) => sendToBlockout(payload));
  ipcMain.handle('blockout:status', () => isBlockoutRunning());
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    app: APP_VERSION,
    ffmpeg: ffmpegPath(),
    ffprobe: ffprobePath(),
    workspace: workspaceRoot(),
    platform: process.platform,
    displayName: APP_NAME,
    appId: APP_ID,
    isCommunityBuild: String(Boolean(DISTRIBUTION.isCommunityBuild)),
    maintainer: DISTRIBUTION.maintainer || '',
    configFile: config.motionDiscoveryFile()
  }));
  ipcMain.handle('app:info', () => ({
    platform: process.platform,
    appId: APP_ID,
    displayName: APP_NAME,
    version: APP_VERSION,
    isCommunityBuild: Boolean(DISTRIBUTION.isCommunityBuild),
    maintainer: DISTRIBUTION.maintainer || null
  }));

  createWindow();

  // Agent-control HTTP server (MCP bridge). Localhost-only, token-gated; writes
  // a discovery file in the platform config directory. Failure to start
  // must never take the app down — the UI works without it.
  control
    .startControlServer(() => mainWindow, { ipcMain, app, appName: 'motion-previs-studio', version: APP_VERSION })
    .catch((error) => console.warn(`[motion-previs] control server failed to start: ${error.message}`));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Electron does not await async event listeners. Gate the first quit request,
// await both encoder pipes and every tracked child process, then resume quit.
shutdown.installShutdownGate(app, async () => {
  isShuttingDown = true;
  await Promise.allSettled([
    frameEncode.disposeAllSessions(),
    cancelActiveProcesses()
  ]);
});
