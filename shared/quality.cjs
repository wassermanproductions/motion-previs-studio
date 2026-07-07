'use strict';

/**
 * Motion Previs Studio - single source of truth for the quality readiness score.
 *
 * Both the Electron main process (electron/main.cjs) and the React renderer
 * (src/lib/quality.ts, mirrored from here) must produce IDENTICAL scores for the
 * same inputs. Keep the constants below and src/lib/quality.ts in exact sync.
 *
 * Plain CommonJS, no dependencies, so it can be required from main.cjs and also
 * mirrored verbatim by the TypeScript module for the renderer.
 */

// Score weights (percent points). tracking + camera + layers can total 100.
const WEIGHT_TRACKING = 34;
const WEIGHT_CAMERA = 42;
const WEIGHT_LAYERS = 24;

// Readiness thresholds on the 0-100 score.
const READY_THRESHOLD = 80;
const REVIEW_THRESHOLD = 58;

// Pose tracking helpers.
const FILLED_FRAME_CREDIT_CAP = 0.18;

// Layer scoring: full credit once this many control layers are selected.
const LAYER_TARGET_COUNT = 6;

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(value, 0), 1);
}

function qualityBand(value) {
  if (value >= 0.82) return 'Excellent';
  if (value >= 0.64) return 'Good';
  if (value > 0) return 'Review';
  return 'Missing';
}

/**
 * Normalized pose tracking score in [0, 1] from raw pose frame counts.
 */
function trackingScore(rawDetectedFrames, filledFrames, totalFrames) {
  if (!totalFrames) return 0;
  return clamp01(
    rawDetectedFrames / totalFrames + Math.min(filledFrames / totalFrames, FILLED_FRAME_CREDIT_CAP)
  );
}

/**
 * Normalized control-layer score in [0, 1] from the count of selected layers.
 */
function layerScore(selectedLayerCount) {
  return Math.min(1, (Number(selectedLayerCount) || 0) / LAYER_TARGET_COUNT);
}

/**
 * The one quality formula. Inputs are normalized scalars in [0, 1].
 * Returns { score, readiness } only; callers assemble bands/notes.
 */
function scoreFromComponents(tracking, camera, layers) {
  const t = clamp01(tracking);
  const c = clamp01(camera);
  const l = clamp01(layers);
  const score = Math.round(t * WEIGHT_TRACKING + c * WEIGHT_CAMERA + l * WEIGHT_LAYERS);
  const readiness = score >= READY_THRESHOLD ? 'Ready' : score >= REVIEW_THRESHOLD ? 'Review' : 'Blocked';
  return { score, readiness };
}

/**
 * Full quality report from normalized scalar inputs plus display metadata.
 *
 * @param {Object} input
 * @param {number} input.tracking      normalized pose tracking score [0,1]
 * @param {number} input.camera        normalized camera confidence [0,1]
 * @param {number} input.layers        normalized layer score [0,1]
 * @param {boolean} [input.cameraActive=true]  whether camera move is in use
 * @param {number} [input.rawDetectedFrames]
 * @param {number} [input.totalFrames]
 * @param {number} [input.filledFrames]
 * @param {string[]} [input.notes]     override notes; otherwise built from counts
 */
function computeQualityReport(input) {
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

module.exports = {
  WEIGHT_TRACKING,
  WEIGHT_CAMERA,
  WEIGHT_LAYERS,
  READY_THRESHOLD,
  REVIEW_THRESHOLD,
  FILLED_FRAME_CREDIT_CAP,
  LAYER_TARGET_COUNT,
  clamp01,
  qualityBand,
  trackingScore,
  layerScore,
  scoreFromComponents,
  computeQualityReport
};
