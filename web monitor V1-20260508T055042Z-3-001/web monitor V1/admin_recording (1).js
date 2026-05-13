const RECORDING_STORAGE_KEY = "camera-recording-admin-config-v1";
const DEFAULT_BACKEND_URL = "http://10.10.218.105:8000";
const SOCKET_IO_CDN = "https://cdn.socket.io/4.7.5/socket.io.min.js";

const recordingState = {
  devices: [],
  selectedSocketId: "",
  socket: null,
  connected: false,
  uploads: [],
};

let recordingEls = null;

function getBackendBaseUrl() {
  const direct = document.getElementById("backendBase");
  const value = direct && typeof direct.value === "string" ? direct.value.trim() : "";
  if (value) return value.replace(/\/$/, "");

  try {
    const stored = localStorage.getItem(RECORDING_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed && typeof parsed.backendBase === "string" && parsed.backendBase.trim()) {
        return parsed.backendBase.trim().replace(/\/$/, "");
      }
    }
  } catch {
    // ignore
  }

  return DEFAULT_BACKEND_URL;
}

function getAdminToken() {
  const normalize = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    return trimmed.replace(/^Bearer\s+/i, "").trim();
  };

  const direct = document.getElementById("adminToken");
  if (direct && typeof direct.value === "string") {
    return normalize(direct.value);
  }
  const recordingDirect = document.getElementById("recordingAdminToken");
  if (recordingDirect && typeof recordingDirect.value === "string") {
    return normalize(recordingDirect.value);
  }
  return "";
}

function normalizeTokenValue(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return "";
  return trimmed.replace(/^Bearer\s+/i, "").trim();
}

function saveLocalConfig(partial) {
  try {
    const current = JSON.parse(localStorage.getItem(RECORDING_STORAGE_KEY) || "{}");
    localStorage.setItem(RECORDING_STORAGE_KEY, JSON.stringify({ ...current, ...partial }));
  } catch {
    // ignore
  }
}

function ensureRecordingUi() {
  if (recordingEls) return recordingEls;

  let section = document.querySelector("#recording-admin-panel");
  if (!section) {
    const main = document.querySelector("main.container") || document.body;
    section = document.createElement("section");
    section.className = "card";
    section.id = "recording-admin-panel";
    section.innerHTML = `
      <h2>Remote Camera Recording</h2>
      <p class="subtitle">Live device list from <code>/api/devices</code>, record command controls, and upload links streamed from Socket.IO.</p>
      <div class="status-grid">
        <div>
          <strong>Socket State</strong>
          <p id="recordingSocketState" class="status unknown">Disconnected</p>
        </div>
        <div>
          <strong>Connected Devices</strong>
          <p id="recordingDeviceCount" class="status unknown">0</p>
        </div>
        <div>
          <strong>Latest Uploads</strong>
          <p id="recordingUploadCount" class="status unknown">0</p>
        </div>
      </div>

      <div class="camera-layout">
        <section class="card">
          <h3>Connected Devices</h3>
          <div id="recordingDeviceList" class="device-list"></div>
        </section>

        <div class="panel-stack">
          <section class="card">
            <h3>Recording Controls</h3>
            <div class="grid">
              <label>
                Camera Side
                <div class="row">
                  <label class="check-pill"><input type="radio" name="recording-camera" value="front" checked /> Front</label>
                  <label class="check-pill"><input type="radio" name="recording-camera" value="back" /> Back</label>
                </div>
              </label>
              <label>
                Duration (seconds)
                <input id="recordingDurationSeconds" type="number" min="1" max="600" step="1" value="15" />
              </label>
              <label>
                Backend URL
                <input id="recordingBackendBase" type="text" placeholder="http://127.0.0.1:8000" />
              </label>
              <label>
                Admin Token
                <input id="recordingAdminToken" type="password" placeholder="Optional bearer token" />
              </label>
            </div>
            <div class="row">
              <button id="recordingRefreshBtn">Refresh Devices</button>
              <button id="recordingSendBtn">Send Record Command</button>
            </div>
            <p id="recordingSelectionSummary" class="summary-text">Select a connected device to queue a recording.</p>
          </section>

          <section class="card">
            <h3>Upload Feed</h3>
            <div id="recordingUploadFeed" class="activity-list"></div>
          </section>

          <section class="card">
            <h3>Storage Browser</h3>
            <div class="grid">
              <label>
                Folder
                <select id="recordingStorageFolder">
                  <option value="captured_video">Captured Video</option>
                  <option value="captured_img">Captured Images</option>
                  <option value="captured_location">Captured Location</option>
                </select>
              </label>
              <label>
                Backend URL
                <input id="recordingStorageBackendBase" type="text" placeholder="http://127.0.0.1:8000" />
              </label>
                <label>
                  Storage Token
                  <input id="recordingStorageAdminToken" type="password" placeholder="Required for /api/admin/files" />
                </label>
            </div>
            <div class="row">
              <button id="recordingStorageRefreshBtn">Refresh Storage</button>
            </div>
            <div id="recordingStorageList" class="activity-list"></div>
          </section>
        </div>
      </div>
    `;

    main.appendChild(section);
  }

  recordingEls = {
    socketState: section.querySelector("#recordingSocketState"),
    deviceCount: section.querySelector("#recordingDeviceCount"),
    uploadCount: section.querySelector("#recordingUploadCount"),
    deviceList: section.querySelector("#recordingDeviceList"),
    durationSeconds: section.querySelector("#recordingDurationSeconds"),
    backendBase: section.querySelector("#recordingBackendBase"),
    adminToken: section.querySelector("#recordingAdminToken"),
    refreshBtn: section.querySelector("#recordingRefreshBtn"),
    sendBtn: section.querySelector("#recordingSendBtn"),
    selectionSummary: section.querySelector("#recordingSelectionSummary"),
    uploadFeed: section.querySelector("#recordingUploadFeed"),
    storageFolder: section.querySelector("#recordingStorageFolder"),
    storageBackendBase: section.querySelector("#recordingStorageBackendBase"),
    storageAdminToken: section.querySelector("#recordingStorageAdminToken"),
    storageRefreshBtn: section.querySelector("#recordingStorageRefreshBtn"),
    storageList: section.querySelector("#recordingStorageList"),
  };

  const saved = safeLoadConfig();
  recordingEls.backendBase.value = saved.backendBase || getBackendBaseUrl();
  recordingEls.adminToken.value = saved.adminToken || getAdminToken();
  recordingEls.durationSeconds.value = String(saved.durationSeconds || 15);

  recordingEls.storageBackendBase.value = recordingEls.backendBase.value;
  recordingEls.storageAdminToken.value = normalizeTokenValue(saved.storageAdminToken || saved.adminToken || getAdminToken());
  const recordingTokenField = section.querySelector("#recordingAdminToken");
  if (recordingTokenField instanceof HTMLInputElement) {
    recordingTokenField.value = saved.adminToken || getAdminToken();
  }

  recordingEls.backendBase.addEventListener("change", () => {
    saveLocalConfig({ backendBase: recordingEls.backendBase.value.trim() });
    connectRecordingSocket();
  });

  recordingEls.adminToken.addEventListener("change", () => {
    saveLocalConfig({ adminToken: recordingEls.adminToken.value.trim() });
    connectRecordingSocket();
  });

  if (recordingTokenField instanceof HTMLInputElement) {
    recordingTokenField.addEventListener("change", () => {
      saveLocalConfig({ adminToken: recordingTokenField.value.trim() });
      connectRecordingSocket();
    });
  }

  recordingEls.refreshBtn.addEventListener("click", () => {
    void refreshDevices();
  });

  recordingEls.sendBtn.addEventListener("click", () => {
    void submitRecordCommand();
  });

  recordingEls.storageRefreshBtn.addEventListener("click", () => {
    void fetchStorageFiles();
  });

  recordingEls.storageBackendBase.addEventListener("change", () => {
    saveLocalConfig({ backendBase: recordingEls.storageBackendBase.value.trim() });
  });

  recordingEls.storageAdminToken.addEventListener("change", () => {
    saveLocalConfig({ storageAdminToken: normalizeTokenValue(recordingEls.storageAdminToken.value) });
  });

  return recordingEls;
}

function safeLoadConfig() {
  try {
    const raw = localStorage.getItem(RECORDING_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

async function fetchStorageFiles() {
  const els = ensureRecordingUi();
  const backendBase = els.storageBackendBase.value || getBackendBaseUrl();
  const token = normalizeTokenValue(els.storageAdminToken.value);
  const folder = els.storageFolder.value || "captured_video";
  if (!token) {
    els.storageList.innerHTML = '<div class="activity-item">Storage Token is required.</div>';
    return;
  }
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const res = await fetchJson(`${backendBase}/api/admin/files?folder=${encodeURIComponent(folder)}`, { headers });
    if (!res.ok) {
      els.storageList.innerHTML = `<div class="activity-item">Failed to load files (${res.status})</div>`;
      return;
    }

    const files = Array.isArray(res.data?.files) ? res.data.files : [];
    if (!files.length) {
      els.storageList.innerHTML = '<div class="activity-item">No files found.</div>';
      return;
    }

    els.storageList.innerHTML = files
      .map((f) => `
        <div class="activity-item">
          <div><strong>${escapeHtml(f.name)}</strong> · ${escapeHtml(String(Math.round((f.size||0)/1024))) } KB</div>
          <div class="muted">${escapeHtml(formatDate(f.modified_at))}</div>
          <div><a href="${escapeAttr(f.url)}" target="_blank" rel="noreferrer">Open</a></div>
        </div>
      `)
      .join("");
  } catch (err) {
    els.storageList.innerHTML = `<div class="activity-item">Error: ${escapeHtml(err.message || String(err))}</div>`;
  }
}

function setSocketStatus(text, ok = null) {
  const els = ensureRecordingUi();
  if (!els.socketState) return;
  els.socketState.className = `status ${ok === null ? "unknown" : ok ? "ok" : "fail"}`;
  els.socketState.textContent = text;
}

function getSelectedCamera() {
  const checked = document.querySelector('input[name="recording-camera"]:checked');
  return checked && checked instanceof HTMLInputElement ? checked.value : "front";
}

function getSelectedDevice() {
  return recordingState.devices.find((device) => device.socket_id === recordingState.selectedSocketId) || null;
}

function renderDevices() {
  const els = ensureRecordingUi();
  if (!els.deviceList) return;

  if (!recordingState.devices.length) {
    els.deviceList.innerHTML = '<div class="activity-item">No connected devices yet.</div>';
    els.deviceCount.textContent = "0";
    els.selectionSummary.textContent = "Waiting for devices to connect.";
    return;
  }

  if (!recordingState.selectedSocketId || !recordingState.devices.some((device) => device.socket_id === recordingState.selectedSocketId)) {
    recordingState.selectedSocketId = recordingState.devices[0].socket_id;
  }

  els.deviceList.innerHTML = recordingState.devices
    .map((device) => {
      const selected = device.socket_id === recordingState.selectedSocketId;
      const metaBits = [device.device_name || "Unnamed device", device.device_id || "n/a", device.user_id || "n/a"];
      return `
        <label class="device-card ${selected ? "selected" : ""}">
          <div class="device-topline">
            <strong class="device-title">${escapeHtml(device.device_name || device.device_id || device.socket_id)}</strong>
            <input type="radio" name="recording-device" value="${escapeAttr(device.socket_id)}" ${selected ? "checked" : ""} />
          </div>
          <div class="device-meta">
            <span class="pill badge-online">${escapeHtml(device.socket_id)}</span>
            <span class="pill">${escapeHtml(metaBits[1])}</span>
            <span class="pill">${escapeHtml(metaBits[2])}</span>
          </div>
          <p class="device-subtitle">Connected: ${formatDate(device.connected_at)} · Updated: ${formatAge(device.last_seen_at)}</p>
        </label>
      `;
    })
    .join("");

  els.deviceCount.textContent = String(recordingState.devices.length);
  els.deviceCount.className = "status ok";

  els.deviceList.querySelectorAll('input[name="recording-device"]').forEach((input) => {
    input.addEventListener("change", () => {
      if (input instanceof HTMLInputElement && input.checked) {
        recordingState.selectedSocketId = input.value;
        renderDevices();
      }
    });
  });

  const selected = getSelectedDevice();
  els.selectionSummary.textContent = selected
    ? `Selected ${selected.device_name || selected.device_id || selected.socket_id}. Queue a recording command to start upload.`
    : "Select a device to continue.";
}

function renderUploads() {
  const els = ensureRecordingUi();
  if (!els.uploadFeed) return;

  if (!recordingState.uploads.length) {
    els.uploadFeed.innerHTML = '<div class="activity-item">No uploads received yet.</div>';
    els.uploadCount.textContent = "0";
    els.uploadCount.className = "status unknown";
    return;
  }

  els.uploadCount.textContent = String(recordingState.uploads.length);
  els.uploadCount.className = "status ok";
  els.uploadFeed.innerHTML = recordingState.uploads
    .map((item) => `
      <div class="activity-item">
        <div><strong>${escapeHtml(item.device_name || item.device_id || item.socket_id)}</strong> · ${escapeHtml(item.camera || "camera")}</div>
        <div class="muted">Duration: ${escapeHtml(String(item.duration || "n/a"))}s · ${escapeHtml(formatDate(item.uploaded_at))}</div>
        <div><a href="${escapeAttr(item.file_url)}" target="_blank" rel="noreferrer">Download / view file</a></div>
      </div>
    `)
    .join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function formatDate(value) {
  if (!value) return "n/a";
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "n/a";
}

function formatAge(value) {
  const ms = typeof value === "number" ? value : Date.parse(String(value));
  if (!Number.isFinite(ms)) return "--";
  const ageMs = Math.max(0, Date.now() - ms);
  if (ageMs < 1000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: response.ok, status: response.status, data };
}

async function refreshDevices() {
  const els = ensureRecordingUi();
  const backendBase = getBackendBaseUrl();
  const token = getAdminToken();
  saveLocalConfig({ backendBase, adminToken: token });

  try {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const result = await fetchJson(`${backendBase}/api/devices`, { headers });
    const devices = Array.isArray(result.data)
      ? result.data
      : Array.isArray(result.data?.devices)
        ? result.data.devices
        : [];

    recordingState.devices = devices;
    if (!recordingState.selectedSocketId && devices.length > 0) {
      recordingState.selectedSocketId = devices[0].socket_id;
    }
    renderDevices();
    setSocketStatus(result.ok ? `Devices loaded (${devices.length})` : `Device fetch failed (${result.status})`, result.ok);
  } catch (error) {
    setSocketStatus(`Device fetch failed: ${error.message || error}`, false);
  }
}

async function submitRecordCommand() {
  const selected = getSelectedDevice();
  const els = ensureRecordingUi();
  if (!selected) {
    els.selectionSummary.textContent = "Pick a connected device first.";
    return;
  }

  const backendBase = getBackendBaseUrl();
  const token = getAdminToken();
  const duration = Math.max(1, Math.min(600, Number(els.durationSeconds.value) || 15));
  const camera = getSelectedCamera();
  saveLocalConfig({ backendBase, adminToken: token, durationSeconds: duration });

  try {
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    const result = await fetchJson(`${backendBase}/api/record`, {
      method: "POST",
      headers,
      body: JSON.stringify({ socket_id: selected.socket_id, camera, duration }),
    });

    if (!result.ok) {
      els.selectionSummary.textContent = `Command failed (${result.status})`;
      return;
    }

    els.selectionSummary.textContent = `Recording request queued for ${selected.device_name || selected.device_id || selected.socket_id}.`;
  } catch (error) {
    els.selectionSummary.textContent = `Command error: ${error.message || error}`;
  }
}

async function ensureSocketIoClient() {
  if (window.io) return window.io;

  await new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SOCKET_IO_CDN;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Unable to load the Socket.IO CDN client."));
    document.head.appendChild(script);
  });

  if (!window.io) {
    throw new Error("Socket.IO client did not load correctly.");
  }

  return window.io;
}

function closeSocket() {
  if (recordingState.socket) {
    try {
      recordingState.socket.disconnect();
    } catch {
      // ignore
    }
  }
  recordingState.socket = null;
  recordingState.connected = false;
}

async function connectRecordingSocket() {
  ensureRecordingUi();
  const backendBase = getBackendBaseUrl();
  const token = getAdminToken();
  saveLocalConfig({ backendBase, adminToken: token });

  try {
    await ensureSocketIoClient();
    closeSocket();
    const socket = window.io(backendBase, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 10,
      auth: token ? { token } : undefined,
    });

    recordingState.socket = socket;
    setSocketStatus("Connecting...", null);

    socket.on("connect", () => {
      recordingState.connected = true;
      setSocketStatus(`Connected (${socket.id || "socket"})`, true);
    });

    socket.on("disconnect", () => {
      recordingState.connected = false;
      setSocketStatus("Disconnected", false);
    });

    socket.on("devices:updated", (payload) => {
      const devices = Array.isArray(payload)
        ? payload
        : Array.isArray(payload?.devices)
          ? payload.devices
          : [];
      recordingState.devices = devices;
      renderDevices();
    });

    socket.on("admin:upload_ready", (payload) => {
      const record = {
        socket_id: payload?.socket_id || payload?.socketId || "",
        device_id: payload?.device_id || payload?.deviceId || "",
        device_name: payload?.device_name || payload?.deviceName || "",
        file_url: payload?.file_url || payload?.fileUrl || "",
        camera: payload?.camera || "",
        duration: payload?.duration || "",
        path: payload?.path || "",
        bucket: payload?.bucket || "recordings",
        uploaded_at: payload?.uploaded_at || Date.now(),
      };
      if (record.file_url) {
        recordingState.uploads.unshift(record);
        recordingState.uploads = recordingState.uploads.slice(0, 20);
        renderUploads();
      }
    });
  } catch (error) {
    setSocketStatus(`Socket setup failed: ${error.message || error}`, false);
  }
}

async function initRecordingAdmin() {
  ensureRecordingUi();
  await refreshDevices();
  await connectRecordingSocket();
  renderUploads();
  void fetchStorageFiles();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    void initRecordingAdmin();
  });
} else {
  void initRecordingAdmin();
}
