/**
 * OpenPose BODY_25 export for Motion Previs Studio v4.
 *
 * MediaPipe Pose emits 33 landmarks; most AI-video / ControlNet pose pipelines
 * consume OpenPose. This module maps MediaPipe -> OpenPose BODY_25, renders the
 * canonical OpenPose skeleton look deterministically (per-limb color wheel,
 * round joints, thick limbs on pure black), and builds the standard per-frame
 * OpenPose JSON.
 *
 * BODY_25 joint order:
 *   0  Nose        1  Neck        2  RShoulder   3  RElbow      4  RWrist
 *   5  LShoulder   6  LElbow      7  LWrist      8  MidHip      9  RHip
 *  10  RKnee      11  RAnkle     12  LHip       13  LKnee      14  LAnkle
 *  15  REye       16  LEye       17  REar       18  LEar       19  LBigToe
 *  20  LSmallToe  21  LHeel      22  RBigToe    23  RSmallToe  24  RHeel
 *
 * MediaPipe -> BODY_25 index mapping (MediaPipe "left" is the subject's left,
 * which is anatomically consistent with OpenPose's L/R naming):
 *   Nose      <- 0
 *   Neck      <- midpoint(11 L-shoulder, 12 R-shoulder)   [derived]
 *   RShoulder <- 12   RElbow <- 14   RWrist <- 16
 *   LShoulder <- 11   LElbow <- 13   LWrist <- 15
 *   MidHip    <- midpoint(23 L-hip, 24 R-hip)             [derived]
 *   RHip <- 24   RKnee <- 26   RAnkle <- 28
 *   LHip <- 23   LKnee <- 25   LAnkle <- 27
 *   REye <- 5    LEye <- 2     REar <- 8   LEar <- 7
 *   LBigToe <- 31  LSmallToe <- 31*  LHeel <- 29
 *   RBigToe <- 32  RSmallToe <- 32*  RHeel <- 30
 *   (*MediaPipe has a single foot_index per foot; small-toe reuses it. Any
 *    BODY_25 joint with no MediaPipe source is emitted with confidence 0.)
 */

import type { Landmark, PoseData, PoseFrame, PosePersonFrame, ProgressFn } from '../types';
import { encodeFrames } from './frameEncoder';

export const BODY_25_COUNT = 25;

export const BODY_25_NAMES = [
  'Nose', 'Neck', 'RShoulder', 'RElbow', 'RWrist', 'LShoulder', 'LElbow', 'LWrist',
  'MidHip', 'RHip', 'RKnee', 'RAnkle', 'LHip', 'LKnee', 'LAnkle', 'REye', 'LEye',
  'REar', 'LEar', 'LBigToe', 'LSmallToe', 'LHeel', 'RBigToe', 'RSmallToe', 'RHeel'
] as const;

// Kind of source for each BODY_25 index:
//  - a number N: copy MediaPipe landmark N directly.
//  - a [a, b] pair: midpoint of MediaPipe landmarks a and b (derived joint).
//  - null: no MediaPipe source; emit (0,0,0).
type Source = number | [number, number] | null;

export const BODY_25_FROM_MEDIAPIPE: Source[] = [
  0, // 0  Nose
  [11, 12], // 1  Neck = midpoint(shoulders)
  12, // 2  RShoulder (MediaPipe right_shoulder)
  14, // 3  RElbow
  16, // 4  RWrist
  11, // 5  LShoulder (MediaPipe left_shoulder)
  13, // 6  LElbow
  15, // 7  LWrist
  [23, 24], // 8  MidHip = midpoint(hips)
  24, // 9  RHip
  26, // 10 RKnee
  28, // 11 RAnkle
  23, // 12 LHip
  25, // 13 LKnee
  27, // 14 LAnkle
  5, // 15 REye (MediaPipe right_eye)
  2, // 16 LEye (MediaPipe left_eye)
  8, // 17 REar (MediaPipe right_ear)
  7, // 18 LEar (MediaPipe left_ear)
  31, // 19 LBigToe (MediaPipe left_foot_index)
  31, // 20 LSmallToe (reuse: MediaPipe has one foot index per foot)
  29, // 21 LHeel
  32, // 22 RBigToe (MediaPipe right_foot_index)
  32, // 23 RSmallToe (reuse)
  30 // 24 RHeel
];

// Canonical OpenPose BODY_25 limb pairs + the standard per-limb color wheel
// (BGR in the original C++; expressed here as CSS hex). Order matters for the
// look: draw limbs first, then joint dots.
export const BODY_25_PAIRS: Array<[number, number]> = [
  [1, 0], [1, 2], [1, 5], [2, 3], [3, 4], [5, 6], [6, 7], [1, 8],
  [8, 9], [9, 10], [10, 11], [8, 12], [12, 13], [13, 14], [1, 8],
  [0, 15], [0, 16], [15, 17], [16, 18], [14, 19], [19, 20], [14, 21],
  [11, 22], [22, 23], [11, 24]
];

// Per-joint colors follow the canonical OpenPose wheel (25 hues around the
// spectrum). Index = BODY_25 joint index.
export const BODY_25_COLORS: string[] = [
  '#ff0000', '#ff5500', '#ffaa00', '#ffff00', '#aaff00', '#55ff00', '#00ff00', '#00ff55',
  '#00ffaa', '#00ffff', '#00aaff', '#0055ff', '#0000ff', '#5500ff', '#aa00ff', '#ff00ff',
  '#ff00aa', '#ff0055', '#ff0000', '#ff0033', '#ff0066', '#ff0099', '#3300ff', '#6600ff', '#9900ff'
];

export type OpenPoseKeypoint = { x: number; y: number; c: number };
export type OpenPosePerson = { person_id: number[]; pose_keypoints_2d: number[] };
export type OpenPoseFrameJson = { version: number; people: OpenPosePerson[] };

/**
 * Map one MediaPipe person (normalized landmarks) to BODY_25 keypoints in the
 * given pixel resolution. Missing/derived-from-missing joints get confidence 0.
 */
export function mediaPipeToBody25(
  landmarks: Landmark[],
  width: number,
  height: number
): OpenPoseKeypoint[] {
  const out: OpenPoseKeypoint[] = [];
  for (let j = 0; j < BODY_25_COUNT; j += 1) {
    out.push(sourceToKeypoint(BODY_25_FROM_MEDIAPIPE[j], landmarks, width, height));
  }
  return out;
}

function sourceToKeypoint(source: Source, landmarks: Landmark[], width: number, height: number): OpenPoseKeypoint {
  if (source === null) return { x: 0, y: 0, c: 0 };
  if (Array.isArray(source)) {
    const a = landmarks[source[0]];
    const b = landmarks[source[1]];
    if (!a || !b) return { x: 0, y: 0, c: 0 };
    const ca = confidenceOf(a);
    const cb = confidenceOf(b);
    return {
      x: ((a.x + b.x) / 2) * width,
      y: ((a.y + b.y) / 2) * height,
      c: Math.min(ca, cb)
    };
  }
  const lm = landmarks[source];
  if (!lm) return { x: 0, y: 0, c: 0 };
  return { x: lm.x * width, y: lm.y * height, c: confidenceOf(lm) };
}

function confidenceOf(landmark: Landmark): number {
  const v = landmark.visibility ?? landmark.presence;
  if (v === undefined) return 0.9;
  return clamp01(v);
}

/** Flatten BODY_25 keypoints into the OpenPose [x,y,c,...] array (75 numbers). */
export function keypointsToFlatArray(keypoints: OpenPoseKeypoint[]): number[] {
  const flat: number[] = [];
  for (const kp of keypoints) {
    flat.push(round2(kp.x), round2(kp.y), round4(kp.c));
  }
  return flat;
}

/** Extract the people (poses) for a frame, falling back to the primary landmarks. */
function framePeople(frame: PoseFrame | undefined): PosePersonFrame[] {
  if (!frame) return [];
  if (frame.poses?.length) return frame.poses;
  if (frame.landmarks?.length) {
    return [{ id: 0, landmarks: frame.landmarks, worldLandmarks: frame.worldLandmarks, score: frame.score }];
  }
  return [];
}

/**
 * Build the per-frame OpenPose JSON for the whole clip, in pixel coordinates of
 * the reference resolution. Returns one object per frame.
 */
export function buildOpenPoseJson(poseData: PoseData, width: number, height: number): OpenPoseFrameJson[] {
  return poseData.frames.map((frame) => {
    const people = framePeople(frame).map((person, index) => ({
      person_id: [index === 0 ? -1 : index],
      pose_keypoints_2d: keypointsToFlatArray(mediaPipeToBody25(person.landmarks, width, height))
    }));
    return { version: 1.3, people };
  });
}

/**
 * Draw the canonical OpenPose skeleton for one frame to a 2D context: pure
 * black background, thick colored limbs, round colored joints. Multi-person is
 * supported (all people drawn). Deterministic — no timing, no randomness.
 */
export function drawOpenPoseFrame(
  ctx: CanvasRenderingContext2D,
  frame: PoseFrame | undefined,
  width: number,
  height: number
): void {
  ctx.save();
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, width, height);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const limbWidth = Math.max(3, Math.round(Math.min(width, height) * 0.012));
  const jointRadius = Math.max(3, Math.round(Math.min(width, height) * 0.008));

  for (const person of framePeople(frame)) {
    const kps = mediaPipeToBody25(person.landmarks, width, height);

    // Limbs first so joint dots sit on top.
    for (const [a, b] of BODY_25_PAIRS) {
      const pa = kps[a];
      const pb = kps[b];
      if (!pa || !pb || pa.c <= 0.05 || pb.c <= 0.05) continue;
      ctx.strokeStyle = BODY_25_COLORS[a];
      ctx.globalAlpha = Math.min(1, Math.min(pa.c, pb.c) + 0.25);
      ctx.lineWidth = limbWidth;
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }

    // Joints.
    kps.forEach((kp, index) => {
      if (kp.c <= 0.05) return;
      ctx.globalAlpha = Math.min(1, kp.c + 0.3);
      ctx.fillStyle = BODY_25_COLORS[index];
      ctx.beginPath();
      ctx.arc(kp.x, kp.y, jointRadius, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  ctx.globalAlpha = 1;
  ctx.restore();
}

/**
 * Render the OpenPose skeleton video deterministically to an H.264 mp4 Blob
 * using the shared frame encoder (renderer -> main -> ffmpeg). Exactly one
 * encoded frame per pose frame.
 */
export async function renderOpenPoseFrames(
  poseData: PoseData,
  width: number,
  height: number,
  progress?: ProgressFn,
  signal?: AbortSignal
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create OpenPose render canvas.');

  try {
    return await encodeFrames({
      canvas,
      fps: poseData.fps,
      frameCount: poseData.frames.length,
      signal,
      renderFrame: (index) => {
        drawOpenPoseFrame(ctx, poseData.frames[index], width, height);
      },
      onProgress: (fraction) => {
        progress?.(0.9 + fraction * 0.05, `Rendering OpenPose skeleton ${Math.round(fraction * poseData.frames.length)}/${poseData.frames.length}`);
      }
    });
  } finally {
    releaseCanvas(canvas);
  }
}

function releaseCanvas(canvas: HTMLCanvasElement) {
  canvas.width = 0;
  canvas.height = 0;
}

function clamp01(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
