# Church Transcriber (Tauri v1)

Desktop wrapper for the church transcription batch workflow.

- Frontend: React + TypeScript
- Desktop shell / process control: Tauri 2 + Rust
- Engine: existing `church_transcribe_batch.ps1` (FFmpeg + whisper.cpp)

---

## Design system snapshot (from existing WinForms tool)

The original PowerShell GUI established a **utilitarian operations-console** style:

- Dense form-first layout (path fields + run controls)
- High readability over visual flourish
- Prominent run controls and persistent live log pane
- Practical defaults (D:\\vMix, D:\\ChurchTranscripts, whisper/model paths)

This Tauri version keeps the same operating model and controls, while modernizing:

- clearer status signaling (IDLE / RUNNING / PAUSED)
- cleaner field grouping
- stronger pause/resume affordances
- real-time stream logs with capped history

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

## Local development

```bash
cd church-transcriber-tauri
npm install
npm run tauri dev
```

## Desktop bundle

```bash
npm run tauri build
```

The bundled app includes:
- `src-tauri/resources/church_transcribe_batch.ps1`

---

## Runtime requirements on target machine (Windows church PC)

1. FFmpeg available on PATH
2. whisper.cpp executable (for example `C:\\ai\\whisper\\whisper-cli.exe`)
3. whisper model file (for example `C:\\ai\\whisper-models\\ggml-small.en.bin`)

---

## Notes

This is intentionally v1 and focused on reliability + operator speed.
If desired, v2 can add:
- settings profiles
- persisted run history
- dependency diagnostics + one-click setup checks
- post-run “Brother Bob finder” panel
