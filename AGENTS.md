# AGENTS.md — running & modifying Motion Previs Studio with an AI agent

This file is the single source of truth for AI coding agents (Claude Code, Codex, Hermes, …) working on this repo. Read it before making changes.

## What this app is

Electron + TypeScript + React desktop app. Filmmakers import a reference video shot, extract **pose** (MediaPipe), **depth**, a **subject-masked optical-flow camera solve**, edges/lineart/masks/normals control layers, and **OpenPose BODY_25** skeleton video + keypoints, then export a production pack (control videos + prompts + Blender scripts + ZIP) for AI-video generators (Seedance, ComfyUI, Runway, Kling) and Blender. All ML runs locally in the renderer.

## Commands

```bash
npm install            # once; runs scripts/prepare-mediapipe-assets.cjs (postinstall)
npm run dev            # Vite + Electron with hot reload (127.0.0.1 only)
npm run build          # tsc + vite build into dist/
npm start              # run the production build
npm run verify         # smoke checks (tests/smoke.cjs)
npm run verify:quality # unified quality-score sync check
npm run verify:engines # engine/runtime checks
npm run verify:e2e     # headless Electron export; asserts openpose_pose.mp4 + openpose_keypoints.json land in the bundle
npm run verify:all     # verify + build + verify:e2e
npm run dist           # electron-builder → arm64 DMG + ZIP in release/
```

**Definition of done for any change: `npm run build && npm run verify:quality && npm run verify:engines && npm run verify:e2e` green.** Run `npm run verify:all` before shipping.

## Repo map

```
src/                React UI. App.tsx owns the whole studio surface.
src/lib/            Pure-ish analysis modules, all locally runnable:
                    pose.ts (MediaPipe), cameraMotion.ts (LK + RANSAC camera solve),
                    aiDepth.ts (Depth Anything), openpose.ts (BODY_25 render + JSON),
                    poseVideo.ts, frameEncoder.ts (deterministic ffmpeg frame encode),
                    quality.ts (single source of the unified quality score).
src/components/     ThreePreview (three.js stick figure), PoseCanvas.
src/control/        Agent-control renderer layer: registry.ts (the window.__mps surface
                    contract), handler.ts (whitelisted action dispatcher, wired from main.tsx).
electron/           main.cjs (window, IPC, ffmpeg, save/restore, Send to Blockout, control server wiring),
                    control.cjs (localhost HTTP agent-control server + discovery file),
                    preload.cjs (window.motionPrevis bridge), security.cjs (path + IPC allowlist).
mcp/                motion-previs-mcp.mjs (zero-dep stdio MCP bridge) + README.md (agent-integration guide).
shared/             quality.cjs — the CJS mirror of src/lib/quality.ts (verify:quality checks they agree).
tests/              e2e-electron.cjs (real export + control-server smoke), smoke, quality-sync, engines.
public/             generated MediaPipe/model/bin assets (gitignored).
```

## Hard rules

1. **Determinism.** Control videos are encoded frame-by-frame through the `frameEncoder` bridge — never `captureStream` or wall-clock timers. `verify:e2e` renders real frames; keep it reproducible.
2. **Security.** All renderer file access goes through the `mps://` protocol and the `security.cjs` allowlist (`isAllowedPath` / `allowImportSource`). Never hand the renderer a raw `file://` path or accept an arbitrary path in an IPC handler without validating it against the allowlist. `webSecurity` stays on.
3. **Quality score has one source.** `src/lib/quality.ts` is the definition; `shared/quality.cjs` mirrors it and `verify:quality` asserts they agree. Change both together.
4. **Cancellation is cooperative.** Long loops (pose, camera, aiDepth, frameEncoder) accept an `AbortSignal` and check it between frames via `throwIfAborted` / `signal.aborted`, throwing an `Error` whose `name` is `'AbortError'`. Preserve that contract so Cancel stays clean.
5. **Credit + license stay intact.** Apache-2.0, the `NOTICE` file, and the in-app "Created by Sam Wasserman · wassermanproductions.com · wasserman.ai · Apache-2.0" credit must be preserved.

## Send to Blockout

After export, the main process reads a sibling app's control descriptor at `~/.config/blockout/control.json` (`{ port, token }`) and POSTs a `set_reference` action (`{ path, mode, opacity }`) to Blockout's localhost control server. Only files inside the app workspace allowlist are sent. The UI shows a live availability dot and disables the buttons with a friendly toast when Blockout isn't running.

## Agent control (MCP)

The app is drivable by an external AI agent (Claude Code, Codex, Hermes) exactly like Blockout. On `whenReady`, `electron/control.cjs` starts a **localhost-only, token-gated HTTP control server** on a random port and writes `~/.config/motion-previs/control.json` (`{ port, token, pid, startedAt }`, mode `0600`, deleted on `will-quit`). `GET /health` is unauthenticated; `POST /rpc` is Bearer-auth'd and forwards `{ action, params }` to the renderer over the `control:invoke` / `control:result` IPC pair (correlation-id + per-action timeouts). `screenshot` is served main-side via `webContents.capturePage`.

The renderer registers `registerControlHandler()` (`src/control/handler.ts`) from `main.tsx`; it dispatches whitelisted actions against the `window.__mps` surface that `App.tsx` publishes (`src/control/registry.ts` is the contract). **Every action runs the SAME flow as the equivalent UI click** — `import_file`/`import_url` reuse `acceptSource`, `run_analysis` calls `runAnalysis`, `export_pack` awaits `exportBundle`, `send_to_blockout` reuses the Send-to-Blockout IPC. Keep it that way: don't fork logic into the handler.

The MCP bridge `mcp/motion-previs-mcp.mjs` is a zero-dependency Node ≥18 stdio server (newline-delimited JSON-RPC 2.0) that reads the discovery file and forwards `tools/call` to `/rpc`. 11 tools; see `mcp/README.md`. Whenever you add or change a control action, update the action list in `handler.ts`, the surface in `registry.ts`, the tool schema in the mjs, and the table in `mcp/README.md` together. Run `node --check mcp/motion-previs-mcp.mjs`.

## No private notes

Do **not** add private QA notes, internal handoff docs, model-specific scratch files, or any "for the agent" markdown to the repo or its git history. Keep the working tree and history free of internal-only files. If you need scratch space, use a location outside the repo.
