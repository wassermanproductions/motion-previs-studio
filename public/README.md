<!-- Modified for cross-platform Windows support in 2026; see MODIFICATIONS.md. -->

# Motion Previs Studio Public Runtime Assets

The app uses generated runtime assets under `public/mediapipe`, `public/models`,
and `runtime/bin`. They are intentionally not committed to this repository.

Run `npm install` or `npm run prepare-assets` to populate them:

- MediaPipe WASM files are copied from `@mediapipe/tasks-vision`.
- All three pose landmarker task files are downloaded from pinned official
  MediaPipe URLs and verified against `ASSET_MANIFEST.json`.
- The platform-specific `yt-dlp` 2026.07.04 executable is stored outside the
  web assets and verified against its publisher SHA-256 before packaging.
