import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { Landmark, PoseData, PoseFrame, ProgressFn } from '../types';

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

let poseLandmarkerPromise: Promise<PoseLandmarker> | null = null;

export async function loadPoseLandmarker(progress?: ProgressFn) {
  if (!poseLandmarkerPromise) {
    poseLandmarkerPromise = createPoseLandmarker(progress);
  }
  return poseLandmarkerPromise;
}

async function createPoseLandmarker(progress?: ProgressFn) {
  progress?.(0.03, 'Loading MediaPipe pose model');
  const vision = await FilesetResolver.forVisionTasks(publicAssetUrl('mediapipe/wasm'));
  const common = {
    runningMode: 'VIDEO' as const,
    numPoses: 2,
    minPoseDetectionConfidence: 0.35,
    minPosePresenceConfidence: 0.35,
    minTrackingConfidence: 0.35
  };

  try {
    return await PoseLandmarker.createFromOptions(vision, {
      ...common,
      baseOptions: {
        modelAssetPath: publicAssetUrl('models/pose_landmarker_lite.task'),
        delegate: 'GPU'
      }
    });
  } catch {
    return PoseLandmarker.createFromOptions(vision, {
      ...common,
      baseOptions: {
        modelAssetPath: publicAssetUrl('models/pose_landmarker_lite.task'),
        delegate: 'CPU'
      }
    });
  }
}

function publicAssetUrl(relativePath: string) {
  return new URL(relativePath.replace(/^\/+/, ''), window.location.href).href;
}

export async function analyzePoseVideo(videoUrl: string, fps: number, progress?: ProgressFn): Promise<PoseData> {
  const landmarker = await loadPoseLandmarker(progress);
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  await waitForMetadata(video);
  await seekVideo(video, 0);

  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
  const totalFrames = Math.max(1, Math.ceil(duration * fps));
  const frames: PoseFrame[] = [];
  let previous: Landmark[] | null = null;
  let motionTotal = 0;

  for (let index = 0; index < totalFrames; index += 1) {
    const time = Math.min(index / fps, Math.max(duration - 0.001, 0));
    await seekVideo(video, time);
    const result = landmarker.detectForVideo(video, Math.round(time * 1000));
    const landmarks = normalizeLandmarks(result.landmarks?.[0] || []);
    const worldLandmarks = normalizeLandmarks(result.worldLandmarks?.[0] || []);
    const score = scoreLandmarks(landmarks);
    if (previous && landmarks.length) {
      motionTotal += estimateMotion(previous, landmarks);
    }
    previous = landmarks.length ? landmarks : previous;
    frames.push({ time, landmarks, worldLandmarks, score });
    progress?.(0.18 + (index / totalFrames) * 0.62, `Tracking pose ${index + 1}/${totalFrames}`);
  }

  const detectedFrames = frames.filter((frame) => frame.landmarks.length > 0).length;
  const averageScore =
    detectedFrames > 0 ? frames.reduce((sum, frame) => sum + frame.score, 0) / Math.max(detectedFrames, 1) : 0;

  return {
    fps,
    duration,
    width: video.videoWidth,
    height: video.videoHeight,
    frames,
    summary: {
      detectedFrames,
      averageScore,
      motionEnergy: detectedFrames > 1 ? motionTotal / (detectedFrames - 1) : 0
    }
  };
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

function scoreLandmarks(landmarks: Landmark[]) {
  if (!landmarks.length) return 0;
  const scores = landmarks.map((landmark) => landmark.visibility ?? landmark.presence ?? 0.75);
  return scores.reduce((sum, score) => sum + score, 0) / scores.length;
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
