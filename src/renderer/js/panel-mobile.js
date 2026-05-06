(function () {
  if (window.__piguardMobilePanelHttpBootstrapped) {
    return;
  }
  window.__piguardMobilePanelHttpBootstrapped = true;

  var shared = window.PiguardMobileShared || {};
  var devices = new Map();
  var deviceLayers = new Map();
  var gpsEvents = [];
  var maxEvents = 50;
  var map = null;
  var listenersRegistered = false;
  var selectedDeviceId = "";
  var expandedDeviceId = "";
  var backendHttpBaseUrl = '';

  var getEl = shared.getEl || function (id) { return document.getElementById(id); };
  var toNum = shared.toNum || function (v) { var n = Number(v); return Number.isFinite(n) ? n : null; };
  var getDeviceId = shared.getDeviceId || function (v) { if (!v) { return ""; } return String(v.deviceId || v.device_id || "").trim(); };
  var safeTs = shared.safeTs || function (ts) { return new Date(ts != null ? ts : Date.now()).toISOString(); };
  var friendlyName = shared.friendlyName || function (deviceId) { return deviceId ? String(deviceId) : "Unknown"; };
  var lastSeenText = shared.lastSeenText || function () { return "unknown"; };
  var isActive = shared.isActive || function () { return false; };
  var colorFromIndex = shared.colorFromIndex || function (idx) { return "hsl(" + ((idx * 47) % 360) + ",72%,54%)"; };

  function isDeviceOnline(device) {
    var status = String(device && device.status || '').trim().toLowerCase();
    return status === 'online' || status === 'active' || isActive(device && device.lastSeen);
  }

  function isRaspiDeviceId(deviceId) {
    return String(deviceId || "").trim().toLowerCase().indexOf("raspi") === 0;
  }

  function isValidLocation(lat, lng) {
    if (lat == null || lng == null) { return false; }
    if (Math.abs(lat) < 1e-6 && Math.abs(lng) < 1e-6) { return false; }
    if (lat < -90 || lat > 90) { return false; }
    if (lng < -180 || lng > 180) { return false; }
    return true;
  }

  function removeExcludedDevices() {
    Array.from(devices.keys()).forEach(function (deviceId) {
      if (isRaspiDeviceId(deviceId)) {
        devices.delete(deviceId);
        deviceLayers.delete(deviceId);
      }
    });
  }

  function getOrCreateLayer(deviceId) {
    if (!deviceLayers.has(deviceId)) {
      var idx = deviceLayers.size;
      var color = colorFromIndex(idx);
      deviceLayers.set(deviceId, { color: color, marker: null, routeLine: null, routePoints: [] });
    }
    return deviceLayers.get(deviceId);
  }

  function initMap() {
    if (map) { return map; }
    var el = getEl("mobile-map");
    if (!el) { console.error("[Panel] mobile-map div missing"); return null; }
    if (typeof window.L === "undefined") {
      console.error("[Panel] Leaflet not loaded");
      return null;
    }
    if (window.mobileMap && typeof window.mobileMap.invalidateSize === "function") {
      map = window.mobileMap;
      try { map.invalidateSize(); } catch { }
      return map;
    }
    if (el._leaflet_id) {
      console.warn("[Panel] mobile-map already initialized");
      return null;
    }
    try {
      map = window.L.map("mobile-map").setView([14.5995, 120.9842], 12);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
      window.mobileMap = map;
      return map;
    } catch (e) {
      console.error("[Panel] Map error:", e && e.message ? e.message : e);
      map = null;
      return null;
    }
  }

  function centerMapOnDevice(deviceId) {
    if (!deviceId) { return; }
    var m = initMap();
    if (!m) { return; }
    var device = devices.get(deviceId);
    if (!device) { return; }
    var targetZoom = 18;
    try { m.invalidateSize(); } catch { }

    var layer = deviceLayers.get(deviceId);
    if (layer && layer.marker) {
      m.flyTo(layer.marker.getLatLng(), targetZoom, { animate: true, duration: 0.6 });
      try { layer.marker.openPopup(); } catch { }
      return;
    }

    var lat = toNum(device.lat);
    var lng = toNum(device.lng);
    if (lat == null || lng == null) { return; }
    m.flyTo([lat, lng], targetZoom, { animate: true, duration: 0.6 });
  }

  function mergeDevice(deviceId, patch) {
    if (!deviceId || isRaspiDeviceId(deviceId)) { return null; }
    var existing = devices.get(deviceId) || { deviceId: deviceId, userId: null, status: "known", lastSeen: null, lat: null, lng: null };
    var merged = Object.assign({}, existing, patch, { deviceId: deviceId, lastSeen: safeTs((patch && patch.lastSeen) || existing.lastSeen || Date.now()) });
    var lat = toNum(merged.lat != null ? merged.lat : merged.latitude);
    var lng = toNum(merged.lng != null ? merged.lng : merged.longitude);
    if (!isValidLocation(lat, lng)) {
      lat = existing.lat;
      lng = existing.lng;
    }
    merged.lat = lat;
    merged.lng = lng;
    devices.set(deviceId, merged);
    return merged;
  }

  function updateMapForDevice(device) {
    if (!device) { return; }
    var m = initMap();
    if (!m) { return; }
    var lat = toNum(device.lat);
    var lng = toNum(device.lng);
    if (lat == null || lng == null) { return; }

    var layer = getOrCreateLayer(device.deviceId);
    if (!layer) { return; }
    var point = [lat, lng];
    if (layer.routeLine) {
      m.removeLayer(layer.routeLine);
      layer.routeLine = null;
    }
    layer.routePoints = [point];

    if (!layer.marker) {
      layer.marker = window.L.circleMarker(point, { radius: 8, color: layer.color, weight: 2, fillColor: layer.color, fillOpacity: 0.9 }).addTo(m);
    } else {
      layer.marker.setLatLng(point);
    }

    if (layer.marker) {
      layer.marker.bindPopup("<strong>" + friendlyName(device.deviceId) + "</strong><br/>Device: " + device.deviceId + "<br/>Lat: " + lat.toFixed(6) + "<br/>Lng: " + lng.toFixed(6) + "<br/>Seen: " + lastSeenText(device.lastSeen));
    }
  }

  function renderHeader() {
    var count = devices.size;
    var statusEl = getEl("mobileTrackingStatus");
    var coordsEl = getEl("mobileGpsCoords");
    if (statusEl) { statusEl.textContent = count ? count + " devices tracked" : "Waiting for device presence updates..."; }
    if (coordsEl) {
      if (selectedDeviceId && devices.has(selectedDeviceId)) {
        var d = devices.get(selectedDeviceId);
        if (toNum(d.lat) != null && toNum(d.lng) != null) {
          coordsEl.textContent = friendlyName(d.deviceId) + ": " + toNum(d.lat).toFixed(5) + ", " + toNum(d.lng).toFixed(5);
        } else {
          coordsEl.textContent = "No coordinates for " + friendlyName(d.deviceId);
        }
      } else {
        coordsEl.textContent = count ? "Tracking " + count + " devices" : "No active mobile tracking";
      }
    }
  }

  function renderCards() {
    var wrap = getEl("trackingDeviceCards");
    if (!wrap) { return; }
    var list = Array.from(devices.values()).sort(function (a, b) { return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0); });
    if (!list.length) {
      wrap.innerHTML = "<div class=\"tracking-device-empty\">No devices seen yet. Device cards appear automatically when mobile apps connect.</div>";
      renderHeader();
      return;
    }

    wrap.innerHTML = list.map(function (device) {
      var layer = getOrCreateLayer(device.deviceId);
      var active = isDeviceOnline(device);
      var coords = (toNum(device.lat) != null && toNum(device.lng) != null) ? toNum(device.lat).toFixed(5) + ", " + toNum(device.lng).toFixed(5) : "No coordinates";
      var isExpanded = expandedDeviceId === device.deviceId;
        return "<article class=\"tracking-device-card " + (active ? "is-online" : "is-offline") + " " + (selectedDeviceId === device.deviceId ? "is-selected" : "") + "\" data-device-id=\"" + device.deviceId + "\" style=\"border-left-color:" + layer.color + ";\">"
          + "<div class=\"tracking-device-top\"><div class=\"tracking-device-id\" title=\"" + device.deviceId + "\">" + friendlyName(device.deviceId) + "</div><div class=\"tracking-status-wrap\"><span class=\"tracking-status-dot " + (active ? "online" : "offline") + "\" style=\"background:" + layer.color + ";\"></span><span>" + (active ? "active" : "inactive") + "</span></div></div>"
          + "<div class=\"tracking-device-meta\">Device: " + device.deviceId + "<br/>Seen: " + lastSeenText(device.lastSeen) + "<br/>Coords: " + coords + "</div>"
          + "<div class=\"tracking-device-actions\">"
          + "<button type=\"button\" class=\"tracking-action-btn tracking-action-toggle\" data-action=\"toggle_actions\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;width:100%;\">Actions " + (isExpanded ? "&#9650;" : "&#9660;") + "</button>"
          + "<div class=\"tracking-device-dropdown\" style=\"margin-top:6px;display:" + (isExpanded ? "grid" : "none") + ";gap:6px;\">"
          + "<button type=\"button\" class=\"tracking-action-btn\" data-action=\"record_video\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;\">Send Record Command</button>"
          + "<button type=\"button\" class=\"tracking-action-btn\" data-action=\"show_sms\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;\">Show SMS</button>"
          + "<button type=\"button\" class=\"tracking-action-btn\" data-action=\"show_logs\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;\">Show Logs</button>"
          + "</div>"
          + "</div>"
          + "</article>";
    }).join("");

    renderHeader();
  }

  function renderGpsLog() {
    var listEl = getEl("trackingGpsEventList");
    var countEl = getEl("trackingGpsEventCount");
    if (countEl) { countEl.textContent = gpsEvents.length + " events"; }
    if (!listEl) { return; }
    if (!gpsEvents.length) {
      listEl.innerHTML = "<div class=\"tracking-log-empty\">No GPS events yet.</div>";
      return;
    }
    listEl.innerHTML = gpsEvents.map(function (item) {
      var layer = getOrCreateLayer(item.deviceId);
      if (!isValidLocation(item.latitude, item.longitude)) { return ""; }
      return "<div class=\"tracking-log-line kind-location\" style=\"border-left-color:" + layer.color + ";\"><span class=\"time\">[" + new Date(item.timestamp).toLocaleTimeString() + "]</span><span class=\"device\">[" + friendlyName(item.deviceId) + "]</span><span class=\"detail\">[" + item.latitude.toFixed(5) + ", " + item.longitude.toFixed(5) + "]</span></div>";
    }).join("");
  }

  function pushGpsEvent(deviceId, lat, lng, timestamp) {
    gpsEvents.unshift({ deviceId: deviceId, latitude: lat, longitude: lng, timestamp: safeTs(timestamp) });
    if (gpsEvents.length > maxEvents) { gpsEvents.length = maxEvents; }
    renderGpsLog();
  }

  function emitSidebarSnapshot() {
    window.dispatchEvent(new CustomEvent("piguard:mobile-devices", { detail: { devices: Array.from(devices.values()) } }));
    window.dispatchEvent(new CustomEvent("piguard:mobile-gps-log", { detail: { events: gpsEvents.slice(0, 10) } }));
  }

  function handleDeviceOnline(data) {
    var id = getDeviceId(data);
    if (!id || isRaspiDeviceId(id)) { return; }
    mergeDevice(id, { userId: data.userId || data.user_id || null, status: data.status || "active", lastSeen: data.connectedAt || data.lastSeen || Date.now() });
    if (!selectedDeviceId) {
      selectedDeviceId = id;
      expandedDeviceId = id;
      centerMapOnDevice(id);
    }
    renderCards();
    emitSidebarSnapshot();
  }

  function handleDeviceOffline(data) {
    var id = getDeviceId(data);
    if (!id || isRaspiDeviceId(id)) { return; }
    mergeDevice(id, { status: "inactive", lastSeen: data.lastSeen || Date.now() });
    renderCards();
    emitSidebarSnapshot();
  }

  function handleLocation(data) {
    var id = getDeviceId(data);
    if (!id || isRaspiDeviceId(id)) { return; }
    var lat = toNum(data.latitude != null ? data.latitude : data.lat);
    var lng = toNum(data.longitude != null ? data.longitude : data.lng);
    if (!isValidLocation(lat, lng)) { return; }
    var timestamp = data.timestamp || Date.now();
    var existing = devices.get(id);
    if (existing && existing.lat === lat && existing.lng === lng) { return; }
    var updated = mergeDevice(id, { userId: data.userId || data.user_id || null, status: "active", lat: lat, lng: lng, lastSeen: timestamp });
    if (lat != null && lng != null) {
      updateMapForDevice(updated);
      pushGpsEvent(id, lat, lng, timestamp);
    }
    renderCards();
    emitSidebarSnapshot();
  }

  function handleDevicesList(payload) {
    var rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.devices) ? payload.devices : []);
    if (!rows.length) {
      removeExcludedDevices();
      renderCards();
      renderGpsLog();
      return;
    }

    rows.forEach(function (item) {
      var id = getDeviceId(item);
      if (!id || isRaspiDeviceId(id)) { return; }
      var lastLocation = item.last_location || item.lastLocation || null;
      var lat = item.lat != null ? item.lat : (item.latitude != null ? item.latitude : (item.last_lat != null ? item.last_lat : (lastLocation ? lastLocation.lat || lastLocation.latitude : null)));
      var lng = item.lng != null ? item.lng : (item.longitude != null ? item.longitude : (item.last_lng != null ? item.last_lng : (lastLocation ? lastLocation.lng || lastLocation.longitude : null)));
      if (!isValidLocation(toNum(lat), toNum(lng))) {
        lat = null;
        lng = null;
      }
      var merged = mergeDevice(id, { userId: item.userId || item.user_id || null, status: item.status || "known", lat: lat, lng: lng, lastSeen: item.lastSeen || item.last_seen || Date.now() });
      updateMapForDevice(merged);
    });

    removeExcludedDevices();

    if (!selectedDeviceId && rows.length) {
      var firstId = getDeviceId(rows[0]);
      if (firstId && !isRaspiDeviceId(firstId)) {
        selectedDeviceId = firstId;
        expandedDeviceId = firstId;
        centerMapOnDevice(firstId);
      }
    }
    renderCards();
    emitSidebarSnapshot();
  }

  function registerListeners() {
    if (listenersRegistered) { return; }
    if (!window.electronAPI) { console.error("[Panel] electronAPI missing"); return; }
    if (typeof window.electronAPI.on !== "function") { console.error("[Panel] electronAPI.on missing"); return; }
    listenersRegistered = true;
    window.electronAPI.on("mobile:device_online", function (_event, data) { handleDeviceOnline(data || {}); });
    window.electronAPI.on("mobile:device_offline", function (_event, data) { handleDeviceOffline(data || {}); });
    window.electronAPI.on("mobile:location", function (_event, data) { handleLocation(data || {}); });
    window.electronAPI.on("mobile:devices_list", function (_event, data) { handleDevicesList(data || {}); });
  }

  function loadCachedDevices() {
    if (!window.electronAPI || typeof window.electronAPI.invoke !== "function") { return; }
    window.electronAPI.invoke("get-cached-devices").then(function (result) {
      var rows = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      handleDevicesList({ devices: rows });
    }).catch(function (err) {
      console.warn("[Panel] Failed to load cached devices:", err && err.message ? err.message : err);
    });
  }

  function loadSupabaseDevices() {
    if (!window.electronAPI || typeof window.electronAPI.getSupabaseDevices !== "function") { return; }
    window.electronAPI.getSupabaseDevices().then(function (result) {
      var rows = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      handleDevicesList({ devices: rows });
    }).catch(function (err) {
      console.warn("[Panel] Failed to load Supabase devices:", err && err.message ? err.message : err);
    });
  }

  function bindCardActions() {
    var cards = getEl("trackingDeviceCards");
    if (!cards) { return; }
    cards.addEventListener("click", function (evt) {
      var actionBtn = evt.target && evt.target.closest ? evt.target.closest(".tracking-action-btn[data-action]") : null;
      if (actionBtn) {
        evt.preventDefault();
        evt.stopPropagation();
        var action = String(actionBtn.getAttribute("data-action") || "").trim();
        var deviceId = String(actionBtn.getAttribute("data-device-id") || "").trim();
        if (action === "toggle_actions") {
          expandedDeviceId = expandedDeviceId === deviceId ? "" : deviceId;
          selectedDeviceId = deviceId || selectedDeviceId;
          renderCards();
          centerMapOnDevice(selectedDeviceId);
          return;
        }
        if (deviceId && window.electronAPI && typeof window.electronAPI.invoke === "function") {
          if (action === 'show_camera' || action === 'record_video') {
            openCameraModal(deviceId);
            return;
          } else {
            window.electronAPI.invoke("send-command", deviceId, action, {}).catch(function (err) {
              console.warn("[Panel] Failed to send " + action + ":", err && err.message ? err.message : err);
            });
          }
        }
        return;
      }

      var card = evt.target && evt.target.closest ? evt.target.closest(".tracking-device-card[data-device-id]") : null;
      if (!card) { return; }
      selectedDeviceId = String(card.getAttribute("data-device-id") || "").trim();
      expandedDeviceId = selectedDeviceId;
      renderCards();
      centerMapOnDevice(selectedDeviceId);
    });
  }

  registerListeners();
  bindCardActions();
  loadCachedDevices();
  loadSupabaseDevices();
  renderCards();
  renderGpsLog();

  if (window.backendBridge && typeof window.backendBridge.getHttpBaseUrl === 'function') {
    window.backendBridge.getHttpBaseUrl().then(function (url) {
      backendHttpBaseUrl = String(url || '').trim().replace(/\/+$/, '');
    }).catch(function () { backendHttpBaseUrl = ''; });
  }

  var cameraModalState = { deviceId: '', lastVideoUrl: '', lastImageUrl: '', toastTimer: null };

  /* Camera modal UI */
  function createCameraModal() {
    if (document.getElementById('cameraModal')) return;
    var modal = document.createElement('div');
    modal.id = 'cameraModal';
    modal.style.position = 'fixed';
    modal.style.left = '0';
    modal.style.top = '0';
    modal.style.width = '100%';
    modal.style.height = '100%';
    modal.style.background = 'rgba(3, 8, 18, 0.72)';
    modal.style.display = 'none';
    modal.style.alignItems = 'center';
    modal.style.justifyContent = 'center';
    modal.style.zIndex = '9999';

    if (!document.getElementById('cameraModalStyles')) {
      var styleEl = document.createElement('style');
      styleEl.id = 'cameraModalStyles';
      styleEl.textContent =
        '@keyframes cameraStaticShift {'
        + '0% { background-position: 0% 0%; }'
        + '50% { background-position: 0% 100%; }'
        + '100% { background-position: 0% 0%; }'
        + '}'
        + '@keyframes cameraPulse {'
        + '0%, 100% { transform: scale(1); opacity: 0.72; }'
        + '50% { transform: scale(1.2); opacity: 1; }'
        + '}'
        + '@keyframes cameraLiveDot {'
        + '0%, 100% { box-shadow: 0 0 0 0 rgba(255, 78, 104, 0.5); opacity: 1; }'
        + '50% { box-shadow: 0 0 0 8px rgba(255, 78, 104, 0); opacity: 0.78; }'
        + '}'
        + '@keyframes cameraOfflinePulse {'
        + '0%, 100% { box-shadow: inset 0 0 0 1px rgba(0, 170, 255, 0.22), 0 0 0 rgba(0,170,255,0); }'
        + '50% { box-shadow: inset 0 0 0 1px rgba(0, 170, 255, 0.5), 0 0 26px rgba(0,170,255,0.18); }'
        + '}'
        + '@keyframes cameraEllipsis {'
        + '0% { content: ""; }'
        + '33% { content: "."; }'
        + '66% { content: ".."; }'
        + '100% { content: "..."; }'
        + '}'
        + '.camera-modal-frame { width: 92%; max-width: 940px; max-height: 90vh; overflow: hidden; backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }'
        + '.camera-modal-frame .cam-cell { min-height: 50px; border-radius: 14px; overflow: hidden; }'
        + '#cameraModal .camera-media-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; }'
        + '#cameraModal .camera-media-block { display: grid; gap: 8px; min-width: 0; }'
        + '#cameraModal .camera-media-block .cam-cell { aspect-ratio: 16 / 8; min-height: 96px; max-height: 210px; }'
        + '#cameraModal .cam-cell.is-offline { animation: cameraOfflinePulse 2.3s ease-in-out infinite; }'
        + '#cameraModal .cam-dot { background: #ff4e68; animation: cameraLiveDot 1.6s ease-in-out infinite; }'
        + '#cameraModal .cam-status.offline { background: rgba(255, 78, 104, 0.14); color: #ffd7de; border: 1px solid rgba(255, 78, 104, 0.35); border-radius: 999px; padding: 2px 9px; letter-spacing: 0.08em; text-transform: uppercase; font-size: 10px; font-weight: 700; }'
        + '#cameraModal .camera-section-label { position: relative; color: #7ad7ff; font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; font-weight: 700; padding-left: 10px; }'
        + '#cameraModal .camera-section-label::before { content: ""; position: absolute; left: 0; top: 2px; bottom: 2px; width: 2px; border-radius: 2px; background: linear-gradient(180deg, #00aaff, #79e8ff); }'
        + '#cameraModal #cameraFacingSelect, #cameraModal #cameraDurationSeconds { transition: border-color .2s ease, box-shadow .2s ease; }'
        + '#cameraModal #cameraFacingSelect:focus, #cameraModal #cameraDurationSeconds:focus { outline: none; border-color: rgba(0, 170, 255, 0.9); box-shadow: 0 0 0 3px rgba(0, 170, 255, 0.2); }'
        + '#cameraModal .camera-status-text { color: var(--muted); font-style: italic; }'
        + '#cameraModal .camera-status-text::after { content: ""; display: inline-block; width: 12px; text-align: left; animation: cameraEllipsis 1.3s steps(1, end) infinite; }'
        + '#cameraModal #cameraModalClose { width: 30px; height: 30px; border-radius: 9px; line-height: 1; padding: 0; font-size: 16px; display: inline-flex; align-items: center; justify-content: center; }'
        + '#cameraModal #cameraModalClose:hover { border-color: rgba(0,170,255,0.75); box-shadow: 0 0 0 2px rgba(0,170,255,0.18); }'
        + '#cameraModal #cameraModalSend, #cameraModal #cameraModalCapture { display: inline-flex; align-items: center; gap: 8px; border-radius: 10px; font-weight: 700; border: 1px solid rgba(122, 232, 255, 0.35); background: linear-gradient(120deg, #0077ff, #00aaff 62%, #72f1ff); color: #031a2f; box-shadow: 0 10px 26px rgba(0, 153, 255, 0.28); }'
        + '#cameraModal #cameraModalSend:hover, #cameraModal #cameraModalCapture:hover { transform: translateY(-1px); filter: brightness(1.05); }'
        + '#cameraModal #cameraModalCapturedStatus, #cameraModal #cameraModalRecordedStatus { box-shadow: inset 0 0 0 1px rgba(0, 170, 255, 0.08), 0 8px 18px rgba(0, 0, 0, 0.25); }'
        + '@media (max-width: 900px) {'
        + '.camera-modal-frame { width: 94%; padding: 12px; max-height: 90vh; overflow: auto; }'
        + '#cameraModal .camera-media-grid { grid-template-columns: 1fr; }'
        + '.camera-modal-frame .cam-cell { min-height: 50px; }'
        + '}';
      styleEl.textContent += '@media (max-height: 820px) { .camera-modal-frame { max-height: 90vh; overflow: auto; } }';
      document.head.appendChild(styleEl);
    }

    var frame = document.createElement('div');
    frame.className = 'camera-modal-frame';
    frame.style.width = '88%';
    frame.style.maxWidth = '780px';
    frame.style.maxHeight = '86vh';
    frame.style.overflow = 'hidden';
    frame.style.background = 'linear-gradient(180deg, var(--card-bg), var(--surface-1))';
    frame.style.border = '1px solid var(--card-border)';
    frame.style.padding = '12px';
    frame.style.borderRadius = '10px';
    frame.style.boxShadow = '0 10px 40px rgba(0,0,0,0.6)';
    frame.style.display = 'flex';
    frame.style.flexDirection = 'column';
    frame.style.gap = '10px';

    var header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';

    var title = document.createElement('div');
    title.id = 'cameraModalTitle';
    title.style.color = 'var(--text)';
    title.style.fontSize = '16px';
    title.style.fontWeight = '600';
    title.textContent = 'Camera';

    var closeWrap = document.createElement('div');
    var close = document.createElement('button');
    close.id = 'cameraModalClose';
    close.textContent = '\u00D7';
    close.setAttribute('aria-label', 'Close');
    close.style.background = 'var(--surface-2)';
    close.style.color = 'var(--text)';
    close.style.border = '1px solid var(--card-border)';
    close.style.padding = '6px 10px';
    close.style.borderRadius = '6px';
    close.style.cursor = 'pointer';
    close.addEventListener('click', function () {
      closeCameraModal();
    });
    closeWrap.appendChild(close);

    header.appendChild(title);
    header.appendChild(closeWrap);

    var settings = document.createElement('div');
    settings.style.display = 'grid';
    settings.style.gridTemplateColumns = 'repeat(auto-fit, minmax(140px, 1fr))';
    settings.style.gap = '8px';

    var facingWrap = document.createElement('label');
    facingWrap.style.display = 'grid';
    facingWrap.style.gap = '6px';
    facingWrap.style.color = 'var(--muted)';
    facingWrap.style.fontSize = '12px';
    facingWrap.textContent = 'Camera Facing';

    var facingSelect = document.createElement('select');
    facingSelect.id = 'cameraFacingSelect';
    facingSelect.style.background = 'var(--surface-1)';
    facingSelect.style.border = '1px solid var(--card-border)';
    facingSelect.style.color = 'var(--text)';
    facingSelect.style.borderRadius = '8px';
    facingSelect.style.padding = '8px';
    var facingFront = document.createElement('option');
    facingFront.value = 'front';
    facingFront.textContent = 'Front';
    var facingBack = document.createElement('option');
    facingBack.value = 'back';
    facingBack.textContent = 'Back';
    facingSelect.appendChild(facingFront);
    facingSelect.appendChild(facingBack);
    facingWrap.appendChild(facingSelect);

    var durationWrap = document.createElement('label');
    durationWrap.style.display = 'grid';
    durationWrap.style.gap = '6px';
    durationWrap.style.color = 'var(--muted)';
    durationWrap.style.fontSize = '12px';
    durationWrap.textContent = 'Duration (seconds)';

    var durationInput = document.createElement('input');
    durationInput.id = 'cameraDurationSeconds';
    durationInput.type = 'number';
    durationInput.min = '1';
    durationInput.max = '60';
    durationInput.step = '1';
    durationInput.value = '15';
    durationInput.style.background = 'var(--surface-1)';
    durationInput.style.border = '1px solid var(--card-border)';
    durationInput.style.color = 'var(--text)';
    durationInput.style.borderRadius = '8px';
    durationInput.style.padding = '8px';
    durationWrap.appendChild(durationInput);

    settings.appendChild(facingWrap);
    settings.appendChild(durationWrap);

    var videoStage = document.createElement('div');
    videoStage.id = 'cameraModalVideoStage';
    videoStage.className = 'cam-cell is-offline';
    videoStage.style.minHeight = '96px';
    videoStage.style.maxHeight = '210px';

    var videoFeed = document.createElement('div');
    videoFeed.className = 'cam-feed';

    var videoPlaceholder = document.createElement('div');
    videoPlaceholder.className = 'cam-placeholder';
    videoPlaceholder.textContent = 'Waiting for the request';

    var videoOverlay = document.createElement('div');
    videoOverlay.className = 'cam-overlay';

    var videoCorner = document.createElement('div');
    videoCorner.className = 'cam-corner';
    var videoDot = document.createElement('span');
    videoDot.className = 'cam-dot';
    videoCorner.appendChild(videoDot);

    var videoLabel = document.createElement('div');
    videoLabel.className = 'cam-label';
    var videoName = document.createElement('div');
    videoName.className = 'cam-name';
    videoName.textContent = 'Video feed';
    var videoStatus = document.createElement('div');
    videoStatus.className = 'cam-status offline';
    videoStatus.textContent = 'offline';
    videoLabel.appendChild(videoName);
    videoLabel.appendChild(videoStatus);

    videoFeed.appendChild(videoPlaceholder);
    videoStage.appendChild(videoFeed);
    videoStage.appendChild(videoOverlay);
    videoStage.appendChild(videoCorner);
    videoStage.appendChild(videoLabel);

    var imgWrap = document.createElement('div');
    imgWrap.className = 'cam-cell is-offline';
    imgWrap.style.minHeight = '96px';
    imgWrap.style.maxHeight = '210px';

    var imgFeed = document.createElement('div');
    imgFeed.className = 'cam-feed';

    var img = document.createElement('img');
    img.id = 'cameraModalImg';
    img.style.width = '100%';
    img.style.height = 'auto';
    img.style.objectFit = 'contain';
    img.style.display = 'none';
    img.alt = 'Camera frame';

    var placeholder = document.createElement('div');
    placeholder.id = 'cameraPlaceholder';
    placeholder.className = 'cam-placeholder';
    placeholder.textContent = 'Waiting for the request';

    var imgOverlay = document.createElement('div');
    imgOverlay.className = 'cam-overlay';

    var imgCorner = document.createElement('div');
    imgCorner.className = 'cam-corner';
    var imgDot = document.createElement('span');
    imgDot.className = 'cam-dot';
    imgCorner.appendChild(imgDot);

    var imgLabel = document.createElement('div');
    imgLabel.className = 'cam-label';
    var imgName = document.createElement('div');
    imgName.className = 'cam-name';
    imgName.textContent = 'Capture frame';
    var imgStatus = document.createElement('div');
    imgStatus.className = 'cam-status offline';
    imgStatus.textContent = 'offline';
    imgLabel.appendChild(imgName);
    imgLabel.appendChild(imgStatus);

    imgFeed.appendChild(img);
    imgFeed.appendChild(placeholder);
    imgWrap.appendChild(imgFeed);
    imgWrap.appendChild(imgOverlay);
    imgWrap.appendChild(imgCorner);
    imgWrap.appendChild(imgLabel);

    var capturedStatus = document.createElement('div');
    capturedStatus.id = 'cameraModalCapturedStatus';
    capturedStatus.style.display = 'flex';
    capturedStatus.style.alignItems = 'center';
    capturedStatus.style.justifyContent = 'space-between';
    capturedStatus.style.background = 'var(--surface-1)';
    capturedStatus.style.border = '1px solid var(--card-border)';
    capturedStatus.style.borderRadius = '8px';
    capturedStatus.style.padding = '10px 12px';
    capturedStatus.style.color = 'var(--text)';
    capturedStatus.style.fontSize = '12px';
    var capturedLabel = document.createElement('div');
    capturedLabel.id = 'cameraModalCapturedLabel';
    capturedLabel.className = 'camera-status-text';
    capturedLabel.textContent = 'Captured Image: waiting for capture';

    var imageMeta = document.createElement('div');
    imageMeta.style.display = 'flex';
    imageMeta.style.alignItems = 'center';
    imageMeta.style.gap = '8px';

    var imageName = document.createElement('div');
    imageName.id = 'cameraModalImageName';
    imageName.style.color = 'var(--muted)';
    imageName.style.fontSize = '12px';
    imageName.style.display = 'none';

    var imageDownload = document.createElement('a');
    imageDownload.id = 'cameraModalImageDownload';
    imageDownload.textContent = 'Download image';
    imageDownload.style.background = 'var(--primary)';
    imageDownload.style.color = 'var(--secondary)';
    imageDownload.style.borderRadius = '6px';
    imageDownload.style.padding = '4px 8px';
    imageDownload.style.textDecoration = 'none';
    imageDownload.style.display = 'none';

    imageMeta.appendChild(imageName);
    imageMeta.appendChild(imageDownload);
    capturedStatus.appendChild(capturedLabel);
    capturedStatus.appendChild(imageMeta);

    var recordedStatus = document.createElement('div');
    recordedStatus.id = 'cameraModalRecordedStatus';
    recordedStatus.style.display = 'flex';
    recordedStatus.style.alignItems = 'center';
    recordedStatus.style.justifyContent = 'space-between';
    recordedStatus.style.background = 'var(--surface-1)';
    recordedStatus.style.border = '1px solid var(--card-border)';
    recordedStatus.style.borderRadius = '8px';
    recordedStatus.style.padding = '10px 12px';
    recordedStatus.style.color = 'var(--text)';
    recordedStatus.style.fontSize = '12px';
    recordedStatus.className = 'camera-status-text';
    recordedStatus.textContent = 'Recorded Video: waiting for upload';

    var videoWrap = document.createElement('div');
    videoWrap.id = 'cameraModalVideoWrap';
    videoWrap.style.background = 'var(--surface-1)';
    videoWrap.style.border = '1px solid var(--card-border)';
    videoWrap.style.borderRadius = '8px';
    videoWrap.style.padding = '10px';
    videoWrap.style.display = 'none';

    var video = document.createElement('video');
    video.id = 'cameraModalVideo';
    video.controls = true;
    video.preload = 'metadata';
    video.style.width = '100%';
    video.style.borderRadius = '6px';
    video.style.background = '#000';

    var downloadWrap = document.createElement('div');
    downloadWrap.style.display = 'flex';
    downloadWrap.style.justifyContent = 'flex-end';
    downloadWrap.style.marginTop = '8px';
    downloadWrap.style.gap = '8px';
    downloadWrap.style.alignItems = 'center';

    var filename = document.createElement('div');
    filename.id = 'cameraModalFilename';
    filename.style.color = 'var(--muted)';
    filename.style.fontSize = '12px';
    filename.style.display = 'none';

    var download = document.createElement('a');
    download.id = 'cameraModalDownload';
    download.textContent = 'Download video';
    download.style.background = 'var(--primary)';
    download.style.color = 'var(--secondary)';
    download.style.borderRadius = '6px';
    download.style.padding = '6px 10px';
    download.style.textDecoration = 'none';
    download.style.display = 'none';
    downloadWrap.appendChild(filename);
    downloadWrap.appendChild(download);

    videoWrap.appendChild(video);
    videoWrap.appendChild(downloadWrap);

    var footer = document.createElement('div');
    footer.style.display = 'flex';
    footer.style.justifyContent = 'space-between';
    footer.style.alignItems = 'center';
    footer.style.gap = '12px';

    var hint = document.createElement('div');
    hint.id = 'cameraModalHint';
    hint.style.color = 'var(--muted)';
    hint.style.fontSize = '12px';
    hint.textContent = 'Set duration, then send a recording command.';

    var send = document.createElement('button');
    send.id = 'cameraModalSend';
    send.textContent = 'Send Record Command';
    send.style.background = '#0077ff';
    send.style.color = '#031a2f';
    send.style.border = '1px solid rgba(122, 232, 255, 0.35)';
    send.style.padding = '8px 12px';
    send.style.borderRadius = '10px';
    send.style.cursor = 'pointer';
    send.innerHTML = '<span aria-hidden="true">\u25CF</span><span>Send Record Command</span>';
    send.addEventListener('click', function () {
      var targetId = cameraModalState.deviceId;
      if (!targetId) return;
      sendRecordCommand(targetId);
    });

    var capture = document.createElement('button');
    capture.id = 'cameraModalCapture';
    capture.textContent = 'Send Capture Command';
    send.style.background = '#0077ff';
    capture.style.color = '#031a2f';
    capture.style.border = '1px solid rgba(122, 232, 255, 0.35)';
    capture.style.padding = '8px 12px';
    capture.style.borderRadius = '8px';
    capture.style.cursor = 'pointer';
    capture.addEventListener('click', function () {
      var targetId = cameraModalState.deviceId;
      if (!targetId) return;
      sendCaptureCommand(targetId);
    });

    var videoLabel = document.createElement('div');
    videoLabel.className = 'camera-section-label';
    videoLabel.textContent = 'VIDEO';
    videoLabel.style.color = 'var(--primary)';
    videoLabel.style.fontSize = '12px';
    videoLabel.style.letterSpacing = '0.12em';
    videoLabel.style.textTransform = 'uppercase';

    var videoSection = document.createElement('div');
    videoSection.style.display = 'grid';
    videoSection.style.gap = '8px';

    var videoActions = document.createElement('div');
    videoActions.style.display = 'flex';
    videoActions.style.justifyContent = 'flex-end';
    videoActions.appendChild(send);

    videoSection.appendChild(videoStage);
    videoSection.appendChild(recordedStatus);
    videoSection.appendChild(videoWrap);
    videoSection.appendChild(videoActions);

    var divider = document.createElement('div');
    divider.style.height = '1px';
    divider.style.background = 'var(--card-border)';
    divider.style.margin = '4px 0';

    var captureLabel = document.createElement('div');
    captureLabel.className = 'camera-section-label';
    captureLabel.textContent = 'CAPTURE';
    captureLabel.style.color = 'var(--muted)';
    captureLabel.style.fontSize = '12px';
    captureLabel.style.letterSpacing = '0.12em';
    captureLabel.style.textTransform = 'uppercase';

    var captureSection = document.createElement('div');
    captureSection.style.display = 'grid';
    captureSection.style.gap = '8px';

    var captureActions = document.createElement('div');
    captureActions.style.display = 'flex';
    captureActions.style.justifyContent = 'flex-end';
    captureActions.appendChild(capture);

    captureSection.appendChild(imgWrap);
    captureSection.appendChild(capturedStatus);
    captureSection.appendChild(captureActions);

    frame.appendChild(header);
    frame.appendChild(settings);
    var mediaGrid = document.createElement('div');
    mediaGrid.className = 'camera-media-grid';

    var videoBlock = document.createElement('div');
    videoBlock.className = 'camera-media-block';
    videoBlock.appendChild(videoLabel);
    videoBlock.appendChild(videoSection);

    var captureBlock = document.createElement('div');
    captureBlock.className = 'camera-media-block';
    captureBlock.appendChild(captureLabel);
    captureBlock.appendChild(captureSection);

    mediaGrid.appendChild(videoBlock);
    mediaGrid.appendChild(captureBlock);

    frame.appendChild(mediaGrid);
    footer.appendChild(hint);
    frame.appendChild(footer);
    var toast = document.createElement('div');
    toast.id = 'cameraModalToast';
    toast.style.position = 'absolute';
    toast.style.right = '24px';
    toast.style.top = '18px';
    toast.style.background = 'linear-gradient(180deg, var(--surface-2), var(--card-bg))';
    toast.style.color = 'var(--text)';
    toast.style.border = '1px solid var(--primary)';
    toast.style.borderRadius = '10px';
    toast.style.padding = '10px 14px';
    toast.style.display = 'flex';
    toast.style.alignItems = 'center';
    toast.style.gap = '10px';
    toast.style.fontSize = '12px';
    toast.style.fontWeight = '600';
    toast.style.boxShadow = '0 10px 25px rgba(2, 6, 23, 0.5)';
    toast.style.display = 'none';
    frame.appendChild(toast);
    modal.appendChild(frame);
    document.body.appendChild(modal);
  }

  function showCameraModalToast(message) {
    var toast = document.getElementById('cameraModalToast');
    if (!toast) { return; }

    toast.textContent = '';
    var text = document.createElement('div');
    text.textContent = message;
    text.style.flex = '1';

    var done = document.createElement('button');
    done.textContent = 'Done';
    done.style.background = 'var(--primary)';
    done.style.color = 'var(--secondary)';
    done.style.border = '1px solid var(--card-border)';
    done.style.borderRadius = '6px';
    done.style.padding = '4px 8px';
    done.style.cursor = 'pointer';

    var close = document.createElement('button');
    close.textContent = 'Close';
    close.style.background = 'transparent';
    close.style.color = 'var(--text)';
    close.style.border = '1px solid var(--card-border)';
    close.style.borderRadius = '6px';
    close.style.padding = '4px 8px';
    close.style.cursor = 'pointer';

    function hideToast() {
      toast.style.display = 'none';
      if (cameraModalState.toastTimer) {
        clearTimeout(cameraModalState.toastTimer);
        cameraModalState.toastTimer = null;
      }
    }

    done.addEventListener('click', hideToast);
    close.addEventListener('click', hideToast);

    toast.appendChild(text);
    toast.appendChild(done);
    toast.appendChild(close);
    toast.style.display = 'flex';

    if (cameraModalState.toastTimer) {
      clearTimeout(cameraModalState.toastTimer);
    }
    cameraModalState.toastTimer = setTimeout(function () {
      hideToast();
    }, 600000);
  }

  function setCameraModalVideo(url, nameOverride) {
    var videoWrap = document.getElementById('cameraModalVideoWrap');
    var video = document.getElementById('cameraModalVideo');
    var download = document.getElementById('cameraModalDownload');
    var filename = document.getElementById('cameraModalFilename');
    var recordedStatus = document.getElementById('cameraModalRecordedStatus');
    if (!videoWrap || !video || !download) { return; }

    if (url) {
      var name = '';
      try {
        var cleaned = String(url).split('#')[0].split('?')[0];
        name = cleaned.split('/').pop() || '';
      } catch (e) { name = ''; }
      if (nameOverride) { name = String(nameOverride); }

      video.src = url;
      videoWrap.style.display = 'block';
      download.href = url;
      download.setAttribute('download', '');
      download.style.display = 'inline-flex';
      if (filename) {
        filename.textContent = name ? ('File: ' + name) : 'File ready';
        filename.style.display = 'inline-flex';
      }
      if (recordedStatus) {
        recordedStatus.textContent = name ? ('Recorded Video: ' + name) : 'Recorded Video: ready';
      }
      if (cameraModalState.lastVideoUrl !== url) {
        cameraModalState.lastVideoUrl = url;
        showCameraModalToast('Recorded video is ready. You can download it now.');
      }
      return;
    }

    video.removeAttribute('src');
    video.load();
    videoWrap.style.display = 'none';
    download.removeAttribute('href');
    download.style.display = 'none';
    if (filename) {
      filename.textContent = '';
      filename.style.display = 'none';
    }
    if (recordedStatus) {
      recordedStatus.textContent = 'Recorded Video: waiting for upload...';
    }
    cameraModalState.lastVideoUrl = '';
  }

  function setCameraModalImage(url, nameOverride) {
    var img = document.getElementById('cameraModalImg');
    var placeholder = document.getElementById('cameraPlaceholder');
    var imageDownload = document.getElementById('cameraModalImageDownload');
    var imageName = document.getElementById('cameraModalImageName');
    var capturedLabel = document.getElementById('cameraModalCapturedLabel');

    if (!img || !imageDownload) { return; }

    if (url) {
      var name = '';
      try {
        var cleaned = String(url).split('#')[0].split('?')[0];
        name = cleaned.split('/').pop() || '';
      } catch (e) { name = ''; }
      if (nameOverride) { name = String(nameOverride); }

      img.src = url;
      img.style.display = 'block';
      if (placeholder) { placeholder.style.display = 'none'; }
      imageDownload.href = url;
      imageDownload.setAttribute('download', '');
      imageDownload.style.display = 'inline-flex';
      if (imageName) {
        imageName.textContent = name ? ('File: ' + name) : 'Image ready';
        imageName.style.display = 'inline-flex';
      }
      if (capturedLabel) {
        capturedLabel.textContent = name ? ('Captured Image: ' + name) : 'Captured Image: ready';
      }
      cameraModalState.lastImageUrl = url;
      return;
    }

    img.removeAttribute('src');
    img.style.display = 'none';
    if (placeholder) { placeholder.style.display = 'block'; }
    imageDownload.removeAttribute('href');
    imageDownload.style.display = 'none';
    if (imageName) {
      imageName.textContent = '';
      imageName.style.display = 'none';
    }
    if (capturedLabel) {
      capturedLabel.textContent = 'Captured Image: waiting for capture...';
    }
    cameraModalState.lastImageUrl = '';
  }

  function openCameraModal(deviceId) {
    createCameraModal();
    cameraModalState.deviceId = String(deviceId || '').trim();
    var modal = document.getElementById('cameraModal');
    var title = document.getElementById('cameraModalTitle');
    var img = document.getElementById('cameraModalImg');
    var placeholder = document.getElementById('cameraPlaceholder');
    var hint = document.getElementById('cameraModalHint');
    if (title) title.textContent = 'Camera: ' + deviceId;
    if (img) {
      img.src = ''; // clear
      img.style.display = 'none';
    }
    if (placeholder) {
      placeholder.style.display = 'block';
      placeholder.textContent = 'Ready to record. Configure settings and send the command.';
    }
    if (hint) {
      hint.textContent = 'Set duration, then send a recording command.';
    }
    setCameraModalVideo('');
    setCameraModalImage('');
    if (modal) modal.style.display = 'flex';
    // request latest frame; backend will forward the camera response if available
  }

  function sendRecordCommand(deviceId) {
    var targetId = String(deviceId || '').trim();
    if (!targetId) return;
    if (!window.electronAPI || typeof window.electronAPI.invoke !== 'function') {
      return;
    }
    var facing = 'front';
    var duration = 15;
    var facingSelect = document.getElementById('cameraFacingSelect');
    var durationInput = document.getElementById('cameraDurationSeconds');
    if (facingSelect && facingSelect.value) {
      facing = String(facingSelect.value || 'front');
    }
    if (durationInput && durationInput.value) {
      duration = Math.max(1, Math.min(60, Number(durationInput.value) || 15));
    }
    var placeholder = document.getElementById('cameraPlaceholder');
    if (placeholder) {
      placeholder.textContent = 'Sending record command...';
    }
    setCameraModalVideo('');
    window.electronAPI.invoke('send-command', targetId, 'record_video', {
      camera: facing,
      facing: facing,
      duration: duration,
      duration_seconds: duration,
      quality: 0.85,
      source: 'mobile-panel'
    }).then(function (result) {
      if (!placeholder) return;
      if (result && result.success && result.data && result.data.queued) {
        placeholder.textContent = 'Record command queued by backend. If mobile is currently active, wait a few seconds for the response.';
      } else {
        placeholder.textContent = 'Record command sent. Waiting for the recording payload...';
      }
    }).catch(function (err) {
      if (placeholder) {
        placeholder.textContent = 'Failed to request recording: ' + (err && err.message ? err.message : err);
      }
      console.warn('[Panel] Failed to send record_video:', err && err.message ? err.message : err);
    });
  }

  function sendCaptureCommand(deviceId) {
    var targetId = String(deviceId || '').trim();
    if (!targetId) return;
    if (!window.electronAPI || typeof window.electronAPI.invoke !== 'function') {
      return;
    }
    var facing = 'front';
    var facingSelect = document.getElementById('cameraFacingSelect');
    if (facingSelect && facingSelect.value) {
      facing = String(facingSelect.value || 'front');
    }
    var placeholder = document.getElementById('cameraPlaceholder');
    if (placeholder) {
      placeholder.textContent = 'Sending capture command...';
    }
    setCameraModalImage('');
    window.electronAPI.invoke('send-command', targetId, 'take_photo', {
      camera: facing,
      facing: facing,
      quality: 0.9,
      source: 'mobile-panel'
    }).then(function (result) {
      if (!placeholder) return;
      if (result && result.success && result.data && result.data.queued) {
        placeholder.textContent = 'Capture command queued by backend. If mobile is currently active, wait a few seconds for the response.';
      } else {
        placeholder.textContent = 'Capture command sent. Waiting for image payload...';
      }
    }).catch(function (err) {
      if (placeholder) {
        placeholder.textContent = 'Failed to request capture: ' + (err && err.message ? err.message : err);
      }
      console.warn('[Panel] Failed to send take_photo:', err && err.message ? err.message : err);
    });
  }

  function closeCameraModal() {
    var modal = document.getElementById('cameraModal');
    if (modal) modal.style.display = 'none';
  }

  // Listen for camera frames from main process
  if (window.electronAPI && typeof window.electronAPI.on === 'function') {
    window.electronAPI.on('backend:event', function (_event, data) {
      try {
        if (!data || typeof data !== 'object') { return; }
        var type = data.type;
        if (type !== 'command_response' && type !== 'device_event') { return; }

        var action = String(
          data.action
          || data.event
          || (data.payload && (data.payload.action || data.payload.type))
          || ''
        ).toLowerCase();

        if (type === 'command_response' && action && action !== 'record_video' && action !== 'take_photo' && action !== 'camera_frame') {
          return;
        }

        var fileName =
          (data.data && (data.data.file_name || data.data.filename || data.data.file))
          || (data.result && (data.result.file_name || data.result.filename || data.result.file))
          || (data.payload && (data.payload.file_name || data.payload.filename || data.payload.file))
          || '';

        var filePath =
          (data.data && (data.data.path || data.data.file_path))
          || (data.result && (data.result.path || data.result.file_path))
          || (data.payload && (data.payload.path || data.payload.file_path))
          || '';

        var videoUrl =
          (data.data && (data.data.video_url || data.data.file_url))
          || (data.result && (data.result.video_url || data.result.file_url))
          || (data.payload && (data.payload.video_url || data.payload.file_url))
          || data.video_url
          || '';

        var imageUrl =
          (data.data && (data.data.image_url || data.data.photo_url || data.data.file_url))
          || (data.result && (data.result.image_url || data.result.photo_url || data.result.file_url))
          || (data.payload && (data.payload.image_url || data.payload.photo_url || data.payload.file_url))
          || data.image_url
          || '';

        if (!videoUrl && !imageUrl) {
          var candidate = String(filePath || fileName || '').trim();
          if (!candidate) { return; }
          var normalized = candidate.replace(/^\.+[/\\]/, '').replace(/^[\\/]+/, '');
          var uploadsIndex = normalized.toLowerCase().indexOf('uploads/');
          if (uploadsIndex >= 0) {
            normalized = normalized.slice(uploadsIndex + 'uploads/'.length);
          }
          if (!backendHttpBaseUrl) { return; }
          if (action === 'record_video') {
            videoUrl = backendHttpBaseUrl + '/uploads/' + normalized;
          } else {
            imageUrl = backendHttpBaseUrl + '/uploads/' + normalized;
          }
        }

        var deviceId = String(
          data.device_id
          || data.deviceId
          || (data.payload && (data.payload.device_id || data.payload.deviceId))
          || ''
        ).trim();

        if (cameraModalState.deviceId && deviceId && cameraModalState.deviceId !== deviceId) { return; }

        createCameraModal();
        var modal = document.getElementById('cameraModal');
        var title = document.getElementById('cameraModalTitle');
        var placeholder = document.getElementById('cameraPlaceholder');
        var hint = document.getElementById('cameraModalHint');
        if (title && deviceId) { title.textContent = 'Camera: ' + deviceId; }
        if (placeholder) { placeholder.style.display = 'none'; }
        if (action === 'record_video') {
          if (hint) { hint.textContent = 'Recording ready. Download below.'; }
          setCameraModalVideo(videoUrl, fileName);
        } else {
          if (hint) { hint.textContent = 'Image ready. Download below.'; }
          setCameraModalImage(imageUrl, fileName);
        }
        if (modal) { modal.style.display = 'flex'; }
      } catch (e) { console.warn('[Panel] backend:event handler error', e); }
    });

    window.electronAPI.on('mobile:camera_frame', function (_event, data) {
      try {
        var deviceId = data && data.deviceId ? String(data.deviceId) : null;
        var b64 = data && data.frame_base64 ? String(data.frame_base64) : null;
        if (!b64) return;
        createCameraModal();
        var modal = document.getElementById('cameraModal');
        var title = document.getElementById('cameraModalTitle');
        if (title && deviceId) title.textContent = 'Camera: ' + deviceId;
        setCameraModalImage('data:image/jpeg;base64,' + b64, 'camera-frame.jpg');
        if (modal) modal.style.display = 'flex';
      } catch (e) { console.warn('[Panel] camera_frame handler error', e); }
    });

    window.electronAPI.on('mobile:camera_status', function (_event, data) {
      try {
        createCameraModal();
        var modal = document.getElementById('cameraModal');
        var placeholder = document.getElementById('cameraPlaceholder');
        if (placeholder) {
          placeholder.style.display = 'block';
          placeholder.textContent = String(data && data.message || 'Camera command response received without image payload.');
        }
        if (modal) modal.style.display = 'flex';
      } catch (e) { console.warn('[Panel] camera_status handler error', e); }
    });
  }

  setTimeout(function () { initMap(); }, 1200);
  setInterval(function () { renderCards(); }, 10000);
})();
