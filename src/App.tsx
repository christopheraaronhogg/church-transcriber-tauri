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

type PreflightRequest = {
  inputFolders: string[];
  outputFolder: string;
  whisperExe: string;
  modelFile: string;
  scriptPath?: string;
};

type PreflightCheck = {
  key: string;
  ok: boolean;
  detail: string;
  fix: string;
};

type PreflightReport = {
  ready: boolean;
  checks: PreflightCheck[];
  resolvedScriptPath?: string;
  generatedAtEpoch: number;
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
  const [preflightBusy, setPreflightBusy] = useState(false);
  const [stageLabel, setStageLabel] = useState("Idle");
  const [logs, setLogs] = useState<string[]>([
    "[system] Ready.",
    "[system] Pause uses safe checkpoints (current ffmpeg/whisper step may finish first).",
  ]);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [progressDone, setProgressDone] = useState(0);
  const [progressTotal, setProgressTotal] = useState(0);

  const inputFolders = useMemo(
    () => [primaryInput.trim(), secondaryInput.trim()].filter(Boolean),
    [primaryInput, secondaryInput],
  );

  const progressPercent = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;

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

  function ingestLog(stream: string, line: string) {
    pushLog(stream, line);

    const match = line.match(/\[progress\]\s+done=(\d+)\s+total=(\d+)(?:\s+status=([^\s]+))?/i);
    if (match) {
      const done = Number.parseInt(match[1] || "0", 10);
      const total = Number.parseInt(match[2] || "0", 10);
      if (!Number.isNaN(done)) setProgressDone(done);
      if (!Number.isNaN(total)) setProgressTotal(total);

      if ((match[3] || "").toLowerCase() === "complete") {
        setStageLabel("Processing complete");
      }
    }
  }

  function buildPreflightRequest(): PreflightRequest {
    return {
      inputFolders,
      outputFolder: outputFolder.trim(),
      whisperExe: whisperExe.trim(),
      modelFile: modelFile.trim(),
      scriptPath: scriptPath.trim() ? scriptPath.trim() : undefined,
    };
  }

  async function runPreflightChecks(logSummary = true): Promise<PreflightReport | null> {
    try {
      setPreflightBusy(true);
      const report = await invoke<PreflightReport>("run_preflight", {
        request: buildPreflightRequest(),
      });

      setPreflight(report);

      if (logSummary) {
        if (report.ready) {
          ingestLog("preflight", "All checks passed. System ready.");
        } else {
          const failed = report.checks.filter((c) => !c.ok);
          ingestLog("preflight", `Preflight found ${failed.length} issue(s).`);
          failed.slice(0, 6).forEach((check) => {
            ingestLog("preflight", `${check.key}: ${check.detail} | fix: ${check.fix}`);
          });
        }
      }

      return report;
    } catch (error) {
      ingestLog("system", `Preflight failed to run: ${String(error)}`);
      return null;
    } finally {
      setPreflightBusy(false);
    }
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
        ingestLog("system", `Could not read initial status: ${String(error)}`);
      }

      await runPreflightChecks(false);

      const unlistenLog = await listen<LogEvent>("transcribe://log", (event) => {
        ingestLog(event.payload.stream, event.payload.line);
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
        ingestLog("stage", label);
      });
      unsubs.push(unlistenStage);

      const unlistenFinished = await listen<FinishEvent>("transcribe://finished", (event) => {
        const { success, code, message } = event.payload;
        setStageLabel(success ? "Complete" : "Stopped / Failed");
        ingestLog("system", `${success ? "Complete" : "Ended"} (code ${code}): ${message}`);
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
      ingestLog("system", "Primary input folder is required.");
      return;
    }

    const parsedThreads = Number.parseInt(threads, 10);
    if (Number.isNaN(parsedThreads) || parsedThreads < 1) {
      ingestLog("system", "Threads must be a positive number.");
      return;
    }

    const pre = await runPreflightChecks(true);
    if (!pre || !pre.ready) {
      setStageLabel("Blocked by preflight");
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
      setProgressDone(0);
      setProgressTotal(0);
      ingestLog("system", "Starting transcription run...");
      const nextStatus = await invoke<RunnerStatus>("start_transcription", { request });
      setStatus(nextStatus);
    } catch (error) {
      ingestLog("system", `Start failed: ${String(error)}`);
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
      ingestLog("system", `Pause/resume failed: ${String(error)}`);
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
      ingestLog("system", `Stop failed: ${String(error)}`);
    } finally {
      setBusy(false);
    }
  }

  async function exportLogs() {
    try {
      const targetOutput = outputFolder.trim() || "D:\\ChurchTranscripts";
      const path = await invoke<string>("export_run_logs", {
        outputFolder: targetOutput,
        lines: logs,
      });
      ingestLog("system", `Log export saved: ${path}`);
    } catch (error) {
      ingestLog("system", `Log export failed: ${String(error)}`);
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

          <button
            type="button"
            className="key-btn"
            disabled={busy || preflightBusy || status.running}
            onClick={() => runPreflightChecks(true)}
          >
            {preflightBusy ? "Checking..." : "Run Preflight"}
          </button>

          <div className="run-meta">
            <span className="run-meta-main">{stageLabel}</span>
            {status.stopRequested ? <span className="warn">[ STOP REQUESTED ]</span> : null}
          </div>
        </div>

        <div className="progress-card">
          <div className="progress-head">
            <span>[ FILE PROGRESS ]</span>
            <span>
              {progressDone}/{progressTotal || "?"}
            </span>
          </div>
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
          </div>
        </div>

        <div className={`preflight-card ${preflight?.ready ? "preflight-card--ok" : "preflight-card--bad"}`}>
          <div className="preflight-head">
            <span>[ PREFLIGHT STATUS ]</span>
            <span>{preflight ? (preflight.ready ? "READY" : "NOT READY") : "NOT RUN"}</span>
          </div>

          {preflight ? (
            <>
              <ul className="preflight-list">
                {preflight.checks.map((check, index) => (
                  <li key={`${check.key}-${index}`} className={check.ok ? "ok" : "bad"}>
                    <span className="preflight-pill">{check.ok ? "OK" : "FIX"}</span>
                    <div className="preflight-copy">
                      <div className="preflight-key">{check.key}</div>
                      <div>{check.detail}</div>
                      {!check.ok ? <div className="preflight-fix">→ {check.fix}</div> : null}
                    </div>
                  </li>
                ))}
              </ul>
              {preflight.resolvedScriptPath ? (
                <div className="preflight-script">Script: {preflight.resolvedScriptPath}</div>
              ) : null}
            </>
          ) : (
            <p className="preflight-empty">Run preflight to validate this machine before production runs.</p>
          )}
        </div>

        <p className="hint">Pause is checkpoint-based. Active ffmpeg/whisper step may finish before pause engages.</p>
      </section>

      <section className="panel log-panel">
        <div className="log-header">
          <h2>[ LIVE LOG ]</h2>
          <div className="log-actions">
            <button type="button" className="key-btn" onClick={exportLogs}>
              Export Log
            </button>
            <button type="button" className="key-btn" onClick={() => setLogs([])}>
              Clear
            </button>
          </div>
        </div>
        <pre>{logs.join("\n")}</pre>
      </section>
    </main>
  );
}

export default App;
