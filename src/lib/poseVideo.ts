import type { Landmark, PoseData, PoseFrame, PosePersonFrame, ProgressFn } from '../types';
import { POSE_CONNECTIONS, poseConnectionColor } from './pose';

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

export async function createPoseVideoBlob(
  poseData: PoseData,
  width: number,
  height: number,
  progress?: ProgressFn
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not create pose render canvas.');

  const mimeType = chooseMimeType();
  const stream = canvas.captureStream(poseData.fps);
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();
  const track = stream.getVideoTracks()[0] as MediaStreamTrack & { requestFrame?: () => void };
  const delayMs = 1000 / poseData.fps;

  for (let index = 0; index < poseData.frames.length; index += 1) {
    drawPoseFrame(ctx, poseData.frames[index], width, height);
    track.requestFrame?.();
    progress?.(0.82 + (index / poseData.frames.length) * 0.12, `Rendering pose video ${index + 1}/${poseData.frames.length}`);
    await delay(delayMs);
  }

  recorder.stop();
  await stopped;
  stream.getTracks().forEach((trackItem) => trackItem.stop());
  return new Blob(chunks, { type: mimeType || 'video/webm' });
}

function chooseMimeType() {
  const candidates = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || '';
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
