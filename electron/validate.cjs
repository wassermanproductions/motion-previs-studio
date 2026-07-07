'use strict';

/**
 * Lightweight IPC payload validation for Motion Previs Studio v4.
 * No dependencies. Every ipcMain handler runs its payload through these guards
 * so malformed or hostile renderer input is rejected before touching the FS.
 */

function fail(message) {
  throw new Error(`Invalid request: ${message}`);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Require a non-empty string. */
function requireString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty string.`);
  }
  return value;
}

/** Optional string; returns undefined when absent, throws on wrong type. */
function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(`${field} must be a string when provided.`);
  return value;
}

/** Finite number, optionally with a default. */
function requireNumber(value, field, fallback) {
  if (value === undefined || value === null) {
    if (fallback !== undefined) return fallback;
    fail(`${field} must be a number.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${field} must be a finite number.`);
  return n;
}

/** Validate an optional resolution field: 'auto' | '720p'. Defaults 'auto'. */
function validateResolution(value) {
  if (value === undefined || value === null) return 'auto';
  if (value !== 'auto' && value !== '720p') {
    fail("resolution must be 'auto' or '720p'.");
  }
  return value;
}

/** Validate the analysis:prepare payload shape. Returns a sanitized copy. */
function validatePreparePayload(payload) {
  if (!isPlainObject(payload)) fail('analysis payload must be an object.');
  requireString(payload.sourcePath, 'sourcePath');
  return {
    sourcePath: payload.sourcePath,
    start: requireNumber(payload.start, 'start', 0),
    end: payload.end === undefined || payload.end === null ? undefined : requireNumber(payload.end, 'end'),
    sampleFps: requireNumber(payload.sampleFps, 'sampleFps', 12),
    resolution: validateResolution(payload.resolution)
  };
}

/** Validate the analysis:save-pose-artifacts payload. Mutating-safe: returns the
 *  original object after asserting the load-bearing fields, plus a normalized
 *  resolution. */
function validateSavePosePayload(payload) {
  if (!isPlainObject(payload)) fail('save-pose payload must be an object.');
  requireString(payload.outputDir, 'outputDir');
  requireString(payload.referencePath, 'referencePath');
  requireString(payload.depthPath, 'depthPath');
  optionalString(payload.edgesPath, 'edgesPath');
  optionalString(payload.lineartPath, 'lineartPath');
  optionalString(payload.motionMaskPath, 'motionMaskPath');
  optionalString(payload.normalsPath, 'normalsPath');
  optionalString(payload.contactSheetPath, 'contactSheetPath');
  optionalString(payload.animaticPath, 'animaticPath');
  if (!isPlainObject(payload.poseData)) fail('poseData must be an object.');
  // v4 optional extra artifacts: an OpenPose render buffer and its keypoints
  // JSON. Validate shape only when present so old payloads still pass.
  if (payload.openPoseVideoBuffer !== undefined && payload.openPoseVideoBuffer !== null) {
    if (!isBufferLike(payload.openPoseVideoBuffer)) fail('openPoseVideoBuffer must be an ArrayBuffer/typed array.');
  }
  if (payload.openPoseKeypoints !== undefined && payload.openPoseKeypoints !== null) {
    if (!isPlainObject(payload.openPoseKeypoints) && !Array.isArray(payload.openPoseKeypoints)) {
      fail('openPoseKeypoints must be an object or array.');
    }
  }
  payload.resolution = validateResolution(payload.resolution);
  return payload;
}

/** True for an ArrayBuffer, typed array, or Node Buffer (post-IPC shapes). */
function isBufferLike(value) {
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (value && typeof value === 'object' && value.buffer instanceof ArrayBuffer) return true;
  return false;
}

module.exports = {
  isPlainObject,
  isBufferLike,
  requireString,
  optionalString,
  requireNumber,
  validateResolution,
  validatePreparePayload,
  validateSavePosePayload
};
