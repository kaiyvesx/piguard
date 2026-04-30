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

  var getEl = shared.getEl || function (id) { return document.getElementById(id); };
  var toNum = shared.toNum || function (v) { var n = Number(v); return Number.isFinite(n) ? n : null; };
  var getDeviceId = shared.getDeviceId || function (v) { if (!v) { return ""; } return String(v.deviceId || v.device_id || "").trim(); };
  var safeTs = shared.safeTs || function (ts) { return new Date(ts != null ? ts : Date.now()).toISOString(); };
  var friendlyName = shared.friendlyName || function (deviceId) { return deviceId ? String(deviceId) : "Unknown"; };
  var lastSeenText = shared.lastSeenText || function () { return "unknown"; };
  var isActive = shared.isActive || function () { return false; };
  var colorFromIndex = shared.colorFromIndex || function (idx) { return "hsl(" + ((idx * 47) % 360) + ",72%,54%)"; };

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
    if (!deviceId) { return null; }
    var existing = devices.get(deviceId) || { deviceId: deviceId, userId: null, status: "known", lastSeen: null, lat: null, lng: null };
    var merged = Object.assign({}, existing, patch, { deviceId: deviceId, lastSeen: safeTs((patch && patch.lastSeen) || existing.lastSeen || Date.now()) });
    var lat = toNum(merged.lat != null ? merged.lat : merged.latitude);
    var lng = toNum(merged.lng != null ? merged.lng : merged.longitude);
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
      var active = isActive(device.lastSeen);
      var coords = (toNum(device.lat) != null && toNum(device.lng) != null) ? toNum(device.lat).toFixed(5) + ", " + toNum(device.lng).toFixed(5) : "No coordinates";
      var isExpanded = expandedDeviceId === device.deviceId;
      return "<article class=\"tracking-device-card " + (active ? "is-online" : "is-offline") + " " + (selectedDeviceId === device.deviceId ? "is-selected" : "") + "\" data-device-id=\"" + device.deviceId + "\" style=\"border-left-color:" + layer.color + ";\">"
        + "<div class=\"tracking-device-top\"><div class=\"tracking-device-id\" title=\"" + device.deviceId + "\">" + friendlyName(device.deviceId) + "</div><div class=\"tracking-status-wrap\"><span class=\"tracking-status-dot " + (active ? "online" : "offline") + "\" style=\"background:" + layer.color + ";\"></span><span>" + (active ? "active" : "inactive") + "</span></div></div>"
        + "<div class=\"tracking-device-meta\">Device: " + device.deviceId + "<br/>Seen: " + lastSeenText(device.lastSeen) + "<br/>Coords: " + coords + "</div>"
        + "<div class=\"tracking-device-actions\">"
        + "<button type=\"button\" class=\"tracking-action-btn tracking-action-toggle\" data-action=\"toggle_actions\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;width:100%;\">Actions " + (isExpanded ? "&#9650;" : "&#9660;") + "</button>"
        + "<div class=\"tracking-device-dropdown\" style=\"margin-top:6px;display:" + (isExpanded ? "grid" : "none") + ";gap:6px;\">"
        + "<button type=\"button\" class=\"tracking-action-btn\" data-action=\"show_camera\" data-device-id=\"" + device.deviceId + "\" style=\"display:block;\">Show Camera</button>"
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
    if (!id) { return; }
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
    if (!id) { return; }
    mergeDevice(id, { status: "inactive", lastSeen: data.lastSeen || Date.now() });
    renderCards();
    emitSidebarSnapshot();
  }

  function handleLocation(data) {
    var id = getDeviceId(data);
    if (!id) { return; }
    var lat = toNum(data.latitude != null ? data.latitude : data.lat);
    var lng = toNum(data.longitude != null ? data.longitude : data.lng);
    var timestamp = data.timestamp || Date.now();
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
    if (!rows.length) { renderCards(); renderGpsLog(); return; }
    rows.forEach(function (item) {
      var id = getDeviceId(item);
      if (!id) { return; }
      var lastLocation = item.last_location || item.lastLocation || null;
      var lat = item.lat != null ? item.lat : (item.latitude != null ? item.latitude : (item.last_lat != null ? item.last_lat : (lastLocation ? lastLocation.lat || lastLocation.latitude : null)));
      var lng = item.lng != null ? item.lng : (item.longitude != null ? item.longitude : (item.last_lng != null ? item.last_lng : (lastLocation ? lastLocation.lng || lastLocation.longitude : null)));
      var merged = mergeDevice(id, { userId: item.userId || item.user_id || null, status: item.status || "known", lat: lat, lng: lng, lastSeen: item.lastSeen || item.last_seen || Date.now() });
      updateMapForDevice(merged);
    });
    if (!selectedDeviceId && rows.length) {
      var firstId = getDeviceId(rows[0]);
      if (firstId) {
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
          window.electronAPI.invoke("send-command", deviceId, action, {}).catch(function (err) {
            console.warn("[Panel] Failed to send " + action + ":", err && err.message ? err.message : err);
          });
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

  setTimeout(function () { initMap(); }, 1200);
  setInterval(function () { renderCards(); }, 10000);
})();
