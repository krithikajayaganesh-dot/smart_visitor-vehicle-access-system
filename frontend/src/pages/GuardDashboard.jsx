import { useState, useRef, useEffect } from "react";
import { Html5Qrcode } from "html5-qrcode";
import API from "../api";
import Navbar from "../components/Navbar";
import Toast from "../components/Toast";
import CampusSketchBG from "../components/CampusSketchBG";
import LiveANPR from "../components/LiveANPR";
import { formatDateTime, formatTimeOnly } from "../utils/datetime";
import { exportToCSV } from "../utils/exportCsv";
import {
  KeyboardIcon,
  SearchIcon,
  SortIcon,
  CameraIcon,
  StopIcon,
  VehicleEntryIcon,
  VehicleExitIcon,
  ExportIcon,
  RefreshIcon,
  QrTicketIcon,
  LogsIcon,
  FilterIcon,
  FolderIcon,
  ClipboardIcon,
  CheckCircleIcon,
  XCircleIcon,
  CalendarIcon,
  ClockIcon,
} from "../components/Icons";

export default function GuardDashboard() {
  const [scanResult, setScanResult] = useState(null);
  const [lastSource, setLastSource] = useState(null); // 'qr' or 'manual'
  const [scanning, setScanning] = useState(false);
  const [manualToken, setManualToken] = useState("");
  const [error, setError] = useState("");
  const [toast, setToast] = useState({ message: "", type: "info" });
  const [searchQuery, setSearchQuery] = useState("");
  const [sortOrder, setSortOrder] = useState("date_desc"); // 'date_desc', 'date_asc', 'name_asc', 'name_desc'
  const [statusFilter, setStatusFilter] = useState("all"); // 'all', 'in_campus', 'not_inside', 'exited', 'expired'
  const [actionFilter, setActionFilter] = useState("all"); // 'all', 'entry', 'exit'
  
  // Date Range & Time Filter state
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [datePreset, setDatePreset] = useState("all"); // 'all', 'today', 'yesterday', 'last7', 'custom'
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [action, setAction] = useState("entry");
  const scannerRef = useRef(null);
  const html5QrCodeRef = useRef(null);
  const isProcessingScanRef = useRef(false);
  const isVerifyingRef = useRef(false);

  // Manual vehicle entry form state
  const [manualVehicle, setManualVehicle] = useState("");
  const [manualVisitor, setManualVisitor] = useState("");
  const [manualFlat, setManualFlat] = useState("");
  const [manualPurpose, setManualPurpose] = useState("");
  const [loadingManual, setLoadingManual] = useState(false);
  const [verifying, setVerifying] = useState(false);

  // Today's lists state
  const [todayPasses, setTodayPasses] = useState([]);
  const [todayLogs, setTodayLogs] = useState([]);
  const [activeTab, setActiveTab] = useState("scanner"); // "scanner", "passes", "logs"
  const [visiblePassesCount, setVisiblePassesCount] = useState(10);
  const [visibleLogsCount, setVisibleLogsCount] = useState(10);

  // Sorting helper
  const sortData = (list) => {
    return [...list].sort((a, b) => {
      const aId = a.id || 0;
      const bId = b.id || 0;

      const aName = (a.visitor_name || a.vehicle_number || a.visitor_pass?.visitor_name || a.visitor_pass?.vehicle_number || "").toLowerCase();
      const bName = (b.visitor_name || b.vehicle_number || b.visitor_pass?.visitor_name || b.visitor_pass?.vehicle_number || "").toLowerCase();

      const aDate = new Date(a.timestamp || a.created_at || a.expires_at || 0).getTime();
      const bDate = new Date(b.timestamp || b.created_at || b.expires_at || 0).getTime();

      if (sortOrder === "id_asc") return aId - bId;
      if (sortOrder === "id_desc") return bId - aId;
      if (sortOrder === "name_asc") return aName.localeCompare(bName);
      if (sortOrder === "name_desc") return bName.localeCompare(aName);
      if (sortOrder === "date_desc") return bDate - aDate;
      if (sortOrder === "date_asc") return aDate - bDate;
      return 0;
    });
  };

  const renderStatusBadge = (status) => {
    const map = {
      not_inside: { label: "Pass Created (Not Inside)", badge: "badge-not_inside" },
      approved: { label: "Pass Created (Not Inside)", badge: "badge-not_inside" },
      pending: { label: "Pass Created (Not Inside)", badge: "badge-not_inside" },
      in_campus: { label: "In Campus", badge: "badge-in_campus" },
      used: { label: "In Campus", badge: "badge-in_campus" },
      exited: { label: "Vehicle Exited Campus", badge: "badge-exited" },
      expired: { label: "Pass Expired", badge: "badge-expired" },
    };
    const item = map[status] || { label: status?.toUpperCase() || "UNKNOWN", badge: "badge-pending" };
    return <span className={`badge ${item.badge}`}>{item.label}</span>;
  };

  useEffect(() => {
    fetchTodayData();
    return () => {
      stopScanner();
    };
  }, []);

  // Keyboard Shortcuts for Power Users (Alt+S: Scanner, Alt+E: Toggle Action, Alt+R: Refresh)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.altKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (scanning) stopScanner();
        else startScanner();
      } else if (e.altKey && (e.key === "e" || e.key === "E")) {
        e.preventDefault();
        setAction((prev) => (prev === "entry" ? "exit" : "entry"));
        setToast({ message: `Gate action set to ${action === "entry" ? "EXIT" : "ENTRY"}`, type: "info" });
      } else if (e.altKey && (e.key === "r" || e.key === "R")) {
        e.preventDefault();
        fetchTodayData();
        setToast({ message: "Today's logs and passes refreshed", type: "info" });
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [scanning, action]);

  const handleExportPasses = () => {
    exportToCSV("today_approved_passes.csv", filteredPasses, [
      { label: "Visitor Name", accessor: "visitor_name" },
      { label: "Vehicle Number", accessor: (r) => r.vehicle_number || "N/A" },
      { label: "Purpose", accessor: (r) => r.purpose || "N/A" },
      { label: "Resident Name", accessor: (r) => r.resident?.full_name || "N/A" },
      { label: "Flat Number", accessor: (r) => r.resident?.flat_number || "N/A" },
      { label: "Pass Status", accessor: "status" },
      { label: "Expires Date & Time", accessor: (r) => formatDateTime(r.expires_at) },
    ]);
    setToast({ message: "Exported today's passes to CSV", type: "success" });
  };

  const handleExportLogs = () => {
    exportToCSV("today_vehicle_logs.csv", filteredLogs, [
      { label: "Log ID", accessor: "id" },
      { label: "Gate Action", accessor: (r) => r.action.toUpperCase() },
      { label: "Vehicle Number", accessor: (r) => r.visitor_pass?.vehicle_number || "N/A" },
      { label: "Visitor Name", accessor: (r) => r.visitor_pass?.visitor_name || "N/A" },
      { label: "Resident Name", accessor: (r) => r.visitor_pass?.resident?.full_name || "N/A" },
      { label: "Flat Number", accessor: (r) => r.visitor_pass?.resident?.flat_number || "N/A" },
      { label: "Logged By Guard", accessor: (r) => r.guard?.full_name || "N/A" },
      { label: "Timestamp", accessor: (r) => formatDateTime(r.timestamp) },
    ]);
    setToast({ message: "Exported today's activity logs to CSV", type: "success" });
  };

  const fetchTodayData = async () => {
    try {
      const params = {};
      if (fromDate) params.from_date = new Date(fromDate).toISOString();
      if (toDate) params.to_date = new Date(toDate).toISOString();

      const [passesRes, logsRes] = await Promise.all([
        API.get("/api/qr/today-passes", { params }),
        API.get("/api/qr/today-logs", { params }),
      ]);
      setTodayPasses(passesRes.data);
      setTodayLogs(logsRes.data);
      setVisiblePassesCount(10);
      setVisibleLogsCount(10);
    } catch (err) {
      console.error("Failed to fetch today guard data:", err);
    }
  };

  const startScanner = async () => {
    setError("");
    setScanResult(null);
    setScanning(true);
    isProcessingScanRef.current = false;

    try {
      const html5QrCode = new Html5Qrcode("qr-reader");
      html5QrCodeRef.current = html5QrCode;

      await html5QrCode.start(
        { facingMode: "environment" },
        { fps: 10, qrbox: { width: 250, height: 250 } },
        async (decodedText) => {
          if (isProcessingScanRef.current) return;
          isProcessingScanRef.current = true;
          try {
            await html5QrCode.stop();
          } catch (e) {}
          setScanning(false);
          verifyToken(decodedText, 'qr');
        },
        () => {} // ignore scan errors
      );
    } catch (err) {
      setError("Camera access denied or unavailable. Use manual entry or file upload below.");
      setScanning(false);
    }
  };


  const stopScanner = async () => {
    if (html5QrCodeRef.current) {
      try {
        await html5QrCodeRef.current.stop();
      } catch (e) {
        // Scanner might already be stopped
      }
    }
    setScanning(false);
  };

  const verifyToken = async (token, source = 'qr') => {
    if (isVerifyingRef.current) return;
    isVerifyingRef.current = true;
    setError("");
    setScanResult(null);
    setVerifying(true);
    try {
      const res = await API.post("/api/qr/verify", { qr_token: token, action });
      setScanResult(res.data);
      setLastSource(source);
      fetchTodayData(); // Refresh tables in real-time
    } catch (err) {
      setError(err.response?.data?.detail || "Verification failed");
    } finally {
      setVerifying(false);
      setTimeout(() => {
        isVerifyingRef.current = false;
      }, 800);
    }
  };

  const handleManualVerify = (e) => {
    e.preventDefault();
    if (manualToken.trim()) {
      verifyToken(manualToken.trim(), 'qr');
      setManualToken("");
    }
  };

  const processImageFile = async (file) => {
    setError("");
    setScanResult(null);
    try {
      const html5QrCode = new Html5Qrcode("qr-file-helper");
      const decodedText = await html5QrCode.scanFile(file, true);
      html5QrCode.clear();
      verifyToken(decodedText, 'qr');
    } catch (err) {
      setError("Could not read a valid QR code from that image. Please try another image file.");
    }
  };

  const handleFileUpload = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      processImageFile(file);
    }
  };

  const handlePaste = (e) => {
    if (e) {
      e.stopPropagation();
    }
    const items = e.clipboardData?.files;
    if (items && items.length > 0) {
      const file = items[0];
      if (file.type.startsWith("image/")) {
        e.preventDefault();
        processImageFile(file);
      }
    }
  };


  const handleManualVehicleSubmit = async (e) => {
    e.preventDefault();
    if (loadingManual) return;
    if (!manualVehicle.trim() || !manualVisitor.trim()) {
      setError("Please provide at least Vehicle Number and Visitor Name.");
      return;
    }

    setError("");
    setScanResult(null);
    setLoadingManual(true);
    try {
      const res = await API.post("/api/qr/manual-entry", {
        vehicle_number: manualVehicle.trim().toUpperCase(),
        visitor_name: manualVisitor.trim(),
        flat_number: manualFlat.trim() || null,
        purpose: manualPurpose.trim() || "Manual Gate Entry",
        action: action,
      });
      setScanResult(res.data);
      setLastSource('manual');
      setManualVehicle("");
      setManualVisitor("");
      setManualFlat("");
      setManualPurpose("");
      fetchTodayData(); // Refresh tables in real-time
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to log manual vehicle entry");
    } finally {
      setLoadingManual(false);
    }
  };


  const renderResultCard = () => {
    if (!scanResult) return null;
    return (
      <div className={`scan-result-container ${scanResult.valid ? "result-valid" : "result-invalid"}`}>
        <h3 style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          {scanResult.valid ? <CheckCircleIcon size={20} style={{ color: "var(--success)" }} /> : <XCircleIcon size={20} style={{ color: "var(--danger)" }} />} {scanResult.message}
        </h3>
        {scanResult.visitor_pass && (
          <>
            <div className="result-details">
              <div className="detail-row"><strong>Visitor:</strong> {scanResult.visitor_pass.visitor_name}</div>
              <div className="detail-row"><strong>Vehicle Number:</strong> <code>{scanResult.visitor_pass.vehicle_number || "Not specified"}</code></div>
              <div className="detail-row"><strong>Purpose:</strong> {scanResult.visitor_pass.purpose || "Not specified"}</div>
              <div className="detail-row"><strong>Vehicle Status:</strong> {renderStatusBadge(scanResult.visitor_pass.status)}</div>
              <div className="detail-row"><strong>Host Resident:</strong> {scanResult.visitor_pass.resident?.full_name || "—"} ({scanResult.visitor_pass.resident?.flat_number || "Gate"})</div>
              <div className="detail-row"><strong>Expires / Valid Until:</strong> {formatDateTime(scanResult.visitor_pass.expires_at)}</div>
            </div>

            {scanResult.visitor_pass.qr_image_path && (
              <div className="qr-pass-display-box" style={{ marginTop: "16px", padding: "16px", background: "var(--bg-input)", borderRadius: "var(--radius)", textAlign: "center", border: "1px solid var(--border)" }}>
                <h4 style={{ margin: "0 0 6px 0", fontSize: "0.95rem", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", gap: "6px" }}>
                  <QrTicketIcon size={18} /> Gate Pass QR Code (Generated for Exit Verification)
                </h4>
                <img
                  src={`http://${window.location.hostname}:8000${scanResult.visitor_pass.qr_image_path}`}
                  alt="Gate Pass QR Code"
                  style={{ width: "160px", height: "160px", margin: "10px auto", display: "block", borderRadius: "8px", border: "2px solid var(--border)", background: "#fff", padding: "4px" }}
                />
                <p style={{ fontSize: "0.8rem", color: "var(--text-muted)", margin: "4px 0 0 0" }}>
                  Pass Token UUID: <code>{scanResult.visitor_pass.qr_token}</code>
                </p>
              </div>
            )}
          </>
        )}
      </div>
    );
  };

  const applyDatePreset = (preset) => {
    setDatePreset(preset);
    const now = new Date();
    if (preset === "all") {
      setFromDate("");
      setToDate("");
    } else if (preset === "today") {
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
      const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
      setFromDate(start.toISOString().slice(0, 16));
      setToDate(end.toISOString().slice(0, 16));
    } else if (preset === "yesterday") {
      const y = new Date();
      y.setDate(y.getDate() - 1);
      const start = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0);
      const end = new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59);
      setFromDate(start.toISOString().slice(0, 16));
      setToDate(end.toISOString().slice(0, 16));
    } else if (preset === "last7") {
      const start = new Date();
      start.setDate(start.getDate() - 7);
      start.setHours(0, 0, 0, 0);
      const end = new Date();
      end.setHours(23, 59, 59, 999);
      setFromDate(start.toISOString().slice(0, 16));
      setToDate(end.toISOString().slice(0, 16));
    }
  };

  const resetAllFilters = () => {
    setSearchQuery("");
    setStatusFilter("all");
    setActionFilter("all");
    setDatePreset("all");
    setFromDate("");
    setToDate("");
    setSortOrder("date_desc");
    
    // We should refetch without date filters when clearing
    setTimeout(() => {
        // A little hack to fetch without dates because state isn't immediately updated
        API.get("/api/qr/today-passes").then(res => setTodayPasses(res.data));
        API.get("/api/qr/today-logs").then(res => setTodayLogs(res.data));
    }, 0);
  };

  const filteredPasses = sortData(todayPasses.filter((p) => {
    if (statusFilter !== "all" && p.status !== statusFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      (p.visitor_name && p.visitor_name.toLowerCase().includes(q)) ||
      (p.vehicle_number && p.vehicle_number.toLowerCase().includes(q)) ||
      (p.purpose && p.purpose.toLowerCase().includes(q)) ||
      (p.resident?.full_name && p.resident.full_name.toLowerCase().includes(q)) ||
      (p.resident?.flat_number && p.resident.flat_number.toLowerCase().includes(q)) ||
      (p.status && p.status.toLowerCase().includes(q))
    );
  }));

  const filteredLogs = sortData(todayLogs.filter((log) => {
    if (actionFilter !== "all" && log.action !== actionFilter) return false;
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase().trim();
    return (
      (log.action && log.action.toLowerCase().includes(q)) ||
      (log.visitor_pass?.vehicle_number && log.visitor_pass.vehicle_number.toLowerCase().includes(q)) ||
      (log.visitor_pass?.visitor_name && log.visitor_pass.visitor_name.toLowerCase().includes(q)) ||
      (log.visitor_pass?.resident?.full_name && log.visitor_pass.resident.full_name.toLowerCase().includes(q)) ||
      (log.visitor_pass?.resident?.flat_number && log.visitor_pass.resident.flat_number.toLowerCase().includes(q)) ||
      (log.guard?.full_name && log.guard.full_name.toLowerCase().includes(q))
    );
  }));

  const displayedPasses = filteredPasses.slice(0, visiblePassesCount);
  const displayedLogs = filteredLogs.slice(0, visibleLogsCount);

  return (
    <>
      <CampusSketchBG />
      <Navbar />
      <Toast message={toast.message} type={toast.type} onClose={() => setToast({ message: "", type: "info" })} />

      <div className="dashboard" onPaste={handlePaste}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "16px" }}>
          <h2 style={{ margin: 0 }}>Gate Guard Terminal</h2>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => setShowShortcuts(!showShortcuts)}
            style={{ fontSize: "0.85rem", display: "inline-flex", alignItems: "center", gap: "6px" }}
          >
            <KeyboardIcon size={16} /> {showShortcuts ? "Hide Shortcuts" : "Keyboard Shortcuts"}
          </button>
        </div>

        {error && <div className="alert alert-error">{error}</div>}

        {showShortcuts && (
          <div className="shortcuts-legend" style={{ marginBottom: "16px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><KeyboardIcon size={14} /> Power Shortcuts:</span>
            <span><span className="shortcut-badge">Alt + S</span> Start/Stop Camera</span>
            <span><span className="shortcut-badge">Alt + E</span> Toggle Action (Entry/Exit)</span>
            <span><span className="shortcut-badge">Alt + R</span> Refresh Logs</span>
          </div>
        )}

        {/* Dashboard Section Navigation Tabs */}
        <div className="tabs">
          <button
            className={`tab ${activeTab === "scanner" ? "active" : ""}`}
            onClick={() => setActiveTab("scanner")}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <CameraIcon size={16} /> Gate Scanner & Manual Entry
          </button>
          <button
            className={`tab ${activeTab === "anpr" ? "active" : ""}`}
            onClick={() => { if (scanning) stopScanner(); setError(""); setActiveTab("anpr"); }}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <CameraIcon size={16} /> Live Plate Recognition
          </button>
          <button
            className={`tab ${activeTab === "passes" ? "active" : ""}`}
            onClick={() => setActiveTab("passes")}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <QrTicketIcon size={16} /> Approved Passes ({filteredPasses.length})
          </button>
          <button
            className={`tab ${activeTab === "logs" ? "active" : ""}`}
            onClick={() => setActiveTab("logs")}
            style={{ display: "flex", alignItems: "center", gap: "6px" }}
          >
            <LogsIcon size={16} /> Entry / Exit Logs ({filteredLogs.length})
          </button>
        </div>

        {/* Live ANPR camera tab */}
        {activeTab === "anpr" && (
          <LiveANPR
            onLogged={(msg) => {
              setToast({ message: msg, type: "success" });
              fetchTodayData();
            }}
          />
        )}

        {/* Tab 1: Gate Scanner & Manual Entry */}
        {activeTab === "scanner" && (
          <>
            {/* Scan & Verification Panel */}
            <div className="panel">
              <h3 style={{ display: "flex", alignItems: "center", gap: "8px" }}><SearchIcon size={18} /> Scan / Upload Visitor QR Code</h3>

              <div className="scan-controls">
                <div className="gate-action-toggle-group">
                  <label className="gate-action-label">Gate Action</label>
                  <div className="gate-action-buttons">
                    <button
                      type="button"
                      className={`btn-action-toggle ${action === "entry" ? "active-entry" : ""}`}
                      onClick={() => setAction("entry")}
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <VehicleEntryIcon size={16} /> Vehicle Entry
                    </button>
                    <button
                      type="button"
                      className={`btn-action-toggle ${action === "exit" ? "active-exit" : ""}`}
                      onClick={() => setAction("exit")}
                      style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}
                    >
                      <VehicleExitIcon size={16} /> Vehicle Exit
                    </button>
                  </div>
                </div>

                {!scanning ? (
                  <button className="btn btn-primary" onClick={startScanner} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <CameraIcon size={18} /> Start Live Camera Scanner
                  </button>
                ) : (
                  <button className="btn btn-danger" onClick={stopScanner} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                    <StopIcon size={18} /> Stop Camera Scanner
                  </button>
                )}
              </div>

              <div id="qr-reader" className="qr-scanner-box"></div>
              <div id="qr-file-helper" style={{ display: "none" }}></div>

              <div className="qr-methods">
                <div className="qr-method-card">
                  <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}><FolderIcon size={16} /> Select QR Image File</h4>
                  <p className="method-desc">Choose a saved QR image (`.png`, `.jpg`, `.jpeg`) from device:</p>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleFileUpload}
                    className="file-input"
                  />
                </div>

                <div className="qr-method-card">
                  <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}><ClipboardIcon size={16} /> Paste Image from Clipboard</h4>
                  <p className="method-desc">Press <strong>Ctrl + V</strong> (or <strong>Cmd + V</strong>) anywhere, or click below:</p>
                  <div className="paste-zone" tabIndex="0" onPaste={handlePaste}>
                    <span>Click & Press Ctrl+V to paste QR image</span>
                  </div>
                </div>

                <div className="qr-method-card">
                  <h4 style={{ display: "flex", alignItems: "center", gap: "6px" }}><KeyboardIcon size={16} /> Manual Token UUID String</h4>
                  <p className="method-desc">Enter raw QR UUID token string:</p>
                  <form onSubmit={handleManualVerify} className="form-row">
                    <input
                      type="text"
                      value={manualToken}
                      onChange={(e) => setManualToken(e.target.value)}
                      placeholder="e.g. e75baca1-d421-4191..."
                      className="flex-grow"
                    />
                    <button type="submit" className="btn btn-primary" disabled={verifying || !manualToken.trim()}>
                      {verifying ? "Verifying..." : "Verify"}
                    </button>
                  </form>
                </div>
              </div>

              {/* QR Scan Result Banner rendered immediately inside the QR section */}
              {lastSource === 'qr' && renderResultCard()}
            </div>

            {/* Manual Vehicle Entry Panel */}
            <div className="panel">
              <h3 style={{ display: "flex", alignItems: "center", gap: "8px" }}><VehicleEntryIcon size={20} /> Manual Vehicle Entry / Register</h3>
              <p className="method-desc" style={{ marginBottom: "16px" }}>
                Use this section for walk-in visitors or vehicles arriving without a pre-generated QR code pass.
              </p>

              {(() => {
                const isManualEntryDisabled = loadingManual || !manualVehicle.trim() || !manualVisitor.trim() || !(/^[A-Z0-9\s-]{4,15}$/i.test(manualVehicle.trim()));

                return (
                  <form onSubmit={handleManualVehicleSubmit} className="create-form">
                    <div className="form-row">
                      <div className="form-group">
                        <label>
                          Vehicle Number <span style={{ color: "var(--primary)", fontWeight: "bold" }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={manualVehicle}
                          onChange={(e) => setManualVehicle(e.target.value.toUpperCase())}
                          placeholder="e.g. MH14DX5842"
                          required
                        />
                        {manualVehicle && (
                          <small style={{ color: (/^[A-Z0-9\s-]{4,15}$/i.test(manualVehicle.trim())) ? "var(--success)" : "var(--danger)", fontSize: "0.8rem", marginTop: "4px", display: "block" }}>
                            {(/^[A-Z0-9\s-]{4,15}$/i.test(manualVehicle.trim())) ? "✓ Valid vehicle license plate format" : "Format should be e.g. MH14DX5842 or KA01AB1234"}
                          </small>
                        )}
                      </div>
                      <div className="form-group">
                        <label>
                          Visitor Name <span style={{ color: "var(--primary)", fontWeight: "bold" }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={manualVisitor}
                          onChange={(e) => setManualVisitor(e.target.value)}
                          placeholder="e.g. Suresh Kumar"
                          required
                        />
                      </div>
                    </div>

                    <div className="form-row">
                      <div className="form-group">
                        <label>
                          Flat / Unit Number <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontWeight: "normal" }}>(Optional)</span>
                        </label>
                        <input
                          type="text"
                          value={manualFlat}
                          onChange={(e) => setManualFlat(e.target.value)}
                          placeholder="e.g. A-101 (Optional)"
                        />
                      </div>
                      <div className="form-group">
                        <label>
                          Purpose <span style={{ color: "var(--text-muted)", fontSize: "0.8rem", fontWeight: "normal" }}>(Optional)</span>
                        </label>
                        <input
                          type="text"
                          value={manualPurpose}
                          onChange={(e) => setManualPurpose(e.target.value)}
                          placeholder="e.g. Delivery, Maintenance, Guest"
                        />
                      </div>
                    </div>

                    <button type="submit" className="btn btn-primary" disabled={isManualEntryDisabled} style={{ display: "inline-flex", alignItems: "center", gap: "6px" }}>
                      <VehicleEntryIcon size={16} /> {loadingManual ? "Logging..." : `Log Manual Vehicle ${action.toUpperCase()}`}
                    </button>

                  </form>
                );
              })()}

              {/* Manual Entry Result Banner rendered immediately inside the Manual Entry section */}
              {lastSource === 'manual' && renderResultCard()}
            </div>
          </>
        )}

        {/* Tab 2: Today's Approved Visitor Passes */}
        {activeTab === "passes" && (
          <div className="panel">
            <div className="panel-header">
              <h3 style={{ display: "flex", alignItems: "center", gap: "8px" }}><QrTicketIcon size={20} /> Approved Visitor Passes</h3>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn btn-outline btn-sm" onClick={handleExportPasses} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><ExportIcon size={14} /> Export CSV</button>
                <button className="btn btn-outline btn-sm" onClick={fetchTodayData} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><RefreshIcon size={14} /> Refresh</button>
              </div>
            </div>

            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "16px", marginBottom: "20px" }}>
              <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
                <div className="search-filter-box" style={{ flex: 1, minWidth: "240px", marginBottom: 0 }}>
                  <SearchIcon className="search-icon" size={16} />
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search passes by visitor name, vehicle number, host resident, flat..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                    <FilterIcon size={16} /> Filter Status:
                  </label>
                  <select
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    style={{
                      padding: "10px 14px",
                      fontSize: "0.875rem",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      color: "var(--text)",
                      fontWeight: 500,
                      cursor: "pointer"
                    }}
                  >
                    <option value="all">All Statuses</option>
                    <option value="in_campus">In Campus Only</option>
                    <option value="not_inside">Not Inside (Pass Created)</option>
                    <option value="exited">Vehicle Exited Only</option>
                    <option value="expired">Pass Expired Only</option>
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                    <SortIcon size={16} /> Sort By:
                  </label>
                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    style={{
                      padding: "10px 14px",
                      fontSize: "0.875rem",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      color: "var(--text)",
                      fontWeight: 500,
                      cursor: "pointer"
                    }}
                  >
                    <option value="date_desc">Time: Newest First</option>
                    <option value="date_asc">Time: Oldest First</option>
                    <option value="name_asc">Visitor / Vehicle: A to Z</option>
                    <option value="name_desc">Visitor / Vehicle: Z to A</option>
                  </select>
                </div>
              </div>

              {/* Date Presets & Date Range Search Bar */}
              <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <CalendarIcon size={16} style={{ color: "var(--primary)" }} />
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)" }}>Date Presets:</span>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button type="button" className={`btn btn-sm ${datePreset === "all" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("all")}>All Time</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "today" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("today")}>Today</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "yesterday" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("yesterday")}>Yesterday</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "last7" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("last7")}>Last 7 Days</button>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto", flexWrap: "wrap" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                    <ClockIcon size={14} /> From:
                  </label>
                  <input
                    type="datetime-local"
                    value={fromDate}
                    onChange={(e) => { setFromDate(e.target.value); setDatePreset("custom"); }}
                    style={{ padding: "6px 10px", fontSize: "0.8rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text)" }}
                  />

                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                    <ClockIcon size={14} /> To:
                  </label>
                  <input
                    type="datetime-local"
                    value={toDate}
                    onChange={(e) => { setToDate(e.target.value); setDatePreset("custom"); }}
                    style={{ padding: "6px 10px", fontSize: "0.8rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text)" }}
                  />

                  {(fromDate || toDate || searchQuery || statusFilter !== "all" || actionFilter !== "all" || datePreset !== "all") && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={resetAllFilters} style={{ fontSize: "0.8rem" }}>
                      Clear Filters
                    </button>
                  )}
                  
                  <button type="button" className="btn btn-primary btn-sm" onClick={fetchTodayData} style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "6px" }}>
                    <SearchIcon size={14} /> Apply Date Filter
                  </button>
                </div>
              </div>
            </div>

            {filteredPasses.length === 0 ? (
              <p className="empty-state">No matching visitor passes found.</p>
            ) : (
              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Visitor Name</th>
                      <th>Vehicle Number</th>
                      <th>Purpose</th>
                      <th>Host Resident / Flat</th>
                      <th>Pass Status</th>
                      <th>Expires Date & Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedPasses.map((p) => (
                      <tr key={p.id}>
                        <td><strong>{p.visitor_name}</strong></td>
                        <td><code>{p.vehicle_number || "—"}</code></td>
                        <td>{p.purpose || "—"}</td>
                        <td>{p.resident?.full_name || "—"} ({p.resident?.flat_number || "Gate"})</td>
                        <td>{renderStatusBadge(p.status)}</td>
                        <td>{formatDateTime(p.expires_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                
                {filteredPasses.length > visiblePassesCount && (
                  <div style={{ display: "flex", justifyContent: "center", gap: "12px", marginTop: "20px" }}>
                    <button className="btn btn-outline" onClick={() => setVisiblePassesCount(v => v + 10)}>
                      Show 10 More
                    </button>
                    <button className="btn btn-outline" onClick={() => setVisiblePassesCount(filteredPasses.length)}>
                      Show All {filteredPasses.length}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Today's Entry / Exit Activity Logs */}
        {activeTab === "logs" && (
          <div className="panel">
            <div className="panel-header">
              <h3 style={{ display: "flex", alignItems: "center", gap: "8px" }}><LogsIcon size={20} /> Today's Vehicle Entry & Exit Activity Logs</h3>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn btn-outline btn-sm" onClick={handleExportLogs} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><ExportIcon size={14} /> Export CSV</button>
                <button className="btn btn-outline btn-sm" onClick={fetchTodayData} style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}><RefreshIcon size={14} /> Refresh</button>
              </div>
            </div>

            <div style={{ background: "var(--bg-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: "16px", marginBottom: "20px" }}>
              <div style={{ display: "flex", gap: "12px", alignItems: "center", marginBottom: "12px", flexWrap: "wrap" }}>
                <div className="search-filter-box" style={{ flex: 1, minWidth: "240px", marginBottom: 0 }}>
                  <SearchIcon className="search-icon" size={16} />
                  <input
                    type="text"
                    className="search-input"
                    placeholder="Search logs by vehicle number, visitor name, gate action, guard..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                  />
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                    <FilterIcon size={16} /> Filter Action:
                  </label>
                  <select
                    value={actionFilter}
                    onChange={(e) => setActionFilter(e.target.value)}
                    style={{
                      padding: "10px 14px",
                      fontSize: "0.875rem",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      color: "var(--text)",
                      fontWeight: 500,
                      cursor: "pointer"
                    }}
                  >
                    <option value="all">All Gate Actions</option>
                    <option value="entry">Vehicle Entry Only</option>
                    <option value="exit">Vehicle Exit Only</option>
                  </select>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: "4px" }}>
                    <SortIcon size={16} /> Sort By:
                  </label>
                  <select
                    value={sortOrder}
                    onChange={(e) => setSortOrder(e.target.value)}
                    style={{
                      padding: "10px 14px",
                      fontSize: "0.875rem",
                      borderRadius: "var(--radius)",
                      border: "1px solid var(--border)",
                      background: "var(--bg-input)",
                      color: "var(--text)",
                      fontWeight: 500,
                      cursor: "pointer"
                    }}
                  >
                    <option value="date_desc">Logged: Newest First</option>
                    <option value="date_asc">Logged: Oldest First</option>
                    <option value="name_asc">Vehicle / Visitor: A to Z</option>
                    <option value="name_desc">Vehicle / Visitor: Z to A</option>
                  </select>
                </div>
              </div>

              {/* Date Presets & Date Range Search Bar */}
              <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", borderTop: "1px solid var(--border)", paddingTop: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                  <CalendarIcon size={16} style={{ color: "var(--primary)" }} />
                  <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "var(--text-muted)" }}>Date Presets:</span>
                  <div style={{ display: "flex", gap: "4px" }}>
                    <button type="button" className={`btn btn-sm ${datePreset === "all" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("all")}>All Time</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "today" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("today")}>Today</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "yesterday" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("yesterday")}>Yesterday</button>
                    <button type="button" className={`btn btn-sm ${datePreset === "last7" ? "btn-primary" : "btn-outline"}`} onClick={() => applyDatePreset("last7")}>Last 7 Days</button>
                  </div>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "8px", marginLeft: "auto", flexWrap: "wrap" }}>
                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                    <ClockIcon size={14} /> From:
                  </label>
                  <input
                    type="datetime-local"
                    value={fromDate}
                    onChange={(e) => { setFromDate(e.target.value); setDatePreset("custom"); }}
                    style={{ padding: "6px 10px", fontSize: "0.8rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text)" }}
                  />

                  <label style={{ fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 600, display: "flex", alignItems: "center", gap: "4px" }}>
                    <ClockIcon size={14} /> To:
                  </label>
                  <input
                    type="datetime-local"
                    value={toDate}
                    onChange={(e) => { setToDate(e.target.value); setDatePreset("custom"); }}
                    style={{ padding: "6px 10px", fontSize: "0.8rem", borderRadius: "var(--radius)", border: "1px solid var(--border)", background: "var(--bg-input)", color: "var(--text)" }}
                  />

                  {(fromDate || toDate || searchQuery || statusFilter !== "all" || actionFilter !== "all" || datePreset !== "all") && (
                    <button type="button" className="btn btn-outline btn-sm" onClick={resetAllFilters} style={{ fontSize: "0.8rem" }}>
                      Clear Filters
                    </button>
                  )}
                  
                  <button type="button" className="btn btn-primary btn-sm" onClick={fetchTodayData} style={{ fontSize: "0.8rem", display: "flex", alignItems: "center", gap: "6px" }}>
                    <SearchIcon size={14} /> Apply Date Filter
                  </button>
                </div>
              </div>
            </div>

            {filteredLogs.length === 0 ? (
              <p className="empty-state">No matching vehicle activity logs found.</p>
            ) : (
              <div className="data-table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Gate Action</th>
                      <th>Vehicle Number</th>
                      <th>Visitor Name</th>
                      <th>Host Resident / Flat</th>
                      <th>Logged By Guard</th>
                      <th>Logged Date & Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayedLogs.map((log) => (
                      <tr key={log.id}>
                        <td><span className={`badge badge-${log.action}`}>{log.action.toUpperCase()}</span></td>
                        <td><code>{log.visitor_pass?.vehicle_number || "—"}</code></td>
                        <td>{log.visitor_pass?.visitor_name || "—"}</td>
                        <td>{log.visitor_pass?.resident?.full_name || "—"} ({log.visitor_pass?.resident?.flat_number || "Gate"})</td>
                        <td>{log.guard?.full_name || "—"}</td>
                        <td>{formatDateTime(log.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                
                {filteredLogs.length > visibleLogsCount && (
                  <div style={{ display: "flex", justifyContent: "center", gap: "12px", marginTop: "20px" }}>
                    <button className="btn btn-outline" onClick={() => setVisibleLogsCount(v => v + 10)}>
                      Show 10 More
                    </button>
                    <button className="btn btn-outline" onClick={() => setVisibleLogsCount(filteredLogs.length)}>
                      Show All {filteredLogs.length}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
