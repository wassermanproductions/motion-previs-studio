# Motion Previs Studio v3 Public Runtime Assets

The app uses generated runtime assets under `public/mediapipe`, `public/models`,
and `public/bin`. They are intentionally not committed to this repository.

Run `npm install` or `npm run prepare-assets` to populate them:

- MediaPipe WASM files are copied from `@mediapipe/tasks-vision`.
- The pose landmarker model is downloaded from the official MediaPipe model bucket.
- `yt-dlp` is downloaded for URL imports when possible; otherwise the app falls back to `yt-dlp` on `PATH`.
