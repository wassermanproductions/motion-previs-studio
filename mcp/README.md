# Motion Previs Studio MCP — drive the app from an AI agent

Motion Previs Studio ships a small [MCP](https://modelcontextprotocol.io) server so an AI agent — **Claude Code, Codex, Hermes, or any MCP client** — can drive a **running** copy of the app: import a shot, trim the range, pick a reference mode, run the pose/depth/camera analysis, export the production pack, and hand a clip to Blockout. It's the same set of moves you'd make by hand, exposed as tools.

This is the agent-integration guide. For the product itself, see the [main README](../README.md).

---

## How it works

```
 MCP client  ──stdio──▶  motion-previs-mcp.mjs  ──HTTP+bearer──▶  control server  ──IPC──▶  renderer
 (Claude Code)           (this bridge)           127.0.0.1:<rnd>   (electron/main)           (the app)
```

- On launch, the app's main process starts a **localhost-only HTTP control server** on a **random port** with a **bearer token**, and writes descriptor protocol v1 — `{ protocolVersion, app, appVersion, port, token, pid, startedAt, capabilities }` — to `~/.config/motion-previs/control.json` on macOS/Linux or `%APPDATA%\Motion Previs Studio\v4\control.json` on Windows. `MOTION_PREVIS_CONFIG_DIR` overrides the directory for CI and managed environments.
- The bridge **`motion-previs-mcp.mjs`** is a zero-dependency Node ≥18 stdio server. It reads that file, forwards each `tools/call` to the control server, which relays it to the renderer over the `control:invoke` / `control:result` IPC pair and returns the result.
- **Discovery and auth are automatic** — nothing to configure. The server binds `127.0.0.1` only and every request must carry the bearer token, so it is not reachable off-machine. The port is random, so there are no port conflicts.
- **The app must be running.** If it isn't, every tool returns `Motion Previs Studio isn't running — launch the app first.` Launch with `npm run dev` (or the packaged app) so the control server comes up.

---

## Connect

Use the bridge's **absolute path** in every config below. From a source checkout,
that is `/ABSOLUTE/PATH/motion-previs-studio/mcp/motion-previs-mcp.mjs`. In an
installed Windows build it is under the selected installation directory at
`resources\mcp\motion-previs-mcp.mjs`.

### Claude Code

One line:

```bash
claude mcp add motion-previs -- node "/ABSOLUTE/PATH/motion-previs-studio/mcp/motion-previs-mcp.mjs"
```

Then in a session, `/mcp` should list **motion-previs** as connected (once the app is running). Remove it with `claude mcp remove motion-previs`.

### Codex CLI

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.motion-previs]
command = "node"
args = ["/ABSOLUTE/PATH/motion-previs-studio/mcp/motion-previs-mcp.mjs"]
```

### Hermes

The bridge is also published standalone at [wassermanproductions/motion-previs-mcp](https://github.com/wassermanproductions/motion-previs-mcp) for Hermes's git-install flow (a catalog entry is proposed in [hermes-agent#60718](https://github.com/NousResearch/hermes-agent/pull/60718) — once merged, `hermes mcp install official/motion-previs-studio` is all you need). Manual config in `~/.hermes/config.yaml` (the app must be running for the tools to respond):

```yaml
mcp_servers:
  motion-previs:
    command: "node"
    args: ["/ABSOLUTE/PATH/motion-previs-studio/mcp/motion-previs-mcp.mjs"]
```

### Any generic MCP client

Any client that takes the standard stdio server list accepts this JSON block:

```json
{
  "mcpServers": {
    "motion-previs": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/motion-previs-studio/mcp/motion-previs-mcp.mjs"]
    }
  }
}
```

No `env`, no headers, no URL — the bridge discovers the running app on its own.

---

## Tools

11 tools. Times are in **seconds**.

| Tool | Params | Does |
|---|---|---|
| `get_state` | — | **Call first, and poll during analysis.** Loaded media, shot range, reference mode, settings, and analysis progress `{ status, stage, progress, poseFrames, detectedFrames, cameraConfidence, qualityScore }`, plus `lastBundlePath` and `blockoutAvailable`. |
| `import_file` | `path` | Load a local media file by absolute path as the reference shot. |
| `import_url` | `url` | Download a web video (yt-dlp) and load it as the reference shot. |
| `set_range` | `startS, endS` | Set the trim window (seconds) analysis/export use. |
| `set_mode` | `mode: camera_only\|actor_motion\|object_motion\|full_scene` | Set what to preserve from the reference. |
| `set_settings` | `sampleFps?, maxPeople?, smoothing?, detectionConfidence?, trackingConfidence?, resolution?` | Adjust analysis settings; omitted fields unchanged. |
| `run_analysis` | — | Kick the full pipeline (prepare → pose → camera). Returns `{ started: true }`; poll `get_state` until `analysis.status === "done"`. |
| `export_pack` | — | Render + save the production pack. **Awaits** and returns `{ bundlePath, zipPath }`. Needs a completed analysis. |
| `list_bundle` | — | List files in the last exported bundle. |
| `send_to_blockout` | `which: reference\|depth\|ai_depth\|pose\|openpose` | Send a bundle clip to a running Blockout session as a ghost underlay. |
| `screenshot` | — | Capture the app window as a PNG (returned as an image result). |

---

## A worked session

Launch the app first (`npm run dev`), then have the agent run:

```jsonc
// 1. Orient — always start here.
get_state {}
// → { media: null, range: {...}, analysis: { status: "idle" }, ... }

// 2. Load a shot and trim it.
import_file { "path": "/path/to/clips/chase.mp4" } // macOS/Linux
// import_file { "path": "C:\\Users\\me\\Videos\\chase.mp4" } // Windows
set_range { "startS": 0, "endS": 3 }
set_mode { "mode": "camera_only" }
set_settings { "sampleFps": 6 }

// 3. Analyze, then poll until done.
run_analysis {}                 // → { started: true }
get_state {}                    // repeat until analysis.status === "done"

// 4. Export the production pack (this one waits).
export_pack {}                  // → { bundlePath, zipPath }
list_bundle {}

// 5. Hand the reference to a running Blockout session.
send_to_blockout { "which": "reference" }

// Look at the UI any time.
screenshot {}
```

---

## Troubleshooting

| Symptom | Cause & fix |
|---|---|
| `Motion Previs Studio isn't running — launch the app first.` | The app isn't up (or has quit). Launch `npm run dev` / the packaged app and retry; the control server starts with the app. |
| Tools connect but every call errors after a restart | The descriptor may be stale after a crash. It is `~/.config/motion-previs/control.json` on macOS/Linux or `%APPDATA%\Motion Previs Studio\v4\control.json` on Windows. Quit the app fully and relaunch; if needed, delete the file and start the app again. |
| `No media loaded` errors | Call `import_file` or `import_url` before `run_analysis`. |
| `No completed analysis` on `export_pack` | Wait until `get_state` reports `analysis.status === "done"` before exporting. |
| `node: command not found` in the client | The MCP client's PATH doesn't include Node. Use an absolute node path in the config's `command`, or launch the client from a shell where `node --version` works (Node ≥18). |
| Port conflicts | None to worry about — the control server binds a **random** localhost port each launch and advertises it via the discovery file. |

The bridge and control server are localhost-only and token-gated; nothing is exposed off your machine.
