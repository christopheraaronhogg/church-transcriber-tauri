import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import "./App.css";

type RunnerStatus = {
  running: boolean;
  paused: boolean;
  stopRequested: boolean;
};

type LogEvent = {
  stream: string;
  line: string;
};

type StageEvent = {
  index: number;
  total: number;
  inputFolder: string;
};

type FinishEvent = {
  success: boolean;
  code: number;
  message: string;
};

type StartRequest = {
  inputFolders: string[];
  outputFolder: string;
  whisperExe: string;
  modelFile: string;
  beforeDate?: string;
  threads: number;
  limit?: number;
  fastScan: boolean;
  force: boolean;
  noRecursive: boolean;
  keepAudio: boolean;
  scriptPath?: string;
};

const MAX_LOG_LINES = 1200;

function App() {
  const [status, setStatus] = useState<RunnerStatus>({
    running: false,
    paused: false,
    stopRequested: false,
  });

  const [primaryInput, setPrimaryInput] = useState("D:\\vMix");
  const [secondaryInput, setSecondaryInput] = useState("");
  const [outputFolder, setOutputFolder] = useState("D:\\ChurchTranscripts");
  const [whisperExe, setWhisperExe] = useState("C:\\ai\\whisper\\whisper-cli.exe");
  const [modelFile, setModelFile] = useState("C:\\ai\\whisper-models\\ggml-small.en.bin");
  const [beforeDate, setBeforeDate] = useState("2024-12-31");
  const [threads, setThreads] = useState("5");
  const [limit, setLimit] = useState("");
  const [fastScan, setFastScan] = useState(false);
  const [force, setForce] = useState(false);
  const [noRecursive, setNoRecursive] = useState(false);
  const [keepAudio, setKeepAudio] = useState(false);
  const [scriptPath, setScriptPath] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [busy, setBusy] = useState(false);
  const [stageLabel, setStageLabel] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([
    "[system] Ready.",
    "[system] Pause uses safe checkpoints (current ffmpeg/whisper step may finish first).",
  ]);

  const inputFolders = useMemo(
    () => [primaryInput.trim(), secondaryInput.trim()].filter(Boolean),
    [primaryInput, secondaryInput],
  );

  function pushLog(stream: string, text: string) {
    const line = `[${stream}] ${text}`;
    setLogs((prev) => {
      const next = [...prev, line];
      if (next.length > MAX_LOG_LINES) {
        return next.slice(next.length - MAX_LOG_LINES);
      }
      return next;
    });
  }

  useEffect(() => {
    let isMounted = true;

    const unsubs: Array<() => void> = [];

    (async () => {
      try {
        const current = await invoke<RunnerStatus>("get_runner_status");
        if (isMounted) {
          setStatus(current);
          if (current.running) {
            setStageLabel(current.paused ? "Paused" : "Running");
          }
        }
      } catch (error) {
        pushLog("system", `Could not read initial status: ${String(error)}`);
      }

      const unlistenLog = await listen<LogEvent>("transcribe://log", (event) => {
        pushLog(event.payload.stream, event.payload.line);
      });
      unsubs.push(unlistenLog);

      const unlistenStatus = await listen<RunnerStatus>("transcribe://status", (event) => {
        setStatus(event.payload);
      });
      unsubs.push(unlistenStatus);

      const unlistenStage = await listen<StageEvent>("transcribe://stage", (event) => {
        const { index, total, inputFolder } = event.payload;
        const label = `Running ${index}/${total}: ${inputFolder}`;
        setStageLabel(label);
        pushLog("stage", label);
      });
      unsubs.push(unlistenStage);

      const unlistenFinished = await listen<FinishEvent>("transcribe://finished", (event) => {
        const { success, code, message } = event.payload;
        setStageLabel(success ? "Complete" : "Stopped / Failed");
        pushLog("system", `${success ? "Complete" : "Ended"} (code ${code}): ${message}`);
      });
      unsubs.push(unlistenFinished);
    })();

    return () => {
      isMounted = false;
      unsubs.forEach((off) => off());
    };
  }, []);

  async function pickFolder(setter: (value: string) => void, currentValue: string) {
    const selected = await open({
      directory: true,
      multiple: false,
      defaultPath: currentValue || undefined,
      title: "Select folder",
    });

    if (typeof selected === "string") {
      setter(selected);
    }
  }

  async function pickFile(setter: (value: string) => void, currentValue: string) {
    const selected = await open({
      directory: false,
      multiple: false,
      defaultPath: currentValue || undefined,
      title: "Select file",
    });

    if (typeof selected === "string") {
      setter(selected);
    }
  }

  async function runTranscription() {
    if (inputFolders.length === 0) {
      pushLog("system", "Primary input folder is required.");
      return;
    }

    const parsedThreads = Number.parseInt(threads, 10);
    if (Number.isNaN(parsedThreads) || parsedThreads < 1) {
      pushLog("system", "Threads must be a positive number.");
      return;
    }

    const parsedLimit = Number.parseInt(limit, 10);
    const request: StartRequest = {
      inputFolders,
      outputFolder: outputFolder.trim(),
      whisperExe: whisperExe.trim(),
      modelFile: modelFile.trim(),
      beforeDate: beforeDate.trim() ? beforeDate.trim() : undefined,
      threads: parsedThreads,
      limit: Number.isNaN(parsedLimit) || parsedLimit <= 0 ? undefined : parsedLimit,
      fastScan,
      force,
      noRecursive,
      keepAudio,
      scriptPath: scriptPath.trim() ? scriptPath.trim() : undefined,
    };

    try {
      setBusy(true);
      setStageLabel("Starting...");
      pushLog("system", "Starting transcription run...");
      const nextStatus = await invoke<RunnerStatus>("start_transcription", { request });
      setStatus(nextStatus);
    } catch (error) {
      pushLog("system", `Start failed: ${String(error)}`);
      setStageLabel("Idle");
    } finally {
      setBusy(false);
    }
  }

  async function togglePause() {
    if (!status.running) {
      return;
    }

    try {
      setBusy(true);
      const nextPaused = !status.paused;
      const nextStatus = await invoke<RunnerStatus>("toggle_pause", { paused: nextPaused });
      setStatus(nextStatus);
      setStageLabel(nextPaused ? "Pause requested" : "Resuming");
    } catch (error) {
      pushLog("system", `Pause/resume failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function stopRun() {
    if (!status.running) {
      return;
    }

    try {
      setBusy(true);
      const nextStatus = await invoke<RunnerStatus>("stop_transcription");
      setStatus(nextStatus);
      setStageLabel("Stopping...");
    } catch (error) {
      pushLog("system", `Stop failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  const statusText = status.running ? (status.paused ? "PAUSED" : "RUNNING") : "IDLE";

  return (
    <main className="app-shell">
      <header className="hero">
        <div className="hero-left">
          <div className="hero-kicker">[ INDUSTRIAL KEYBOARD BRUTALISM ]</div>
          <h1>Church Transcriber</h1>
          <p>Operator console for FFmpeg + whisper.cpp transcription runs.</p>
        </div>

        <div className={`status-pill ${status.running ? (status.paused ? "paused" : "running") : "idle"}`}>
          <span className="status-label">STATE</span>
          <span className="status-value">{statusText}</span>
        </div>
      </header>

      <section className="panel">
        <div className="panel-title">[ RUN CONFIG ]</div>

        <div className="grid">
          <label className="field">
            <span className="field-title">[ PRIMARY INPUT FOLDER ]</span>
            <div className="field-row">
              <input value={primaryInput} onChange={(e) => setPrimaryInput(e.target.value)} />
              <button type="button" className="key-btn" onClick={() => pickFolder(setPrimaryInput, primaryInput)}>
                Browse
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-title">[ SECONDARY INPUT (OPTIONAL) ]</span>
            <div className="field-row">
              <input value={secondaryInput} onChange={(e) => setSecondaryInput(e.target.value)} />
              <button type="button" className="key-btn" onClick={() => pickFolder(setSecondaryInput, secondaryInput)}>
                Browse
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-title">[ OUTPUT TRANSCRIPT FOLDER ]</span>
            <div className="field-row">
              <input value={outputFolder} onChange={(e) => setOutputFolder(e.target.value)} />
              <button type="button" className="key-btn" onClick={() => pickFolder(setOutputFolder, outputFolder)}>
                Browse
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-title">[ WHISPER EXECUTABLE ]</span>
            <div className="field-row">
              <input value={whisperExe} onChange={(e) => setWhisperExe(e.target.value)} />
              <button type="button" className="key-btn" onClick={() => pickFile(setWhisperExe, whisperExe)}>
                Browse
              </button>
            </div>
          </label>

          <label className="field">
            <span className="field-title">[ WHISPER MODEL FILE ]</span>
            <div className="field-row">
              <input value={modelFile} onChange={(e) => setModelFile(e.target.value)} />
              <button type="button" className="key-btn" onClick={() => pickFile(setModelFile, modelFile)}>
                Browse
              </button>
            </div>
          </label>

          <div className="grid-inline">
            <label className="field">
              <span className="field-title">[ BEFORE DATE ]</span>
              <input value={beforeDate} onChange={(e) => setBeforeDate(e.target.value)} placeholder="YYYY-MM-DD" />
            </label>

            <label className="field">
              <span className="field-title">[ THREADS ]</span>
              <input value={threads} onChange={(e) => setThreads(e.target.value)} />
            </label>

            <label className="field">
              <span className="field-title">[ TEST LIMIT ]</span>
              <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Blank = full run" />
            </label>
          </div>

          <div className="toggles">
            <label className="toggle-line">
              <input type="checkbox" checked={fastScan} onChange={(e) => setFastScan(e.target.checked)} />
              <span>[ FAST SCAN ]</span>
            </label>
            <label className="toggle-line">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>[ FORCE OVERWRITE ]</span>
            </label>
            <label className="toggle-line">
              <input type="checkbox" checked={noRecursive} onChange={(e) => setNoRecursive(e.target.checked)} />
              <span>[ TOP FOLDER ONLY ]</span>
            </label>
            <label className="toggle-line">
              <input type="checkbox" checked={keepAudio} onChange={(e) => setKeepAudio(e.target.checked)} />
              <span>[ KEEP WAV FILES ]</span>
            </label>
          </div>

          <button type="button" className="advanced-toggle key-btn" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? "Hide" : "Show"} Advanced
          </button>

          {showAdvanced ? (
            <label className="field">
              <span className="field-title">[ SCRIPT PATH OVERRIDE ]</span>
              <div className="field-row">
                <input
                  value={scriptPath}
                  onChange={(e) => setScriptPath(e.target.value)}
                  placeholder="Auto-detected if empty"
                />
                <button type="button" className="key-btn" onClick={() => pickFile(setScriptPath, scriptPath)}>
                  Browse
                </button>
              </div>
            </label>
          ) : null}
        </div>

        <div className="action-row">
          <button
            type="button"
            className="key-btn key-btn--accent"
            disabled={busy || status.running}
            onClick={runTranscription}
          >
            Run Transcription
          </button>

          <button type="button" className="key-btn" disabled={busy || !status.running} onClick={togglePause}>
            {status.paused ? "Resume" : "Pause"}
          </button>

          <button type="button" className="key-btn key-btn--danger" disabled={busy || !status.running} onClick={stopRun}>
            Stop
          </button>

          <div className="run-meta">
            <span className="run-meta-main">{stageLabel}</span>
            {status.stopRequested ? <span className="warn">[ STOP REQUESTED ]</span> : null}
          </div>
        </div>

        <p className="hint">Pause is checkpoint-based. Active ffmpeg/whisper step may finish before pause engages.</p>
      </section>

      <section className="panel log-panel">
        <div className="log-header">
          <h2>[ LIVE LOG ]</h2>
          <button type="button" className="key-btn" onClick={() => setLogs([])}>
            Clear
          </button>
        </div>
        <pre>{logs.join("\n")}</pre>
      </section>
    </main>
  );
}

export default App;
