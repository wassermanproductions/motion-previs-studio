'use strict';

const HANDOFF_VERSION = 1;

function buildSetReferenceParams(videoPath, mode, opacity, includeVersion = true) {
  return {
    path: videoPath,
    mode,
    opacity,
    ...(includeVersion ? { handoffVersion: HANDOFF_VERSION } : {})
  };
}

function shouldRetryLegacyHandoff(responseStatus, errorText) {
  if (responseStatus < 400 && responseStatus !== 200) return false;
  const text = String(errorText || '');
  return /(unknown|unexpected|unsupported|invalid).{0,40}(handoffVersion|handoff version)|(handoffVersion|handoff version).{0,40}(unknown|unexpected|unsupported|invalid)/i.test(text);
}

module.exports = { HANDOFF_VERSION, buildSetReferenceParams, shouldRetryLegacyHandoff };
