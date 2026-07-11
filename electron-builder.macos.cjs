'use strict';

const base = require('./package.json').build;
const arch = process.arch;

module.exports = {
  ...base,
  extraResources: [
    ...base.extraResources,
    { from: `runtime/media/darwin-${arch}/ffmpeg`, to: 'media/ffmpeg' },
    { from: `runtime/media/darwin-${arch}/ffprobe`, to: 'media/ffprobe' },
    { from: `runtime/media/darwin-${arch}/LICENSE.txt`, to: 'media/LICENSE.txt' },
    { from: `runtime/media/darwin-${arch}/PROVENANCE.json`, to: 'media/PROVENANCE.json' }
  ]
};
