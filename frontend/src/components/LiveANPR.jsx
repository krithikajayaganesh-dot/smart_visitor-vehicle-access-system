import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import API from "../api";
import "./LiveANPR.css";

const SEND_WIDTH = 800; // frames are downscaled to this width before upload
const WINDOW = 8; // vote over the last 8 readings
const CONFIRM_HITS = 2; // the voted plate must match this many individual readings
const HOLD_MS = 5000; // keep the last reading on screen this long if the plate disappears
const SPEEDS = { fast: 700, normal: 1200, slow: 2000 };

const RECO = {
  entry: { label: "Valid pass found. Log ENTRY.", color: "var(--success)" },
  exit: { label: "Vehicle is inside. Log EXIT.", color: "var(--warning)" },
  already_exited: { label: "This pass was already used to exit.", color: "var(--danger)" },
  expired: { label: "Pass EXPIRED. Do not allow entry.", color: "var(--danger)" },
  unregistered: { label: "No pass for this plate. Walk-in vehicle.", color: "var(--warning)" },
  unknown: { label: "Pass status unclear. Verify manually.", color: "var(--text-muted)" },
};

// character-by-character vote over recent readings of the most common length
function voteReadings(readings) {
  if (!readings.length) return { text: "", support: 0 };
  const counts = {};
  readings.forEach((r) => { counts[r.length] = (counts[r.length] || 0) + 1; });
  const len = Number(Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0]);
  const pool = readings.filter((r) => r.length === len);
  let text = "";
  for (let i = 0; i < len; i++) {
    const tally = {};
    pool.forEach((r) => { tally[r[i]] = (tally[r[i]] || 0) + 1; });
    text += Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
  }
  return { text, support: pool.filter((r) => r === text).length };
}

function beep(ok = true) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = ok ? 880 : 220;
    g.gain.value = 0.06;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + (ok ? 0.12 : 0.3));
    setTimeout(() => ctx.close(), 500);
  } catch { /* sound is optional */ }
}

function loadSettings() {
  try {
    return { speed: "normal", minConf: 0.5, autoLock: true, sound: true, ...JSON.parse(localStorage.getItem("anpr_settings") || "{}") };
  } catch {
    return { speed: "normal", minConf: 0.5, autoLock: true, sound: true };
  }
}

export default function LiveANPR({ onLogged }) {
  // ---- DOM refs
  const videoRef = useRef(null);
  const stillRef = useRef(null);
  const overlayRef = useRef(null);
  const captureRef = useRef(null);
  // ---- runtime refs (used inside timers, so they must not go stale)
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);
  const historyRef = useRef([]);
  const lastGoodRef = useRef(0);
  const phaseRef = useRef("idle");
  const settingsRef = useRef({ speed: "normal", minConf: 0.5, autoLock: true, sound: true });
  const lastDetRef = useRef(null);

  // ---- UI state
  const [mode, setMode] = useState("camera"); // camera | upload | samples
  const [phase, setPhase] = useState("idle"); // idle | scanning | analyzing | locked
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [engine, setEngine] = useState(null);
  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [samples, setSamples] = useState([]);
  const [stillSrc, setStillSrc] = useState("");
  const [aspect, setAspect] = useState(16 / 9);
  const [notice, setNotice] = useState(null); // {type, text}
  const [result, setResult] = useState(null);
  const [plateEdit, setPlateEdit] = useState(null);
  const [gateAction, setGateAction] = useState("entry");
  const [visitorName, setVisitorName] = useState("");
  const [flat, setFlat] = useState("");
  const [logging, setLogging] = useState(false);
  const [latencies, setLatencies] = useState([]);
  const [history, setHistory] = useState([]); // this session's logged vehicles
  const [scans, setScans] = useState(0);
  const [camOn, setCamOn] = useState(false);
  const [looked, setLooked] = useState("");

  const setPhaseBoth = (p) => { phaseRef.current = p; setPhase(p); };
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    try { localStorage.setItem("anpr_settings", JSON.stringify(settings)); } catch { /* ignore */ }
  }, [settings]);

  // ---------- engine status + sample images ----------
  useEffect(() => {
    API.get("/api/anpr/status").then((r) => setEngine(r.data)).catch(() => setEngine({ initialized: false, offline: true }));
    API.get("/api/anpr/samples").then((r) => setSamples(r.data.samples || [])).catch(() => {});
  }, []);

  // ---------- overlay drawing ----------
  const drawBox = useCallback((det, color = "#22c55e") => {
    const cv = overlayRef.current;
    if (!cv) return;
    const vid = videoRef.current;
    const img = stillRef.current;
    const w = (vid && vid.videoWidth) || (img && img.naturalWidth) || cv.width || 640;
    const h = (vid && vid.videoHeight) || (img && img.naturalHeight) || cv.height || 360;
    cv.width = w;
    cv.height = h;
    const ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    if (!det || !det.bbox) return;
    const sx = w / det.bbox.img_width;
    const sy = h / det.bbox.img_height;
    const x = det.bbox.x1 * sx;
    const y = det.bbox.y1 * sy;
    const bw = (det.bbox.x2 - det.bbox.x1) * sx;
    const bh = (det.bbox.y2 - det.bbox.y1) * sy;
    ctx.lineWidth = Math.max(3, w / 220);
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, bw, bh);
    const label = det.plate_number;
    const fs = Math.max(16, w / 34);
    ctx.font = `bold ${fs}px monospace`;
    const tw = ctx.measureText(label).width + 14;
    const th = fs + 10;
    const ty = y - th < 0 ? y + bh : y - th;
    ctx.fillStyle = color;
    ctx.fillRect(x, ty, tw, th);
    ctx.fillStyle = "#04130a";
    ctx.fillText(label, x + 7, ty + th - 8);
  }, []);

  // ---------- one request to the AI ----------
  const requestDetection = useCallback(async (dataUrl) => {
    const t0 = performance.now();
    const { data } = await API.post("/api/anpr/detect-frame", { image: dataUrl, auto_check_pass: true });
    const ms = Math.round(performance.now() - t0);
    setLatencies((prev) => [...prev.slice(-19), ms]);
    return data;
  }, []);

  const explain = (err) => {
    const st = err.response?.status;
    if (st === 401 || st === 403) return "You are not allowed to use ANPR. Log in as a guard or admin.";
    if (st === 400) return "The server could not read that image.";
    if (err.response?.data?.detail) return String(err.response.data.detail);
    return "Could not reach the recognition server. Is the backend running?";
  };

  // ---------- lock / rescan ----------
  const stopLoop = () => { clearInterval(timerRef.current); timerRef.current = null; };

  const lock = useCallback(() => {
    if (phaseRef.current === "locked") return;
    stopLoop();
    videoRef.current?.pause?.();
    setPhaseBoth("locked");
    setScans((n) => n + 1);
    if (settingsRef.current.sound) beep(true);
  }, []);

  const grabFrame = useCallback(() => {
    const vid = videoRef.current;
    const cv = captureRef.current;
    if (!vid || !cv || !vid.videoWidth) return null;
    const scale = Math.min(1, SEND_WIDTH / vid.videoWidth);
    cv.width = Math.round(vid.videoWidth * scale);
    cv.height = Math.round(vid.videoHeight * scale);
    cv.getContext("2d").drawImage(vid, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.85);
  }, []);

  // ---------- handle a live-camera reading ----------
  const handleLive = useCallback((data, force = false) => {
    const det = data.detection;
    if (det && det.detected) {
      const hist = historyRef.current;
      hist.push(det.plate_number);
      if (hist.length > WINDOW) hist.shift();
      const { text, support } = voteReadings(hist);
      lastGoodRef.current = Date.now();
      lastDetRef.current = { ...det, plate_number: text };
      drawBox(lastDetRef.current);
      const sameAsFrame = text === det.plate_number;
      setResult({
        detection: { ...det, plate_number: text },
        matched_pass: sameAsFrame ? data.matched_pass : null,
        recommendation: sameAsFrame ? data.recommendation : "none",
        confirmed: support >= CONFIRM_HITS,
      });
      if (sameAsFrame) {
        if (data.recommendation === "exit") setGateAction("exit");
        else if (data.recommendation === "entry") setGateAction("entry");
      } else {
        API.get("/api/anpr/lookup", { params: { plate: text } })
          .then((r) => {
            setResult((prev) => (prev && prev.detection.plate_number === text
              ? { ...prev, matched_pass: r.data.matched_pass, recommendation: r.data.recommendation } : prev));
            if (r.data.recommendation === "exit") setGateAction("exit");
            else if (r.data.recommendation === "entry") setGateAction("entry");
          })
          .catch(() => {});
      }
      const s = settingsRef.current;
      if (force || (s.autoLock && support >= CONFIRM_HITS && det.valid_format && det.confidence >= s.minConf)) {
        lock();
      }
    } else {
      drawBox(null);
      if (force) {
        setNotice({ type: "info", text: "No plate found in that frame. Move closer, add light, and try again." });
      } else if (Date.now() - lastGoodRef.current > HOLD_MS) {
        historyRef.current = [];
        lastDetRef.current = null;
        setResult(null);
      }
    }
  }, [drawBox, lock]);

  const tick = useCallback(async (force = false) => {
    if (busyRef.current) return;
    const frame = grabFrame();
    if (!frame) return;
    busyRef.current = true;
    try {
      const data = await requestDetection(frame);
      if (phaseRef.current === "scanning") handleLive(data, force);
    } catch (err) {
      setNotice({ type: "err", text: explain(err) });
    } finally {
      busyRef.current = false;
    }
  }, [grabFrame, requestDetection, handleLive]);

  const startLoop = useCallback(() => {
    stopLoop();
    timerRef.current = setInterval(() => tick(false), SPEEDS[settingsRef.current.speed] || 1200);
  }, [tick]);

  // restart the timer when the scan speed changes
  useEffect(() => {
    if (phaseRef.current === "scanning") startLoop();
  }, [settings.speed, startLoop]);

  // ---------- camera control ----------
  const stopCamera = useCallback(() => {
    stopLoop();
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamOn(false);
  }, []);

  const resetReading = useCallback(() => {
    historyRef.current = [];
    lastDetRef.current = null;
    lastGoodRef.current = 0;
    setResult(null);
    setPlateEdit(null);
    drawBox(null);
  }, [drawBox]);

  const startCamera = useCallback(async (id) => {
    setNotice(null);
    setStillSrc("");
    stopCamera();
    resetReading();
    if (!navigator.mediaDevices?.getUserMedia) {
      setNotice({ type: "err", text: "This browser cannot use the camera. Open http://localhost:5173 in Chrome or Edge." });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: id
          ? { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
      streamRef.current = stream;
      const vid = videoRef.current;
      vid.srcObject = stream;
      await vid.play();
      if (vid.videoWidth) setAspect(vid.videoWidth / vid.videoHeight);
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(all.filter((d) => d.kind === "videoinput"));
      const active = stream.getVideoTracks()[0]?.getSettings()?.deviceId;
      if (active) setDeviceId(active);
      setCamOn(true);
      setPhaseBoth("scanning");
      startLoop();
    } catch (err) {
      const name = err?.name || "";
      const msg =
        name === "NotAllowedError" ? "Camera permission was denied. Click the camera icon in the address bar and choose Allow."
        : name === "NotFoundError" ? "No camera found. Plug in a webcam and try again."
        : name === "NotReadableError" ? "The camera is busy. Close Zoom, Teams or other tabs that use it."
        : `Could not start the camera: ${err?.message || name}`;
      setNotice({ type: "err", text: msg });
      setPhaseBoth("idle");
    }
  }, [stopCamera, resetReading, startLoop]);

  const stopAll = useCallback(() => {
    stopCamera();
    resetReading();
    setStillSrc("");
    setPhaseBoth("idle");
  }, [stopCamera, resetReading]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ---------- still images (upload / samples) ----------
  const analyzeImage = useCallback((dataUrl) => {
    stopCamera();
    resetReading();
    setNotice(null);
    setPhaseBoth("analyzing");
    const img = new Image();
    img.onerror = () => {
      setPhaseBoth("idle");
      setNotice({ type: "err", text: "That file could not be opened as an image." });
    };
    img.onload = async () => {
      setAspect(img.width / img.height);
      setStillSrc(dataUrl);
      const cv = captureRef.current;
      const scale = Math.min(1, SEND_WIDTH / img.width);
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      try {
        const data = await requestDetection(cv.toDataURL("image/jpeg", 0.9));
        const det = data.detection;
        if (det && det.detected) {
          lastDetRef.current = det;
          setTimeout(() => drawBox(det), 60);
          setResult({
            detection: det,
            matched_pass: data.matched_pass,
            recommendation: data.recommendation,
            confirmed: true,
          });
          if (data.recommendation === "exit") setGateAction("exit");
          else if (data.recommendation === "entry") setGateAction("entry");
          setPhaseBoth("locked");
          setScans((n) => n + 1);
          if (settingsRef.current.sound) beep(true);
        } else {
          setPhaseBoth("idle");
          setNotice({ type: "info", text: "No number plate was found in this image. Try a closer, sharper photo where the plate is clearly visible." });
        }
      } catch (err) {
        setPhaseBoth("idle");
        setNotice({ type: "err", text: explain(err) });
      }
    };
    img.src = dataUrl;
  }, [stopCamera, resetReading, requestDetection, drawBox]);

  const onUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => analyzeImage(reader.result);
    reader.readAsDataURL(f);
    e.target.value = "";
  };

  // ---------- rescan / capture ----------
  const rescan = useCallback(() => {
    setNotice(null);
    resetReading();
    if (streamRef.current) {
      videoRef.current?.play?.();
      setPhaseBoth("scanning");
      startLoop();
    } else {
      setStillSrc("");
      setPhaseBoth("idle");
    }
  }, [resetReading, startLoop]);

  const capture = useCallback(() => {
    if (phaseRef.current !== "scanning") return;
    if (lastDetRef.current) lock();
    else tick(true);
  }, [lock, tick]);

  // ---------- plate value + automatic pass lookup after manual edits ----------
  const aiPlate = result?.detection?.plate_number || "";
  const currentPlate = (plateEdit ?? aiPlate).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const edited = plateEdit !== null && currentPlate !== aiPlate;

  useEffect(() => {
    if (!edited || currentPlate.length < 6) return undefined;
    const t = setTimeout(async () => {
      try {
        const { data } = await API.get("/api/anpr/lookup", { params: { plate: currentPlate } });
        setResult((prev) => (prev ? { ...prev, matched_pass: data.matched_pass, recommendation: data.recommendation, confirmed: true } : prev));
        if (data.recommendation === "exit") setGateAction("exit");
        else if (data.recommendation === "entry") setGateAction("entry");
      } catch { /* ignore */ }
      setLooked(currentPlate);
    }, 450);
    return () => clearTimeout(t);
  }, [edited, currentPlate]);
  const checking = edited && currentPlate.length >= 6 && looked !== currentPlate;

  const ensureLocked = () => { if (phaseRef.current === "scanning") lock(); };

  // ---------- record the gate action ----------
  const mp = result?.matched_pass;
  const rec = result?.recommendation;
  const canLog = !!result && currentPlate.length >= 6 && rec !== "expired" && rec !== "already_exited";

  const logAccess = useCallback(async () => {
    if (!result || logging) return;
    setLogging(true);
    setNotice(null);
    try {
      const { data } = await API.post("/api/anpr/quick-log", {
        action: gateAction,
        plate_number: currentPlate,
        pass_id: mp?.id ?? null,
        visitor_name: mp ? undefined : visitorName.trim() || undefined,
        flat_number: mp ? undefined : flat.trim() || undefined,
      });
      if (data.success) {
        setNotice({ type: "ok", text: data.message });
        setHistory((h) => [
          { time: new Date(), plate: currentPlate, action: gateAction, who: mp?.visitor_name || visitorName.trim() || "Walk-in", walkin: !mp },
          ...h,
        ].slice(0, 25));
        if (settingsRef.current.sound) beep(true);
        if (onLogged) onLogged(data.message);
        setVisitorName("");
        setFlat("");
        resetReading();
        if (streamRef.current) {
          setTimeout(() => { if (phaseRef.current === "locked") rescan(); }, 1600);
        } else {
          setPhaseBoth("idle");
          setStillSrc("");
        }
      } else {
        setNotice({ type: "err", text: data.message || "Could not record the entry or exit." });
      }
    } catch (err) {
      if (settingsRef.current.sound) beep(false);
      setNotice({ type: "err", text: err.response?.data?.detail || "Could not record the entry or exit." });
    } finally {
      setLogging(false);
    }
  }, [result, logging, gateAction, currentPlate, mp, visitorName, flat, onLogged, resetReading, rescan]);

  // ---------- keyboard shortcuts ----------
  const kbRef = useRef({});
  useEffect(() => { kbRef.current = { capture, rescan, logAccess, canLog }; });
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag === "input" || tag === "select" || tag === "textarea") {
        if (e.key === "Escape") e.target.blur();
        return;
      }
      const k = kbRef.current;
      if (e.code === "Space") { document.activeElement?.blur?.(); e.preventDefault(); k.capture(); }
      else if (e.key === "Enter" && phaseRef.current === "locked" && k.canLog) { e.preventDefault(); k.logAccess(); }
      else if (e.key === "Escape") { k.rescan(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ---------- derived ----------
  const avgMs = useMemo(() => (latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null), [latencies]);
  const entries = history.filter((h) => h.action === "entry").length;
  const exits = history.filter((h) => h.action === "exit").length;
  const walkins = history.filter((h) => h.walkin).length;
  const det = result?.detection;
  const recInfo = RECO[rec] || null;
  const confPct = Math.round((det?.confidence || 0) * 100);
  const confColor = confPct >= 75 ? "var(--success)" : confPct >= 50 ? "var(--warning)" : "var(--danger)";
  const running = camOn && (phase === "scanning" || phase === "locked");
  const showVideo = mode === "camera" && !stillSrc;

  const setMsg = (m) => { if (m !== mode) { stopAll(); } setMode(m); setNotice(null); };

  return (
    <div className="lp">
      {/* ---------- header ---------- */}
      <div className="lp-head">
        <div>
          <h3>Live Number Plate Recognition</h3>
          <div className="lp-sub">Point a camera at the vehicle plate. The plate is read, matched to a visitor pass, and logged in one click.</div>
        </div>
        <div className="lp-chips">
          <span className={`lp-chip ${engine == null ? "" : engine.initialized ? "ok" : "bad"}`}>
            <i />{engine == null ? "Checking AI engine" : engine.initialized ? `AI engine online (${engine.device})` : engine.offline ? "Backend offline" : "AI models not loaded"}
          </span>
          <span className={`lp-chip ${phase === "scanning" ? "ok" : phase === "locked" ? "warn" : ""}`}>
            <i />{phase === "scanning" ? "Scanning" : phase === "locked" ? "Plate locked" : phase === "analyzing" ? "Analysing" : "Idle"}
          </span>
          {avgMs != null && <span className="lp-chip"><i />{avgMs} ms / frame</span>}
        </div>
      </div>

      {/* ---------- stats ---------- */}
      <div className="lp-stats">
        <div className="lp-stat"><b>{scans}</b><span>Plates read</span></div>
        <div className="lp-stat"><b>{entries}</b><span>Entries logged</span></div>
        <div className="lp-stat"><b>{exits}</b><span>Exits logged</span></div>
        <div className="lp-stat"><b>{walkins}</b><span>Walk-ins</span></div>
      </div>

      {/* ---------- source switch ---------- */}
      <div className="lp-modes">
        <div className="lp-seg">
          <button className={mode === "camera" ? "on" : ""} onClick={() => setMsg("camera")}>Live camera</button>
          <button className={mode === "upload" ? "on" : ""} onClick={() => setMsg("upload")}>Upload image</button>
          <button className={mode === "samples" ? "on" : ""} onClick={() => setMsg("samples")}>Sample images</button>
        </div>
        <button className="btn btn-outline btn-sm" onClick={() => setShowSettings((v) => !v)}>
          {showSettings ? "Hide settings" : "Settings"}
        </button>
      </div>

      <div className="lp-grid">
        {/* ================= LEFT: viewport ================= */}
        <div className="lp-card">
          <div className="lp-stage-wrap">
            <div className={`lp-stage ${phase === "locked" ? "locked" : ""}`} style={{ "--ar": aspect }}>
              <video ref={videoRef} muted playsInline style={{ display: showVideo ? "block" : "none" }} />
              {stillSrc && <img ref={stillRef} src={stillSrc} alt="Analysed vehicle" />}
              <canvas ref={overlayRef} />

              <div className="lp-hud">
                {phase === "scanning" && <span className="lp-tag live">● LIVE</span>}
                {phase === "locked" && <span className="lp-tag lock">LOCKED</span>}
                {phase === "analyzing" && <span className="lp-tag wait">ANALYSING</span>}
              </div>

              {phase === "scanning" && (<><div className="lp-reticle scan"><i /></div><div className="lp-scanline" /></>)}

              {phase === "analyzing" && (
                <div className="lp-empty"><div><div className="lp-spin" />Reading the plate…</div></div>
              )}

              {phase === "idle" && !stillSrc && (
                <div className="lp-empty">
                  <div>
                    <b>{mode === "camera" ? "Camera is off" : mode === "upload" ? "Choose a vehicle photo" : "Pick a sample image"}</b>
                    {mode === "camera" && "Press Start camera, then hold the plate 1 to 2 metres from the lens."}
                    {mode === "upload" && "Use any clear photo where the number plate is visible."}
                    {mode === "samples" && "Sample vehicles from the project let you test without a camera."}
                  </div>
                </div>
              )}
            </div>
          </div>
          <canvas ref={captureRef} style={{ display: "none" }} />

          {/* toolbar for the current mode */}
          <div className="lp-bar">
            {mode === "camera" && (
              <>
                {!running ? (
                  <button className="btn btn-primary" onClick={() => startCamera(deviceId)}>Start camera</button>
                ) : (
                  <button className="btn btn-danger" onClick={stopAll}>Stop camera</button>
                )}
                <button className="btn btn-outline" onClick={capture} disabled={phase !== "scanning"}>Capture <kbd>Space</kbd></button>
                <button className="btn btn-outline" onClick={rescan} disabled={phase === "idle"}>Rescan <kbd>Esc</kbd></button>
                {devices.length > 1 && (
                  <select value={deviceId} onChange={(e) => { setDeviceId(e.target.value); startCamera(e.target.value); }}>
                    {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>)}
                  </select>
                )}
              </>
            )}
            {mode === "upload" && (
              <>
                <label className="btn btn-primary" style={{ cursor: "pointer", margin: 0 }}>
                  Choose image
                  <input type="file" accept="image/*" onChange={onUpload} style={{ display: "none" }} />
                </label>
                <button className="btn btn-outline" onClick={rescan} disabled={phase === "idle"}>Clear</button>
              </>
            )}
            {mode === "samples" && (
              <>
                {samples.length === 0 && <span className="lp-hint">No sample images found on the server.</span>}
                {samples.map((s) => (
                  <button key={s.name} className="btn btn-outline btn-sm" onClick={() => analyzeImage(s.image)}>
                    Sample {s.name.replace(/\..+$/, "")}
                  </button>
                ))}
                <span className="grow" />
                <button className="btn btn-outline btn-sm" onClick={rescan} disabled={phase === "idle"}>Clear</button>
              </>
            )}
          </div>

          {mode === "camera" && (
            <div className="lp-hint">
              Shortcuts: <kbd>Space</kbd> lock the current plate, <kbd>Enter</kbd> confirm, <kbd>Esc</kbd> scan again. The plate locks by itself once it is read clearly.
            </div>
          )}

          {showSettings && (
            <div className="lp-set">
              <label>
                Scan speed
                <select value={settings.speed} onChange={(e) => setSettings({ ...settings, speed: e.target.value })}>
                  <option value="fast">Fast (every 0.7 s)</option>
                  <option value="normal">Normal (every 1.2 s)</option>
                  <option value="slow">Slow (every 2 s, lighter on the CPU)</option>
                </select>
              </label>
              <label>
                Auto-lock confidence: {Math.round(settings.minConf * 100)}%
                <input type="range" min="0.3" max="0.95" step="0.05" value={settings.minConf}
                  onChange={(e) => setSettings({ ...settings, minConf: Number(e.target.value) })} />
              </label>
              <label className="row">
                <input type="checkbox" checked={settings.autoLock} onChange={(e) => setSettings({ ...settings, autoLock: e.target.checked })} />
                Lock automatically when the plate is clear
              </label>
              <label className="row">
                <input type="checkbox" checked={settings.sound} onChange={(e) => setSettings({ ...settings, sound: e.target.checked })} />
                Beep on lock and on success
              </label>
            </div>
          )}
        </div>

        {/* ================= RIGHT: result ================= */}
        <div className="lp-card">
          <h4>{phase === "locked" ? "Plate locked: check and confirm" : det ? "Reading…" : "Detected plate"}</h4>

          {det ? (
            <>
              <div className="lp-plate-row">
                <input
                  className="lp-plate"
                  value={plateEdit ?? aiPlate}
                  maxLength={11}
                  spellCheck={false}
                  onFocus={ensureLocked}
                  onChange={(e) => { ensureLocked(); setPlateEdit(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "")); }}
                  aria-label="Detected number plate (editable)"
                />
                {checking && <span className="lp-hint">Checking pass…</span>}
              </div>

              <div className="lp-conf"><div style={{ width: `${confPct}%`, background: confColor }} /></div>
              <div className="lp-meta">
                <span>{confPct}% confidence</span>·
                <span style={{ color: det.valid_format ? "var(--success)" : "var(--warning)" }}>
                  {det.valid_format ? "Valid Indian plate format" : "Unusual format: check the characters"}
                </span>
                {det.candidates?.filter((c) => c !== aiPlate).length > 0 && (
                  <>
                    ·<span>Other readings:</span>
                    {det.candidates.filter((c) => c !== aiPlate).map((c) => (
                      <button key={c} className="lp-alt" onClick={() => { ensureLocked(); setPlateEdit(c); }}>{c}</button>
                    ))}
                  </>
                )}
              </div>
              <div className="lp-hint">Wrong character? Click the yellow plate and type the correct number. The pass is re-checked automatically.</div>

              {det.crop_base64 && <img className="lp-crop" src={det.crop_base64} alt="Cropped plate" />}

              {recInfo && (
                <div className="lp-reco" style={{ color: recInfo.color }}>{recInfo.label}</div>
              )}
              {mp?.match_type === "near" && (
                <div className="lp-toast err">
                  Near match only: the pass plate is <b>{mp.vehicle_number}</b>. Compare it with the real plate before letting the vehicle in.
                </div>
              )}

              {mp && (
                <dl className="lp-pass">
                  <dt>Visitor</dt><dd>{mp.visitor_name}</dd>
                  <dt>Host</dt><dd>{mp.host_name} (Flat {mp.host_flat || "-"})</dd>
                  <dt>Purpose</dt><dd>{mp.purpose || "-"}</dd>
                  <dt>Pass plate</dt><dd style={{ fontFamily: "monospace" }}>{mp.vehicle_number}</dd>
                  <dt>Valid until</dt><dd>{new Date(mp.expires_at).toLocaleString()}</dd>
                </dl>
              )}

              {!mp && rec !== "expired" && (
                <div className="lp-form">
                  <input placeholder="Visitor name (optional)" value={visitorName}
                    onFocus={ensureLocked} onChange={(e) => setVisitorName(e.target.value)} />
                  <input placeholder="Host flat number (optional)" value={flat}
                    onFocus={ensureLocked} onChange={(e) => setFlat(e.target.value)} />
                </div>
              )}

              {canLog && (
                <div className="lp-actions">
                  <div className="lp-seg">
                    <button className={gateAction === "entry" ? "on" : ""} onClick={() => setGateAction("entry")}>Entry</button>
                    <button className={gateAction === "exit" ? "on" : ""} onClick={() => setGateAction("exit")}>Exit</button>
                  </div>
                  <button className="btn btn-primary go" onClick={logAccess} disabled={logging}>
                    {logging ? "Saving…" : `Confirm ${gateAction.toUpperCase()}`}
                  </button>
                </div>
              )}
              <div className="lp-actions">
                <button className="btn btn-outline btn-sm" onClick={rescan}>Cancel and scan again</button>
              </div>
            </>
          ) : (
            <div className="lp-idle">
              <div style={{ fontSize: "2rem" }}>🚗</div>
              <div>No plate yet.</div>
              <ul>
                <li>Hold the plate flat and facing the camera</li>
                <li>Keep it 1 to 2 metres away, filling about a third of the frame</li>
                <li>Use even light with no glare or shadow across it</li>
                <li>Hold steady for 2 to 3 seconds</li>
              </ul>
            </div>
          )}

          {notice && <div className={`lp-toast ${notice.type}`}>{notice.text}</div>}
        </div>
      </div>

      {/* ---------- session log ---------- */}
      <div className="lp-card">
        <h4>Logged in this session</h4>
        {history.length === 0 ? (
          <div className="lp-hint">Vehicles you confirm here will appear in this list. The full record is under Entry / Exit Logs.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table className="lp-table">
              <thead><tr><th>Time</th><th>Plate</th><th>Visitor</th><th>Action</th></tr></thead>
              <tbody>
                {history.map((h, i) => (
                  <tr key={i}>
                    <td>{h.time.toLocaleTimeString()}</td>
                    <td className="mono">{h.plate}</td>
                    <td>{h.who}{h.walkin ? "" : ""}</td>
                    <td>
                      <span className={`lp-pill ${h.action === "entry" ? "in" : "out"}`}>{h.action === "entry" ? "ENTRY" : "EXIT"}</span>{" "}
                      {h.walkin && <span className="lp-pill walk">WALK-IN</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
