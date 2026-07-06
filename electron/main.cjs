const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { spawn } = require('node:child_process');
const archiver = require('archiver');

let mainWindow;

function appRoot() {
  return app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '..');
}

function rendererRoot() {
  return app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : appRoot();
}

function resolveBin(packagePath, fallback) {
  const candidate = packagePath || fallback;
  if (!app.isPackaged) return candidate;
  if (!candidate) return fallback;
  const unpacked = candidate.replace('app.asar', 'app.asar.unpacked');
  return fs.existsSync(unpacked) ? unpacked : candidate;
}

function ffmpegPath() {
  return resolveBin(require('ffmpeg-static'), 'ffmpeg');
}

function ffprobePath() {
  const ffprobe = require('ffprobe-static');
  return resolveBin(ffprobe.path, 'ffprobe');
}

function ytDlpPath() {
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const resourceCandidate = path.join(process.resourcesPath || '', 'bin', exe);
  if (app.isPackaged && fs.existsSync(resourceCandidate)) return resourceCandidate;
  const publicCandidate = path.join(appRoot(), 'public', 'bin', exe);
  if (fs.existsSync(publicCandidate)) return publicCandidate;
  return exe;
}

function workspaceRoot() {
  const dir = path.join(app.getPath('userData'), 'projects');
  fs.mkdirSync(dir, { recursive: true });
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

function fileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

async function openExternalUrl(url) {
  const parsed = new URL(String(url || ''));
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('External links must use http or https.');
  }
  await shell.openExternal(parsed.href);
}

function run(bin, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      cwd: options.cwd || appRoot(),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const message = `${path.basename(bin)} exited with ${code}\n${stderr || stdout}`;
        reject(new Error(message));
      }
    });
  });
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
  return probe(result.filePaths[0]);
}

async function importUrl(url) {
  if (!/^https?:\/\//i.test(url)) {
    throw new Error('Please enter a valid http or https video URL.');
  }

  const dir = path.join(workspaceRoot(), 'imports', `${Date.now()}-${safeName(url)}`);
  fs.mkdirSync(dir, { recursive: true });
  const outputTemplate = path.join(dir, '%(title).120B-%(id)s.%(ext)s');

  await run(ytDlpPath(), [
    url,
    '--output',
    outputTemplate,
    '--format',
    'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
    '--merge-output-format',
    'mp4',
    '--no-playlist',
    '--restrict-filenames'
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
  const sourcePath = payload.sourcePath;
  if (!sourcePath || !fs.existsSync(sourcePath)) throw new Error('Source media is missing.');

  const meta = await probe(sourcePath);
  if (!meta.width || !meta.height) {
    throw new Error('This source does not contain a video stream. Audio-only files can be attached for sync, but pose/depth analysis needs video.');
  }

  const fps = clamp(Number(payload.sampleFps || 12), 4, 30);
  const start = clamp(Number(payload.start || 0), 0, Math.max(meta.duration - 0.1, 0));
  const end = clamp(Number(payload.end || Math.min(meta.duration, start + 8)), start + 0.1, meta.duration || start + 60);
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
  const referenceScale = meta.width >= meta.height ? 'scale=1280:-2' : 'scale=-2:1280';
  const depthScale = meta.width >= meta.height ? 'scale=960:-2' : 'scale=-2:960';

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

  await createControlVideo(referencePath, depthPath, `fps=${fps},${depthScale},format=gray,eq=contrast=1.45:brightness=0.03,boxblur=2:1`, fps);
  await createControlVideo(referencePath, edgesPath, `fps=${fps},${depthScale},edgedetect=low=0.08:high=0.28,format=gray,eq=contrast=1.35`, fps);
  await createControlVideo(referencePath, lineartPath, `fps=${fps},${depthScale},format=gray,sobel,negate,eq=contrast=1.2`, fps);
  await createControlVideo(referencePath, motionMaskPath, `fps=${fps},${depthScale},tblend=all_mode=difference,format=gray,eq=contrast=3.2:brightness=0.02,boxblur=1:1`, fps);
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

  fs.writeFileSync(path.join(outDir, 'analysis_manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function savePoseArtifacts(payload) {
  const analysisDir = payload.outputDir;
  if (!analysisDir || !fs.existsSync(analysisDir)) throw new Error('Analysis output folder is missing.');

  const poseJsonPath = path.join(analysisDir, 'pose_landmarks.json');
  const cameraMotionJsonPath = path.join(analysisDir, 'camera_motion.json');
  const poseWebmPath = path.join(analysisDir, 'pose_high_contrast.webm');
  const poseMp4Path = path.join(analysisDir, 'pose_high_contrast.mp4');
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

  if (payload.poseVideoBuffer) {
    fs.writeFileSync(poseWebmPath, Buffer.from(payload.poseVideoBuffer));
    try {
      await run(ffmpegPath(), ['-y', '-i', poseWebmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', poseMp4Path]);
    } catch (error) {
      console.warn(error.message);
    }
  }

  if (payload.aiDepthVideoBuffer) {
    fs.writeFileSync(aiDepthWebmPath, Buffer.from(payload.aiDepthVideoBuffer));
    try {
      await run(ffmpegPath(), ['-y', '-i', aiDepthWebmPath, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', aiDepthMp4Path]);
    } catch (error) {
      console.warn(error.message);
    }
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
    app: 'Motion Previs Studio v3',
    version: '0.3.0',
    createdAt: new Date().toISOString(),
    sourceName: payload.sourceName,
    range: payload.range,
    sampleFps: payload.poseData?.fps || payload.sampleFps,
    frameCount: payload.poseData?.frames?.length || 0,
    cameraMoveFrames: payload.cameraMotionData?.frames?.length || 0,
    planning: payload.planningData || null,
    files
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
    name: 'Motion Previs Studio v3 Control Reference Bundle',
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
    '# Motion Previs Studio v3 Prompt Pack',
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

function defaultQualityReport(payload) {
  const detected = payload.poseData?.summary?.detectedFrames || 0;
  const total = payload.poseData?.frames?.length || 0;
  const poseRatio = total ? detected / total : 0;
  const camera = payload.cameraMotionData?.summary?.averageConfidence || 0;
  const score = Math.round((poseRatio * 0.34 + camera * 0.42 + 0.24) * 100);
  return {
    score,
    tracking: qualityBand(poseRatio),
    camera: qualityBand(camera),
    layers: 'Excellent',
    readiness: score >= 80 ? 'Ready' : score >= 60 ? 'Review' : 'Blocked',
    notes: [
      `Pose frames detected: ${detected}/${total}`,
      `Camera confidence: ${Math.round(camera * 100)}%`,
      'Control layers generated: depth, edges, lineart, motion mask, normals proxy, pose, camera.'
    ]
  };
}

function qualityBand(value) {
  if (value >= 0.82) return 'Excellent';
  if (value >= 0.64) return 'Good';
  if (value > 0) return 'Review';
  return 'Missing';
}

function modelPresets(payload) {
  const selected = payload.planningData?.exportPresets || ['seedance', 'comfyui', 'blender'];
  return {
    selected,
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
      { key: 'masks', file: 'motion_mask.mp4', purpose: 'Motion/foreground proxy mask.' },
      { key: 'normals', file: 'normals_proxy.mp4', purpose: 'Depth-gradient normals proxy.' },
      { key: 'motion', file: 'motion_mask.mp4', purpose: 'Frame-difference motion proxy.' }
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

    print(f"Imported {len(frames)} camera move frames from Motion Previs Studio v3.")

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
    print("Built Motion Previs Studio v3 Blender scene with camera, pose, and reference plates.")

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

    print(f"Imported {len(frames)} pose frames from Motion Previs Studio v3.")

if __name__ == "__main__":
    main()
`;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 1180,
    minHeight: 760,
    title: 'Motion Previs Studio v3',
    backgroundColor: '#101214',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false
    }
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(rendererRoot(), 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
  app.setAboutPanelOptions({
    applicationName: 'Motion Previs Studio v3',
    applicationVersion: app.getVersion(),
    copyright: 'Developed and created by Sam Wasserman (Wasserman Productions / Wasserman.ai).',
    credits: 'Developed and created by Sam Wasserman. WassermanProductions.com / Wasserman.ai.'
  });

  ipcMain.handle('dialog:open-media', openMediaFile);
  ipcMain.handle('media:import-url', (_event, url) => importUrl(url));
  ipcMain.handle('analysis:prepare', (_event, payload) => prepareAnalysis(payload));
  ipcMain.handle('analysis:save-pose-artifacts', (_event, payload) => savePoseArtifacts(payload));
  ipcMain.handle('shell:open-path', (_event, targetPath) => shell.openPath(targetPath));
  ipcMain.handle('shell:reveal-path', (_event, targetPath) => shell.showItemInFolder(targetPath));
  ipcMain.handle('shell:open-external', (_event, url) => openExternalUrl(url));
  ipcMain.handle('app:versions', () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    ffmpeg: ffmpegPath(),
    ffprobe: ffprobePath(),
    workspace: workspaceRoot()
  }));

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
