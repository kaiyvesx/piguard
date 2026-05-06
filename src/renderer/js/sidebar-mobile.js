(function () {
  if (window.__piguardSidebarMobileHttpBootstrapped) {
    return;
  }
  window.__piguardSidebarMobileHttpBootstrapped = true;

  var shared = window.PiguardMobileShared || {};
  var deviceColor = new Map();
  var deviceMap = new Map();
  var gpsEvents = [];
  var devicesLoading = true;
  var gpsLoading = true;
  var listenersRegistered = false;

  var getEl = shared.getEl || function (id) { return document.getElementById(id); };
  var toNum = shared.toNum || function (v) { var n = Number(v); return Number.isFinite(n) ? n : null; };
  var getDeviceId = shared.getDeviceId || function (v) { if (!v) { return ""; } return String(v.deviceId || v.device_id || "").trim(); };
  var safeTs = shared.safeTs || function (ts) { return new Date(ts != null ? ts : Date.now()).toISOString(); };
  var friendlyName = shared.friendlyName || function (deviceId) { return deviceId ? String(deviceId) : "Unknown"; };
  var lastSeenText = shared.lastSeenText || function () { return "unknown"; };
  var isActive = shared.isActive || function () { return false; };
  var colorFromIndex = shared.colorFromIndex || function (idx) { return "hsl(" + ((idx * 47) % 360) + ",72%,54%)"; };

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getDeviceSkeletonMarkup() {
    return "<div class=\"tracking-sidebar-skeleton\" aria-hidden=\"true\">"
      + "<div class=\"tracking-sidebar-skeleton-line w-55\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-90\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-70\"></div>"
      + "</div>"
      + "<div class=\"tracking-sidebar-skeleton\" aria-hidden=\"true\">"
      + "<div class=\"tracking-sidebar-skeleton-line w-48\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-88\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-62\"></div>"
      + "</div>";
  }

  function getGpsSkeletonMarkup() {
    return "<div class=\"tracking-sidebar-skeleton\" aria-hidden=\"true\">"
      + "<div class=\"tracking-sidebar-skeleton-line w-44\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-74\"></div>"
      + "</div>"
      + "<div class=\"tracking-sidebar-skeleton\" aria-hidden=\"true\">"
      + "<div class=\"tracking-sidebar-skeleton-line w-51\"></div>"
      + "<div class=\"tracking-sidebar-skeleton-line w-67\"></div>"
      + "</div>";
  }

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

  function colorFor(deviceId) {
    if (deviceColor.has(deviceId)) { return deviceColor.get(deviceId); }
    var idx = deviceColor.size;
    var color = colorFromIndex(idx);
    deviceColor.set(deviceId, color);
    return color;
  }

  function mergeDevice(deviceId, patch) {
    if (!deviceId || isRaspiDeviceId(deviceId)) { return null; }
    var existing = deviceMap.get(deviceId) || { deviceId: deviceId, status: "known", lastSeen: null, lat: null, lng: null, userId: null };
    var merged = Object.assign({}, existing, patch, { deviceId: deviceId, lastSeen: safeTs((patch && patch.lastSeen) || existing.lastSeen || Date.now()) });
    merged.lat = toNum(merged.lat != null ? merged.lat : merged.latitude);
    merged.lng = toNum(merged.lng != null ? merged.lng : merged.longitude);
    if (!isValidLocation(merged.lat, merged.lng)) {
      merged.lat = existing.lat;
      merged.lng = existing.lng;
    }
    deviceMap.set(deviceId, merged);
    return merged;
  }

  function renderPresence() {
    var online = 0; var offline = 0;
    deviceMap.forEach(function (device) { if (isDeviceOnline(device)) { online += 1; } else { offline += 1; } });
    var onlineEl = getEl("mobileSidebarOnlineCount");
    var offlineEl = getEl("mobileSidebarOfflineCount");
    var summaryEl = getEl("mobileSidebarPresenceSummary");
    if (onlineEl) { onlineEl.textContent = String(online); }
    if (offlineEl) { offlineEl.textContent = String(offline); }
    if (summaryEl) { summaryEl.textContent = deviceMap.size + " devices tracked"; }
  }

  function renderDevices() {
    var list = getEl("mobileSidebarDevicesList");
    if (!list) { return; }
    if (devicesLoading) {
      list.innerHTML = getDeviceSkeletonMarkup();
      renderPresence();
      return;
    }
    var rows = Array.from(deviceMap.values()).sort(function (a, b) { return new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0); });
    if (!rows.length) {
      list.innerHTML = "<div class=\"tracking-sidebar-location-empty\">Waiting for mobile devices...</div>";
      renderPresence();
      return;
    }
    list.innerHTML = rows.map(function (device) {
      var dot = colorFor(device.deviceId);
      var coords = (toNum(device.lat) != null && toNum(device.lng) != null) ? toNum(device.lat).toFixed(5) + ", " + toNum(device.lng).toFixed(5) : "No coordinates";
      return "<div class=\"tracking-sidebar-location-line\" style=\"border-left-color:" + dot + ";\"><div><span style=\"display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:" + dot + ";\"></span><strong>" + escapeHtml(friendlyName(device.deviceId)) + "</strong></div><div style=\"opacity:.82;margin-top:2px;\">Status: " + (isDeviceOnline(device) ? "active" : "inactive") + " | Seen: " + escapeHtml(lastSeenText(device.lastSeen)) + "</div><div style=\"opacity:.82;\">Coords: " + escapeHtml(coords) + "</div></div>";
    }).join("");
    renderPresence();
  }

  function renderGpsLog() {
    var list = getEl("mobileSidebarGpsLogList");
    if (!list) { return; }
    if (gpsLoading) {
      list.innerHTML = getGpsSkeletonMarkup();
      return;
    }
    if (!gpsEvents.length) {
      list.innerHTML = "<div class=\"tracking-sidebar-location-empty\">No GPS entries yet.</div>";
      return;
    }
    list.innerHTML = gpsEvents.slice(0, 10).map(function (item) {
      var dot = colorFor(item.deviceId);
      if (!isValidLocation(item.latitude, item.longitude)) { return ""; }
      return "<div class=\"tracking-sidebar-location-line\" style=\"border-left-color:" + dot + ";\"><div>[" + escapeHtml(new Date(item.timestamp || Date.now()).toLocaleTimeString()) + "] [" + escapeHtml(friendlyName(item.deviceId)) + "]</div><div style=\"opacity:.84;\">[" + escapeHtml(item.latitude.toFixed(5)) + ", " + escapeHtml(item.longitude.toFixed(5)) + "]</div></div>";
    }).join("");
  }

  function handleDevicesList(payload) {
    devicesLoading = false;
    gpsLoading = false;
    var rows = Array.isArray(payload) ? payload : (payload && Array.isArray(payload.devices) ? payload.devices : []);
    if (!rows.length) { renderDevices(); return; }
    rows.forEach(function (item) {
      var id = getDeviceId(item);
      if (!id || isRaspiDeviceId(id)) { return; }
      var lat = item.lat != null ? item.lat : item.latitude;
      var lng = item.lng != null ? item.lng : item.longitude;
      if (!isValidLocation(toNum(lat), toNum(lng))) {
        lat = null;
        lng = null;
      }
      mergeDevice(id, { userId: item.userId || item.user_id || null, status: item.status || "known", lat: lat, lng: lng, lastSeen: item.lastSeen || item.last_seen || Date.now() });
      colorFor(id);
    });
    renderDevices();
  }

  function handleLocation(payload) {
    gpsLoading = false;
    var id = getDeviceId(payload);
    if (!id || isRaspiDeviceId(id)) { return; }
    var lat = toNum(payload && payload.latitude != null ? payload.latitude : payload && payload.lat);
    var lng = toNum(payload && payload.longitude != null ? payload.longitude : payload && payload.lng);
    if (!isValidLocation(lat, lng)) { return; }
    var ts = payload && payload.timestamp != null ? payload.timestamp : Date.now();
    var existing = deviceMap.get(id);
    if (existing && existing.lat === lat && existing.lng === lng) { return; }
    mergeDevice(id, { status: "active", lastSeen: ts, lat: lat, lng: lng, userId: payload && payload.userId || payload && payload.user_id || null });
    colorFor(id);
    if (lat != null && lng != null) {
      gpsEvents.unshift({ deviceId: id, latitude: lat, longitude: lng, timestamp: safeTs(ts) });
      if (gpsEvents.length > 10) { gpsEvents.length = 10; }
    }
    renderDevices();
    renderGpsLog();
  }

  function handleDeviceOnline(payload) {
    var id = getDeviceId(payload);
    if (!id || isRaspiDeviceId(id)) { return; }
    mergeDevice(id, { status: "active", lastSeen: payload && payload.connectedAt || Date.now(), userId: payload && payload.userId || payload && payload.user_id || null });
    colorFor(id);
    renderDevices();
  }

  function handleDeviceOffline(payload) {
    var id = getDeviceId(payload);
    if (!id || isRaspiDeviceId(id)) { return; }
    mergeDevice(id, { status: "inactive", lastSeen: payload && payload.lastSeen || Date.now() });
    renderDevices();
  }

  function registerElectronListeners() {
    if (listenersRegistered) { return; }
    if (!window.electronAPI) { console.error("[Sidebar] electronAPI missing"); return; }
    if (typeof window.electronAPI.on !== "function") { console.error("[Sidebar] electronAPI.on missing"); return; }
    listenersRegistered = true;
    window.electronAPI.on("mobile:devices_list", function (_event, data) { handleDevicesList(data || {}); });
    window.electronAPI.on("mobile:location", function (_event, data) { handleLocation(data || {}); });
    window.electronAPI.on("mobile:device_online", function (_event, data) { handleDeviceOnline(data || {}); });
    window.electronAPI.on("mobile:device_offline", function (_event, data) { handleDeviceOffline(data || {}); });
  }

  function registerPanelBridgeEvents() {
    window.addEventListener("piguard:mobile-devices", function (evt) {
      devicesLoading = false;
      var devices = evt && evt.detail && Array.isArray(evt.detail.devices) ? evt.detail.devices : [];
      handleDevicesList({ devices: devices });
    });
    window.addEventListener("piguard:mobile-gps-log", function (evt) {
      gpsLoading = false;
      var events = evt && evt.detail && Array.isArray(evt.detail.events) ? evt.detail.events : [];
      gpsEvents = events.slice(0, 10).map(function (item) {
        return {
          deviceId: String(item.deviceId || "").trim(),
          latitude: (toNum(item.latitude) != null) ? toNum(item.latitude) : null,
          longitude: (toNum(item.longitude) != null) ? toNum(item.longitude) : null,
          timestamp: safeTs(item.timestamp)
        };
      }).filter(function (it) { return it.latitude != null && it.longitude != null; });
      renderGpsLog();
    });
  }

  function loadCached() {
    if (!window.electronAPI || typeof window.electronAPI.invoke !== "function") { return; }
    window.electronAPI.invoke("get-cached-devices").then(function (result) {
      devicesLoading = false;
      gpsLoading = false;
      var rows = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      handleDevicesList({ devices: rows });
    }).catch(function (err) {
      devicesLoading = false;
      gpsLoading = false;
      console.warn("[Sidebar] Failed to load cached devices:", err && err.message ? err.message : err);
      renderDevices();
      renderGpsLog();
    });
  }

  function loadSupabaseDevices() {
    if (!window.electronAPI || typeof window.electronAPI.getSupabaseDevices !== "function") { return; }
    window.electronAPI.getSupabaseDevices().then(function (result) {
      devicesLoading = false;
      gpsLoading = false;
      var rows = Array.isArray(result) ? result : (result && Array.isArray(result.data) ? result.data : []);
      handleDevicesList({ devices: rows });
    }).catch(function (err) {
      devicesLoading = false;
      gpsLoading = false;
      console.warn("[Sidebar] Failed to load Supabase devices:", err && err.message ? err.message : err);
      renderDevices();
      renderGpsLog();
    });
  }

  registerElectronListeners();
  registerPanelBridgeEvents();
  loadCached();
  loadSupabaseDevices();
  renderDevices();
  renderGpsLog();
  setInterval(function () { renderDevices(); }, 12000);
})();
