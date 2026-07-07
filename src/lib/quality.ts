// Motion Previs Studio - quality readiness score (renderer mirror).
//
// SOURCE OF TRUTH: shared/quality.cjs. This module MUST stay byte-for-byte
// equivalent in constants and logic to that CommonJS file. The main process
// requires shared/quality.cjs directly; the renderer cannot require a .cjs
// through the Vite/TS build, so this is an exact mirror. A sync test
// (tests/quality-sync.cjs) compares both against a shared fixture matrix.
//
// If you change a constant or the formula here, change shared/quality.cjs too.

import type { QualityReport } from '../types';

type Band = QualityReport['tracking'];
type Readiness = QualityReport['readiness'];

// Score weights (percent points). tracking + camera + layers can total 100.
export const WEIGHT_TRACKING = 34;
export const WEIGHT_CAMERA = 42;
export const WEIGHT_LAYERS = 24;

// Readiness thresholds on the 0-100 score.
export const READY_THRESHOLD = 80;
export const REVIEW_THRESHOLD = 58;

// Pose tracking helpers.
export const FILLED_FRAME_CREDIT_CAP = 0.18;

// Layer scoring: full credit once this many control layers are selected.
export const LAYER_TARGET_COUNT = 6;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

export function qualityBand(value: number): Band {
  if (value >= 0.82) return 'Excellent';
  if (value >= 0.64) return 'Good';
  if (value > 0) return 'Review';
  return 'Missing';
}

/** Normalized pose tracking score in [0, 1] from raw pose frame counts. */
export function trackingScore(
  rawDetectedFrames: number,
  filledFrames: number,
  totalFrames: number
): number {
  if (!totalFrames) return 0;
  return clamp01(
    rawDetectedFrames / totalFrames + Math.min(filledFrames / totalFrames, FILLED_FRAME_CREDIT_CAP)
  );
}

/** Normalized control-layer score in [0, 1] from the count of selected layers. */
export function layerScore(selectedLayerCount: number): number {
  return Math.min(1, (Number(selectedLayerCount) || 0) / LAYER_TARGET_COUNT);
}

/** The one quality formula. Inputs are normalized scalars in [0, 1]. */
export function scoreFromComponents(
  tracking: number,
  camera: number,
  layers: number
): { score: number; readiness: Readiness } {
  const t = clamp01(tracking);
  const c = clamp01(camera);
  const l = clamp01(layers);
  const score = Math.round(t * WEIGHT_TRACKING + c * WEIGHT_CAMERA + l * WEIGHT_LAYERS);
  const readiness: Readiness = score >= READY_THRESHOLD ? 'Ready' : score >= REVIEW_THRESHOLD ? 'Review' : 'Blocked';
  return { score, readiness };
}

export type QualityComputeInput = {
  tracking: number;
  camera: number;
  layers: number;
  cameraActive?: boolean;
  rawDetectedFrames?: number;
  totalFrames?: number;
  filledFrames?: number;
  notes?: string[];
};

/** Full quality report from normalized scalar inputs plus display metadata. */
export function computeQualityReport(input: QualityComputeInput): QualityReport {
  const tracking = clamp01(input.tracking);
  const camera = clamp01(input.camera);
  const layers = clamp01(input.layers);
  const cameraActive = input.cameraActive !== false;
  const { score, readiness } = scoreFromComponents(tracking, camera, layers);

  const rawDetectedFrames = Number(input.rawDetectedFrames) || 0;
  const totalFrames = Number(input.totalFrames) || 0;
  const filledFrames = Number(input.filledFrames) || 0;

  const notes = Array.isArray(input.notes)
    ? input.notes
    : [
        `Pose frames detected: ${rawDetectedFrames}/${totalFrames}`,
        `Filled pose gaps: ${filledFrames}`,
        `Camera confidence: ${Math.round(camera * 100)}%`,
        'Control layers generated: depth, edges, lineart, motion mask, normals proxy, pose, camera.'
      ];

  return {
    score,
    tracking: qualityBand(tracking),
    camera: cameraActive ? qualityBand(camera) : 'Missing',
    layers: qualityBand(layers),
    readiness,
    notes
  };
}
