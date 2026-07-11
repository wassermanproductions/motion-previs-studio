# Third-Party Notices

Motion Previs Studio is distributed under Apache-2.0. Its dependency graph is
recorded in `package-lock.json`; release builds also publish an SBOM.

The packaged media executables are separate works under their own licenses:

- Windows installers use the pinned BtbN GPL-3.0-or-later FFmpeg/FFprobe pair recorded in
  `ASSET_MANIFEST.json`. The binaries are checked by archive hash, extracted
  file hashes, required/forbidden configure flags, and are packaged with their
  license and provenance. Exact BtbN build scripts and FFmpeg source archives
  are included in the Windows release compliance bundle.
- macOS packages build a native FFmpeg/FFprobe pair from the pinned
  `mifi/ffmpeg-build-script` commit and the exact source archives recorded in
  `ASSET_MANIFEST.json`. The recipe is patched to enable GPL/version3/libx264,
  disable nonfree/OpenSSL inputs, and is audited before packaging; its patch,
  license, build provenance, and corresponding source archives ship in the
  release compliance bundle.
- Linux development uses `MOTION_PREVIS_FFMPEG` and
  `MOTION_PREVIS_FFPROBE` overrides, then PATH. Linux packages remain
  publication-blocked until an audited native asset recipe is supplied. No
  static npm media binaries are dependencies or packaged resources.
- `yt-dlp` 2026.07.04 is distributed under The Unlicense. Its publisher SHA-256
  checksums are pinned in `ASSET_MANIFEST.json`.
- The packaged Electron runtime is MIT licensed. The renderer bundle includes
  React, React DOM, and Three.js under MIT; Lucide React under ISC; and
  Transformers.js plus MediaPipe Tasks Vision under Apache-2.0. Archiver and
  its production dependency graph are recorded in `package-lock.json` and the
  release SBOMs.
- The pinned MediaPipe pose task assets are provided under Apache-2.0.
- The Depth Anything model is a
  first-use download pinned to the revision in `ASSET_MANIFEST.json` and remains
  subject to its upstream model terms.

This notice is informational and does not replace the complete license texts
shipped with the relevant packages and release compliance bundle.
