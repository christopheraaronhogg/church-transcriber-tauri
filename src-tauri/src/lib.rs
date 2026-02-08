use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{BufRead, BufReader, Read},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
struct RunnerState {
    running: Mutex<bool>,
    stop_requested: Mutex<bool>,
    child: Mutex<Option<Child>>,
    pause_flag: Mutex<Option<PathBuf>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartRequest {
    input_folders: Vec<String>,
    output_folder: String,
    whisper_exe: String,
    model_file: String,
    before_date: Option<String>,
    threads: u32,
    limit: Option<u32>,
    fast_scan: bool,
    force: bool,
    no_recursive: bool,
    keep_audio: bool,
    script_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LogEvent {
    stream: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StageEvent {
    index: usize,
    total: usize,
    input_folder: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FinishEvent {
    success: bool,
    code: i32,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RunnerStatus {
    running: bool,
    paused: bool,
    stop_requested: bool,
}

fn emit_log(app: &AppHandle, stream: &str, line: impl Into<String>) {
    let payload = LogEvent {
        stream: stream.to_string(),
        line: line.into(),
    };
    let _ = app.emit("transcribe://log", payload);
}

fn spawn_log_reader<R: Read + Send + 'static>(reader: R, stream: &'static str, app: AppHandle) {
    thread::spawn(move || {
        let buf = BufReader::new(reader);
        for line in buf.lines() {
            match line {
                Ok(text) => emit_log(&app, stream, text),
                Err(err) => {
                    emit_log(&app, "system", format!("log read error: {err}"));
                    break;
                }
            }
        }
    });
}

fn resolve_script_path(app: &AppHandle, requested: Option<String>) -> Result<PathBuf, String> {
    if let Some(path) = requested {
        let trimmed = path.trim();
        if !trimmed.is_empty() {
            let p = PathBuf::from(trimmed);
            if p.exists() {
                return Ok(p);
            }
            return Err(format!("Script path does not exist: {}", p.display()));
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join("church_transcribe_batch.ps1"));
        candidates.push(resource_dir.join("resources").join("church_transcribe_batch.ps1"));
    }

    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("resources").join("church_transcribe_batch.ps1"));
        candidates.push(cwd.join("church_transcribe_batch.ps1"));
        candidates.push(cwd.join("../scripts/church_transcribe_batch.ps1"));
        candidates.push(cwd.join("scripts/church_transcribe_batch.ps1"));
    }

    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }

    Err("Could not locate church_transcribe_batch.ps1. Set Script Path in Advanced settings.".to_string())
}

fn get_status(state: &RunnerState) -> RunnerStatus {
    let running = state.running.lock().map(|v| *v).unwrap_or(false);
    let stop_requested = state.stop_requested.lock().map(|v| *v).unwrap_or(false);

    let paused = state
        .pause_flag
        .lock()
        .ok()
        .and_then(|p| p.clone())
        .map(|p| p.exists())
        .unwrap_or(false);

    RunnerStatus {
        running,
        paused,
        stop_requested,
    }
}

fn emit_status(app: &AppHandle) {
    let state = app.state::<RunnerState>();
    let status = get_status(&state);
    let _ = app.emit("transcribe://status", status);
}

fn set_running(state: &RunnerState, value: bool) {
    if let Ok(mut running) = state.running.lock() {
        *running = value;
    }
}

fn set_stop_requested(state: &RunnerState, value: bool) {
    if let Ok(mut stop) = state.stop_requested.lock() {
        *stop = value;
    }
}

fn current_stop_requested(app: &AppHandle) -> bool {
    let state = app.state::<RunnerState>();
    state.stop_requested.lock().map(|v| *v).unwrap_or(true)
}

fn clear_pause_flag_file(state: &RunnerState) {
    let pause_path = state.pause_flag.lock().ok().and_then(|p| p.clone());
    if let Some(path) = pause_path {
        if path.exists() {
            let _ = fs::remove_file(path);
        }
    }
}

fn cleanup_after_run(app: &AppHandle, success: bool, code: i32, message: impl Into<String>) {
    let msg = message.into();
    let state = app.state::<RunnerState>();

    clear_pause_flag_file(&state);

    if let Ok(mut child) = state.child.lock() {
        *child = None;
    }

    if let Ok(mut pause) = state.pause_flag.lock() {
        *pause = None;
    }

    set_running(&state, false);
    set_stop_requested(&state, false);

    let _ = app.emit(
        "transcribe://finished",
        FinishEvent {
            success,
            code,
            message: msg,
        },
    );

    emit_status(app);
}

fn spawn_worker(app: AppHandle, request: StartRequest) {
    thread::spawn(move || {
        let state = app.state::<RunnerState>();

        let script_path = match resolve_script_path(&app, request.script_path.clone()) {
            Ok(path) => path,
            Err(err) => {
                emit_log(&app, "system", err.clone());
                cleanup_after_run(&app, false, 1, err);
                return;
            }
        };

        emit_log(
            &app,
            "system",
            format!("Using batch script: {}", script_path.display()),
        );

        let pause_path = PathBuf::from(request.output_folder.trim()).join(".transcribe.pause");
        if let Ok(mut pause) = state.pause_flag.lock() {
            *pause = Some(pause_path.clone());
        }

        if pause_path.exists() {
            let _ = fs::remove_file(&pause_path);
        }

        let powershell_bin = if cfg!(target_os = "windows") {
            "powershell"
        } else {
            "pwsh"
        };

        let total = request.input_folders.len();
        let mut final_code = 0;
        let mut final_message = "Transcription complete.".to_string();
        let mut success = true;

        for (index, folder) in request.input_folders.iter().enumerate() {
            if current_stop_requested(&app) {
                success = false;
                final_code = 130;
                final_message = "Stopped by user before next folder.".to_string();
                emit_log(&app, "system", &final_message);
                break;
            }

            let _ = app.emit(
                "transcribe://stage",
                StageEvent {
                    index: index + 1,
                    total,
                    input_folder: folder.clone(),
                },
            );

            let mut cmd = Command::new(powershell_bin);
            cmd.arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(&script_path)
                .arg("-InputFolder")
                .arg(folder)
                .arg("-OutputFolder")
                .arg(request.output_folder.trim())
                .arg("-WhisperExe")
                .arg(request.whisper_exe.trim())
                .arg("-ModelFile")
                .arg(request.model_file.trim())
                .arg("-PauseFlagFile")
                .arg(&pause_path)
                .arg("-Threads")
                .arg(request.threads.to_string())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            if let Some(before_date) = request.before_date.as_ref() {
                let trimmed = before_date.trim();
                if !trimmed.is_empty() {
                    cmd.arg("-BeforeDate").arg(trimmed);
                }
            }

            if let Some(limit) = request.limit {
                if limit > 0 {
                    cmd.arg("-Limit").arg(limit.to_string());
                }
            }

            if request.fast_scan {
                cmd.arg("-FastScan");
            }
            if request.force {
                cmd.arg("-Force");
            }
            if request.no_recursive {
                cmd.arg("-NoRecursive");
            }
            if request.keep_audio {
                cmd.arg("-KeepAudio");
            }

            emit_log(
                &app,
                "system",
                format!("Starting folder {}/{}: {}", index + 1, total, folder),
            );

            let mut child = match cmd.spawn() {
                Ok(process) => process,
                Err(err) => {
                    success = false;
                    final_code = 1;
                    final_message = format!("Failed to start PowerShell process: {err}");
                    emit_log(&app, "system", &final_message);
                    break;
                }
            };

            if let Some(stdout) = child.stdout.take() {
                spawn_log_reader(stdout, "stdout", app.clone());
            }
            if let Some(stderr) = child.stderr.take() {
                spawn_log_reader(stderr, "stderr", app.clone());
            }

            if let Ok(mut child_slot) = state.child.lock() {
                *child_slot = Some(child);
            }

            let exit_code = loop {
                if current_stop_requested(&app) {
                    if let Ok(mut child_slot) = state.child.lock() {
                        if let Some(ch) = child_slot.as_mut() {
                            let _ = ch.kill();
                        }
                    }
                }

                let mut done: Option<i32> = None;
                if let Ok(mut child_slot) = state.child.lock() {
                    if let Some(ch) = child_slot.as_mut() {
                        match ch.try_wait() {
                            Ok(Some(status)) => {
                                done = Some(status.code().unwrap_or(1));
                                *child_slot = None;
                            }
                            Ok(None) => {}
                            Err(err) => {
                                emit_log(&app, "system", format!("Process wait error: {err}"));
                                done = Some(1);
                                *child_slot = None;
                            }
                        }
                    } else {
                        done = Some(1);
                    }
                } else {
                    done = Some(1);
                }

                if let Some(code) = done {
                    break code;
                }

                thread::sleep(Duration::from_millis(180));
            };

            if exit_code != 0 {
                success = false;
                final_code = exit_code;
                final_message = if current_stop_requested(&app) {
                    "Stopped by user.".to_string()
                } else {
                    format!("Folder run failed (exit code {exit_code}).")
                };
                emit_log(&app, "system", &final_message);
                break;
            }

            emit_log(
                &app,
                "system",
                format!("Completed folder {}/{}", index + 1, total),
            );
        }

        cleanup_after_run(&app, success, final_code, final_message);
    });
}

#[tauri::command]
fn start_transcription(
    app: AppHandle,
    state: State<RunnerState>,
    request: StartRequest,
) -> Result<RunnerStatus, String> {
    if request.input_folders.is_empty() {
        return Err("At least one input folder is required.".to_string());
    }

    if request.output_folder.trim().is_empty() {
        return Err("Output folder is required.".to_string());
    }

    if request.whisper_exe.trim().is_empty() {
        return Err("Whisper executable path is required.".to_string());
    }

    if request.model_file.trim().is_empty() {
        return Err("Model file path is required.".to_string());
    }

    let mut running = state
        .running
        .lock()
        .map_err(|_| "Runner state lock failed".to_string())?;

    if *running {
        return Err("A transcription run is already in progress.".to_string());
    }

    *running = true;
    drop(running);

    set_stop_requested(&state, false);

    spawn_worker(app.clone(), request);
    emit_status(&app);

    Ok(get_status(&state))
}

#[tauri::command]
fn toggle_pause(app: AppHandle, state: State<RunnerState>, paused: bool) -> Result<RunnerStatus, String> {
    let is_running = state
        .running
        .lock()
        .map_err(|_| "Runner state lock failed".to_string())?;

    if !*is_running {
        return Err("No active run to pause/resume.".to_string());
    }
    drop(is_running);

    let pause_path = state
        .pause_flag
        .lock()
        .map_err(|_| "Pause state lock failed".to_string())?
        .clone()
        .ok_or_else(|| "Pause flag path not initialized.".to_string())?;

    if paused {
        fs::write(&pause_path, b"paused")
            .map_err(|err| format!("Failed to write pause flag: {err}"))?;
        emit_log(
            &app,
            "system",
            format!("Pause requested (flag: {}).", pause_path.display()),
        );
    } else if pause_path.exists() {
        fs::remove_file(&pause_path).map_err(|err| format!("Failed to clear pause flag: {err}"))?;
        emit_log(&app, "system", "Resume requested.");
    }

    let status = get_status(&state);
    let _ = app.emit("transcribe://status", status.clone());
    Ok(status)
}

#[tauri::command]
fn stop_transcription(app: AppHandle, state: State<RunnerState>) -> Result<RunnerStatus, String> {
    let is_running = state
        .running
        .lock()
        .map_err(|_| "Runner state lock failed".to_string())?;

    if !*is_running {
        return Ok(get_status(&state));
    }
    drop(is_running);

    set_stop_requested(&state, true);

    if let Ok(mut child_slot) = state.child.lock() {
        if let Some(ch) = child_slot.as_mut() {
            let _ = ch.kill();
        }
    }

    emit_log(&app, "system", "Stop requested. Finishing current checkpoint...");
    let status = get_status(&state);
    let _ = app.emit("transcribe://status", status.clone());
    Ok(status)
}

#[tauri::command]
fn get_runner_status(state: State<RunnerState>) -> RunnerStatus {
    get_status(&state)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(RunnerState::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            start_transcription,
            toggle_pause,
            stop_transcription,
            get_runner_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
