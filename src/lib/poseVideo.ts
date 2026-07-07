import type { Landmark, PoseData, PoseFrame, PosePersonFrame, ProgressFn } from '../types';
import { POSE_CONNECTIONS, poseConnectionColor } from './pose';
import { encodeFrames } from './frameEncoder';

export function drawPoseFrame(ctx: CanvasRenderingContext2D, frame: PoseFrame | undefined, width: number, height: number) {
  ctx.save();
  ctx.fillStyle = '#030405';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#172226';
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 80) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 80) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  const poses = frame?.poses?.length ? frame.poses : frame?.landmarks?.length ? [frameToPerson(frame)] : [];

  if (!poses.length) {
    ctx.fillStyle = '#667176';
    ctx.font = '600 18px Inter, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No pose detected', width / 2, height / 2);
    ctx.restore();
    return;
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.shadowColor = 'rgba(0, 0, 0, 0.72)';
  ctx.shadowBlur = 8;

  poses.forEach((pose, poseIndex) => {
    const points = pose.landmarks;
    const poseAlpha = poseIndex === 0 ? 1 : 0.58;

    for (const [from, to] of POSE_CONNECTIONS) {
      const a = points[from];
      const b = points[to];
      if (!a || !b) continue;
      const confidence = Math.min(a.visibility ?? 1, b.visibility ?? 1);
      ctx.globalAlpha = confidence > 0.5 ? poseAlpha : poseAlpha * 0.38;
      ctx.strokeStyle = poseConnectionColor(from, to);
      ctx.lineWidth = confidence > 0.5 ? 7 : 3;
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }

    points.forEach((point, index) => {
      const confidence = point.visibility ?? 1;
      const radius = index <= 10 ? 4.5 : 6.5;
      ctx.globalAlpha = confidence > 0.5 ? poseAlpha : poseAlpha * 0.45;
      ctx.fillStyle = index === 0 ? '#e646d8' : '#8ff5ff';
      ctx.beginPath();
      ctx.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#050708';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  });

  ctx.globalAlpha = 1;
  ctx.shadowBlur = 0;
  ctx.fillStyle = '#c8d2d2';
  ctx.font = '600 14px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${(frame?.time || 0).toFixed(2)}s  ${frame?.source === 'filled' ? 'filled gap' : 'tracked'}`, 18, 28);
  ctx.restore();
}

function frameToPerson(frame: PoseFrame): PosePersonFrame {
  return {
    id: 0,
    landmarks: frame.landmarks as Landmark[],
    worldLandmarks: frame.worldLandmarks as Landmark[],
    score: frame.score
  };
}

/**
 * Render the high-contrast MediaPipe skeleton to a deterministic H.264 mp4.
 *
 * v4: this used to capture a MediaRecorder off a canvas.captureStream on a
 * wall-clock timer, which dropped/duplicated frames under load and produced a
 * WebM. It now draws every frame and streams the PNGs to ffmpeg via the shared
 * frame encoder, so the encoded frame count exactly equals the pose frame count
 * and the output is reproducible. The return type stays `Blob` (now mp4 bytes),
 * so callers doing `blob.arrayBuffer()` are unchanged — see App.tsx exportBundle
 * and tests/e2e-electron.cjs. main's savePoseArtifacts detects the mp4 magic and
 * writes it straight through instead of transcoding.
 */
export async function createPoseVideoBlob(
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
  if (!ctx) throw new Error('Could not create pose render canvas.');

  try {
    return await encodeFrames({
      canvas,
      fps: poseData.fps,
      frameCount: poseData.frames.length,
      signal,
      renderFrame: (index) => {
        drawPoseFrame(ctx, poseData.frames[index], width, height);
      },
      onProgress: (fraction, index) => {
        progress?.(0.82 + fraction * 0.12, `Rendering pose video ${index + 1}/${poseData.frames.length}`);
      }
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
