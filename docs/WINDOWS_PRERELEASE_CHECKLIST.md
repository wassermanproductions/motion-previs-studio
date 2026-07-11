# Windows 11 Prerelease Checklist

Automated Windows CI verifies the unpacked application, bundled media binaries,
descriptor identity, assisted per-user NSIS install, launch with a minimal PATH,
silent uninstall, retained user data, checksums/SBOMs, and a best-effort Defender
custom scan. The following visible Windows 11 VM checks remain a required manual
prerelease gate.

## Installer and trust

- Verify the downloaded installer with `Get-FileHash .\Motion-Previs-Studio-*.exe -Algorithm SHA256` and match `SHA256SUMS` before running it.
- Confirm the unsigned SmartScreen screen identifies an unrecognized app; use **More info → Run anyway** only after the hash matches.
- Run a Microsoft Defender custom scan over the installer and installed folder and record the clean result.
- Install without elevation, choose a non-default directory containing spaces, and confirm desktop and Start Menu shortcuts.

## Native Windows behavior

- At both 100% and 150% display scaling, verify the native title bar controls, app icon, taskbar grouping, dialogs, tooltips, and all primary panels remain usable.
- Use **Open Folder** and **Show ZIP in Folder** and confirm File Explorer opens/selects the correct files.
- Confirm no console windows appear during yt-dlp, FFmpeg, FFprobe, analysis, export, cancel, MCP, or Blockout handoff operations.

## Primary flow

- Use a source path under `OneDrive - Studio\Director's Cut\José` and exercise local import, controlled HTTP URL import, trim, pose, camera solve, all control layers, OpenPose, production-pack ZIP, cancellation, relink after moving source media, MCP control, and Motion → Blockout handoff v1 across restart.
- Inspect `bundle_manifest.json` and `analysis_manifest.json`: all production-pack filenames must be relative with `/` separators and no drive/UNC/user path leakage.
- Repeat with system FFmpeg/FFprobe absent from PATH and confirm the bundled BtbN pair is used.

## Uninstall and data

- Uninstall from Windows Settings and from the generated uninstaller; confirm application files and shortcuts are removed.
- Confirm the machine-local project/session/model data root is intentionally retained, and that upstream-generic and downstream-distributor data roots do not collide.
- Record Windows edition/build, installer SHA-256, display scale, Defender result, install directory, and any SmartScreen behavior in the prerelease evidence.
