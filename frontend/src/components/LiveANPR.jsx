import { useState, useRef, useEffect, useCallback } from "react";
import API from "../api";

const SEND_WIDTH = 800; // frames are downscaled to this width before upload (bigger = clearer plate)
const INTERVAL_MS = 1200; // one detection request every ~1.2 s
const HOLD_MS = 6000; // keep showing the last good plate for 6 s
const WINDOW = 8; // vote over the last 8 readings
const CONFIRM_HITS = 2; // the voted plate must match this many individual readings

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

const RECO = {
  entry: { label: "Pass found: log ENTRY", color: "var(--success)" },
  exit: { label: "Vehicle inside: log EXIT", color: "#d97706" },
  already_exited: { label: "Vehicle already exited", color: "var(--danger)" },
  expired: { label: "Pass EXPIRED", color: "var(--danger)" },
  unregistered: { label: "No pass for this plate (walk-in)", color: "#d97706" },
  unknown: { label: "Unknown pass state", color: "var(--text-muted)" },
  none: { label: "", color: "var(--text-muted)" },
};

export default function LiveANPR({ onLogged }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const captureRef = useRef(null);
  const streamRef = useRef(null);
  const timerRef = useRef(null);
  const busyRef = useRef(false);
  const historyRef = useRef([]); // recent plate readings
  const lastGoodRef = useRef(0);

  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");
  const [running, setRunning] = useState(false);
  const [engine, setEngine] = useState(null); // /api/anpr/status
  const [camError, setCamError] = useState("");
  const [result, setResult] = useState(null); // {detection, matched_pass, recommendation, confirmed}
  const [latency, setLatency] = useState(null);
  const [gateAction, setGateAction] = useState("entry");
  const [visitorName, setVisitorName] = useState("");
  const [flat, setFlat] = useState("");
  const [logging, setLogging] = useState(false);
  const [logMsg, setLogMsg] = useState(null); // {ok, text}
  const [samples, setSamples] = useState([]);
  const [plateEdit, setPlateEdit] = useState(null); // manual correction (null = use AI reading)
  const [lookingUp, setLookingUp] = useState(false);

  // ---------- engine status + sample images ----------
  useEffect(() => {
    API.get("/api/anpr/status").then((r) => setEngine(r.data)).catch(() => setEngine({ status: "offline" }));
    API.get("/api/anpr/samples").then((r) => setSamples(r.data.samples || [])).catch(() => {});
  }, []);

  // ---------- overlay drawing ----------
  const drawBox = useCallback((det) => {
    const cv = overlayRef.current;
    const vid = videoRef.current;
    if (!cv) return;
    const w = (vid && vid.videoWidth) || cv.width;
    const h = (vid && vid.videoHeight) || cv.height;
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
    ctx.lineWidth = Math.max(3, w / 200);
    ctx.strokeStyle = "#22c55e";
    ctx.strokeRect(x, y, bw, bh);
    const label = det.plate_number;
    ctx.font = `bold ${Math.max(18, w / 28)}px monospace`;
    const tw = ctx.measureText(label).width + 12;
    const th = Math.max(26, w / 22);
    ctx.fillStyle = "#22c55e";
    ctx.fillRect(x, Math.max(0, y - th), tw, th);
    ctx.fillStyle = "#000";
    ctx.fillText(label, x + 6, Math.max(th - 8, y - 8));
  }, []);

  // ---------- send one frame ----------
  const detectOnce = useCallback(async (imageDataUrl) => {
    if (busyRef.current) return Promise.resolve();
    busyRef.current = true;
    try {
      const t0 = performance.now();
      const { data } = await API.post("/api/anpr/detect-frame", { image: imageDataUrl, auto_check_pass: true });
      setLatency(Math.round(performance.now() - t0));
      const det = data.detection;
      if (det && det.detected) {
        const hist = historyRef.current;
        hist.push(det.plate_number);
        if (hist.length > WINDOW) hist.shift();
        const { text, support } = voteReadings(hist);
        lastGoodRef.current = Date.now();
        drawBox(det);
        setResult({
          detection: { ...det, plate_number: text },
          matched_pass: data.matched_pass,
          recommendation: data.recommendation,
          confirmed: support >= CONFIRM_HITS,
        });
        // the pass lookup was done for this frame's own reading; re-check when the voted plate differs
        if (text !== det.plate_number) {
          API.get("/api/anpr/lookup", { params: { plate: text } })
            .then((r) => setResult((prev) => (prev && prev.detection.plate_number === text
              ? { ...prev, matched_pass: r.data.matched_pass, recommendation: r.data.recommendation } : prev)))
            .catch(() => {});
        }
        const rec = text === det.plate_number ? data.recommendation : null;
        if (rec === "exit") setGateAction("exit");
        else if (rec === "entry") setGateAction("entry");
      } else {
        drawBox(null);
        if (Date.now() - lastGoodRef.current > HOLD_MS) {
          historyRef.current = [];
          setPlateEdit(null);
          setResult(null);
        }
      }
    } catch (err) {
      if (err.response?.status === 401 || err.response?.status === 403) {
        setCamError("Not allowed to use ANPR. Log in as a guard or admin.");
      }
    } finally {
      busyRef.current = false;
    }
  }, [drawBox]);

  const grabFrame = useCallback(() => {
    const vid = videoRef.current;
    const cv = captureRef.current;
    if (!vid || !cv || !vid.videoWidth) return null;
    const scale = Math.min(1, SEND_WIDTH / vid.videoWidth);
    cv.width = Math.round(vid.videoWidth * scale);
    cv.height = Math.round(vid.videoHeight * scale);
    cv.getContext("2d").drawImage(vid, 0, 0, cv.width, cv.height);
    return cv.toDataURL("image/jpeg", 0.8);
  }, []);

  // ---------- camera control ----------
  const stopCamera = useCallback(() => {
    clearInterval(timerRef.current);
    timerRef.current = null;
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) videoRef.current.srcObject = null;
    drawBox(null);
    setRunning(false);
  }, [drawBox]);

  const startCamera = useCallback(async (id) => {
    setCamError("");
    setLogMsg(null);
    stopCamera();
    if (!navigator.mediaDevices?.getUserMedia) {
      setCamError("This browser cannot access the camera. Use Chrome or Edge on http://localhost:5173.");
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
      // device labels only appear after permission is granted
      const all = await navigator.mediaDevices.enumerateDevices();
      const cams = all.filter((d) => d.kind === "videoinput");
      setDevices(cams);
      const active = stream.getVideoTracks()[0]?.getSettings()?.deviceId;
      if (active) setDeviceId(active);
      setRunning(true);
      timerRef.current = setInterval(() => {
        const frame = grabFrame();
        if (frame) detectOnce(frame);
      }, INTERVAL_MS);
    } catch (err) {
      const name = err?.name || "";
      if (name === "NotAllowedError") setCamError("Camera permission denied. Click the camera icon in the address bar and allow access.");
      else if (name === "NotFoundError") setCamError("No camera found. Plug in a webcam or check that another app is not using it.");
      else if (name === "NotReadableError") setCamError("Camera is busy. Close Zoom/Teams/other tabs that use it, then try again.");
      else setCamError(`Could not start camera: ${err?.message || name}`);
    }
  }, [stopCamera, grabFrame, detectOnce]);

  useEffect(() => () => stopCamera(), [stopCamera]);

  // ---------- test with a sample / uploaded image ----------
  const detectImage = (dataUrl) => {
    stopCamera();
    setLogMsg(null);
    const img = new Image();
    img.onload = () => {
      const cv = captureRef.current;
      const scale = Math.min(1, SEND_WIDTH / img.width);
      cv.width = Math.round(img.width * scale);
      cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      // draw the still under the overlay so the box lines up
      const ov = overlayRef.current;
      ov.width = cv.width;
      ov.height = cv.height;
      historyRef.current = [];
      setPlateEdit(null);
      detectOnce(cv.toDataURL("image/jpeg", 0.85)).then(() => detectOnce(cv.toDataURL("image/jpeg", 0.9)));
    };
    img.src = dataUrl;
  };

  const onUpload = (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => detectImage(reader.result);
    reader.readAsDataURL(f);
    e.target.value = "";
  };

  // ---------- log the gate action ----------
  const logAccess = async () => {
    if (!result) return;
    setLogging(true);
    setLogMsg(null);
    try {
      const { data } = await API.post("/api/anpr/quick-log", {
        action: gateAction,
        plate_number: currentPlate,
        pass_id: result.matched_pass?.id ?? null,
        visitor_name: result.matched_pass ? undefined : visitorName.trim() || undefined,
        flat_number: result.matched_pass ? undefined : flat.trim() || undefined,
      });
      setLogMsg({ ok: !!data.success, text: data.message });
      if (data.success) {
        if (onLogged) onLogged(data.message);
        setVisitorName("");
        setFlat("");
        setResult(null);
        setPlateEdit(null);
        historyRef.current = [];
        lastGoodRef.current = 0;
        drawBox(null);
      }
    } catch (err) {
      setLogMsg({ ok: false, text: err.response?.data?.detail || "Could not record the entry/exit." });
    } finally {
      setLogging(false);
    }
  };

  const aiPlate = result?.detection?.plate_number || "";
  const currentPlate = (plateEdit ?? aiPlate).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const edited = plateEdit !== null && currentPlate !== aiPlate;

  const lookupEdited = async () => {
    if (!currentPlate) return;
    setLookingUp(true);
    try {
      const { data } = await API.get("/api/anpr/lookup", { params: { plate: currentPlate } });
      setResult((prev) => (prev ? { ...prev, matched_pass: data.matched_pass, recommendation: data.recommendation, confirmed: true } : prev));
      if (data.recommendation === "exit") setGateAction("exit");
      else if (data.recommendation === "entry") setGateAction("entry");
    } catch { /* ignore */ }
    setLookingUp(false);
  };

  const reco = RECO[result?.recommendation || "none"] || RECO.none;
  const det = result?.detection;
  const mp = result?.matched_pass;
  const canLog = result && currentPlate.length >= 4 && result.recommendation !== "expired" && result.recommendation !== "already_exited";

  return (
    <div className="panel">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
        <h3 style={{ margin: 0 }}>Live Number Plate Recognition</h3>
        <span
          style={{
            fontSize: "0.8rem",
            padding: "4px 10px",
            borderRadius: 999,
            border: "1px solid var(--border)",
            color: engine?.initialized ? "var(--success)" : "var(--danger)",
          }}
        >
          {engine == null
            ? "Checking engine…"
            : engine.initialized
            ? `AI engine online (${engine.device})`
            : "AI engine NOT loaded: check the backend window"}
        </span>
      </div>

      {camError && <div className="alert alert-error" style={{ marginTop: 12 }}>{camError}</div>}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", margin: "14px 0" }}>
        {!running ? (
          <button className="btn btn-primary" onClick={() => startCamera(deviceId)}>Start Camera</button>
        ) : (
          <button className="btn btn-danger" onClick={stopCamera}>Stop Camera</button>
        )}
        {devices.length > 1 && (
          <select
            value={deviceId}
            onChange={(e) => { setDeviceId(e.target.value); startCamera(e.target.value); }}
            style={{ maxWidth: 260 }}
          >
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${i + 1}`}</option>
            ))}
          </select>
        )}
        <label className="btn btn-outline" style={{ cursor: "pointer", margin: 0 }}>
          Test with image
          <input type="file" accept="image/*" onChange={onUpload} style={{ display: "none" }} />
        </label>
        {samples.map((s) => (
          <button key={s.name} className="btn btn-outline btn-sm" onClick={() => detectImage(s.image)}>
            Sample {s.name.replace(/\..+$/, "")}
          </button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 16 }}>
        {/* camera + overlay */}
        <div>
          <div style={{ position: "relative", background: "#000", borderRadius: 10, overflow: "hidden", aspectRatio: "16 / 9" }}>
            <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%", objectFit: "contain", display: running ? "block" : "none" }} />
            <canvas
              ref={overlayRef}
              style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "contain", pointerEvents: "none" }}
            />
            {!running && !det && (
              <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", textAlign: "center", padding: 16 }}>
                Click “Start Camera” and hold a number plate about 1 to 2 metres from the lens, in good light.
              </div>
            )}
          </div>
          <canvas ref={captureRef} style={{ display: "none" }} />
          <div style={{ fontSize: "0.8rem", color: "var(--text-muted)", marginTop: 6 }}>
            {running ? `Scanning live… ${latency != null ? `${latency} ms per frame` : ""}` : "Camera is off"}
          </div>
        </div>

        {/* result */}
        <div>
          {det ? (
            <div style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14 }}>
              <div style={{ fontSize: "0.8rem", color: "var(--text-muted)" }}>
                {result.confirmed ? "Plate confirmed" : "Reading… (hold steady)"} · {Math.round((det.confidence || 0) * 100)}% confidence
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "6px 0" }}>
                <input
                  value={plateEdit ?? aiPlate}
                  onChange={(e) => setPlateEdit(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
                  onKeyDown={(e) => { if (e.key === "Enter") lookupEdited(); }}
                  maxLength={11}
                  spellCheck={false}
                  style={{
                    fontFamily: "monospace", fontSize: "1.7rem", fontWeight: 700, letterSpacing: 3,
                    padding: "4px 10px", border: "2px solid #111", borderRadius: 6,
                    background: "#facc15", color: "#111", width: "min(100%, 15ch)",
                  }}
                />
                {edited && (
                  <button className="btn btn-outline btn-sm" onClick={lookupEdited} disabled={lookingUp}>
                    {lookingUp ? "Checking…" : "Check pass"}
                  </button>
                )}
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginBottom: 6 }}>
                {det.valid_format ? "Valid Indian plate format." : "Format looks unusual: check the characters."} Wrong? Type the correct plate above{edited ? " and press Check pass." : "."}
                {det.candidates?.length > 1 && !edited ? ` Other readings: ${det.candidates.slice(1).join(", ")}` : ""}
              </div>
              {det.crop_base64 && (
                <div><img src={det.crop_base64} alt="plate crop" style={{ maxWidth: 220, borderRadius: 4, marginBottom: 8 }} /></div>
              )}
              <div style={{ fontWeight: 600, color: reco.color, marginBottom: 8 }}>{reco.label}</div>
              {mp?.match_type === "near" && (
                <div className="alert alert-error" style={{ marginBottom: 8 }}>
                  Near match only: the pass plate is <b>{mp.vehicle_number}</b>. Check the real plate before allowing entry.
                </div>
              )}

              {mp && (
                <div style={{ fontSize: "0.9rem", marginBottom: 10, lineHeight: 1.6 }}>
                  <div><b>Visitor:</b> {mp.visitor_name}</div>
                  <div><b>Host:</b> {mp.host_name} (Flat {mp.host_flat || "—"})</div>
                  <div><b>Purpose:</b> {mp.purpose || "—"}</div>
                </div>
              )}

              {!mp && (
                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  <input placeholder="Visitor name (optional)" value={visitorName} onChange={(e) => setVisitorName(e.target.value)} />
                  <input placeholder="Host flat number (optional)" value={flat} onChange={(e) => setFlat(e.target.value)} />
                </div>
              )}

              {canLog && (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <button className={`btn btn-sm ${gateAction === "entry" ? "btn-primary" : "btn-outline"}`} onClick={() => setGateAction("entry")}>Entry</button>
                  <button className={`btn btn-sm ${gateAction === "exit" ? "btn-primary" : "btn-outline"}`} onClick={() => setGateAction("exit")}>Exit</button>
                  <button className="btn btn-primary" onClick={logAccess} disabled={logging || !(result.confirmed || edited)}>
                    {logging ? "Saving…" : `Confirm ${gateAction.toUpperCase()}`}
                  </button>
                </div>
              )}
              {canLog && !result.confirmed && !edited && (
                <div style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: 6 }}>
                  The button unlocks when the plate reading is stable, or after you type the plate yourself.
                </div>
              )}
            </div>
          ) : (
            <div style={{ border: "1px dashed var(--border)", borderRadius: 10, padding: 18, color: "var(--text-muted)" }}>
              No plate detected yet.
            </div>
          )}

          {logMsg && (
            <div className={`alert ${logMsg.ok ? "alert-success" : "alert-error"}`} style={{ marginTop: 12 }}>
              {logMsg.text}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
