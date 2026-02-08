# Church Transcriber (Tauri v1)

Desktop wrapper for the church transcription batch workflow.

- Frontend: React + TypeScript
- Desktop shell / process control: Tauri 2 + Rust
- Engine: existing `church_transcribe_batch.ps1` (FFmpeg + whisper.cpp)
- UI style: **Industrial Keyboard Brutalism** (keyboard-first neo-brutalist)

---

## One-command install (Windows)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/christopheraaronhogg/church-transcriber-tauri/main/install.ps1 | iex"
```

Notes:
- Installer pulls from the **latest GitHub release**.
- By default it also installs dependencies (`ffmpeg`, `whisper.cpp`, `ggml-small.en.bin`).
- If no release exists yet, create one first (see release section below).

Optional flags:
```powershell
# Install app only (skip dependency bootstrap)
powershell -NoProfile -ExecutionPolicy Bypass -Command "& ([ScriptBlock]::Create((irm https://raw.githubusercontent.com/christopheraaronhogg/church-transcriber-tauri/main/install.ps1))) -SkipDependencies"
```

---

## Features in this build

- Primary + optional secondary folder runs (sequential)
- Pause / Resume via safe checkpoint flag file
- Stop request support
- Live stdout/stderr log streaming
- Live file-progress parsing (`[progress] done=... total=...`)
- Preflight diagnostics panel (dependency + path + writeability checks)
- Exportable run logs to output folder
- Date filter, thread count, test limit, and common flags
- Optional script-path override (advanced)

Pause behavior:
- Pause is checkpoint-based (the current ffmpeg/whisper step may finish first)
- Resume removes the pause flag and continues

---

## Runtime requirements on target machine (Windows church PC)

The default installer bootstraps these automatically:

1. FFmpeg on PATH
2. whisper.cpp executable (default target: `C:\\ai\\whisper\\whisper-cli.exe`)
3. whisper model file (default target: `C:\\ai\\whisper-models\\ggml-small.en.bin`)

If dependency bootstrap is skipped, provide these manually before running transcription.

---

## Local development

```bash
cd church-transcriber-tauri
npm install
npm run tauri dev
```

Build locally:

```bash
npm run tauri build
```

---

## Release flow (GitHub Actions)

This repo includes:
- `.github/workflows/ci.yml` (build verification on push/PR)
- `.github/workflows/release-windows.yml` (tagged Windows release)

Release workflow:
- Trigger: push a tag starting with `v` (for example `v0.2.0`)
- Output: Windows installer assets attached to a GitHub Release

Example:

```bash
git tag v0.2.0
git push origin v0.2.0
```

After release assets are published, the one-liner installer above is live.

---

## Notes

Current production-hardening in place:
- startup preflight diagnostics + guided fixes
- file-level progress tracking
- exportable run logs
- one-command installer + dependency bootstrap

Still recommended before broad rollout:
- clean-machine install validation on a real church PC
- optional telemetry/error reporting policy (if desired)
