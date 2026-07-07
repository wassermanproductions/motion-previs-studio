import type { CameraMotionData, CameraMotionFrame, Landmark, PoseData, PoseFrame, ProgressFn } from '../types';
import { throwIfAborted } from '../types';

/**
 * Camera solve v2 (Motion Previs Studio v4).
 *
 * Replaces the brute-force full-frame shift search (which drifted and was
 * corrupted whenever the subject filled the frame) with a proper feature-based
 * solve, implemented directly on ImageData with no OpenCV dependency:
 *
 *   1. Build a 3-level grayscale image pyramid per frame.
 *   2. Detect ~150 Shi-Tomasi corners on the previous frame, deterministically,
 *      EXCLUDING features that fall inside a per-frame subject mask built from
 *      the pose landmarks (bounding capsules around the limbs). When no pose is
 *      provided, fall back to an edge-weight heuristic that down-weights the
 *      frame center (where the subject usually is).
 *   3. Track each corner into the current frame with pyramidal Lucas-Kanade
 *      (21px windows, coarse-to-fine).
 *   4. Estimate a robust similarity transform (tx, ty, scale, rotation) from the
 *      tracked correspondences via seeded RANSAC over 2-point hypotheses.
 *   5. Accumulate into the same pan / tilt / dollyZoom / roll keyframe output.
 *
 * Confidence per frame is the RANSAC inlier ratio. Determinism: corner order is
 * fixed and RANSAC uses a fixed-seed LCG, so the same input yields the same
 * solve every run.
 */

type GrayFrame = {
  width: number;
  height: number;
  data: Float32Array; // 0..255 grayscale, float for sub-sampling in pyramid
};

type Pyramid = GrayFrame[]; // index 0 = finest (full analysis res)

type Corner = { x: number; y: number };
type Match = { x0: number; y0: number; x1: number; y1: number };

type Similarity = { tx: number; ty: number; scale: number; rotation: number; inlierRatio: number };

const CORNER_TARGET = 150;
const PYRAMID_LEVELS = 3;
const LK_WINDOW = 21; // odd; half-window = 10
const LK_ITERATIONS = 8;
const RANSAC_ITERATIONS = 220;
const RANSAC_INLIER_PX = 1.6;

export async function analyzeCameraMotionVideo(
  videoUrl: string,
  fps: number,
  progressOrPose?: ProgressFn | PoseData,
  progressMaybe?: ProgressFn,
  signal?: AbortSignal
): Promise<CameraMotionData> {
  // Backward-compatible overloads:
  //   analyzeCameraMotionVideo(url, fps, progress)
  //   analyzeCameraMotionVideo(url, fps, poseData, progress)   [v4]
  const poseData = progressOrPose && typeof progressOrPose !== 'function' ? progressOrPose : undefined;
  const progress = typeof progressOrPose === 'function' ? progressOrPose : progressMaybe;

  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = videoUrl;

  try {
    await waitForMetadata(video);

    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 1;
    const sampleFps = Math.min(Math.max(fps, 2), 12);
    const totalFrames = Math.max(1, Math.ceil(duration * sampleFps));
    const size = analysisSize(video.videoWidth, video.videoHeight);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Could not create camera-motion analysis canvas.');

    let previousPyramid: Pyramid | null = null;
    let cumulativeX = 0;
    let cumulativeY = 0;
    let cumulativeZoom = 1;
    let cumulativeRoll = 0;
    const frames: CameraMotionFrame[] = [];

    for (let index = 0; index < totalFrames; index += 1) {
      throwIfAborted(signal);
      const time = Math.min(index / sampleFps, Math.max(duration - 0.001, 0));
      await seekVideo(video, time);
      ctx.drawImage(video, 0, 0, size.width, size.height);
      const gray = toGrayFrame(ctx.getImageData(0, 0, size.width, size.height));
      const pyramid = buildPyramid(gray, PYRAMID_LEVELS);

      let imageMotion = { xPixels: 0, yPixels: 0, scale: 1, rollRadians: 0 };
      let confidence = 1;

      if (previousPyramid) {
        // Subject mask for the PREVIOUS frame (features are seeded there).
        const prevPoseFrame = poseData ? poseFrameAt(poseData, time - 1 / sampleFps) : undefined;
        const mask = buildSubjectMask(size.width, size.height, prevPoseFrame);
        const corners = detectCorners(previousPyramid[0], CORNER_TARGET, mask);
        const matches = trackCorners(previousPyramid, pyramid, corners);
        const similarity = estimateSimilarityRansac(matches, size.width, size.height);

        const scaleX = video.videoWidth / size.width;
        const scaleY = video.videoHeight / size.height;
        imageMotion = {
          xPixels: similarity.tx * scaleX,
          yPixels: similarity.ty * scaleY,
          scale: similarity.scale,
          rollRadians: similarity.rotation
        };
        confidence = clamp(similarity.inlierRatio, 0, 1);
        cumulativeX += imageMotion.xPixels;
        cumulativeY += imageMotion.yPixels;
        cumulativeZoom *= similarity.scale;
        cumulativeRoll += similarity.rotation;
      }

      frames.push({
        time,
        frameIndex: index,
        imageMotion,
        cameraMove: {
          pan: -cumulativeX / Math.max(video.videoWidth, 1),
          tilt: -cumulativeY / Math.max(video.videoHeight, 1),
          dollyZoom: cumulativeZoom,
          roll: -cumulativeRoll
        },
        confidence
      });

      previousPyramid = pyramid;
      progress?.(0.8 + (index / totalFrames) * 0.08, `Solving camera move ${index + 1}/${totalFrames}`);
    }

    const last = frames[frames.length - 1];
    const averageConfidence = frames.reduce((sum, frame) => sum + frame.confidence, 0) / Math.max(frames.length, 1);
    return {
      fps: sampleFps,
      duration,
      width: video.videoWidth,
      height: video.videoHeight,
      frames,
      summary: {
        panPixels: last ? -last.cameraMove.pan * video.videoWidth : 0,
        tiltPixels: last ? -last.cameraMove.tilt * video.videoHeight : 0,
        zoomRatio: last?.cameraMove.dollyZoom || 1,
        rollDegrees: ((last?.cameraMove.roll || 0) * 180) / Math.PI,
        averageConfidence
      }
    };
  } finally {
    releaseVideoElement(video);
  }
}

// ---------------------------------------------------------------------------
// Analysis-resolution grayscale + pyramid
// ---------------------------------------------------------------------------

function analysisSize(width: number, height: number) {
  // A larger long edge than v3 (which used 96px) gives LK real texture to track
  // while staying cheap. 192 keeps ~150 corners meaningful.
  const longEdge = 192;
  if (!width || !height) return { width: longEdge, height: Math.round(longEdge * 0.5625) };
  if (width >= height) {
    return { width: longEdge, height: Math.max(48, Math.round((height / width) * longEdge)) };
  }
  return { width: Math.max(48, Math.round((width / height) * longEdge)), height: longEdge };
}

function toGrayFrame(image: ImageData): GrayFrame {
  const out = new Float32Array(image.width * image.height);
  for (let index = 0, cursor = 0; index < image.data.length; index += 4, cursor += 1) {
    out[cursor] = image.data[index] * 0.299 + image.data[index + 1] * 0.587 + image.data[index + 2] * 0.114;
  }
  return { width: image.width, height: image.height, data: out };
}

function buildPyramid(base: GrayFrame, levels: number): Pyramid {
  const pyramid: Pyramid = [base];
  for (let level = 1; level < levels; level += 1) {
    pyramid.push(downsampleHalf(pyramid[level - 1]));
  }
  return pyramid;
}

/** 2x2 box downsample (Gaussian-ish for tracking; cheap and deterministic). */
function downsampleHalf(src: GrayFrame): GrayFrame {
  const w = Math.max(1, src.width >> 1);
  const h = Math.max(1, src.height >> 1);
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const sy = y * 2;
    const sy1 = Math.min(sy + 1, src.height - 1);
    for (let x = 0; x < w; x += 1) {
      const sx = x * 2;
      const sx1 = Math.min(sx + 1, src.width - 1);
      const a = src.data[sy * src.width + sx];
      const b = src.data[sy * src.width + sx1];
      const c = src.data[sy1 * src.width + sx];
      const d = src.data[sy1 * src.width + sx1];
      data[y * w + x] = (a + b + c + d) * 0.25;
    }
  }
  return { width: w, height: h, data };
}

function sample(frame: GrayFrame, x: number, y: number): number {
  // Bilinear sample with edge clamping.
  const w = frame.width;
  const h = frame.height;
  const cx = clamp(x, 0, w - 1.001);
  const cy = clamp(y, 0, h - 1.001);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const fx = cx - x0;
  const fy = cy - y0;
  const p00 = frame.data[y0 * w + x0];
  const p10 = frame.data[y0 * w + x1];
  const p01 = frame.data[y1 * w + x0];
  const p11 = frame.data[y1 * w + x1];
  return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
}

// ---------------------------------------------------------------------------
// Subject mask from pose landmarks (bounding capsules around limbs)
// ---------------------------------------------------------------------------

type SubjectMask = { width: number; height: number; blocked: Uint8Array } | null;

// Limb segments (MediaPipe indices) to inflate into capsules, plus a torso fill.
const MASK_SEGMENTS: Array<[number, number]> = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
  [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [24, 26], [26, 28]
];

function buildSubjectMask(width: number, height: number, poseFrame?: PoseFrame): SubjectMask {
  if (!poseFrame) return null;
  const people = poseFrame.poses?.length
    ? poseFrame.poses.map((p) => p.landmarks)
    : poseFrame.landmarks?.length
      ? [poseFrame.landmarks]
      : [];
  if (!people.length) return null;

  const blocked = new Uint8Array(width * height);
  const radius = Math.max(4, Math.round(Math.min(width, height) * 0.06));
  let any = false;

  for (const landmarks of people) {
    // Head circle around the nose.
    const nose = landmarks[0];
    if (nose && visible(nose)) {
      stampCircle(blocked, width, height, nose.x * width, nose.y * height, radius * 1.3);
      any = true;
    }
    for (const [a, b] of MASK_SEGMENTS) {
      const pa = landmarks[a];
      const pb = landmarks[b];
      if (!pa || !pb || !visible(pa) || !visible(pb)) continue;
      stampCapsule(blocked, width, height, pa.x * width, pa.y * height, pb.x * width, pb.y * height, radius);
      any = true;
    }
  }

  return any ? { width, height, blocked } : null;
}

function visible(landmark: Landmark): boolean {
  const v = landmark.visibility ?? landmark.presence;
  return v === undefined ? true : v > 0.3;
}

function stampCircle(blocked: Uint8Array, width: number, height: number, cx: number, cy: number, r: number) {
  const minX = Math.max(0, Math.floor(cx - r));
  const maxX = Math.min(width - 1, Math.ceil(cx + r));
  const minY = Math.max(0, Math.floor(cy - r));
  const maxY = Math.min(height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) blocked[y * width + x] = 1;
    }
  }
}

function stampCapsule(blocked: Uint8Array, width: number, height: number, x0: number, y0: number, x1: number, y1: number, r: number) {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - r));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + r));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - r));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + r));
  const r2 = r * r;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (pointSegmentDist2(x, y, x0, y0, x1, y1) <= r2) blocked[y * width + x] = 1;
    }
  }
}

function pointSegmentDist2(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  if (len2 <= 1e-6) {
    const ex = px - x0;
    const ey = py - y0;
    return ex * ex + ey * ey;
  }
  let t = ((px - x0) * dx + (py - y0) * dy) / len2;
  t = clamp(t, 0, 1);
  const cx = x0 + t * dx;
  const cy = y0 + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return ex * ex + ey * ey;
}

// ---------------------------------------------------------------------------
// Shi-Tomasi corner detection (deterministic)
// ---------------------------------------------------------------------------

/**
 * Detect up to `target` Shi-Tomasi corners on `frame`. Corners inside the
 * subject `mask` are skipped. When no mask is available, an edge-weight
 * heuristic down-weights the frame center (where the subject usually sits).
 * Selection is deterministic: score, then grid non-max suppression in a fixed
 * scan order.
 */
function detectCorners(frame: GrayFrame, target: number, mask: SubjectMask): Corner[] {
  const w = frame.width;
  const h = frame.height;
  const border = 3;
  const scored: Array<{ x: number; y: number; score: number }> = [];

  for (let y = border; y < h - border; y += 1) {
    for (let x = border; x < w - border; x += 1) {
      if (mask && mask.blocked[y * w + x]) continue;
      const score = minEigenScore(frame, x, y);
      if (score <= 0) continue;
      const weight = mask ? 1 : centerFalloff(x, y, w, h);
      scored.push({ x, y, score: score * weight });
    }
  }

  // Deterministic ordering: score desc, then y, then x as tie-breakers.
  scored.sort((a, b) => (b.score - a.score) || (a.y - b.y) || (a.x - b.x));

  // Grid-based non-max suppression to spread features across the frame.
  const minDist = Math.max(3, Math.round(Math.min(w, h) / 18));
  const cellSize = minDist;
  const cols = Math.ceil(w / cellSize);
  const rows = Math.ceil(h / cellSize);
  const occupied = new Uint8Array(cols * rows);
  const corners: Corner[] = [];

  for (const candidate of scored) {
    const cellX = Math.floor(candidate.x / cellSize);
    const cellY = Math.floor(candidate.y / cellSize);
    let tooClose = false;
    for (let gy = -1; gy <= 1 && !tooClose; gy += 1) {
      for (let gx = -1; gx <= 1; gx += 1) {
        const nx = cellX + gx;
        const ny = cellY + gy;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        if (occupied[ny * cols + nx]) {
          tooClose = true;
          break;
        }
      }
    }
    if (tooClose) continue;
    occupied[cellY * cols + cellX] = 1;
    corners.push({ x: candidate.x, y: candidate.y });
    if (corners.length >= target) break;
  }

  return corners;
}

/** Shi-Tomasi minimum-eigenvalue score of the 3x3 structure tensor. */
function minEigenScore(frame: GrayFrame, x: number, y: number): number {
  let ixx = 0;
  let iyy = 0;
  let ixy = 0;
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const gx = sample(frame, x + dx + 1, y + dy) - sample(frame, x + dx - 1, y + dy);
      const gy = sample(frame, x + dx, y + dy + 1) - sample(frame, x + dx, y + dy - 1);
      ixx += gx * gx;
      iyy += gy * gy;
      ixy += gx * gy;
    }
  }
  const trace = ixx + iyy;
  const det = ixx * iyy - ixy * ixy;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  return (trace - disc) / 2;
}

function centerFalloff(x: number, y: number, width: number, height: number): number {
  const nx = Math.abs(x / width - 0.5) * 2;
  const ny = Math.abs(y / height - 0.5) * 2;
  const edgeBias = Math.max(nx, ny);
  return edgeBias > 0.45 ? 1.25 : 0.5;
}

// ---------------------------------------------------------------------------
// Pyramidal Lucas-Kanade tracking
// ---------------------------------------------------------------------------

function trackCorners(prev: Pyramid, next: Pyramid, corners: Corner[]): Match[] {
  const matches: Match[] = [];
  const levels = Math.min(prev.length, next.length);
  const half = (LK_WINDOW - 1) / 2;

  for (const corner of corners) {
    // Coarse-to-fine: start displacement 0 at coarsest level, refine downward.
    let flowX = 0;
    let flowY = 0;
    let lost = false;

    for (let level = levels - 1; level >= 0; level -= 1) {
      const scale = 1 << level;
      const px = corner.x / scale;
      const py = corner.y / scale;
      const prevL = prev[level];
      const nextL = next[level];

      // Upscale flow from the coarser level.
      flowX *= 2;
      flowY *= 2;
      if (level === levels - 1) {
        flowX = 0;
        flowY = 0;
      }

      for (let iter = 0; iter < LK_ITERATIONS; iter += 1) {
        let gxx = 0;
        let gyy = 0;
        let gxy = 0;
        let ex = 0;
        let ey = 0;
        for (let wy = -half; wy <= half; wy += 1) {
          for (let wx = -half; wx <= half; wx += 1) {
            const sx = px + wx;
            const sy = py + wy;
            const ix = (sample(prevL, sx + 1, sy) - sample(prevL, sx - 1, sy)) * 0.5;
            const iy = (sample(prevL, sx, sy + 1) - sample(prevL, sx, sy - 1)) * 0.5;
            const it = sample(nextL, sx + flowX, sy + flowY) - sample(prevL, sx, sy);
            gxx += ix * ix;
            gyy += iy * iy;
            gxy += ix * iy;
            ex += ix * it;
            ey += iy * it;
          }
        }
        const det = gxx * gyy - gxy * gxy;
        if (Math.abs(det) < 1e-6) {
          lost = true;
          break;
        }
        // Solve [gxx gxy; gxy gyy] * d = -[ex; ey]
        const dx = -(gyy * ex - gxy * ey) / det;
        const dy = -(gxx * ey - gxy * ex) / det;
        flowX += dx;
        flowY += dy;
        if (dx * dx + dy * dy < 1e-4) break;
      }
      if (lost) break;
    }

    if (lost) continue;
    const nx = corner.x + flowX;
    const ny = corner.y + flowY;
    // Reject flows that leave the frame or are absurdly large.
    if (nx < 0 || ny < 0 || nx >= prev[0].width || ny >= prev[0].height) continue;
    const maxFlow = Math.min(prev[0].width, prev[0].height) * 0.5;
    if (Math.abs(flowX) > maxFlow || Math.abs(flowY) > maxFlow) continue;
    matches.push({ x0: corner.x, y0: corner.y, x1: nx, y1: ny });
  }

  return matches;
}

// ---------------------------------------------------------------------------
// Robust similarity estimation via seeded RANSAC over 2-point hypotheses
// ---------------------------------------------------------------------------

/**
 * Estimate a similarity transform (rotation+uniform-scale+translation) mapping
 * frame0 points to frame1 points, robust to outliers (subject motion,
 * mistracks) via RANSAC. Returns identity with low confidence when there is not
 * enough signal.
 */
export function estimateSimilarityRansac(
  matches: Match[],
  width: number,
  height: number
): Similarity {
  const identity: Similarity = { tx: 0, ty: 0, scale: 1, rotation: 0, inlierRatio: matches.length ? 0.15 : 0 };
  if (matches.length < 3) return identity;

  const rand = makeLcg(0x9e3779b9);
  const n = matches.length;
  const threshold2 = RANSAC_INLIER_PX * RANSAC_INLIER_PX;
  let bestInliers: number[] = [];

  for (let iter = 0; iter < RANSAC_ITERATIONS; iter += 1) {
    const i = Math.floor(rand() * n);
    let j = Math.floor(rand() * n);
    if (j === i) j = (j + 1) % n;
    const model = similarityFromTwo(matches[i], matches[j]);
    if (!model) continue;

    const inliers: number[] = [];
    for (let k = 0; k < n; k += 1) {
      if (residual2(model, matches[k]) <= threshold2) inliers.push(k);
    }
    if (inliers.length > bestInliers.length) {
      bestInliers = inliers;
    }
  }

  if (bestInliers.length < 3) {
    // Fall back to a translation-only median (still robust) so slow shots that
    // starve RANSAC don't jitter to identity.
    const median = medianTranslation(matches);
    return { tx: median.tx, ty: median.ty, scale: 1, rotation: 0, inlierRatio: 0.2 };
  }

  // Refit least-squares similarity over all inliers for accuracy.
  const refined = leastSquaresSimilarity(bestInliers.map((k) => matches[k]));
  const inlierRatio = bestInliers.length / n;
  // Sanity clamps so a bad frame can't blow out the accumulation.
  const scale = clamp(refined.scale, 0.8, 1.25);
  const rotation = clamp(refined.rotation, -0.2, 0.2);
  const maxT = Math.max(width, height) * 0.6;
  return {
    tx: clamp(refined.tx, -maxT, maxT),
    ty: clamp(refined.ty, -maxT, maxT),
    scale,
    rotation,
    inlierRatio
  };
}

/** Two-point similarity hypothesis. */
function similarityFromTwo(a: Match, b: Match): Similarity | null {
  const dx0 = b.x0 - a.x0;
  const dy0 = b.y0 - a.y0;
  const dx1 = b.x1 - a.x1;
  const dy1 = b.y1 - a.y1;
  const len0sq = dx0 * dx0 + dy0 * dy0;
  if (len0sq < 1e-6) return null;
  // Complex division (dx1+i dy1) / (dx0+i dy0) gives scale*e^{i*rot}.
  const a11 = (dx1 * dx0 + dy1 * dy0) / len0sq; // = scale*cos
  const a21 = (dy1 * dx0 - dx1 * dy0) / len0sq; // = scale*sin
  const scale = Math.hypot(a11, a21);
  if (scale < 1e-6) return null;
  const rotation = Math.atan2(a21, a11);
  const tx = a.x1 - (a11 * a.x0 - a21 * a.y0);
  const ty = a.y1 - (a21 * a.x0 + a11 * a.y0);
  return { tx, ty, scale, rotation, inlierRatio: 0 };
}

function residual2(model: Similarity, m: Match): number {
  const c = model.scale * Math.cos(model.rotation);
  const s = model.scale * Math.sin(model.rotation);
  const px = c * m.x0 - s * m.y0 + model.tx;
  const py = s * m.x0 + c * m.y0 + model.ty;
  const ex = px - m.x1;
  const ey = py - m.y1;
  return ex * ex + ey * ey;
}

/** Closed-form least-squares similarity (Umeyama, 2D). */
function leastSquaresSimilarity(matches: Match[]): Similarity {
  const n = matches.length;
  let mx0 = 0;
  let my0 = 0;
  let mx1 = 0;
  let my1 = 0;
  for (const m of matches) {
    mx0 += m.x0;
    my0 += m.y0;
    mx1 += m.x1;
    my1 += m.y1;
  }
  mx0 /= n;
  my0 /= n;
  mx1 /= n;
  my1 /= n;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let syx = 0;
  let var0 = 0;
  for (const m of matches) {
    const ax = m.x0 - mx0;
    const ay = m.y0 - my0;
    const bx = m.x1 - mx1;
    const by = m.y1 - my1;
    sxx += ax * bx;
    syy += ay * by;
    sxy += ax * by;
    syx += ay * bx;
    var0 += ax * ax + ay * ay;
  }
  // Rotation from the cross-covariance.
  const numerator = sxy - syx; // sum(ax*by - ay*bx) -> sin term
  const denominator = sxx + syy; // cos term
  const rotation = Math.atan2(numerator, denominator);
  const scale = var0 > 1e-6 ? Math.hypot(numerator, denominator) / var0 : 1;
  const c = scale * Math.cos(rotation);
  const s = scale * Math.sin(rotation);
  const tx = mx1 - (c * mx0 - s * my0);
  const ty = my1 - (s * mx0 + c * my0);
  return { tx, ty, scale, rotation, inlierRatio: 1 };
}

function medianTranslation(matches: Match[]): { tx: number; ty: number } {
  const xs = matches.map((m) => m.x1 - m.x0).sort((a, b) => a - b);
  const ys = matches.map((m) => m.y1 - m.y0).sort((a, b) => a - b);
  const mid = xs.length >> 1;
  const tx = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  const ty = ys.length % 2 ? ys[mid] : (ys[mid - 1] + ys[mid]) / 2;
  return { tx, ty };
}

/**
 * Deterministic linear congruential generator (glibc constants). Returns a
 * float in [0,1). Fixed seed => reproducible RANSAC.
 */
export function makeLcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    // state = (a*state + c) mod 2^31, glibc-style.
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

// ---------------------------------------------------------------------------
// Pose lookup + shared video helpers
// ---------------------------------------------------------------------------

function poseFrameAt(poseData: PoseData, time: number): PoseFrame | undefined {
  const frames = poseData.frames;
  if (!frames.length) return undefined;
  // Nearest frame by time.
  let best = frames[0];
  let bestDelta = Math.abs(frames[0].time - time);
  for (let i = 1; i < frames.length; i += 1) {
    const delta = Math.abs(frames[i].time - time);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = frames[i];
    }
  }
  return best;
}

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

function waitForMetadata(video: HTMLVideoElement) {
  return new Promise<void>((resolve, reject) => {
    if (video.readyState >= 1) {
      resolve();
      return;
    }
    const timeout = window.setTimeout(() => reject(new Error('Timed out loading video metadata for camera motion.')), 15000);
    video.onloadedmetadata = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    video.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error('Could not load video for camera-motion analysis.'));
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

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}
