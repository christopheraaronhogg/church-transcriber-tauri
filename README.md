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
- If no release exists yet, create one first (see release section below).

---

## Features in this build

- Primary + optional secondary folder runs (sequential)
- Pause / Resume via safe checkpoint flag file
- Stop request support
- Live stdout/stderr log streaming
- Date filter, thread count, test limit, and common flags
- Optional script-path override (advanced)

Pause behavior:
- Pause is checkpoint-based (the current ffmpeg/whisper step may finish first)
- Resume removes the pause flag and continues

---

## Runtime requirements on target machine (Windows church PC)

1. FFmpeg available on PATH
2. whisper.cpp executable (for example `C:\\ai\\whisper\\whisper-cli.exe`)
3. whisper model file (for example `C:\\ai\\whisper-models\\ggml-small.en.bin`)

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

This repo includes `.github/workflows/release-windows.yml`.

- Trigger: push a tag starting with `v` (for example `v0.1.0`)
- Output: Windows installer assets attached to a GitHub Release

Example:

```bash
git tag v0.1.0
git push origin v0.1.0
```

After release assets are published, the one-liner installer above is live.

---

## Notes

This is intentionally v1 and focused on reliability + operator speed.
Planned production hardening includes:
- startup dependency diagnostics + guided fixes
- richer progress/ETA indicators
- exportable run-error bundles
- clean-machine validation checklist
