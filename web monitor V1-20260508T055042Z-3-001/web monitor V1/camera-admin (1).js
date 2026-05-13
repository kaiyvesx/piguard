const els = {
  backendBase: document.getElementById("backendBase"),
  adminToken: document.getElementById("adminToken"),
  cameraFacing: document.getElementById("cameraFacing"),
  durationSeconds: document.getElementById("durationSeconds"),
  refreshMs: document.getElementById("refreshMs"),
  autoStream: document.getElementById("autoStream"),
  showOffline: document.getElementById("showOffline"),
  saveBtn: document.getElementById("saveBtn"),
  runBtn: document.getElementById("runBtn"),
  autoBtn: document.getElementById("autoBtn"),
  cameraStartBtn: document.getElementById("cameraStartBtn"),
  cameraStopBtn: document.getElementById("cameraStopBtn"),
  refreshFrameBtn: document.getElementById("refreshFrameBtn"),
  backendHealth: document.getElementById("backendHealth"),
  usersStatus: document.getElementById("usersStatus"),
  locationsStatus: document.getElementById("locationsStatus"),
  deviceCount: document.getElementById("deviceCount"),
  deviceList: document.getElementById("deviceList"),
  selectedSummary: document.getElementById("selectedSummary"),
  selectedUsername: document.getElementById("selectedUsername"),
  selectedUserId: document.getElementById("selectedUserId"),
  selectedDeviceId: document.getElementById("selectedDeviceId"),
  selectedDeviceName: document.getElementById("selectedDeviceName"),
  selectedLastSeen: document.getElementById("selectedLastSeen"),
  selectedLocation: document.getElementById("selectedLocation"),
  selectedStatus: document.getElementById("selectedStatus"),
  cameraTitle: document.getElementById("cameraTitle"),
  cameraOverlayText: document.getElementById("cameraOverlayText"),
  streamState: document.getElementById("streamState"),
  frameCounter: document.getElementById("frameCounter"),
  frameAge: document.getElementById("frameAge"),
  frameClock: document.getElementById("frameClock"),
  activityList: document.getElementById("activityList"),
  liveFrame: document.getElementById("liveFrame"),
  output: document.getElementById("output"),
};

const STORAGE_KEY = "camera-admin-monitor-config-v3";
const activeThresholdMs = 5 * 60 * 1000;
const pendingTimeoutBaseMs = 15_000;
const websocketPingMs = 25_000;

let refreshTimer = null;
let watchdogTimer = null;
let pingTimer = null;
let reconnectTimer = null;
let ws = null;
let wsState = "disconnected";
let selectedUserId = null;
let deviceSnapshot = [];
let latestLocationsSnapshot = [];
let commandSnapshot = [];
let responseSnapshot = [];
let eventSnapshot = [];
let lastVideosByUser = new Map();
let pendingByUser = new Map();
let pendingCommand = null;
let frameCounter = 0;
let latestVideoTouchedAt = 0;
let lastRequestedUserId = null;
let lastRequestedAt = 0;

function normalizeBase(url) {
  return (url || "").trim().replace(/\/$/, "");
}

function buildWsUrl(baseUrl) {
  if (!baseUrl) return "";
  const cleaned = normalizeBase(baseUrl);
  if (cleaned.startsWith("https://")) return `${cleaned.replace(/^https:/, "wss:")}/ws/admin`;
  if (cleaned.startsWith("http://")) return `${cleaned.replace(/^http:/, "ws:")}/ws/admin`;
  return `${cleaned.replace(/\/$/, "")}/ws/admin`;
}

function makeRequestId() {
  return `camera-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function setStatus(el, ok, text) {
  if (!el) return;
  el.className = `status ${ok === null ? "unknown" : ok ? "ok" : "fail"}`;
  el.textContent = text;
}

function toMillis(value) {
  if (typeof value === "number") {
    return value > 2_000_000_000 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatDate(value) {
  const ms = toMillis(value);
  return ms ? new Date(ms).toLocaleString() : "n/a";
}

function formatAge(value) {
  const ms = toMillis(value);
  if (!ms) return "--";
  const ageMs = Math.max(0, Date.now() - ms);
  if (ageMs < 1000) return "just now";
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1000)}s ago`;
  return `${Math.floor(ageMs / 60_000)}m ago`;
}

function formatLocation(location) {
  if (!location) return "n/a";
  const lat = location.latitude ?? location.lat;
  const lon = location.longitude ?? location.lng ?? location.lon;
  if (lat === undefined || lon === undefined) return "n/a";
  return `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`;
}

function getConfig() {
  return {
    backendBase: normalizeBase(els.backendBase.value),
    adminToken: els.adminToken.value.trim(),
    cameraFacing: els.cameraFacing.value === "back" ? "back" : "front",
    durationSeconds: Math.max(1, Math.min(60, Number(els.durationSeconds.value) || 15)),
    refreshMs: Math.max(1000, Number(els.refreshMs.value) || 5000),
    autoStream: Boolean(els.autoStream.checked),
    showOffline: Boolean(els.showOffline.checked),
  };
}

function saveConfig() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(getConfig()));
}

function loadConfig() {
  const defaults = {
    backendBase: "http://10.10.218.105:8000",
    adminToken: "",
    cameraFacing: "front",
    durationSeconds: 15,
    refreshMs: 5000,
    autoStream: true,
    showOffline: false,
  };
  const raw = localStorage.getItem(STORAGE_KEY);
  const cfg = raw ? { ...defaults, ...JSON.parse(raw) } : defaults;
  els.backendBase.value = cfg.backendBase;
  els.adminToken.value = cfg.adminToken;
  els.cameraFacing.value = cfg.cameraFacing;
  els.durationSeconds.value = String(cfg.durationSeconds);
  els.refreshMs.value = String(cfg.refreshMs);
  els.autoStream.checked = Boolean(cfg.autoStream);
  els.showOffline.checked = Boolean(cfg.showOffline);
}

async function fetchJson(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      data: { error: String(error && error.message ? error.message : error) },
    };
  } finally {
    clearTimeout(timeout);
  }
}

function getAuthHeaders(token) {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function userLabel(user) {
  return user.username || user.device_name || user.user_id || "Unknown user";
}

function mergeDeviceRecords(users, locations) {
  const map = new Map();
  const locationList = Array.isArray(locations) ? locations : [];
  const userList = Array.isArray(users) ? users : [];

  for (const location of locationList) {
    const userId = location.user_id;
    if (!userId) continue;
    map.set(userId, {
      user_id: userId,
      username: location.username || null,
      device_id: location.device_id || null,
      device_name: location.device_name || null,
      last_seen_at: location.timestamp || location.created_at || null,
      latitude: location.latitude,
      longitude: location.longitude,
      source: "location",
    });
  }

  for (const user of userList) {
    const userId = user.user_id;
    if (!userId) continue;
    const existing = map.get(userId) || {};
    map.set(userId, {
      ...existing,
      ...user,
      user_id: userId,
      username: user.username || existing.username || null,
      device_id: user.device_id || existing.device_id || null,
      device_name: user.device_name || existing.device_name || null,
      last_seen_at: user.last_seen_at || existing.last_seen_at || null,
      source: existing.source || "user",
    });
  }

  return Array.from(map.values()).sort((a, b) => {
    const aMs = toMillis(a.last_seen_at) || 0;
    const bMs = toMillis(b.last_seen_at) || 0;
    return bMs - aMs;
  });
}

function enrichDevice(device) {
  const latestLocation = latestLocationsSnapshot.find((item) => item.user_id === device.user_id);
  const lastSeenMs =
    toMillis(device.last_seen_at) ||
    toMillis(latestLocation && (latestLocation.timestamp || latestLocation.created_at)) ||
    0;
  const active = lastSeenMs ? Date.now() - lastSeenMs < activeThresholdMs : Boolean(device.device_id);
  return {
    ...device,
    latestLocation,
    lastSeenMs,
    active,
  };
}

function currentDevices() {
  const devices = mergeDeviceRecords(deviceSnapshot, latestLocationsSnapshot).map(enrichDevice);
  return getConfig().showOffline ? devices : devices.filter((device) => device.active);
}

function selectedDevice() {
  return currentDevices().find((device) => device.user_id === selectedUserId) || null;
}

function latestVideoForUser(userId) {
  return userId ? lastVideosByUser.get(userId) || null : null;
}

function latestActivityForUser(userId) {
  if (!userId) return null;
  const combined = [...commandSnapshot, ...responseSnapshot, ...eventSnapshot].filter((item) => item.user_id === userId);
  if (!combined.length) return null;
  return combined.sort((a, b) => (toMillis(b.ts) || 0) - (toMillis(a.ts) || 0))[0];
}

function setPending(userId, pending) {
  if (!userId) return;
  if (pending) {
    pendingByUser.set(userId, pending);
  } else {
    pendingByUser.delete(userId);
  }
  pendingCommand = userId === selectedUserId ? pendingByUser.get(userId) || null : pendingCommand;
}

function selectedPending() {
  return selectedUserId ? pendingByUser.get(selectedUserId) || null : null;
}

function renderDevices() {
  const devices = currentDevices();
  if (!devices.length) {
    els.deviceList.innerHTML = "<div class='muted'>No active devices detected yet.</div>";
    setStatus(els.deviceCount, null, "0 DETECTED");
    return;
  }

  if (!selectedUserId || !devices.some((device) => device.user_id === selectedUserId)) {
    selectedUserId = devices[0].user_id;
  }

  els.deviceList.innerHTML = devices
    .map((device) => {
      const isSelected = device.user_id === selectedUserId;
      const statusClass = device.active ? "badge-online" : "badge-offline";
      const statusText = device.active ? "ONLINE" : "OFFLINE";
      const latestVideo = latestVideoForUser(device.user_id);
      return `<article class="device-card ${device.active ? "active" : ""} ${isSelected ? "selected" : ""}" data-user-id="${device.user_id}">
        <div class="device-topline">
          <h3 class="device-title">${userLabel(device)}</h3>
          <span class="badge ${statusClass}">${statusText}</span>
        </div>
        <div class="device-meta">
          <span class="pill">user: ${device.user_id || "n/a"}</span>
          <span class="pill">device: ${device.device_id || "n/a"}</span>
        </div>
        <p class="device-subtitle">${device.device_name || "Device name unavailable"}</p>
        <div class="device-meta">
          <span class="muted">Last seen: ${formatDate(device.last_seen_at)}</span>
          <span class="muted">Location: ${formatLocation(device.latestLocation)}</span>
        </div>
        <div class="device-meta">
          <span class="pill">Latest video: ${latestVideo ? formatAge(latestVideo.created_at || latestVideo.received_at) : "none"}</span>
        </div>
      </article>`;
    })
    .join("");

  document.querySelectorAll(".device-card").forEach((card) => {
    card.addEventListener("click", () => {
      selectDevice(card.dataset.userId);
    });
  });

  setStatus(els.deviceCount, true, `${devices.length} DETECTED`);
}

function updateVideoPreview() {
  const device = selectedDevice();
  const latestVideo = device ? latestVideoForUser(device.user_id) : null;
  const pending = selectedPending();
  const nowText = new Date().toLocaleTimeString();
  els.frameClock.textContent = nowText;

  if (latestVideo && latestVideo.video_url) {
    if (els.liveFrame.src !== latestVideo.video_url) {
      els.liveFrame.src = latestVideo.video_url;
      els.liveFrame.load();
    }
    els.frameCounter.textContent = `Videos: ${frameCounter}`;
    const videoTs = latestVideo.created_at || latestVideo.received_at;
    els.frameAge.textContent = `Last video: ${formatAge(videoTs)}`;
    els.streamState.textContent = pending ? "RECORDING" : "READY";
    els.streamState.className = pending ? "pill badge-warm" : "pill badge-online";
    return;
  }

  els.frameCounter.textContent = `Videos: ${frameCounter}`;
  els.frameAge.textContent = pending ? "Last video: waiting..." : "Last video: --";
  els.streamState.textContent = pending ? "RECORDING" : device?.active ? "READY" : "OFFLINE";
  els.streamState.className = pending ? "pill badge-warm" : device?.active ? "pill badge-online" : "pill badge-warm";
}

function renderSelection() {
  const device = selectedDevice();
  const latestVideo = device ? latestVideoForUser(device.user_id) : null;
  const pending = selectedPending();

  if (!device) {
    els.selectedSummary.textContent = "Select a device to request a video recording.";
    els.selectedUsername.textContent = "n/a";
    els.selectedUserId.textContent = "n/a";
    els.selectedDeviceId.textContent = "n/a";
    els.selectedDeviceName.textContent = "n/a";
    els.selectedLastSeen.textContent = "n/a";
    els.selectedLocation.textContent = "n/a";
    els.selectedStatus.textContent = "n/a";
    els.cameraTitle.textContent = "Waiting for a device";
    els.cameraOverlayText.textContent = "Select a device to request a recording.";
    els.streamState.textContent = "IDLE";
    els.streamState.className = "pill badge-warm";
    return;
  }

  els.selectedSummary.textContent = pending
    ? `Recording request sent for ${device.user_id}. Waiting for the backend response.`
    : latestVideo
      ? "Latest recording is visible below. Send another request any time."
      : device.active
        ? "Device is online. Send a recording request now."
        : "Device is offline. The command will queue until it reconnects.";
  els.selectedUsername.textContent = device.username || "n/a";
  els.selectedUserId.textContent = device.user_id || "n/a";
  els.selectedDeviceId.textContent = device.device_id || "n/a";
  els.selectedDeviceName.textContent = device.device_name || "n/a";
  els.selectedLastSeen.textContent = formatDate(device.last_seen_at);
  els.selectedLocation.textContent = formatLocation(device.latestLocation);
  els.selectedStatus.textContent = device.active ? "online" : "offline";
  els.cameraTitle.textContent = `${userLabel(device)} recording monitor`;
  els.cameraOverlayText.textContent = pending
    ? `Recording ${getConfig().cameraFacing} camera for ${getConfig().durationSeconds}s...`
    : latestVideo
      ? `Latest recording received at ${formatDate(latestVideo.created_at || latestVideo.received_at)}`
      : `Ready to record the ${getConfig().cameraFacing} camera for ${getConfig().durationSeconds}s.`;
  els.streamState.textContent = pending ? "RECORDING" : latestVideo ? "READY" : device.active ? "READY" : "OFFLINE";
  els.streamState.className = pending ? "pill badge-warm" : latestVideo ? "pill badge-online" : device.active ? "pill badge-online" : "pill badge-warm";
}

function renderActivity() {
  const rows = [...commandSnapshot, ...responseSnapshot, ...eventSnapshot]
    .sort((a, b) => (toMillis(b.ts) || 0) - (toMillis(a.ts) || 0))
    .slice(0, 12);

  if (!rows.length) {
    els.activityList.innerHTML = "<div class='muted'>No camera events yet.</div>";
    return;
  }

  els.activityList.innerHTML = rows
    .map((row) => {
      const tone = row.kind === "error" ? "badge-offline" : row.kind === "event" ? "badge-online" : row.status === "error" ? "badge-offline" : "badge-warm";
      return `<article class="activity-item">
        <div class="device-topline">
          <strong>${row.title}</strong>
          <span class="badge ${tone}">${row.status || row.kind || "ok"}</span>
        </div>
        <div class="device-meta">
          <span class="pill">${formatDate(row.ts)}</span>
          <span class="pill">user: ${row.user_id || "n/a"}</span>
          <span class="pill">device: ${row.device_id || "n/a"}</span>
        </div>
        ${row.video_url ? `<div class="device-subtitle"><a href="${row.video_url}" target="_blank" rel="noreferrer">Open video</a></div>` : row.message ? `<div class="device-subtitle">${row.message}</div>` : ""}
      </article>`;
    })
    .join("");
}

function updateOutput(health, usersRes, locationsRes, commandsRes, responsesRes) {
  const devices = currentDevices();
  const selected = selectedDevice();
  els.output.textContent = JSON.stringify(
    {
      checked_at: new Date().toISOString(),
      config: getConfig(),
      ws_state: wsState,
      backend_health: health,
      admin_users: usersRes.data,
      admin_locations_latest: locationsRes.data,
      admin_commands: commandsRes.data,
      admin_responses: responsesRes.data,
      selected_device: selected,
      visible_devices: devices,
      pending: selectedPending(),
      latest_video: selected ? latestVideoForUser(selected.user_id) : null,
      activity_count: commandSnapshot.length + responseSnapshot.length + eventSnapshot.length,
    },
    null,
    2,
  );
}

function setSelectedDevice(deviceId) {
  if (!deviceId) return;
  selectedUserId = deviceId;
  renderDevices();
  renderSelection();
  updateVideoPreview();
  renderActivity();
  updateOutput(lastHealthResult, lastUsersResult, lastLocationsResult, lastCommandsResult, lastResponsesResult);
}

function selectDevice(deviceId) {
  setSelectedDevice(deviceId);
  const cfg = getConfig();
  if (cfg.autoStream) {
    void requestRecording({ force: true });
  }
}

function rememberActivity(item) {
  const enriched = { ...item, ts: item.ts || Date.now() };
  if (enriched.kind === "event") {
    eventSnapshot = [enriched, ...eventSnapshot].slice(0, 50);
  } else if (enriched.kind === "response") {
    responseSnapshot = [enriched, ...responseSnapshot].slice(0, 50);
  } else {
    commandSnapshot = [enriched, ...commandSnapshot].slice(0, 50);
  }
}

function updateVideoFromPayload(payload, fallbackUserId) {
  const userId = payload?.user_id || fallbackUserId || selectedUserId;
  if (!userId) return;

  const videoUrl = payload?.video_url || payload?.url || payload?.result?.video_url || payload?.result?.url;
  if (!videoUrl) return;

  const record = {
    user_id: userId,
    device_id: payload?.device_id || null,
    video_url: videoUrl,
    duration: payload?.duration_seconds || payload?.duration || payload?.result?.duration_seconds || payload?.result?.duration || null,
    created_at: payload?.created_at || payload?.ts || Date.now(),
    received_at: Date.now(),
  };
  lastVideosByUser.set(userId, record);
  latestVideoTouchedAt = Date.now();
  frameCounter += 1;
}

function handleSocketMessage(message) {
  if (!message || typeof message !== "object") return;
  const type = message.type;

  if (type === "ready") {
    wsState = "connected";
    setStatus(els.backendHealth, true, "WS READY");
    return;
  }

  if (type === "accepted") {
    rememberActivity({
      kind: "command",
      title: "COMMAND ACCEPTED",
      ts: Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: "accepted",
    });
    renderActivity();
    return;
  }

  if (type === "command_queued") {
    rememberActivity({
      kind: "command",
      title: "COMMAND QUEUED",
      ts: Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: "queued",
      message: message.message,
    });
    renderActivity();
    return;
  }

  if (type === "command_response") {
    const title = `COMMAND ${String(message.status || "success").toUpperCase()}`;
    const responseRow = {
      kind: "response",
      title,
      ts: message.executed_at || Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: message.status || "success",
      message: message.error?.message || null,
      video_url: message.data?.video_url || message.result?.video_url || null,
    };
    rememberActivity(responseRow);
    if (responseRow.video_url) {
      updateVideoFromPayload(
        {
          user_id: message.user_id,
          device_id: message.device_id,
          video_url: responseRow.video_url,
          duration: message.data?.duration_seconds || message.result?.duration_seconds || message.result?.duration,
          created_at: message.executed_at,
        },
        message.user_id,
      );
    }
    if (pendingCommand && pendingCommand.requestId === message.request_id) {
      setPending(message.user_id, null);
      pendingCommand = null;
    }
    renderActivity();
    renderSelection();
    updateVideoPreview();
    return;
  }

  if (type === "device_event") {
    const action = message.action || message.event || message.type || "device_event";
    const title = String(action).toUpperCase();
    const eventRow = {
      kind: "event",
      title,
      ts: message.received_at || message.ts || Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: message.status || "ok",
      message: message.payload?.message || message.message || null,
      video_url: message.payload?.video_url || message.video_url || null,
    };
    rememberActivity(eventRow);
    if (action === "video_recorded" || eventRow.video_url) {
      updateVideoFromPayload(
        {
          user_id: message.user_id,
          device_id: message.device_id,
          video_url: eventRow.video_url,
          duration: message.payload?.duration_seconds || message.payload?.duration,
          created_at: message.received_at || message.ts,
        },
        message.user_id,
      );
    }
    renderActivity();
    renderSelection();
    updateVideoPreview();
    return;
  }

  if (type === "pong") {
    return;
  }
}

function closeSocket() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  ws = null;
  wsState = "disconnected";
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 3000);
}

function connectSocket() {
  const cfg = getConfig();
  const wsUrl = buildWsUrl(cfg.backendBase);
  if (!wsUrl || !cfg.adminToken) {
    wsState = "disconnected";
    setStatus(els.backendHealth, false, cfg.adminToken ? "WS DISABLED" : "TOKEN REQUIRED");
    return;
  }

  closeSocket();
  try {
    ws = new WebSocket(wsUrl);
    wsState = "connecting";
    setStatus(els.backendHealth, null, "CONNECTING");

    ws.onopen = () => {
      wsState = "connected";
      ws.send(JSON.stringify({ type: "hello", role: "admin", bearer: cfg.adminToken }));
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping" }));
        }
      }, websocketPingMs);
      setStatus(els.backendHealth, true, "WS CONNECTED");
    };

    ws.onmessage = (event) => {
      try {
        handleSocketMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed frames
      }
    };

    ws.onerror = () => {
      wsState = "error";
      setStatus(els.backendHealth, false, "WS ERROR");
    };

    ws.onclose = () => {
      wsState = "disconnected";
      if (pingTimer) {
        clearInterval(pingTimer);
        pingTimer = null;
      }
      setStatus(els.backendHealth, false, "WS DISCONNECTED");
      scheduleReconnect();
    };
  } catch {
    wsState = "error";
    setStatus(els.backendHealth, false, "WS FAILED");
    scheduleReconnect();
  }
}

async function sendAdminCommand(action, payload) {
  const cfg = getConfig();
  const device = selectedDevice();
  if (!device) return null;

  const requestId = makeRequestId();
  const body = {
    user_id: device.user_id,
    action,
    request_id: requestId,
    payload: {
      ...payload,
      device_id: device.device_id,
      device_name: device.device_name,
      source: "web-monitor",
      view: "camera-admin",
    },
  };

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "command_request", ...body }));
    return { requestId, transport: "ws" };
  }

  const headers = {
    "Content-Type": "application/json",
    ...getAuthHeaders(cfg.adminToken),
  };
  const response = await fetchJson(`${cfg.backendBase}/admin/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`Backend rejected command (${response.status})`);
  }

  return { requestId, transport: "http" };
}

async function requestRecording({ force = false } = {}) {
  const device = selectedDevice();
  if (!device) return;

  const cfg = getConfig();
  const now = Date.now();
  const cooldownMs = Math.max(cfg.durationSeconds * 1000 + 10_000, pendingTimeoutBaseMs);
  if (!force) {
    if (selectedPending()) return;
    if (lastRequestedUserId === device.user_id && now - lastRequestedAt < cooldownMs) return;
  }

  try {
    const request = await sendAdminCommand("record_video", {
      camera: cfg.cameraFacing,
      facing: cfg.cameraFacing,
      duration: cfg.durationSeconds,
      duration_seconds: cfg.durationSeconds,
      quality: 0.85,
    });

    pendingCommand = {
      requestId: request.requestId,
      userId: device.user_id,
      action: "record_video",
      sentAt: now,
      attempts: force ? 1 : 0,
    };
    setPending(device.user_id, pendingCommand);
    lastRequestedUserId = device.user_id;
    lastRequestedAt = now;
    rememberActivity({
      kind: "command",
      title: "RECORD VIDEO",
      ts: now,
      user_id: device.user_id,
      device_id: device.device_id || null,
      status: request.transport === "ws" ? "sent-ws" : "sent-http",
      message: `Requested ${cfg.cameraFacing} camera for ${cfg.durationSeconds}s`,
    });
    renderSelection();
    renderActivity();
    updateVideoPreview();
    return request;
  } catch (error) {
    rememberActivity({
      kind: "error",
      title: "RECORD FAILED",
      ts: now,
      user_id: device.user_id,
      device_id: device.device_id || null,
      status: "error",
      message: error instanceof Error ? error.message : String(error),
    });
    renderActivity();
    return null;
  }
}

async function cancelOrStop() {
  if (pendingCommand) {
    setPending(pendingCommand.userId, null);
    pendingCommand = null;
    rememberActivity({
      kind: "command",
      title: "CANCELLED",
      ts: Date.now(),
      user_id: selectedUserId,
      device_id: selectedDevice()?.device_id || null,
      status: "cancelled",
      message: "Pending request cleared locally.",
    });
    renderSelection();
    renderActivity();
    updateVideoPreview();
    return;
  }

  await sendAdminCommand("camera_stream_stop", {
    camera: getConfig().cameraFacing,
    source: "web-monitor",
  });
}

async function refreshBackendState() {
  const cfg = getConfig();
  if (!cfg.backendBase) return;

  const headers = getAuthHeaders(cfg.adminToken);
  const requestHeaders = Object.keys(headers).length ? { headers } : {};

  const healthP = fetchJson(`${cfg.backendBase}/health`);
  const usersP = fetchJson(`${cfg.backendBase}/admin/users`, requestHeaders);
  const locationsP = fetchJson(`${cfg.backendBase}/admin/locations/latest`, requestHeaders);
  const commandsP = fetchJson(`${cfg.backendBase}/admin/commands`, requestHeaders);
  const responsesP = fetchJson(`${cfg.backendBase}/admin/responses`, requestHeaders);

  const [health, usersRes, locationsRes, commandsRes, responsesRes] = await Promise.all([
    healthP,
    usersP,
    locationsP,
    commandsP,
    responsesP,
  ]);

  lastHealthResult = health;
  lastUsersResult = usersRes;
  lastLocationsResult = locationsRes;
  lastCommandsResult = commandsRes;
  lastResponsesResult = responsesRes;

  setStatus(els.backendHealth, health.ok, health.ok ? "ACTIVE" : `OFFLINE (${health.status})`);
  setStatus(els.usersStatus, usersRes.ok, usersRes.ok ? "READABLE" : `FAILED (${usersRes.status})`);
  setStatus(els.locationsStatus, locationsRes.ok, locationsRes.ok ? "READABLE" : `FAILED (${locationsRes.status})`);

  deviceSnapshot = usersRes.data && Array.isArray(usersRes.data.users) ? usersRes.data.users : [];
  latestLocationsSnapshot = locationsRes.data && Array.isArray(locationsRes.data.locations) ? locationsRes.data.locations : [];
  commandSnapshot = commandsRes.data && Array.isArray(commandsRes.data.commands)
    ? commandsRes.data.commands.map((item) => ({
        kind: "command",
        title: String(item.action || "COMMAND").toUpperCase(),
        ts: item.created_at,
        user_id: item.user_id,
        device_id: item.device_id || null,
        status: item.status || "pending",
        message: item.source || null,
      }))
    : [];
  responseSnapshot = responsesRes.data && Array.isArray(responsesRes.data.responses)
    ? responsesRes.data.responses.map((item) => ({
        kind: "response",
        title: String(item.action || "RESPONSE").toUpperCase(),
        ts: item.received_at || item.executed_at,
        user_id: item.user_id,
        device_id: item.device_id || null,
        status: item.status || "success",
        video_url: item.result?.video_url || null,
        message: item.error?.message || null,
      }))
    : [];

  for (const item of responseSnapshot) {
    if (item.video_url && item.user_id && !lastVideosByUser.get(item.user_id)) {
      lastVideosByUser.set(item.user_id, {
        user_id: item.user_id,
        device_id: item.device_id,
        video_url: item.video_url,
        duration: null,
        created_at: item.ts,
        received_at: item.ts,
      });
    }
  }

  renderDevices();
  renderSelection();
  updateVideoPreview();
  renderActivity();
  updateOutput(health, usersRes, locationsRes, commandsRes, responsesRes);
}

function maybeRetryPending() {
  const pending = selectedPending();
  if (!pending) {
    if (getConfig().autoStream && selectedDevice()) {
      void requestRecording();
    }
    return;
  }

  const cfg = getConfig();
  const timeoutMs = Math.max(pendingTimeoutBaseMs, cfg.durationSeconds * 1000 + 12_000);
  if (Date.now() - pending.sentAt < timeoutMs) return;

  if (pending.attempts >= 2) {
    rememberActivity({
      kind: "error",
      title: "RETRY LIMIT REACHED",
      ts: Date.now(),
      user_id: pending.userId,
      device_id: selectedDevice()?.device_id || null,
      status: "failed",
      message: "No response received after retries.",
    });
    setPending(pending.userId, null);
    pendingCommand = null;
    renderSelection();
    renderActivity();
    updateVideoPreview();
    return;
  }

  pending.attempts += 1;
  pending.sentAt = Date.now();
  setPending(pending.userId, pending);
  pendingCommand = pending;
  void sendAdminCommand("record_video", {
    camera: cfg.cameraFacing,
    facing: cfg.cameraFacing,
    duration: cfg.durationSeconds,
    duration_seconds: cfg.durationSeconds,
    quality: 0.85,
    retry: pending.attempts,
  })
    .then(() => {
      rememberActivity({
        kind: "command",
        title: "RETRY RECORD VIDEO",
        ts: Date.now(),
        user_id: pending.userId,
        device_id: selectedDevice()?.device_id || null,
        status: "resent",
        message: `Retry ${pending.attempts} after timeout`,
      });
      renderActivity();
    })
    .catch((error) => {
      rememberActivity({
        kind: "error",
        title: "RETRY FAILED",
        ts: Date.now(),
        user_id: pending.userId,
        device_id: selectedDevice()?.device_id || null,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      renderActivity();
    });
}

function startTimers() {
  stopTimers();
  const cfg = getConfig();
  refreshTimer = setInterval(() => {
    void refreshBackendState();
  }, cfg.refreshMs);
  watchdogTimer = setInterval(() => {
    maybeRetryPending();
    updateVideoPreview();
  }, 3000);
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    }
  }, websocketPingMs);
}

function stopTimers() {
  if (refreshTimer) clearInterval(refreshTimer);
  if (watchdogTimer) clearInterval(watchdogTimer);
  if (pingTimer) clearInterval(pingTimer);
  refreshTimer = null;
  watchdogTimer = null;
  pingTimer = null;
}

function toggleAuto() {
  if (refreshTimer || watchdogTimer) {
    stopTimers();
    els.autoBtn.textContent = "Start Auto Refresh";
    return;
  }
  els.autoBtn.textContent = "Stop Auto Refresh";
  startTimers();
  void refreshBackendState();
}

function handleSocketMessage(message) {
  if (!message || typeof message !== "object") return;

  if (message.type === "ready") {
    wsState = "connected";
    setStatus(els.backendHealth, true, "WS CONNECTED");
    return;
  }

  if (message.type === "accepted" || message.type === "command_queued") {
    rememberActivity({
      kind: "command",
      title: String(message.type || "COMMAND").toUpperCase(),
      ts: Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: message.type,
      message: message.message || null,
    });
    renderActivity();
    return;
  }

  if (message.type === "command_response") {
    const videoUrl = message.data?.video_url || message.result?.video_url || null;
    rememberActivity({
      kind: "response",
      title: `COMMAND ${String(message.status || "success").toUpperCase()}`,
      ts: message.executed_at || Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: message.status || "success",
      video_url: videoUrl,
      message: message.error?.message || null,
    });
    if (videoUrl) {
      updateVideoFromPayload(
        {
          user_id: message.user_id,
          device_id: message.device_id,
          video_url: videoUrl,
          duration: message.data?.duration_seconds || message.result?.duration_seconds || message.result?.duration,
          created_at: message.executed_at,
        },
        message.user_id,
      );
    }
    if (pendingCommand && pendingCommand.requestId === message.request_id) {
      setPending(message.user_id, null);
      pendingCommand = null;
    }
    renderActivity();
    renderSelection();
    updateVideoPreview();
    return;
  }

  if (message.type === "device_event") {
    const payload = message.payload || {};
    rememberActivity({
      kind: "event",
      title: String(message.action || message.event || "DEVICE_EVENT").toUpperCase(),
      ts: message.received_at || message.ts || Date.now(),
      user_id: message.user_id,
      device_id: message.device_id || null,
      status: message.status || "ok",
      message: payload.message || message.message || null,
      video_url: payload.video_url || message.video_url || null,
    });
    if ((message.action === "video_recorded" || payload.type === "video_recorded") && (payload.video_url || message.video_url)) {
      updateVideoFromPayload(
        {
          user_id: message.user_id,
          device_id: message.device_id,
          video_url: payload.video_url || message.video_url,
          duration: payload.duration_seconds || payload.duration,
          created_at: message.received_at || message.ts,
        },
        message.user_id,
      );
    }
    renderActivity();
    renderSelection();
    updateVideoPreview();
  }
}

function closeSocket() {
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  ws = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSocket();
  }, 3000);
}

function connectSocket() {
  const cfg = getConfig();
  const wsUrl = buildWsUrl(cfg.backendBase);
  if (!wsUrl) return;

  closeSocket();
  try {
    ws = new WebSocket(wsUrl);
    wsState = "connecting";
    setStatus(els.backendHealth, null, "CONNECTING");

    ws.onopen = () => {
      wsState = "connected";
      ws.send(JSON.stringify({ type: "hello", role: "admin", bearer: cfg.adminToken }));
      setStatus(els.backendHealth, true, "WS CONNECTED");
    };

    ws.onmessage = (event) => {
      try {
        handleSocketMessage(JSON.parse(event.data));
      } catch {
        // ignore malformed payloads
      }
    };

    ws.onerror = () => {
      wsState = "error";
      setStatus(els.backendHealth, false, "WS ERROR");
    };

    ws.onclose = () => {
      wsState = "disconnected";
      setStatus(els.backendHealth, false, "WS DISCONNECTED");
      scheduleReconnect();
    };
  } catch {
    wsState = "error";
    setStatus(els.backendHealth, false, "WS FAILED");
    scheduleReconnect();
  }
}

function refreshCurrentSelection() {
  renderDevices();
  renderSelection();
  updateVideoPreview();
  renderActivity();
  updateOutput(lastHealthResult, lastUsersResult, lastLocationsResult, lastCommandsResult, lastResponsesResult);
}

let lastHealthResult = { ok: false, status: 0, data: null };
let lastUsersResult = { ok: false, status: 0, data: null };
let lastLocationsResult = { ok: false, status: 0, data: null };
let lastCommandsResult = { ok: false, status: 0, data: null };
let lastResponsesResult = { ok: false, status: 0, data: null };

els.saveBtn.addEventListener("click", () => {
  saveConfig();
  connectSocket();
  refreshCurrentSelection();
});
els.runBtn.addEventListener("click", () => {
  void refreshBackendState();
});
els.autoBtn.addEventListener("click", toggleAuto);
els.cameraStartBtn.addEventListener("click", () => {
  void requestRecording({ force: true });
});
els.cameraStopBtn.addEventListener("click", () => {
  void cancelOrStop();
});
els.refreshFrameBtn.addEventListener("click", () => {
  updateVideoPreview();
  void refreshBackendState();
});
els.showOffline.addEventListener("change", () => {
  refreshCurrentSelection();
});

function updateFrameButtonLabel() {
  els.cameraStartBtn.textContent = "Record Video";
  els.cameraStopBtn.textContent = "Cancel / Stop";
  els.refreshFrameBtn.textContent = "Refresh State";
}

loadConfig();
updateFrameButtonLabel();
connectSocket();
void refreshBackendState();
startTimers();
els.autoBtn.textContent = "Stop Auto Refresh";
refreshCurrentSelection();
