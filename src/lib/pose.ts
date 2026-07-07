import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseAnalysisSettings, PoseData, PoseFrame, PoseModelKey, PosePersonFrame, ProgressFn } from '../types';

export const DEFAULT_POSE_SETTINGS: PoseAnalysisSettings = {
  poseModel: 'lite',
  depthModel: 'depth-anything',
  detectionConfidence: 0.35,
  trackingConfidence: 0.35,
  smoothing: 0.7,
  temporalWindow: 5,
  maxPeople: 1,
  fillGaps: true,
  optimizeForExport: true
};

export const POSE_MODEL_OPTIONS: Array<{ key: PoseModelKey; label: string; detail: string }> = [
  { key: 'lite', label: 'MediaPipe Pose (Lite)', detail: 'Fastest, best for previews and laptops.' },
  { key: 'full', label: 'MediaPipe Pose (Full)', detail: 'More stable when the full task file is bundled.' },
  { key: 'heavy', label: 'MediaPipe Pose (Heavy)', detail: 'Highest quality when the heavy task file is bundled.' }
];

export const DEPTH_MODEL_OPTIONS: Array<{ key: PoseAnalysisSettings['depthModel']; label: string; detail: string }> = [
  { key: 'depth-anything', label: 'Depth Anything + proxy', detail: 'Exports the local AI depth pass when available.' },
  { key: 'proxy', label: 'Fast temporal proxy', detail: 'Uses the FFmpeg depth proxy only.' }
];

export const POSE_CONNECTIONS: Array<[number, number]> = [
  [11, 12],
  [11, 13],
  [13, 15],
  [15, 17],
  [15, 19],
  [15, 21],
  [17, 19],
  [12, 14],
  [14, 16],
  [16, 18],
  [16, 20],
  [16, 22],
  [18, 20],
  [11, 23],
  [12, 24],
  [23, 24],
  [23, 25],
  [24, 26],
  [25, 27],
  [26, 28],
  [27, 29],
  [28, 30],
  [29, 31],
  [30, 32],
  [27, 31],
  [28, 32],
  [0, 1],
  [1, 2],
  [2, 3],
  [0, 4],
  [4, 5],
  [5, 6],
  [3, 7],
  [6, 8],
  [9, 10]
];

const POSE_MODEL_ASSETS: Record<PoseModelKey, string> = {
  lite: 'models/pose_landmarker_lite.task',
  full: 'models/pose_landmarker_full.task',
  heavy: 'models/pose_landmarker_heavy.task'
};

type PoseRuntime = {
  landmarker: PoseLandmarker;
  modelKey: PoseModelKey;
  delegate: 'GPU' | 'CPU';
  fallbackUsed: boolean;
};

const poseLandmarkerPromises = new Map<string, Promise<PoseRuntime>>();
let reservedTimestampMaxMs = 0;

export async function loadPoseLandmarker(settings: Partial<PoseAnalysisSettings> = DEFAULT_POSE_SETTINGS, progress?: ProgressFn) {
  const normalized = normalizePoseSettings(settings);
  const key = runtimeKey(normalized);
  if (!poseLandmarkerPromises.has(key)) {
    poseLandmarkerPromises.set(key, createPoseLandmarker(normalized, progress));
  }
  return poseLandmarkerPromises.get(key)!;
}

async function createPoseLandmarker(settings: PoseAnalysisSettings, progress?: ProgressFn): Promise<PoseRuntime> {
  progress?.(0.03, `Loading ${poseModelLabel(settings.poseModel)}`);
  const vision = await FilesetResolver.forVisionTasks(publicAssetUrl('mediapipe/wasm'));
  const common = {
    runningMode: 'VIDEO' as const,
    numPoses: settings.maxPeople,
    minPoseDetectionConfidence: settings.detectionConfidence,
    minPosePresenceConfidence: settings.detectionConfidence,
    minTrackingConfidence: settings.trackingConfidence
  };
  const modelPlan = uniquePoseModels([settings.poseModel, 'lite']);
  let lastError: unknown;

  for (const modelKey of modelPlan) {
    for (const delegate of ['CPU', 'GPU'] as const) {
      try {
        const landmarker = await PoseLandmarker.createFromOptions(vision, {
          ...common,
          baseOptions: {
            modelAssetPath: publicAssetUrl(POSE_MODEL_ASSETS[modelKey]),
            delegate
          }
        });
        return {
          landmarker,
          modelKey,
          delegate,
          fallbackUsed: modelKey !== settings.poseModel
        };
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw new Error(`Could not load MediaPipe pose model. ${errorMessage(lastError)}`);
}

function publicAssetUrl(relativePath: string) {
  return new URL(relativePath.replace(/^\/+/, ''), window.location.href).href;
}

export async function analyzePoseVideo(
  videoUrl: string,
  fps: number,
  settingsOrProgress?: Partial<PoseAnalysisSettings> | ProgressFn,
  progressMaybe?: ProgressFn
): Promise<PoseData> {
  const progress = typeof settingsOrProgress === 'function' ? settingsOrProgress : progressMaybe;
  const settings = normalizePoseSettings(typeof settingsOrProgress === 'function' ? undefined : settingsOrProgress);
  let runtime = await loadPoseLandmarker(settings, progress);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  try {
    await waitForMetadata(video);
    await seekVideo(video, 0);

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const totalFrames = Math.max(1, Math.ceil(duration * fps));
    const timestampBaseMs = reserveTimestampBaseMs(duration);
    const rawFrames: PoseFrame[] = [];

    for (let index = 0; index < totalFrames; index += 1) {
      const time = Math.min(index / fps, Math.max(duration - 0.001, 0));
      await seekVideo(video, time);
      const timestampMs = timestampBaseMs + Math.round(time * 1000);
      let result;
      try {
        result = runtime.landmarker.detectForVideo(video, timestampMs);
      } catch (error) {
        if (!String(error).includes('Packet timestamp mismatch')) throw error;
        evictRuntime(settings);
        runtime = await loadPoseLandmarker(settings, progress);
        result = runtime.landmarker.detectForVideo(video, reserveTimestampBaseMs(duration) + Math.round(time * 1000));
      }
      const poses = buildPoses(result.landmarks || [], result.worldLandmarks || [], settings.maxPeople);
      const primary = poses[0];
      rawFrames.push({
        time,
        landmarks: primary?.landmarks || [],
        worldLandmarks: primary?.worldLandmarks || [],
        score: primary?.score || 0,
        poses,
        source: primary ? 'detected' : 'missing'
      });
      progress?.(0.18 + (index / totalFrames) * 0.62, `Tracking pose ${index + 1}/${totalFrames}`);
    }

    const frames = postProcessFrames(rawFrames, settings);
    const summary = summarizeFrames(rawFrames, frames, settings, runtime);

    return {
      fps,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      frames,
      summary
    };
  } finally {
    // Release the hidden <video> element so its decoder/network resources are
    // reclaimed regardless of success or failure.
    releaseVideoElement(video);
  }
}

/** Release a hidden <video> element (used by all analysis paths). */
function releaseVideoElement(video: HTMLVideoElement) {
  try {
    video.pause();
  } catch {
    /* ignore */
  }
  video.onseeked = null;
  video.onloadedmetadata = null;
  video.onerror = null;
  video.removeAttribute('src');
  video.src = '';
  try {
    video.load();
  } catch {
    /* ignore */
  }
  video.remove();
}

/**
 * Evict a cached landmarker runtime AND close its native handle so the WASM /
 * GPU resources are freed (a bare Map.delete would leak them). Safe to call
 * with an in-flight promise: we close it once it settles.
 */
function evictRuntime(settings: PoseAnalysisSettings) {
  const key = runtimeKey(settings);
  const pending = poseLandmarkerPromises.get(key);
  poseLandmarkerPromises.delete(key);
  if (pending) {
    pending
      .then((runtime) => {
        try {
          runtime.landmarker.close();
        } catch {
          /* already closed */
        }
      })
      .catch(() => undefined);
  }
}

/** Close and drop every cached PoseLandmarker. Call between big jobs or on teardown. */
export function disposeAllLandmarkers(): Promise<void> {
  const pendings = Array.from(poseLandmarkerPromises.values());
  poseLandmarkerPromises.clear();
  // The reserved-timestamp counter is a per-app monotonic guard; reset it so a
  // fresh batch starts from wall-clock again instead of growing unbounded.
  reservedTimestampMaxMs = 0;
  return Promise.all(
    pendings.map((pending) =>
      pending
        .then((runtime) => {
          try {
            runtime.landmarker.close();
          } catch {
            /* already closed */
          }
        })
        .catch(() => undefined)
    )
  ).then(() => undefined);
}

function buildPoses(
  landmarksByPerson: Array<Array<Partial<Landmark>>>,
  worldLandmarksByPerson: Array<Array<Partial<Landmark>>>,
  maxPeople: number
): PosePersonFrame[] {
  return landmarksByPerson.slice(0, maxPeople).map((landmarks, index) => {
    const normalizedLandmarks = normalizeLandmarks(landmarks);
    const normalizedWorld = normalizeLandmarks(worldLandmarksByPerson[index] || []);
    return {
      id: index,
      landmarks: normalizedLandmarks,
      worldLandmarks: normalizedWorld,
      score: scoreLandmarks(normalizedLandmarks)
    };
  });
}

function postProcessFrames(frames: PoseFrame[], settings: PoseAnalysisSettings) {
  let processed = frames.map(cloneFrame);
  if (settings.fillGaps) {
    processed = fillMissingFrames(processed, settings.temporalWindow);
  }
  if (settings.smoothing > 0) {
    processed = smoothFrames(processed, settings.smoothing);
  }
  return processed;
}

function fillMissingFrames(frames: PoseFrame[], temporalWindow: number) {
  return frames.map((frame, index) => {
    if (frame.landmarks.length) return frame;
    const previous = findNeighbor(frames, index, -1, temporalWindow);
    const next = findNeighbor(frames, index, 1, temporalWindow);
    if (!previous && !next) return frame;
    const filled = previous && next ? interpolateFrame(frame.time, previous, next) : cloneFrame(previous || next!);
    return {
      ...filled,
      time: frame.time,
      source: 'filled' as const,
      filled: true,
      score: filled.score * 0.92
    };
  });
}

function findNeighbor(frames: PoseFrame[], index: number, direction: -1 | 1, temporalWindow: number) {
  for (let offset = 1; offset <= temporalWindow; offset += 1) {
    const frame = frames[index + offset * direction];
    if (frame?.landmarks.length) return frame;
  }
  return undefined;
}

function interpolateFrame(time: number, previous: PoseFrame, next: PoseFrame): PoseFrame {
  const span = Math.max(0.001, next.time - previous.time);
  const t = clamp((time - previous.time) / span, 0, 1);
  const landmarks = interpolateLandmarks(previous.landmarks, next.landmarks, t);
  const worldLandmarks = interpolateLandmarks(previous.worldLandmarks, next.worldLandmarks, t);
  const score = previous.score + (next.score - previous.score) * t;
  return {
    time,
    landmarks,
    worldLandmarks,
    score,
    poses: [{ id: 0, landmarks, worldLandmarks, score }],
    source: 'filled',
    filled: true
  };
}

function smoothFrames(frames: PoseFrame[], smoothing: number) {
  const alpha = clamp(1 - smoothing, 0.08, 1);
  let previousLandmarks: Landmark[] | null = null;
  let previousWorldLandmarks: Landmark[] | null = null;

  return frames.map((frame) => {
    if (!frame.landmarks.length) {
      return frame;
    }
    const landmarks = previousLandmarks ? blendLandmarks(previousLandmarks, frame.landmarks, alpha) : cloneLandmarks(frame.landmarks);
    const worldLandmarks =
      previousWorldLandmarks && frame.worldLandmarks.length
        ? blendLandmarks(previousWorldLandmarks, frame.worldLandmarks, alpha)
        : cloneLandmarks(frame.worldLandmarks);
    previousLandmarks = landmarks;
    previousWorldLandmarks = worldLandmarks.length ? worldLandmarks : previousWorldLandmarks;
    const score = scoreLandmarks(landmarks) || frame.score;
    const smoothedFrame = {
      ...frame,
      landmarks,
      worldLandmarks,
      score,
      smoothed: true
    };
    smoothedFrame.poses = [{ id: 0, landmarks, worldLandmarks, score }, ...(frame.poses || []).slice(1)];
    return smoothedFrame;
  });
}

function summarizeFrames(rawFrames: PoseFrame[], frames: PoseFrame[], settings: PoseAnalysisSettings, runtime: PoseRuntime): PoseData['summary'] {
  const rawDetectedFrames = rawFrames.filter((frame) => frame.landmarks.length > 0).length;
  const detectedFrames = frames.filter((frame) => frame.landmarks.length > 0).length;
  const filledFrames = frames.filter((frame) => frame.filled).length;
  const missingFrames = frames.length - detectedFrames;
  const lowConfidenceFrames = frames.filter((frame) => frame.landmarks.length && frame.score < settings.detectionConfidence).length;
  const averageScore =
    detectedFrames > 0 ? frames.reduce((sum, frame) => sum + (frame.landmarks.length ? frame.score : 0), 0) / detectedFrames : 0;
  const maxPeopleDetected = Math.max(0, ...rawFrames.map((frame) => frame.poses?.length || 0));

  return {
    totalFrames: frames.length,
    detectedFrames,
    rawDetectedFrames,
    filledFrames,
    missingFrames,
    lowConfidenceFrames,
    maxPeopleDetected,
    averageScore,
    motionEnergy: calculateMotionEnergy(frames),
    settings,
    runtimeModel: runtime.modelKey,
    runtimeDelegate: runtime.delegate,
    diagnostics: buildDiagnostics(rawFrames, frames, settings, runtime, averageScore)
  };
}

function buildDiagnostics(
  rawFrames: PoseFrame[],
  frames: PoseFrame[],
  settings: PoseAnalysisSettings,
  runtime: PoseRuntime,
  averageScore: number
) {
  const diagnostics: string[] = [];
  const rawDetected = rawFrames.filter((frame) => frame.landmarks.length).length;
  const rawRatio = rawFrames.length ? rawDetected / rawFrames.length : 0;
  const filled = frames.filter((frame) => frame.filled).length;

  if (runtime.fallbackUsed) {
    diagnostics.push(`${poseModelLabel(settings.poseModel)} was not available, so Lite was used for this run.`);
  }
  if (!rawDetected) {
    diagnostics.push('No body pose was detected. Use a clearer subject, lower confidence, or switch to Camera only mode.');
  } else if (rawRatio < 0.45) {
    diagnostics.push('Pose detection is intermittent. Lower detection confidence or trim to frames where the body is more visible.');
  }
  if (filled > 0) {
    diagnostics.push(`Filled ${filled} short pose gaps using a ${settings.temporalWindow}-frame temporal window.`);
  }
  if (averageScore > 0 && averageScore < settings.detectionConfidence) {
    diagnostics.push('Average landmark confidence is below the selected detection threshold.');
  }
  if (settings.maxPeople > 1 && !rawFrames.some((frame) => (frame.poses?.length || 0) > 1)) {
    diagnostics.push('Multi-person tracking is enabled, but only one person was detected in this range.');
  }
  if (!diagnostics.length) {
    diagnostics.push('Pose track is ready for export.');
  }
  return diagnostics;
}

function normalizeLandmarks(points: Array<Partial<Landmark>>): Landmark[] {
  return points.map((point) => ({
    x: Number(point.x || 0),
    y: Number(point.y || 0),
    z: Number(point.z || 0),
    visibility: point.visibility === undefined ? undefined : Number(point.visibility),
    presence: point.presence === undefined ? undefined : Number(point.presence)
  }));
}

function cloneFrame(frame: PoseFrame): PoseFrame {
  return {
    ...frame,
    landmarks: cloneLandmarks(frame.landmarks),
    worldLandmarks: cloneLandmarks(frame.worldLandmarks),
    poses: frame.poses?.map((pose) => ({
      id: pose.id,
      landmarks: cloneLandmarks(pose.landmarks),
      worldLandmarks: cloneLandmarks(pose.worldLandmarks),
      score: pose.score
    }))
  };
}

function cloneLandmarks(landmarks: Landmark[]) {
  return landmarks.map((landmark) => ({ ...landmark }));
}

function interpolateLandmarks(previous: Landmark[], next: Landmark[], t: number) {
  const count = Math.min(previous.length, next.length);
  if (!count) return cloneLandmarks(previous.length ? previous : next);
  return Array.from({ length: count }, (_, index) => ({
    x: previous[index].x + (next[index].x - previous[index].x) * t,
    y: previous[index].y + (next[index].y - previous[index].y) * t,
    z: previous[index].z + (next[index].z - previous[index].z) * t,
    visibility: blendOptional(previous[index].visibility, next[index].visibility, t),
    presence: blendOptional(previous[index].presence, next[index].presence, t)
  }));
}

function blendLandmarks(previous: Landmark[], next: Landmark[], alpha: number) {
  const count = Math.min(previous.length, next.length);
  if (!count) return cloneLandmarks(next);
  return Array.from({ length: count }, (_, index) => ({
    x: previous[index].x * (1 - alpha) + next[index].x * alpha,
    y: previous[index].y * (1 - alpha) + next[index].y * alpha,
    z: previous[index].z * (1 - alpha) + next[index].z * alpha,
    visibility: blendOptional(previous[index].visibility, next[index].visibility, alpha),
    presence: blendOptional(previous[index].presence, next[index].presence, alpha)
  }));
}

function blendOptional(previous: number | undefined, next: number | undefined, t: number) {
  if (previous === undefined) return next;
  if (next === undefined) return previous;
  return previous + (next - previous) * t;
}

function scoreLandmarks(landmarks: Landmark[]) {
  if (!landmarks.length) return 0;
  const scores = landmarks.map((landmark) => landmark.visibility ?? landmark.presence ?? 0.75);
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
}

function calculateMotionEnergy(frames: PoseFrame[]) {
  let previous: Landmark[] | null = null;
  let motionTotal = 0;
  let motionFrames = 0;
  for (const frame of frames) {
    if (!frame.landmarks.length) continue;
    if (previous) {
      motionTotal += estimateMotion(previous, frame.landmarks);
      motionFrames += 1;
    }
    previous = frame.landmarks;
  }
  return motionFrames > 0 ? motionTotal / motionFrames : 0;
}

function estimateMotion(previous: Landmark[], next: Landmark[]) {
  const count = Math.min(previous.length, next.length);
  if (!count) return 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = previous[index].x - next[index].x;
    const dy = previous[index].y - next[index].y;
    const dz = previous[index].z - next[index].z;
    total += Math.sqrt(dx * dx + dy * dy + dz * dz);
  }
  return total / count;
}

export function poseConnectionColor(from: number, to: number) {
  const leftArm = new Set([11, 13, 15, 17, 19, 21]);
  const rightArm = new Set([12, 14, 16, 18, 20, 22]);
  const leftLeg = new Set([23, 25, 27, 29, 31]);
  const rightLeg = new Set([24, 26, 28, 30, 32]);
  if (from <= 10 || to <= 10) return '#e646d8';
  if (leftArm.has(from) || leftArm.has(to)) return '#46f083';
  if (rightArm.has(from) || rightArm.has(to)) return '#56e7ff';
  if (leftLeg.has(from) || leftLeg.has(to)) return '#f4e855';
  if (rightLeg.has(from) || rightLeg.has(to)) return '#ff7a2f';
  return '#f5d76e';
}

export function poseModelLabel(key: PoseModelKey) {
  return POSE_MODEL_OPTIONS.find((option) => option.key === key)?.label || key;
}

export function normalizePoseSettings(settings: Partial<PoseAnalysisSettings> = DEFAULT_POSE_SETTINGS): PoseAnalysisSettings {
  return {
    poseModel: settings.poseModel || DEFAULT_POSE_SETTINGS.poseModel,
    depthModel: settings.depthModel || DEFAULT_POSE_SETTINGS.depthModel,
    detectionConfidence: clampUnit(settings.detectionConfidence ?? DEFAULT_POSE_SETTINGS.detectionConfidence),
    trackingConfidence: clampUnit(settings.trackingConfidence ?? DEFAULT_POSE_SETTINGS.trackingConfidence),
    smoothing: clampUnit(settings.smoothing ?? DEFAULT_POSE_SETTINGS.smoothing),
    temporalWindow: clamp(Math.round(settings.temporalWindow ?? DEFAULT_POSE_SETTINGS.temporalWindow), 1, 30),
    maxPeople: clamp(Math.round(settings.maxPeople ?? DEFAULT_POSE_SETTINGS.maxPeople), 1, 4),
    fillGaps: settings.fillGaps ?? DEFAULT_POSE_SETTINGS.fillGaps,
    optimizeForExport: settings.optimizeForExport ?? DEFAULT_POSE_SETTINGS.optimizeForExport
  };
}

function runtimeKey(settings: PoseAnalysisSettings) {
  return [
    settings.poseModel,
    settings.maxPeople,
    settings.detectionConfidence.toFixed(2),
    settings.trackingConfidence.toFixed(2)
  ].join(':');
}

function reserveTimestampBaseMs(durationSeconds: number) {
  const now = Date.now();
  // The MediaPipe VIDEO running mode requires strictly increasing timestamps.
  // We keep a monotonic reservation cursor, but bound it: if it has drifted far
  // ahead of wall-clock (e.g. after many analyses), snap it back to `now` so it
  // can never grow without limit across a long session.
  const MAX_DRIFT_MS = 60 * 60 * 1000; // 1 hour ceiling over wall-clock
  if (reservedTimestampMaxMs > now + MAX_DRIFT_MS) {
    reservedTimestampMaxMs = now;
  }
  const requestedBase = Math.max(now, reservedTimestampMaxMs + 1000);
  reservedTimestampMaxMs = requestedBase + Math.ceil(durationSeconds * 1000) + 1000;
  return requestedBase;
}

function uniquePoseModels(models: PoseModelKey[]) {
  return models.filter((model, index) => models.indexOf(model) === index);
}

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading video metadata.')), 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load video for pose analysis.'));
    };
    video.load();
  });
}

function seekVideo(video: HTMLVideoElement, time: number) {
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => reject(new Error(`Timed out seeking video to ${time.toFixed(2)}s.`)), 10000);
    const done = () => {
      window.clearTimeout(timeout);
      video.onseeked = null;
      resolve();
    };
    video.onseeked = done;
    video.currentTime = time;
    if (Math.abs(video.currentTime - time) < 0.002 && video.readyState >= 2) {
      requestAnimationFrame(done);
    }
  });
}

function clampUnit(value: number) {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '');
}
