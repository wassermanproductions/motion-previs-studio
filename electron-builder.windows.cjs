'use strict';

const base = require('./package.json').build;

module.exports = {
  ...base,
  files: [...base.files],
  extraResources: [
    ...base.extraResources,
    { from: 'runtime/media/win32-x64/ffmpeg.exe', to: 'media/ffmpeg.exe' },
    { from: 'runtime/media/win32-x64/ffprobe.exe', to: 'media/ffprobe.exe' },
    { from: 'runtime/media/win32-x64/LICENSE.txt', to: 'media/LICENSE.txt' },
    { from: 'runtime/media/win32-x64/PROVENANCE.json', to: 'media/PROVENANCE.json' }
  ]
};
