(function () {
  const piApi = window.piBridge;
  const backendApi = window.backendBridge;

  // At least one API must be available
  if (!piApi && !backendApi) {
    console.error('No API bridge available');
    return;
  }

  // Backend connection state
  let backendConnected = false;
  let useBackend = false; // Set to true to prefer WebSocket backend over direct Pi HTTP

  // Initialize backend connection if available
  if (backendApi) {
    backendApi.connect()
      .then((result) => {
        if (result && result.success) {
          console.log('[API] Backend connected via WebSocket');
          backendConnected = true;
          // Update UI to show backend status
          updateBackendConnectionStatus(true);
        }
      })
      .catch((err) => {
        console.warn('[API] Backend connection failed, using Pi direct:', err.message);
        backendConnected = false;
      });

    // Listen for backend events
    backendApi.on('connected', () => {
      console.log('[API] Backend reconnected');
      backendConnected = true;
      updateBackendConnectionStatus(true);
    });

    backendApi.on('disconnected', () => {
      console.log('[API] Backend disconnected');
      backendConnected = false;
      updateBackendConnectionStatus(false);
    });

    backendApi.on('command_response', (data) => {
      console.log('[API] Command response:', data.action, data.status);
      // Handle real-time responses here if needed
      if (data && (data.action === 'tracking_approved' || data.action === 'tracking_rejected')) {
        const did = String(data.device_id || '').trim();
        if (did) {
          pendingTrackingRequests.delete(did);
          renderTrackingRequestBanners();
          if (data.action === 'tracking_rejected') {
            removeDeviceLocationLayer(did);
          }
        }
      }
    });

    backendApi.on('command_queued', (data) => {
      console.log('[API] Command queued (device offline):', data.action);
      // Show notification that device is offline
    });

    backendApi.on('device_event', (data) => {
      handleBackendDeviceEvent(data);
    });

    if (window.electronAPI && typeof window.electronAPI.on === 'function') {
      window.electronAPI.on('tracking:request', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_request' }));
      window.electronAPI.on('tracking:location', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'location_update' }));
      window.electronAPI.on('tracking:session_end', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_session_end' }));
      window.electronAPI.on('tracking:approved', (_evt, data) => {
        const did = String(data && data.device_id || '').trim();
        if (did) {
          pendingTrackingRequests.delete(did);
          renderTrackingRequestBanners();
        }
      });
      window.electronAPI.on('tracking:rejected', (_evt, data) => {
        const did = String(data && data.device_id || '').trim();
        if (did) {
          pendingTrackingRequests.delete(did);
          renderTrackingRequestBanners();
          removeDeviceLocationLayer(did);
        }
      });
    }
  }

  function updateBackendConnectionStatus(connected) {
    const backendStatusEl = document.getElementById('backendConnStatus');
    const backendDotEl = document.getElementById('backendStatusDot');
    if (backendStatusEl) {
      backendStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
      backendStatusEl.textContent = connected ? 'Backend Connected' : 'Backend Disconnected';
    }
    if (backendDotEl) {
      backendDotEl.style.background = connected ? 'var(--success)' : 'var(--danger)';
    }
  }

  // Unified API wrapper - tries backend first if enabled, falls back to Pi direct
  const api = {
    // Use Pi direct API by default, but can switch to backend
    detectBase: () => piApi ? piApi.detectBase() : Promise.reject(new Error('Pi API not available')),

    getStatus: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getDeviceInfo();
        } catch (err) {
          console.warn('[API] Backend getStatus failed:', err.message);
        }
      }
      return piApi ? piApi.getStatus() : Promise.reject(new Error('No API available'));
    },

    getGpsLatest: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getGps();
        } catch (err) {
          console.warn('[API] Backend getGps failed:', err.message);
        }
      }
      return piApi ? piApi.getGpsLatest() : Promise.reject(new Error('No API available'));
    },

    getGpsTrack: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getGpsTrack();
        } catch (err) {
          console.warn('[API] Backend getGpsTrack failed:', err.message);
        }
      }
      return piApi ? piApi.getGpsTrack() : Promise.reject(new Error('No API available'));
    },

    getCameras: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getCameras();
        } catch (err) {
          console.warn('[API] Backend getCameras failed:', err.message);
        }
      }
      return piApi ? piApi.getCameras() : Promise.reject(new Error('No API available'));
    },

    getCameraSnapshot: async (cameraIndex) => {
      // Camera snapshots still use Pi direct for binary data
      return piApi ? piApi.getCameraSnapshot(cameraIndex) : Promise.reject(new Error('No API available'));
    },

    getContacts: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getContacts();
        } catch (err) {
          console.warn('[API] Backend getContacts failed:', err.message);
        }
      }
      return piApi ? piApi.getContacts() : Promise.reject(new Error('No API available'));
    },

    getMessages: async () => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.getMessages();
        } catch (err) {
          console.warn('[API] Backend getMessages failed:', err.message);
        }
      }
      return piApi ? piApi.getMessages() : Promise.reject(new Error('No API available'));
    },

    sendSms: async (numbers, message) => {
      if (useBackend && backendConnected && backendApi) {
        try {
          return await backendApi.sendSms(numbers, message);
        } catch (err) {
          console.warn('[API] Backend sendSms failed:', err.message);
        }
      }
      return piApi ? piApi.sendSms(numbers, message) : Promise.reject(new Error('No API available'));
    },

    // New backend-only methods
    takePhoto: async (options) => {
      if (backendApi && backendConnected) {
        return await backendApi.takePhoto(options);
      }
      throw new Error('Backend not connected');
    },

    makeCall: async (number) => {
      if (backendApi && backendConnected) {
        return await backendApi.makeCall(number);
      }
      throw new Error('Backend not connected');
    },

    sendCommand: async (action, payload, deviceId) => {
      if (backendApi && backendConnected) {
        return await backendApi.sendCommand(action, payload, deviceId);
      }
      throw new Error('Backend not connected');
    },

    // Backend connection controls
    isBackendConnected: () => backendConnected,
    setUseBackend: (use) => { useBackend = use; },
    getUseBackend: () => useBackend,
    connectBackend: () => backendApi ? backendApi.connect() : Promise.reject(new Error('Backend API not available')),
    disconnectBackend: () => backendApi ? backendApi.disconnect() : null,
  };

  // Expose unified API globally for debugging
  window.unifiedApi = api;

  const connStatusEl = document.getElementById('piConnStatus');
  const gpsStatusEl = document.getElementById('gpsConnStatus');
  const piStatusDotEl = document.getElementById('piStatusDot');
  const gpsStatusDotEl = document.getElementById('gpsStatusDot');
  const contactsWrap = document.getElementById('smsContactsList');
  const messagesWrap = document.getElementById('smsMessagesArea');
  const composeInput = document.getElementById('smsComposeInput');
  const newMessageBtn = document.getElementById('smsNewMessageBtn');
  const openArchiveBtn = document.getElementById('smsOpenArchiveBtn');
  const addNumberBtn = document.getElementById('smsAddNumberBtn');
  const extraNumberRow = document.getElementById('smsExtraRow');
  const extraNumberInput = document.getElementById('smsExtraNumberInput');
  const extraNumberHint = document.getElementById('smsExtraHint');
  const sendBtn = document.getElementById('smsSendBtn');
  const smsBadgeEl = document.getElementById('smsBadge');
  const smsThreadAvatarEl = document.getElementById('smsThreadAvatar');
  const smsThreadNameEl = document.getElementById('smsThreadName');
  const smsThreadSubEl = document.getElementById('smsThreadSub');
  const cameraGrid = document.getElementById('cameraGrid');
  const cameraRefreshBtn = document.getElementById('cameraRefreshBtn');
  const cameraModeLiveBtn = document.getElementById('cameraModeLiveBtn');
  const cameraModeSnapshotBtn = document.getElementById('cameraModeSnapshotBtn');
  const cameraConnectionLabel = document.getElementById('cameraConnectionLabel');
  const cameraActionIndicator = document.getElementById('cameraActionIndicator');
  const cameraSlotBackdrop = document.getElementById('cameraSlotBackdrop');
  const cameraSlotMenu = document.getElementById('cameraSlotMenu');
  const cameraSlotMenuTarget = document.getElementById('cameraSlotMenuTarget');
  const cameraSlotMenuCloseBtn = document.getElementById('cameraSlotMenuCloseBtn');
  const cameraMenuRecordStartBtn = document.getElementById('cameraMenuRecordStartBtn');
  const cameraMenuRecordStopBtn = document.getElementById('cameraMenuRecordStopBtn');
  const cameraMenuPowerOffBtn = document.getElementById('cameraMenuPowerOffBtn');
  const cameraMenuPowerOnBtn = document.getElementById('cameraMenuPowerOnBtn');
  const cameraMenuCaptureBtn = document.getElementById('cameraMenuCaptureBtn');
  const cameraMenuIncidentBtn = document.getElementById('cameraMenuIncidentBtn');
  const cameraMenuAutoRecordChip = document.getElementById('cameraMenuAutoRecordChip');
  const cameraMenuAudioMuteChip = document.getElementById('cameraMenuAudioMuteChip');
  const cameraMenuNightVisionChip = document.getElementById('cameraMenuNightVisionChip');
  const cameraSidebarList = document.getElementById('cameraSidebarList');
  const cameraDetectedCountEl = document.getElementById('cameraDetectedCount');
  const cameraDetectedBarEl = document.getElementById('cameraDetectedBar');
  const cameraModeLabelEl = document.getElementById('cameraModeLabel');
  const cameraStreamStatusEl = document.getElementById('cameraStreamStatus');
  const cameraRecordingStateEl = document.getElementById('cameraRecordingState');
  const cameraRecordingActiveCountEl = document.getElementById('cameraRecordingActiveCount');
  const cameraRecordingListEl = document.getElementById('cameraRecordingList');
  const cameraRecordingLastActionEl = document.getElementById('cameraRecordingLastAction');
  const trackingRequestsEl = document.getElementById('trackingRequestsMobile') || document.getElementById('trackingRequestsSidebar') || document.getElementById('trackingRequests');
  const trackingDeviceRowsEl = document.getElementById('trackingDeviceRowsMobile') || document.getElementById('trackingDeviceRowsSidebar') || document.getElementById('trackingDeviceRows');
  const mobileTrackingStatusEl = document.getElementById('mobileTrackingStatus');

  let selectedNumber = null;
  let lastBase = null;
  let contacts = [];
  let manualContacts = [];
  const MANUAL_CONTACTS_KEY = 'pi-sms-manual-contacts';
  const ARCHIVED_CONTACTS_KEY = 'pi-sms-archived-contacts';
  const CONTACT_ALIASES_KEY = 'pi-sms-contact-aliases';
  let contactAliases = {};
  let archivedContacts = new Set();
  let archiveViewMode = false;
  let composeMultiMode = false;
  let selectedRecipients = new Set();
  let lastMessagesData = { sms: [] };
  let localOutgoingSms = [];
  let localOutgoingCounter = 0;
  let lastStatusData = null;
  let trackPolyline = null;
  let piCarMarker = null;
  let lastPanelData = null; // { gps, track, lat, lon, speed, satCount, locEl } for re-fill when panel opens
  let lastCameraData = { count: 0, cameras: [] };
  let cameraMode = 'live';
  let cameraPanelActive = false;
  let cameraRefreshInFlight = false;
  const cameraSnapshotIntervals = new Map();
  const cameraSnapshotRequests = new Map();
  const recordingCameraIndexes = new Set();
  let cameraMenuTargetIndex = 'all';
  let lastRecordingActionLabel = 'No recording command sent';
  const pendingTrackingRequests = new Map();
  const deviceLayers = new Map();
  const deviceColors = new Map();
  const colorOrder = ['#2196F3', '#4CAF50', '#FF9800'];

  function setConnectionState(connected, message, tooltip = '') {
    if (!connStatusEl) return;
    connStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
    connStatusEl.textContent = message;
    connStatusEl.title = tooltip || message;
    connStatusEl.style.cursor = tooltip ? 'help' : 'default';
    if (piStatusDotEl) piStatusDotEl.style.background = connected ? 'var(--success)' : 'var(--danger)';
  }

  function setGpsState(connected, message) {
    if (gpsStatusEl) {
      gpsStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
      gpsStatusEl.textContent = message;
    }
    if (gpsStatusDotEl) gpsStatusDotEl.style.background = connected ? 'var(--success)' : 'var(--danger)';
    const floatGpsEl = document.getElementById('floatGpsStatus');
    if (floatGpsEl) floatGpsEl.textContent = connected ? 'On' : 'Disconnected';
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getTrackingAction(event) {
    const payload = event && typeof event.payload === 'object' ? event.payload : {};
    return String(event?.action || event?.event || payload?.action || payload?.type || '').trim().toLowerCase();
  }

  function getTrackingDeviceId(event) {
    const payload = event && typeof event.payload === 'object' ? event.payload : {};
    return String(event?.device_id || payload?.device_id || '').trim();
  }

  function isMobileTrackingDevice(deviceId) {
    const id = String(deviceId || '').trim().toLowerCase();
    if (!id) return false;
    return id === '13e1b5b146eba495' || id.includes('mobile');
  }

  function getTrackingMap() {
    return window.mobileMap || (typeof map !== 'undefined' ? map : null);
  }

  function getDeviceColor(deviceId) {
    if (deviceColors.has(deviceId)) return deviceColors.get(deviceId);
    const id = String(deviceId || '').toLowerCase();
    let color = '#FF9800';
    if (id === '13e1b5b146eba495' || id.includes('mobile')) {
      color = '#2196F3';
    } else if (!Array.from(deviceColors.values()).includes('#4CAF50')) {
      color = '#4CAF50';
    } else {
      const index = deviceColors.size % colorOrder.length;
      color = colorOrder[index];
    }
    deviceColors.set(deviceId, color);
    return color;
  }

  function buildDeviceIcon(color, waiting = false) {
    const fill = waiting ? `${color}AA` : color;
    const border = waiting ? '2px dashed #fff' : '2px solid #fff';
    return L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${fill};border:${border};box-shadow:0 0 0 4px ${color}55,0 2px 8px rgba(0,0,0,.25);"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function renderTrackingRequestBanners() {
    if (!trackingRequestsEl) return;
    const items = Array.from(pendingTrackingRequests.values());
    if (!items.length) {
      trackingRequestsEl.innerHTML = '';
      return;
    }

    trackingRequestsEl.innerHTML = items.map((request) => `
      <div class="tracking-request-card" data-device-id="${escapeHtml(request.device_id)}" style="background:rgba(10,22,40,.9);border:1px solid rgba(0,200,255,.35);border-radius:10px;padding:10px 12px;box-shadow:0 6px 16px rgba(0,0,0,.25);">
        <div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Tracking request</div>
        <div style="font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:2px;">${escapeHtml(request.device_id)}</div>
        <div style="font-size:.68rem;color:var(--muted);margin-bottom:8px;">Requested at: ${escapeHtml(request.requested_at)}</div>
        <div style="display:flex;gap:8px;justify-content:flex-end;">
          <button type="button" class="tracking-reject-btn" data-device-id="${escapeHtml(request.device_id)}" style="height:30px;padding:0 10px;border-radius:8px;border:1px solid var(--card-border);background:var(--surface-1);color:var(--text);cursor:pointer;">Deny</button>
          <button type="button" class="tracking-accept-btn" data-device-id="${escapeHtml(request.device_id)}" style="height:30px;padding:0 10px;border-radius:8px;border:1px solid #2196F3;background:#2196F3;color:#fff;cursor:pointer;font-weight:700;">Accept</button>
        </div>
      </div>
    `).join('');

    trackingRequestsEl.querySelectorAll('.tracking-accept-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        void respondToTrackingRequestById(btn.getAttribute('data-device-id'), true);
      });
    });
    trackingRequestsEl.querySelectorAll('.tracking-reject-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        void respondToTrackingRequestById(btn.getAttribute('data-device-id'), false);
      });
    });
  }

  async function respondToTrackingRequestById(deviceId, approved) {
    const targetDeviceId = String(deviceId || '').trim();
    if (!targetDeviceId) return;
    const action = approved ? 'tracking_approved' : 'tracking_rejected';
    const payload = approved
      ? { approved_by: 'electron-admin', approved_at: new Date().toISOString() }
      : { reason: 'Permission denied by admin', denied_at: new Date().toISOString() };

    try {
      await api.sendCommand(action, payload, targetDeviceId);
      pendingTrackingRequests.delete(targetDeviceId);
      renderTrackingRequestBanners();
      if (approved) {
        ensureDevicePlaceholderLayer(targetDeviceId);
      }
    } catch (err) {
      const reason = err && err.message ? err.message : 'Failed to send decision';
      alert(`Failed to send ${action}: ${reason}`);
    }
  }

  function ensureDevicePlaceholderLayer(deviceId) {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return;
    const targetDeviceId = String(deviceId || '').trim();
    if (!targetDeviceId || deviceLayers.has(targetDeviceId)) return;

    const center = trackingMap.getCenter();
    const lat = Number(center.lat);
    const lon = Number(center.lng);
    const color = getDeviceColor(targetDeviceId);
    const marker = L.marker([lat, lon], { icon: buildDeviceIcon(color, true) }).addTo(trackingMap);
    const routeLine = L.polyline([], { color, weight: 3, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(trackingMap);
    marker.bindTooltip(`${targetDeviceId} (waiting for first GPS fix)`, { direction: 'top', offset: [0, -12] });

    deviceLayers.set(targetDeviceId, {
      marker,
      routeLine,
      routePoints: [],
      color,
      waiting: true,
      lastLat: null,
      lastLon: null,
      lastUpdate: null,
    });
    updateTrackingCoordsRows();
    fitMapToAllTrackingDevices();
  }

  function updateTrackingCoordsRows() {
    if (!trackingDeviceRowsEl) return;
    const rows = Array.from(deviceLayers.entries());
    if (!rows.length) {
      trackingDeviceRowsEl.innerHTML = '<tr><td colspan="4" style="padding:6px;color:var(--muted);">No active tracked mobile device.</td></tr>';
      if (mobileTrackingStatusEl) mobileTrackingStatusEl.textContent = 'No active mobile tracking.';
      return;
    }

    trackingDeviceRowsEl.innerHTML = rows.map(([deviceId, layer]) => {
      const lat = Number.isFinite(Number(layer.lastLat)) ? Number(layer.lastLat).toFixed(6) : '-';
      const lon = Number.isFinite(Number(layer.lastLon)) ? Number(layer.lastLon).toFixed(6) : '-';
      const lastUpdate = layer.lastUpdate ? fmtTime(layer.lastUpdate) : '-';
      return `<tr>
        <td style="padding:4px 6px;white-space:nowrap;">${escapeHtml(deviceId)}</td>
        <td style="padding:4px 6px;">${escapeHtml(lat)}</td>
        <td style="padding:4px 6px;">${escapeHtml(lon)}</td>
        <td style="padding:4px 6px;">${escapeHtml(lastUpdate)}</td>
      </tr>`;
    }).join('');

    if (mobileTrackingStatusEl) {
      const activeCount = rows.length;
      mobileTrackingStatusEl.textContent = `${activeCount} active mobile device${activeCount === 1 ? '' : 's'}.`;
    }
  }

  function fitMapToAllTrackingDevices() {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return;
    const points = Array.from(deviceLayers.values())
      .filter((layer) => layer && layer.marker)
      .map((layer) => layer.marker.getLatLng());
    if (!points.length) return;
    if (points.length === 1) {
      trackingMap.setView(points[0], Math.max(trackingMap.getZoom(), 15), { animate: true });
      return;
    }
    trackingMap.fitBounds(L.latLngBounds(points), { padding: [36, 36], maxZoom: 16, animate: true });
  }

  function upsertDeviceLocationLayer(event) {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return;
    const deviceId = getTrackingDeviceId(event);
    if (!deviceId) return;
    if (!isMobileTrackingDevice(deviceId)) return;

    const payload = event && typeof event.payload === 'object' ? event.payload : {};
    const nested = payload && typeof payload.payload === 'object' ? payload.payload : null;
    const source = payload.latitude != null || payload.longitude != null
      ? payload
      : (nested && (nested.latitude != null || nested.longitude != null) ? nested : event);

    const lat = toNum(source.latitude != null ? source.latitude : source.lat);
    const lon = toNum(source.longitude != null ? source.longitude : source.lng);
    if (lat == null || lon == null) return;

    const color = getDeviceColor(deviceId);
    let layer = deviceLayers.get(deviceId);
    if (!layer) {
      const icon = buildDeviceIcon(color, false);
      const marker = L.marker([lat, lon], { icon }).addTo(trackingMap);
      const routeLine = L.polyline([], { color, weight: 3, opacity: 0.9, lineCap: 'round', lineJoin: 'round' }).addTo(trackingMap);
      layer = { marker, routeLine, routePoints: [], color, waiting: false, lastLat: lat, lastLon: lon, lastUpdate: source.timestamp || event.received_at || Date.now() };
      deviceLayers.set(deviceId, layer);
    } else if (layer.waiting) {
      layer.marker.setIcon(buildDeviceIcon(layer.color || color, false));
      layer.waiting = false;
    }

    layer.lastLat = lat;
    layer.lastLon = lon;
    layer.lastUpdate = source.timestamp || event.received_at || Date.now();
    layer.routePoints.push([lat, lon]);
    layer.marker.setLatLng([lat, lon]);
    layer.routeLine.setLatLngs(layer.routePoints);
    layer.marker.bindTooltip(`${deviceId}`, { direction: 'top', offset: [0, -12] });

    const mobileCoordsEl = document.getElementById('mobileGpsCoords');
    if (mobileCoordsEl) mobileCoordsEl.textContent = `${deviceLayers.size} active mobile device(s)`;

    updateTrackingCoordsRows();
    fitMapToAllTrackingDevices();
  }

  function removeDeviceLocationLayer(deviceId) {
    const trackingMap = getTrackingMap();
    const target = String(deviceId || '').trim();
    if (!target) return;
    const layer = deviceLayers.get(target);
    if (!layer) return;
    if (layer.marker && trackingMap) trackingMap.removeLayer(layer.marker);
    if (layer.routeLine && trackingMap) trackingMap.removeLayer(layer.routeLine);
    deviceLayers.delete(target);
    const mobileCoordsEl = document.getElementById('mobileGpsCoords');
    if (mobileCoordsEl && deviceLayers.size === 0) mobileCoordsEl.textContent = 'No active mobile tracking';
    updateTrackingCoordsRows();
    fitMapToAllTrackingDevices();
  }

  function handleBackendDeviceEvent(event) {
    if (!event || typeof event !== 'object') return;
    const action = getTrackingAction(event);
    const deviceId = getTrackingDeviceId(event);
    if (!action || !deviceId) return;
    if (!isMobileTrackingDevice(deviceId)) return;

    if (action === 'tracking_request') {
      const payload = event && typeof event.payload === 'object' ? event.payload : {};
      pendingTrackingRequests.set(deviceId, {
        device_id: deviceId,
        requested_at: payload?.payload?.requested_at || payload?.requested_at || new Date().toISOString(),
      });
      renderTrackingRequestBanners();
      return;
    }

    if (action === 'location_update') {
      upsertDeviceLocationLayer(event);
      return;
    }

    if (action === 'tracking_session_end') {
      pendingTrackingRequests.delete(deviceId);
      renderTrackingRequestBanners();
      removeDeviceLocationLayer(deviceId);
    }
  }

  // --- reverse geocoding (Nominatim, cached) ---
  const _geocodeCache = new Map();
  const _geocodePendingByKey = new Map();

  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (_geocodeCache.has(key)) return _geocodeCache.get(key);
    if (_geocodePendingByKey.has(key)) return _geocodePendingByKey.get(key);

    const request = (async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const data = await res.json();
      const a = data.address || {};
      // Build a short human-readable label: road/suburb, city, province
      const parts = [
        a.road || a.neighbourhood || a.hamlet || a.village || '',
        a.city || a.town || a.municipality || a.county || '',
        a.state || a.province || ''
      ].filter(Boolean);
      const label = parts.length ? parts.join(', ') : (data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      _geocodeCache.set(key, label);
      return label;
    } catch { return null; }
    finally { _geocodePendingByKey.delete(key); }
    })();

    _geocodePendingByKey.set(key, request);
    return request;
  }

  function pickInitials(name) {
    const clean = String(name || '').trim();
    if (!clean) return '??';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function getDisplayName(number, fallbackName = '') {
    const key = String(number || '').trim();
    if (!key) return String(fallbackName || '').trim() || 'No contact selected';
    const alias = (contactAliases[key] || '').trim();
    return alias || String(fallbackName || key).trim();
  }

  function setSelectedNumber(number) {
    selectedNumber = number;

    const activeEls = contactsWrap ? contactsWrap.querySelectorAll('.contact-item') : [];
    activeEls.forEach((el) => {
      const isActive = el.getAttribute('data-number') === number;
      el.classList.toggle('active', isActive);
    });

    const c = contacts.find((item) => String(item.number || '') === String(number || ''));
    const baseName = c && c.name ? String(c.name) : (number ? String(number) : 'No contact selected');
    const labelName = number ? getDisplayName(number, baseName) : baseName;
    if (smsThreadAvatarEl) smsThreadAvatarEl.textContent = pickInitials(labelName);
    if (smsThreadNameEl) smsThreadNameEl.textContent = labelName;
    if (smsThreadSubEl) {
      smsThreadSubEl.textContent = number ? `${number} -+ Pi backend SMS` : 'Select a contact to view messages';
    }

    renderMessages(lastMessagesData);
  }

  function loadArchivedContacts() {
    try {
      const raw = localStorage.getItem(ARCHIVED_CONTACTS_KEY);
      if (!raw) return new Set();
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(
        parsed
          .map((item) => String(item || '').trim())
          .filter(Boolean)
      );
    } catch {
      return new Set();
    }
  }

  function saveArchivedContacts() {
    try {
      localStorage.setItem(ARCHIVED_CONTACTS_KEY, JSON.stringify(Array.from(archivedContacts)));
    } catch {
      // ignore storage write errors
    }
  }

  function isArchivedNumber(number) {
    return archivedContacts.has(String(number || '').trim());
  }

  function getVisibleContacts() {
    return contacts.filter((item) => {
      const key = String(item && item.number || '').trim();
      if (!key) return false;
      return archiveViewMode ? isArchivedNumber(key) : !isArchivedNumber(key);
    });
  }

  function updateArchiveButtonUi() {
    if (!openArchiveBtn) return;
    openArchiveBtn.classList.toggle('active', archiveViewMode);
    openArchiveBtn.textContent = archiveViewMode ? 'Back to Inbox' : 'Archived';
  }

  function updateNewMessageButtonUi() {
    if (!newMessageBtn) return;
    newMessageBtn.classList.toggle('active', composeMultiMode);
    newMessageBtn.textContent = composeMultiMode ? 'Cancel new message' : 'New message';
  }

  function updateComposeThreadUi() {
    if (!composeMultiMode) return;
    const count = selectedRecipients.size;
    if (smsThreadAvatarEl) smsThreadAvatarEl.textContent = 'NM';
    if (smsThreadNameEl) smsThreadNameEl.textContent = count ? `New message (${count})` : 'New message';
    if (smsThreadSubEl) {
      smsThreadSubEl.textContent = count
        ? `Recipients selected: ${count}. Type your message and send.`
        : 'Select contacts or add a number, then send.';
    }
  }

  function enterMultiComposeMode() {
    composeMultiMode = true;
    selectedRecipients = new Set();
    if (selectedNumber) selectedRecipients.add(String(selectedNumber).trim());
    if (extraNumberRow) extraNumberRow.removeAttribute('hidden');
    if (addNumberBtn) addNumberBtn.classList.add('active');
    updateNewMessageButtonUi();
    renderContacts();
    updateComposeThreadUi();
    if (composeInput) composeInput.focus();
  }

  function exitMultiComposeMode() {
    composeMultiMode = false;
    selectedRecipients = new Set();
    if (extraNumberRow) extraNumberRow.setAttribute('hidden', '');
    if (extraNumberInput) extraNumberInput.value = '';
    if (extraNumberHint) {
      extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
      extraNumberHint.className = 'sms-extra-hint';
    }
    if (addNumberBtn) {
      addNumberBtn.classList.remove('active');
      addNumberBtn.classList.remove('added');
    }
    updateNewMessageButtonUi();
    renderContacts();
    setSelectedNumber(selectedNumber || (contacts[0] && contacts[0].number) || null);
  }

  function toggleComposeRecipient(number) {
    const key = String(number || '').trim();
    if (!key) return;
    if (selectedRecipients.has(key)) selectedRecipients.delete(key);
    else selectedRecipients.add(key);
    renderContacts();
    updateComposeThreadUi();
  }

  function toggleArchiveForNumber(number) {
    const key = String(number || '').trim();
    if (!key) return;
    if (archivedContacts.has(key)) archivedContacts.delete(key);
    else archivedContacts.add(key);
    saveArchivedContacts();
    renderContacts();

    const visible = getVisibleContacts();
    const stillVisible = visible.some((item) => String(item.number || '').trim() === String(selectedNumber || '').trim());
    if (!stillVisible) {
      const next = visible[0] ? String(visible[0].number || '').trim() : null;
      if (next) setSelectedNumber(next);
      else {
        selectedNumber = null;
        renderMessages(lastMessagesData);
      }
    }
  }

  function toggleArchiveView() {
    archiveViewMode = !archiveViewMode;
    updateArchiveButtonUi();
    renderContacts();

    const visible = getVisibleContacts();
    const selectedVisible = visible.some((item) => String(item.number || '').trim() === String(selectedNumber || '').trim());
    if (!selectedVisible) {
      const next = visible[0] ? String(visible[0].number || '').trim() : null;
      if (next) setSelectedNumber(next);
      else {
        selectedNumber = null;
        renderMessages(lastMessagesData);
      }
    }
  }

  function renderContacts() {
    if (!contactsWrap || !Array.isArray(contacts)) return;

    const visibleContacts = getVisibleContacts();

    if (!visibleContacts.length) {
      contactsWrap.innerHTML = `<div style="padding:12px 14px;color:var(--muted);font-size:.72rem">${archiveViewMode ? 'No archived threads yet.' : 'No contacts or message threads yet.'}</div>`;
      return;
    }

    const activeNumber = selectedNumber || (visibleContacts[0] && visibleContacts[0].number) || '';
    contactsWrap.innerHTML = visibleContacts.map((c) => {
      const name = escapeHtml(getDisplayName(c.number, c.name || 'Unnamed'));
      const number = escapeHtml(c.number || '');
      const preview = escapeHtml(getLatestMessagePreview(c.number));
      const initials = escapeHtml(pickInitials(getDisplayName(c.number, c.name)));
      const isRecipient = selectedRecipients.has(String(c.number || '').trim());
      return `
        <div class="contact-item${number === activeNumber ? ' active' : ''}${composeMultiMode && isRecipient ? ' multi-selected' : ''}" data-number="${number}">
          <div class="contact-avatar">${initials}</div>
          <div class="contact-info">
            <div class="contact-name">${name}</div>
            <div class="contact-preview">${preview}</div>
          </div>
          <div class="contact-meta">
            <div class="contact-time">Pi</div>
            <button class="contact-archive-btn" type="button" data-number="${number}" title="${archiveViewMode ? 'Unarchive thread' : 'Archive thread'}">${archiveViewMode ? 'Unarchive' : 'Archive'}</button>
          </div>
        </div>
      `;
    }).join('');

    contactsWrap.querySelectorAll('.contact-item').forEach((el) => {
      el.addEventListener('click', () => {
        const clickedNumber = el.getAttribute('data-number');
        if (composeMultiMode) {
          toggleComposeRecipient(clickedNumber);
          return;
        }
        setSelectedNumber(clickedNumber);
      });
      el.addEventListener('dblclick', () => {
        renameSelectedContact(el.getAttribute('data-number'));
      });
    });

    contactsWrap.querySelectorAll('.contact-archive-btn').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.preventDefault();
        evt.stopPropagation();
        toggleArchiveForNumber(btn.getAttribute('data-number'));
      });
    });

    if (!composeMultiMode) {
      setSelectedNumber(activeNumber);
    } else {
      updateComposeThreadUi();
    }
  }

  function getBackendSentMessages(messagesData) {
    const sent = messagesData && Array.isArray(messagesData.sms) ? messagesData.sms : [];
    return sent.map((item) => ({
      ...item,
      number: String(item.number || '').trim(),
      direction: item.ok ? 'out' : 'in',
    }));
  }

  function getBackendInboxMessages(messagesData) {
    const inbox = messagesData && Array.isArray(messagesData.sms_inbox) ? messagesData.sms_inbox : [];
    return inbox.map((item, idx) => ({
      id: item.id || `inbox-${idx}-${item.ts || ''}-${item.from_number || ''}`,
      number: String(item.from_number || '').trim(),
      message: item.message || '',
      ts: item.ts,
      ok: false,
      direction: 'in',
    }));
  }

  function getAllBackendThreadMessages(messagesData) {
    return [...getBackendSentMessages(messagesData), ...getBackendInboxMessages(messagesData)].filter((item) => item.number);
  }

  function getLatestMessagePreview(number) {
    const key = String(number || '').trim();
    if (!key) return '';

    const allSms = [...getAllBackendThreadMessages(lastMessagesData), ...localOutgoingSms]
      .filter((item) => String(item.number || '').trim() === key)
      .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());

    if (!allSms.length) return key;

    const latestText = String(allSms[0].message || '').replace(/\s+/g, ' ').trim();
    if (!latestText) return key;
    return latestText.length > 42 ? `${latestText.slice(0, 42)}...` : latestText;
  }

  function renderMessages(messagesData) {
    if (!messagesWrap) return;

    const backendSms = getAllBackendThreadMessages(messagesData);
    const allSms = [...backendSms, ...localOutgoingSms].sort((a, b) => {
      const ta = new Date(a.ts || 0).getTime();
      const tb = new Date(b.ts || 0).getTime();
      return ta - tb;
    });
    if (smsBadgeEl) smsBadgeEl.textContent = String(allSms.length);

    const sms = selectedNumber
      ? allSms.filter((item) => String(item.number || '') === String(selectedNumber))
      : allSms;

    if (!sms.length) {
      messagesWrap.innerHTML = `<div class="date-divider">${selectedNumber ? 'No messages for this contact yet' : 'No message logs yet'}</div>`;
      return;
    }

    const rows = sms.slice(-20).map((item) => {
      const number = escapeHtml(item.number || 'Unknown');
      const msg = escapeHtml(item.message || '');
      const time = escapeHtml(fmtTime(item.ts));
      const itemId = escapeHtml(item.id || '');
      const msgStatus = item.localStatus
        ? (item.localStatus === 'sending' ? 'Sending...' : (item.localStatus === 'sent' ? 'Sent' : 'Failed'))
        : '';
      const ok = item.localStatus ? 'out' : (item.direction === 'in' ? 'in' : 'out');
      const metaParts = [number];
      if (time) metaParts.push(time);
      if (msgStatus) metaParts.push(msgStatus);
      return `
        <div class="msg ${ok}">
          <div class="msg-bubble">${msg}</div>
          <div class="msg-time">${metaParts.join(' -+ ')}</div>
          ${item.localStatus === 'failed' ? `<button class="msg-resend-btn" type="button" data-msg-id="${itemId}">Resend</button>` : ''}
        </div>
      `;
    });

    messagesWrap.innerHTML = '<div class="date-divider">Latest Backend SMS Log</div>' + rows.join('');
    messagesWrap.scrollTop = messagesWrap.scrollHeight;
  }

  function updateSmsStats(messagesData) {
    const unreadEl = document.getElementById('sms-stat-unread');
    const totalEl = document.getElementById('sms-stat-total');
    const onlineEl = document.getElementById('sms-stat-online');
    const allSms = getAllBackendThreadMessages(messagesData);
    const incoming = allSms.filter((m) => m.direction === 'in').length;

    if (unreadEl) unreadEl.textContent = String(incoming);
    if (totalEl) totalEl.textContent = String(allSms.length);
    if (onlineEl) onlineEl.textContent = String(contacts.length);
  }

  function addLocalOutgoingMessages(recipients, message) {
    const nowTs = new Date().toISOString();
    const ids = recipients.map((recipient) => {
      const id = `local-${Date.now()}-${localOutgoingCounter++}`;
      localOutgoingSms.push({
        id,
        number: String(recipient).trim(),
        message,
        ts: nowTs,
        ok: true,
        localStatus: 'sending',
      });
      return id;
    });
    return ids;
  }

  function updateLocalOutgoingStatus(ids, status) {
    const idSet = new Set(ids);
    localOutgoingSms = localOutgoingSms.map((item) => {
      if (!idSet.has(item.id)) return item;
      return { ...item, localStatus: status };
    });
  }

  async function resendFailedMessage(localId) {
    const id = String(localId || '').trim();
    if (!id) return;

    const failedItem = localOutgoingSms.find((item) => String(item.id || '') === id);
    if (!failedItem || failedItem.localStatus !== 'failed') return;

    localOutgoingSms = localOutgoingSms.map((item) => {
      if (String(item.id || '') !== id) return item;
      return { ...item, localStatus: 'sending', ts: new Date().toISOString() };
    });
    renderMessages(lastMessagesData);

    try {
      await api.sendSms([String(failedItem.number || '').trim()], String(failedItem.message || ''));
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (String(item.id || '') !== id) return item;
        return { ...item, localStatus: 'sent', ts: new Date().toISOString() };
      });
      renderMessages(lastMessagesData);
      await refreshFromPi();
    } catch {
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (String(item.id || '') !== id) return item;
        return { ...item, localStatus: 'failed', ts: new Date().toISOString() };
      });
      renderMessages(lastMessagesData);
    }
  }

  function pruneDeliveredLocalMessages(backendSms) {
    if (!Array.isArray(backendSms) || !backendSms.length || !localOutgoingSms.length) return;
    localOutgoingSms = localOutgoingSms.filter((localItem) => {
      if (localItem.localStatus !== 'sent') return true;
      const localMsg = String(localItem.message || '').trim();
      const localNumber = String(localItem.number || '').trim();
      return !backendSms.some((serverItem) => {
        const serverMsg = String(serverItem.message || '').trim();
        const serverNumber = String(serverItem.number || '').trim();
        return serverMsg === localMsg && serverNumber === localNumber;
      });
    });
  }

  function normalizeExtraNumber(raw) {
    return String(raw || '').replace(/\D/g, '').slice(0, 11);
  }

  function loadManualContacts() {
    try {
      const raw = localStorage.getItem(MANUAL_CONTACTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      return parsed
        .map((entry) => {
          const number = normalizeExtraNumber(entry && entry.number);
          if (number.length !== 11 || seen.has(number)) return null;
          seen.add(number);
          return { name: number, number };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function loadContactAliases() {
    try {
      const raw = localStorage.getItem(CONTACT_ALIASES_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function saveManualContacts() {
    try {
      localStorage.setItem(MANUAL_CONTACTS_KEY, JSON.stringify(manualContacts));
    } catch {
      // ignore storage write errors
    }
  }

  function saveContactAliases() {
    try {
      localStorage.setItem(CONTACT_ALIASES_KEY, JSON.stringify(contactAliases));
    } catch {
      // ignore storage write errors
    }
  }

  function ensureSelectedNumber() {
    if (selectedNumber) return String(selectedNumber).trim();
    const first = contacts && contacts[0] ? String(contacts[0].number || '').trim() : '';
    if (first) {
      setSelectedNumber(first);
      return first;
    }
    return '';
  }

  function openRenameDialog(number, currentName) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;';

      const card = document.createElement('div');
      card.style.cssText = 'width:min(92vw,360px);background:var(--card-bg,#0f1724);border:1px solid var(--card-border,#2a3446);border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);color:var(--text,#e7edf5);';

      const title = document.createElement('div');
      title.textContent = 'Rename Contact';
      title.style.cssText = 'font-size:.9rem;font-weight:700;margin-bottom:6px;';

      const subtitle = document.createElement('div');
      subtitle.textContent = number;
      subtitle.style.cssText = 'font-size:.72rem;color:var(--muted,#9ab0c8);margin-bottom:10px;';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName || '';
      input.placeholder = 'Enter display name';
      input.style.cssText = 'width:100%;height:36px;border-radius:10px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);padding:0 10px;outline:none;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

      const mkBtn = (label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = 'height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);cursor:pointer;';
        return btn;
      };

      const btnCancel = mkBtn('Cancel');
      const btnReset = mkBtn('Reset');
      const btnSave = mkBtn('Save');
      btnSave.style.borderColor = 'var(--primary,#00c8ff)';

      actions.appendChild(btnCancel);
      actions.appendChild(btnReset);
      actions.appendChild(btnSave);

      card.appendChild(title);
      card.appendChild(subtitle);
      card.appendChild(input);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
      input.select();

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };

      overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) close(null);
      });
      btnCancel.addEventListener('click', () => close(null));
      btnReset.addEventListener('click', () => close(''));
      btnSave.addEventListener('click', () => close(input.value));
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          close(input.value);
        } else if (evt.key === 'Escape') {
          evt.preventDefault();
          close(null);
        }
      });
    });
  }

  async function renameSelectedContact(targetNumber) {
    const key = String(targetNumber || ensureSelectedNumber()).trim();
    if (!key) {
      alert('No contact to rename yet.');
      return;
    }

    const current = getDisplayName(key, key);
    const next = await openRenameDialog(key, current);
    if (next === null) return;

    const clean = String(next).trim();
    if (!clean || clean === key) {
      delete contactAliases[key];
    } else {
      contactAliases[key] = clean;
    }
    saveContactAliases();

    renderContacts();
    setSelectedNumber(key);
  }

  function openNewMessageModal() {
    const visibleContacts = contacts.filter((item) => {
      const key = String(item && item.number || '').trim();
      return key && !isArchivedNumber(key);
    });

    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;';

      const card = document.createElement('div');
      card.style.cssText = 'width:min(94vw,520px);max-height:88vh;overflow:auto;background:var(--card-bg,#0f1724);border:1px solid var(--card-border,#2a3446);border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);color:var(--text,#e7edf5);';

      const title = document.createElement('div');
      title.textContent = 'New Message';
      title.style.cssText = 'font-size:.95rem;font-weight:700;margin-bottom:6px;';

      const subtitle = document.createElement('div');
      subtitle.textContent = 'Select one or more recipients, then send.';
      subtitle.style.cssText = 'font-size:.72rem;color:var(--muted,#9ab0c8);margin-bottom:10px;';

      const contactsLabel = document.createElement('div');
      contactsLabel.textContent = 'Recipients';
      contactsLabel.style.cssText = 'font-size:.68rem;color:var(--muted,#9ab0c8);margin-bottom:6px;';

      const contactsWrapEl = document.createElement('div');
      contactsWrapEl.style.cssText = 'max-height:180px;overflow:auto;border:1px solid var(--card-border,#2a3446);border-radius:10px;background:var(--surface-1,#111c2e);padding:6px;display:flex;flex-direction:column;gap:6px;';

      const selected = new Set();
      if (selectedNumber) selected.add(String(selectedNumber).trim());

      if (!visibleContacts.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No contacts available. You can still enter a manual number below.';
        empty.style.cssText = 'font-size:.68rem;color:var(--muted,#9ab0c8);padding:6px;';
        contactsWrapEl.appendChild(empty);
      } else {
        visibleContacts.forEach((item) => {
          const number = String(item.number || '').trim();
          const row = document.createElement('label');
          row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--card-border,#2a3446);border-radius:8px;cursor:pointer;';

          const check = document.createElement('input');
          check.type = 'checkbox';
          check.checked = selected.has(number);
          check.addEventListener('change', () => {
            if (check.checked) selected.add(number);
            else selected.delete(number);
            updateCounter();
          });

          const label = document.createElement('div');
          label.style.cssText = 'min-width:0;';
          label.innerHTML = `
            <div style="font-size:.75rem;font-weight:600;color:var(--text)">${escapeHtml(getDisplayName(number, item.name || number))}</div>
            <div style="font-size:.64rem;color:var(--muted)">${escapeHtml(number)}</div>
          `;

          row.appendChild(check);
          row.appendChild(label);
          contactsWrapEl.appendChild(row);
        });
      }

      const extraLabel = document.createElement('div');
      extraLabel.textContent = 'Manual number (optional)';
      extraLabel.style.cssText = 'font-size:.68rem;color:var(--muted,#9ab0c8);margin-top:10px;margin-bottom:6px;';

      const extraInput = document.createElement('input');
      extraInput.type = 'text';
      extraInput.inputMode = 'numeric';
      extraInput.maxLength = 11;
      extraInput.placeholder = 'Enter 11-digit number';
      extraInput.style.cssText = 'width:100%;height:36px;border-radius:10px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);padding:0 10px;outline:none;';

      const messageLabel = document.createElement('div');
      messageLabel.textContent = 'Message';
      messageLabel.style.cssText = 'font-size:.68rem;color:var(--muted,#9ab0c8);margin-top:10px;margin-bottom:6px;';

      const messageInput = document.createElement('textarea');
      messageInput.placeholder = 'Type your message...';
      messageInput.style.cssText = 'width:100%;min-height:88px;resize:vertical;border-radius:10px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);padding:8px 10px;outline:none;font:inherit;';

      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:.66rem;color:var(--muted,#9ab0c8);margin-top:8px;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

      const mkBtn = (label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = 'height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);cursor:pointer;';
        return btn;
      };

      const btnCancel = mkBtn('Cancel');
      const btnSend = mkBtn('Send');
      btnSend.style.borderColor = 'var(--primary,#00c8ff)';

      function collectRecipients() {
        const recipients = Array.from(selected);
        const extra = normalizeExtraNumber(extraInput.value);
        if (extra) recipients.push(extra);
        return Array.from(new Set(recipients.filter(Boolean)));
      }

      function updateCounter() {
        const recipients = collectRecipients();
        hint.textContent = recipients.length
          ? `Recipients selected: ${recipients.length}`
          : 'Select at least one recipient.';
      }

      function close(result) {
        overlay.remove();
        resolve(result);
      }

      btnCancel.addEventListener('click', () => close(false));

      btnSend.addEventListener('click', async () => {
        const recipients = collectRecipients();
        const message = String(messageInput.value || '').trim();
        if (!recipients.length) {
          hint.textContent = 'Select at least one recipient.';
          hint.style.color = 'var(--warning,#f6ad55)';
          return;
        }
        if (!message) {
          hint.textContent = 'Message cannot be empty.';
          hint.style.color = 'var(--warning,#f6ad55)';
          messageInput.focus();
          return;
        }

        try {
          btnSend.disabled = true;
          btnCancel.disabled = true;
          hint.textContent = 'Sending...';
          hint.style.color = 'var(--muted,#9ab0c8)';

          const localIds = addLocalOutgoingMessages(recipients, message);
          renderMessages(lastMessagesData);

          await api.sendSms(recipients, message);
          updateLocalOutgoingStatus(localIds, 'sent');
          renderMessages(lastMessagesData);

          recipients.forEach((recipient) => {
            const clean = upsertManualContact(recipient);
            if (clean) selectedNumber = clean;
          });
          contacts = combineContacts(contacts);
          renderContacts();
          await refreshFromPi();
          close(true);
        } catch (err) {
          const reason = err && err.message ? err.message : 'Send failed';
          hint.textContent = `Failed to send: ${reason}`;
          hint.style.color = 'var(--danger,#ff5252)';
          btnSend.disabled = false;
          btnCancel.disabled = false;
        }
      });

      overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) close(false);
      });

      extraInput.addEventListener('input', () => {
        const clean = normalizeExtraNumber(extraInput.value);
        if (extraInput.value !== clean) extraInput.value = clean;
        updateCounter();
      });

      messageInput.addEventListener('keydown', (evt) => {
        if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
          evt.preventDefault();
          btnSend.click();
        }
      });

      actions.appendChild(btnCancel);
      actions.appendChild(btnSend);

      card.appendChild(title);
      card.appendChild(subtitle);
      card.appendChild(contactsLabel);
      card.appendChild(contactsWrapEl);
      card.appendChild(extraLabel);
      card.appendChild(extraInput);
      card.appendChild(messageLabel);
      card.appendChild(messageInput);
      card.appendChild(hint);
      card.appendChild(actions);

      overlay.appendChild(card);
      document.body.appendChild(overlay);
      updateCounter();
      messageInput.focus();
    });
  }

  function updateExtraNumberUi() {
    if (!addNumberBtn) return;
    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    const isValid = clean.length === 11;

    if (extraNumberInput && extraNumberInput.value !== clean) {
      extraNumberInput.value = clean;
    }

    if (extraNumberHint) {
      if (!clean) {
        extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
        extraNumberHint.className = 'sms-extra-hint';
      } else if (isValid) {
        extraNumberHint.textContent = `Added: ${clean}`;
        extraNumberHint.className = 'sms-extra-hint ok';
      } else {
        extraNumberHint.textContent = `Enter 11 digits (${clean.length}/11)`;
        extraNumberHint.className = 'sms-extra-hint warn';
      }
    }

    addNumberBtn.classList.toggle('active', !extraNumberRow || !extraNumberRow.hasAttribute('hidden'));
    addNumberBtn.classList.toggle('added', isValid);
  }

  function upsertManualContact(number) {
    const clean = normalizeExtraNumber(number);
    if (clean.length !== 11) return null;

    const existsInBackend = contacts.some((item) => String(item.number || '') === clean);
    const existsInManual = manualContacts.some((item) => String(item.number || '') === clean);
    if (!existsInBackend && !existsInManual) {
      manualContacts.unshift({ name: clean, number: clean });
      saveManualContacts();
    }
    return clean;
  }

  function combineContacts(backendContacts) {
    const merged = [];
    const seen = new Set();

    const add = (entry) => {
      const num = String((entry && entry.number) || '').trim();
      if (!num || seen.has(num)) return;
      seen.add(num);
      merged.push({
        name: entry && entry.name ? entry.name : num,
        number: num,
      });
    };

    (backendContacts || []).forEach(add);
    getAllBackendThreadMessages(lastMessagesData).forEach((item) => {
      add({ name: item.number, number: item.number });
    });
    manualContacts.forEach(add);
    return merged;
  }

  function openChatForExtraNumber() {
    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (clean.length !== 11) {
      if (extraNumberHint) {
        extraNumberHint.textContent = `Enter 11 digits (${clean.length}/11)`;
        extraNumberHint.className = 'sms-extra-hint warn';
      }
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const selected = upsertManualContact(clean);
    contacts = combineContacts(contacts);
    renderContacts();
    if (selected) {
      if (composeMultiMode) selectedRecipients.add(selected);
      else setSelectedNumber(selected);
    }

    if (!composeMultiMode && extraNumberRow) extraNumberRow.setAttribute('hidden', '');
    if (addNumberBtn && !composeMultiMode) {
      addNumberBtn.classList.remove('active');
      addNumberBtn.classList.remove('added');
    }
    if (extraNumberInput) extraNumberInput.value = '';
    if (extraNumberHint) {
      extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
      extraNumberHint.className = 'sms-extra-hint';
    }
    if (composeMultiMode) updateComposeThreadUi();
    if (composeInput) composeInput.focus();
  }

  function getRecipientsForSend() {
    const recipients = composeMultiMode
      ? Array.from(selectedRecipients)
      : (selectedNumber ? [String(selectedNumber).trim()] : []);
    const extra = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (extra) recipients.push(extra);
    return Array.from(new Set(recipients.filter(Boolean)));
  }

  function setCameraMode(nextMode) {
    cameraMode = nextMode === 'snapshot' ? 'snapshot' : 'live';
    if (cameraModeLiveBtn) cameraModeLiveBtn.classList.toggle('active', cameraMode === 'live');
    if (cameraModeSnapshotBtn) cameraModeSnapshotBtn.classList.toggle('active', cameraMode === 'snapshot');
    if (cameraModeLabelEl) cameraModeLabelEl.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
    syncCameraMedia();
    updateCameraSidebar();
  }

  function setCameraConnectionState(message) {
    if (cameraConnectionLabel) cameraConnectionLabel.textContent = message;
  }

  function getCameraTargetLabel(targetIndex) {
    if (targetIndex === 'all') return 'All Cameras';
    const num = Number(targetIndex);
    return Number.isFinite(num) ? `Camera ${num}` : 'Selected Camera';
  }

  function setCameraActionIndicator(message) {
    if (!cameraActionIndicator) return;
    cameraActionIndicator.textContent = message;
  }

  function flashCameraAction(btn) {
    if (!btn) return;
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 220);
  }

  function hideCameraSlotMenu() {
    if (cameraSlotBackdrop) cameraSlotBackdrop.hidden = true;
    if (!cameraSlotMenu) return;
    cameraSlotMenu.hidden = true;
  }

  function updateCameraSlotMenuTarget() {
    if (!cameraSlotMenuTarget) return;
    cameraSlotMenuTarget.textContent = `${getCameraTargetLabel(cameraMenuTargetIndex)} controls`;
  }

  function openCameraSlotMenuAt(cameraIndex) {
    if (!cameraSlotMenu) return;
    cameraMenuTargetIndex = String(cameraIndex || 'all');
    updateCameraSlotMenuTarget();
    if (cameraSlotBackdrop) cameraSlotBackdrop.hidden = false;
    cameraSlotMenu.hidden = false;
    const firstMenuBtn = cameraSlotMenu.querySelector('.cam-admin-btn');
    if (firstMenuBtn && typeof firstMenuBtn.focus === 'function') firstMenuBtn.focus();
  }

  function queueCameraUiAction(actionText, targetIndex) {
    const label = getCameraTargetLabel(String(targetIndex || cameraMenuTargetIndex || 'all'));
    setCameraActionIndicator(`${actionText} for ${label} (UI preview only).`);
  }

  function getAvailableCameraIndexes() {
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras.slice(0, 4) : [];
    const indexes = cameras
      .map((camera) => String(Number(camera && camera.index)))
      .filter((idx) => /^\d+$/.test(idx));
    if (indexes.length) return Array.from(new Set(indexes));
    return ['1', '2', '3', '4'];
  }

  function resolveRecordingTargetIndexes(targetIndex) {
    const normalized = String(targetIndex || '').trim();
    if (!normalized || normalized === 'all') return getAvailableCameraIndexes();
    return /^\d+$/.test(normalized) ? [normalized] : [];
  }

  function updateCameraRecordingBadges() {
    if (!cameraGrid) return;
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      const idx = String(card.getAttribute('data-camera-index') || '').trim();
      const dot = card.querySelector('.cam-dot');
      if (!dot) return;
      dot.classList.remove('online', 'rec');
      if (recordingCameraIndexes.has(idx)) {
        dot.classList.add('rec');
        return;
      }
      if (card.classList.contains('is-live')) {
        dot.classList.add('online');
      }
    });
  }

  function applyRecordingCommand(command, targetIndex) {
    const targets = resolveRecordingTargetIndexes(targetIndex);
    if (!targets.length) return;

    targets.forEach((idx) => {
      if (command === 'start') recordingCameraIndexes.add(idx);
      else recordingCameraIndexes.delete(idx);
    });

    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const scopeLabel = getCameraTargetLabel(String(targetIndex || 'all'));
    lastRecordingActionLabel = `${command === 'start' ? 'Start recording' : 'Stop recording'} -> ${scopeLabel} (${timeLabel})`;
    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  function cameraTitle(camera, slotIndex) {
    if (!camera) return `Camera Slot ${slotIndex + 1}`;
    const idx = Number(camera.index);
    return Number.isFinite(idx) ? `Camera ${idx}` : `Camera ${slotIndex + 1}`;
  }

  function cameraMeta(camera) {
    if (!camera) return 'Waiting for signal';
    const parts = [];
    if (camera.device) parts.push(String(camera.device));
    if (camera.width && camera.height) parts.push(`${camera.width}x${camera.height}`);
    if (camera.fps) parts.push(`${Math.round(Number(camera.fps))} fps`);
    return parts.join(' | ') || 'Detected camera';
  }

  function buildCameraMediaUrl(cameraIndex) {
    if (!lastBase) return '';
    return `${lastBase}/camera/${cameraIndex}/snapshot.jpg?t=${Date.now()}`;
  }

  function clearCameraSnapshotIntervals() {
    cameraSnapshotIntervals.forEach((timerId) => {
      clearInterval(timerId);
    });
    cameraSnapshotIntervals.clear();
  }

  async function refreshCameraCardFrame(card) {
    if (!card) return;
    const idx = card.getAttribute('data-camera-index');
    const img = card.querySelector('.cam-feed-media');
    const placeholder = card.querySelector('.cam-placeholder');
    const status = card.querySelector('.cam-status');
    const key = String(idx || '').trim();
    if (!key || !img || !api.getCameraSnapshot) return;
    if (cameraSnapshotRequests.has(key)) return;

    const request = (async () => {
      try {
        const dataUrl = await api.getCameraSnapshot(Number(key));
        img.src = dataUrl;
        if (status) {
          status.className = 'cam-status online';
          status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
        }
      } catch {
        img.hidden = true;
        img.removeAttribute('src');
        if (placeholder) placeholder.hidden = false;
        card.classList.add('is-offline');
        card.classList.remove('is-live');
        if (status) {
          status.className = 'cam-status offline';
          status.textContent = 'Offline';
        }
      } finally {
        cameraSnapshotRequests.delete(key);
      }
    })();

    cameraSnapshotRequests.set(key, request);
    return request;
  }

  function updateCameraSidebar() {
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras : [];
    if (cameraSidebarList) {
      if (!cameras.length) {
        cameraSidebarList.innerHTML = `
          <div style="background:var(--surface-1);border:1px solid var(--card-border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:.78rem;font-weight:600;color:var(--text)">No cameras detected</div>
            <span class="cam-status offline">Offline</span>
          </div>
        `;
      } else {
        cameraSidebarList.innerHTML = cameras.slice(0, 4).map((camera, idx) => `
          <div style="background:var(--surface-1);border:1px solid var(--card-border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div style="min-width:0">
              <div style="font-size:.78rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cameraTitle(camera, idx))}</div>
              <div style="font-size:.64rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cameraMeta(camera))}</div>
            </div>
            <span class="cam-status online">Ready</span>
          </div>
        `).join('');
      }
    }

    if (cameraDetectedCountEl) cameraDetectedCountEl.textContent = String(cameras.length);
    if (cameraDetectedBarEl) cameraDetectedBarEl.style.width = `${Math.min(cameras.length, 4) * 25}%`;
    if (cameraStreamStatusEl) {
      cameraStreamStatusEl.textContent = !cameras.length
        ? 'No signal'
        : (cameraPanelActive ? (cameraMode === 'live' ? 'Streaming' : 'Snapshots') : 'Standby');
    }

    if (cameraRecordingStateEl) {
      const isRecording = recordingCameraIndexes.size > 0;
      cameraRecordingStateEl.textContent = isRecording ? 'Recording' : 'Stopped';
      cameraRecordingStateEl.style.color = isRecording ? 'var(--danger)' : 'var(--success)';
    }
    if (cameraRecordingActiveCountEl) {
      cameraRecordingActiveCountEl.textContent = `${recordingCameraIndexes.size} camera(s)`;
    }
    if (cameraRecordingListEl) {
      const activeIndexes = Array.from(recordingCameraIndexes)
        .map((idx) => Number(idx))
        .filter((idx) => Number.isFinite(idx))
        .sort((a, b) => a - b);

      if (!activeIndexes.length) {
        cameraRecordingListEl.innerHTML = '<div style="font-size:.66rem;color:var(--muted)">No cameras recording</div>';
      } else {
        cameraRecordingListEl.innerHTML = activeIndexes
          .map((idx) => `<div style="font-size:.67rem;color:var(--text)">Camera ${idx} recording</div>`)
          .join('');
      }
    }
    if (cameraRecordingLastActionEl) {
      cameraRecordingLastActionEl.textContent = lastRecordingActionLabel;
    }
  }

  function attachCameraMediaHandlers() {
    if (!cameraGrid) return;
    cameraGrid.querySelectorAll('[data-camera-index]').forEach((card) => {
      const idx = card.getAttribute('data-camera-index');
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');

      card.addEventListener('click', () => {
        if (!idx || !lastBase) return;
        window.open(`${lastBase}/camera/${idx}/snapshot.jpg?t=${Date.now()}`, '_blank', 'noopener');
      });

      card.addEventListener('contextmenu', (evt) => {
        if (!idx) return;
        evt.preventDefault();
        openCameraSlotMenuAt(idx);
      });

      const menuBtn = card.querySelector('.cam-menu-btn');
      if (menuBtn) {
        menuBtn.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const btnIdx = menuBtn.getAttribute('data-camera-index') || idx;
          if (!btnIdx) return;
          openCameraSlotMenuAt(btnIdx);
        });
      }

      if (!img || !placeholder) return;

      img.addEventListener('load', () => {
        placeholder.hidden = true;
        img.hidden = false;
        card.classList.remove('is-offline');
        card.classList.add('is-live');
        const status = card.querySelector('.cam-status');
        if (status) {
          status.className = 'cam-status online';
          status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
        }
        updateCameraRecordingBadges();
      });

      img.addEventListener('error', () => {
        img.hidden = true;
        img.removeAttribute('src');
        placeholder.hidden = false;
        card.classList.add('is-offline');
        card.classList.remove('is-live');
        const status = card.querySelector('.cam-status');
        if (status) {
          status.className = 'cam-status offline';
          status.textContent = 'Offline';
        }
        updateCameraRecordingBadges();
      });

    });
  }

  function renderCameraPanel() {
    if (!cameraGrid) return;
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras.slice(0, 4) : [];
    const slots = Array.from({ length: 4 }, (_, idx) => cameras[idx] || null);

    cameraGrid.innerHTML = slots.map((camera, idx) => {
      const featuredClass = idx === 0 ? ' featured' : '';
      if (!camera) {
        return `
          <div class="cam-cell is-offline${featuredClass}" data-camera-index="${idx + 1}">
            <div class="cam-feed">
              <div class="cam-placeholder">
                <svg width="${idx === 0 ? 80 : 50}" height="${idx === 0 ? 80 : 50}" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
                  <path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect>
                </svg>
                <div>No signal</div>
              </div>
            </div>
            <div class="cam-overlay"></div>
            <div class="cam-corner">
              <button type="button" class="cam-menu-btn" data-camera-index="${idx + 1}" aria-label="Open actions for ${escapeHtml(cameraTitle(camera, idx))}">&#8942;</button>
              <div class="cam-dot"></div>
            </div>
            <div class="cam-label">
              <span class="cam-name">${escapeHtml(cameraTitle(camera, idx))}</span>
              <span class="cam-status offline">Offline</span>
            </div>
            <div class="cam-empty-note"><span>Camera not detected</span></div>
          </div>
        `;
      }

      return `
        <div class="cam-cell${featuredClass}" data-camera-index="${escapeHtml(camera.index)}">
          <div class="cam-feed">
            <img class="cam-feed-media" alt="${escapeHtml(cameraTitle(camera, idx))}" hidden>
            <div class="cam-placeholder">
              <svg width="${idx === 0 ? 80 : 50}" height="${idx === 0 ? 80 : 50}" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
                <path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect>
              </svg>
              <div>${escapeHtml(cameraMeta(camera))}</div>
            </div>
          </div>
          <div class="cam-overlay"></div>
          <div class="cam-corner">
            <button type="button" class="cam-menu-btn" data-camera-index="${escapeHtml(camera.index)}" aria-label="Open actions for ${escapeHtml(cameraTitle(camera, idx))}">&#8942;</button>
            <div class="cam-dot"></div>
          </div>
          <div class="cam-label">
            <span class="cam-name">${escapeHtml(cameraTitle(camera, idx))}</span>
            <span class="cam-status online">${cameraMode === 'live' ? 'Live' : 'Snapshot'}</span>
          </div>
        </div>
      `;
    }).join('');

    attachCameraMediaHandlers();
    syncCameraMedia();
    updateCameraSidebar();
  }

  function stopCameraMedia() {
    if (!cameraGrid) return;
    clearCameraSnapshotIntervals();
    cameraGrid.querySelectorAll('.cam-feed-media').forEach((img) => {
      img.hidden = true;
      img.removeAttribute('src');
    });
    cameraGrid.querySelectorAll('.cam-placeholder').forEach((placeholder) => {
      placeholder.hidden = false;
    });
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      card.classList.remove('is-live');
      card.classList.add('is-offline');
      const status = card.querySelector('.cam-status');
      if (status) {
        status.className = 'cam-status offline';
        status.textContent = 'Standby';
      }
    });
    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  function syncCameraMedia() {
    if (!cameraGrid) return;
    if (!cameraPanelActive || !lastBase) {
      stopCameraMedia();
      return;
    }

    clearCameraSnapshotIntervals();
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      const idx = card.getAttribute('data-camera-index');
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');
      const status = card.querySelector('.cam-status');
      if (!idx || !img) return;

      card.classList.remove('is-offline');
      if (status) {
        status.className = 'cam-status online';
        status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
      }
      if (placeholder) placeholder.hidden = false;

      void refreshCameraCardFrame(card);

      if (cameraMode === 'live') {
        const timerId = setInterval(() => {
          void refreshCameraCardFrame(card);
        }, 1200);
        cameraSnapshotIntervals.set(String(idx), timerId);
      }
    });

    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  async function refreshCameras() {
    if (!api.getCameras || cameraRefreshInFlight) return;
    cameraRefreshInFlight = true;
    try {
      const base = await api.detectBase();
      if (base !== lastBase) lastBase = base;
      const cameraData = await api.getCameras();
      const cameras = Array.isArray(cameraData && cameraData.cameras) ? cameraData.cameras : [];
      lastCameraData = { count: cameras.length, cameras };
      setCameraConnectionState(cameras.length ? `${cameras.length} camera(s) online` : 'No cameras detected');
      renderCameraPanel();
    } catch (err) {
      lastCameraData = { count: 0, cameras: [] };
      setCameraConnectionState(`Camera offline: ${err && err.message ? err.message : 'unreachable'}`);
      renderCameraPanel();
    } finally {
      cameraRefreshInFlight = false;
    }
  }

  function openDevicePanel() {
    const panel = document.getElementById('devicePanelFloat');
    if (panel) {
      if (lastPanelData) {
        const locEl = document.getElementById('gps-location');
        updateFloatingDevicePanel(
          lastPanelData.gps,
          lastPanelData.track,
          lastStatusData,
          lastPanelData.lat,
          lastPanelData.lon,
          lastPanelData.speed,
          lastPanelData.satCount,
          locEl
        );
      }
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
  }

  function closeDevicePanel() {
    const panel = document.getElementById('devicePanelFloat');
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
  }

  function updateFloatingDevicePanel(gps, track, statusData, lat, lon, speed, satCount, locEl) {
    const st = statusData || {};
    const hb = st.heartbeat || {};
    const points = track && Array.isArray(track.points) ? track.points : [];
    const lastTs = points.length > 0 ? points[points.length - 1].ts : hb.last_seen_ts || null;
    let lastUpdateLabel = 'G��';
    if (lastTs) {
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      if (diff < 10) lastUpdateLabel = 'Just now';
      else if (diff < 60) lastUpdateLabel = `${diff}s ago`;
      else if (diff < 3600) lastUpdateLabel = `${Math.floor(diff / 60)}m ago`;
      else lastUpdateLabel = `${Math.floor(diff / 3600)}h ago`;
    }
    const statusText = (hb.status && String(hb.status)) || 'G��';
    const statusClass = /online/i.test(statusText) ? 'online' : (/moving/i.test(statusText) ? 'moving' : 'offline');
    let connectionLabel = 'G��';
    const cgpaddrRaw = st.CGPADDR ? String(st.CGPADDR) : '';
    const ipMatch = cgpaddrRaw.match(/,(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    const parsedIp = ipMatch ? ipMatch[1] : '';
    if (parsedIp && parsedIp !== '0.0.0.0') connectionLabel = `Cellular / IP: ${parsedIp}`;
    else if (st.CREG_MEANING) connectionLabel = String(st.CREG_MEANING);
    else if (cgpaddrRaw) connectionLabel = 'Cellular (no data IP)';
    const modemLabel = (st.CSQ_MEANING && String(st.CSQ_MEANING)) || (st.AT_MEANING && String(st.AT_MEANING)) || 'G��';
    const netLog = st.latest_network_log;
    let operatorLabel = (netLog && netLog.operator && String(netLog.operator).trim()) ? String(netLog.operator).trim() : 'G��';
    if (operatorLabel === 'G��' && st.COPS) {
      const m = String(st.COPS).match(/,\s*"([^"]+)"/);
      if (m) operatorLabel = m[1];
    }
    const coordsLabel = (lat != null && lon != null) ? `${lat.toFixed(5)} N, ${lon.toFixed(5)} E` : 'G��';
    const locLabel = (locEl && locEl.textContent && locEl.textContent.trim()) ? locEl.textContent.trim() : coordsLabel;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text != null && text !== '' ? String(text) : 'G��';
    };
    set('floatDeviceName', 'RPI-01');
    set('floatDeviceSub', 'Raspberry Pi GPS Tracker');
    set('floatLastUpdate', lastUpdateLabel);
    set('floatSpeed', lat != null ? `${Number(speed || 0).toFixed(0)} km/h` : 'G��');
    set('floatCoords', locLabel);
    set('floatOperator', operatorLabel);
    set('floatConnection', connectionLabel);
    set('floatModem', modemLabel);
    set('floatDeviceType', 'Raspberry Pi 4');
    const statusWrap = document.getElementById('floatDeviceStatus');
    const statusTextEl = document.getElementById('floatDeviceStatusText');
    if (statusWrap) statusWrap.className = 'device-status ' + statusClass;
    if (statusTextEl) statusTextEl.textContent = statusText;
  }

  function updateGpsFromBackend(gps, track) {
    // --- determine best position ---
    let lat = null, lon = null, speed = 0;
    const points = track && Array.isArray(track.points) ? track.points : [];

    // prefer live fix
    if (gps && gps.fix === '1' && gps.lat != null && gps.lon != null) {
      lat = parseFloat(gps.lat);
      lon = parseFloat(gps.lon);
      speed = Math.max(0, parseFloat(gps.speed) || 0);
    }

    // fall back to latest track point
    if ((lat === null || lon === null) && points.length > 0) {
      const last = points[points.length - 1];
      lat = parseFloat(last.lat);
      lon = parseFloat(last.lon);
      speed = Math.max(0, parseFloat(last.speed) || 0);
    }

    // --- sidebar GPS card ---
    const locEl   = document.getElementById('gps-location');
    const subEl   = document.getElementById('gps-fix-sub');
    const satEl   = document.getElementById('stat-sat');
    const altEl   = document.getElementById('stat-alt');
    const ptsEl   = document.getElementById('stat-pts');

    const hasFix  = gps && gps.fix === '1';
    const gpsConnected = Boolean(hasFix && gps.lat != null && gps.lon != null);
    setGpsState(gpsConnected, gpsConnected ? 'GPS: On' : 'GPS: Disconnected');
    const satCount = gps && gps.sat != null ? gps.sat : (points.length > 0 ? points[points.length-1].sat : 'G��');

    if (locEl) {
      if (lat !== null) {
        // show cached name instantly, then update asynchronously
        const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
        locEl.textContent = cached || `${Math.abs(lat).toFixed(5)}-� ${lat>=0?'N':'S'}, ${Math.abs(lon).toFixed(5)}-� ${lon>=0?'E':'W'}`;
        if (!cached) reverseGeocode(lat, lon).then(name => { if (name && locEl) locEl.textContent = name; });
      } else {
        locEl.textContent = 'No fix yet';
      }
    }
    if (subEl) subEl.textContent = hasFix ? 'Live GPS fix active' : (points.length > 0 ? `Last fix: ${fmtTime(points[points.length-1].ts)}` : 'Waiting for GPS fixGǪ');
    if (satEl) satEl.textContent = String(satCount);
    if (altEl) {
      const alt = hasFix && gps.alt != null ? parseFloat(gps.alt).toFixed(0)+'m'
                : (points.length > 0 ? parseFloat(points[points.length-1].alt).toFixed(0)+'m' : 'G��');
      altEl.textContent = alt;
    }
    if (ptsEl) ptsEl.textContent = String(track ? track.count || points.length : 0);

    // --- bottom bar live coords ---
    const coordValEl  = document.getElementById('live-coord-value');
    const coordUpdEl  = document.getElementById('live-last-update');
    if (coordValEl && lat !== null) {
      const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
      coordValEl.textContent = cached || `${Math.abs(lat).toFixed(5)}-� ${lat>=0?'N':'S'} -+ ${Math.abs(lon).toFixed(5)}-� ${lon>=0?'E':'W'}`;
      if (!cached) reverseGeocode(lat, lon).then(name => { if (name && coordValEl) coordValEl.textContent = name; });
    }
    if (coordUpdEl && points.length > 0) {
      const lastTs = points[points.length - 1].ts;
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      coordUpdEl.textContent = diff < 60 ? `Updated ${diff}s ago` : diff < 3600 ? `Updated ${Math.floor(diff/60)}m ago` : `Updated ${Math.floor(diff/3600)}h ago`;
    }

    // --- floating device panel content (updated every refresh; re-filled when panel opens) ---
    lastPanelData = { gps, track, lat, lon, speed, satCount };
    updateFloatingDevicePanel(gps, track, lastStatusData, lat, lon, speed, satCount, locEl);

    // --- draw track log polyline (blue line on map) ---
    if (points.length > 1 && typeof map !== 'undefined') {
      const latlngs = points.map(p => [parseFloat(p.lat), parseFloat(p.lon)]);
      if (trackPolyline) {
        trackPolyline.setLatLngs(latlngs);
      } else {
        trackPolyline = L.polyline(latlngs, {
          color: '#00c8ff',
          weight: 4,
          opacity: 0.85,
          lineJoin: 'round',
          lineCap: 'round',
        }).addTo(map);
      }
    }

    // --- move/create Pi vehicle marker ---
    const lastOnlineAgo = (lastStatusData && lastStatusData.heartbeat && lastStatusData.heartbeat.last_online_ago)
      ? String(lastStatusData.heartbeat.last_online_ago)
      : 'G��';
    if (lat !== null && lon !== null && typeof map !== 'undefined') {
      if (piCarMarker) {
        piCarMarker.setLatLng([lat, lon]);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:28px;height:28px;border-radius:50%;background:#00c8ff;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 0 0 6px rgba(0,200,255,.25),0 2px 10px rgba(0,200,255,.5)">&#x1F6F0;</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
        piCarMarker = L.marker([lat, lon], { icon }).addTo(map);
        piCarMarker.bindTooltip('', {
          direction: 'top',
          permanent: false,
          className: 'marker-tooltip-last-seen',
          offset: [0, -24],
        });
        piCarMarker.on('click', function onMarkerClick() {
          openDevicePanel();
          if (piCarMarker && piCarMarker.getTooltip()) piCarMarker.openTooltip();
        });
      }
      if (piCarMarker && piCarMarker.getTooltip()) {
        piCarMarker.setTooltipContent(`Last seen: ${lastOnlineAgo}`);
      }

      // pan map to Pi position
      const follow = document.getElementById('btnFollow');
      if (!follow || follow.classList.contains('active')) {
        map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
      }
    }

    // --- coords display at bottom of map ---
    const coordsEl = document.getElementById('gpsCoords');
    if (coordsEl && lat !== null && lon !== null) {
      const ns = lat >= 0 ? 'N' : 'S';
      const ew = lon >= 0 ? 'E' : 'W';
      coordsEl.textContent = `${Math.abs(lat).toFixed(5)}-� ${ns} -+ ${Math.abs(lon).toFixed(5)}-� ${ew}`;
    }

    // --- speed gauge ---
    const speedEl   = document.getElementById('speedNum');
    const statusEl  = document.getElementById('speedStatus');
    const gaugeFill = document.getElementById('gaugeFill');
    if (speedEl) speedEl.textContent = Math.round(speed);
    if (statusEl) {
      if (speed > 60)      { statusEl.textContent = 'Over limit';   statusEl.style.color = 'var(--danger)';  }
      else if (speed > 50) { statusEl.textContent = 'Near limit';   statusEl.style.color = 'var(--warning)'; }
      else                 { statusEl.textContent = 'Within limit'; statusEl.style.color = 'var(--success)'; }
    }
    if (gaugeFill) {
      const circumference = 2 * Math.PI * 27;
      gaugeFill.style.strokeDashoffset = String(circumference * (1 - Math.min(speed / 80, 1)));
    }
  }

  async function refreshFromPi() {
    try {
      const base = await api.detectBase();
      if (base !== lastBase) {
        lastBase = base;
        syncCameraMedia();
      }
      setConnectionState(true, 'RasPi: Connected', base);

      const [gps, track, contactData, messagesData, statusData] = await Promise.all([
        api.getGpsLatest(),
        api.getGpsTrack(),
        api.getContacts(),
        api.getMessages(),
        api.getStatus(),
      ]);

      lastStatusData = statusData && typeof statusData === 'object' ? statusData : null;
      updateGpsFromBackend(gps, track);

      const backendContacts = Array.isArray(contactData && contactData.contacts) ? contactData.contacts : [];
      lastMessagesData = messagesData && typeof messagesData === 'object' ? messagesData : { sms: [] };
      contacts = combineContacts(backendContacts);
      pruneDeliveredLocalMessages(lastMessagesData.sms);
      renderContacts();
      renderMessages(lastMessagesData);
      updateSmsStats(lastMessagesData);
    } catch (err) {
      const reason = err && err.message ? err.message : 'Cannot reach Pi backend';
      setConnectionState(false, 'RasPi: Disconnected', reason);
      setGpsState(false, 'GPS: Disconnected');
      lastStatusData = null;
      setCameraConnectionState(`Camera offline: ${reason}`);
      stopCameraMedia();
    }
  }

  async function onSend() {
    const message = composeInput ? composeInput.value.trim() : '';
    if (!message) {
      return;
    }

    const extraRaw = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (extraRaw && extraRaw.length !== 11) {
      alert('Additional number must be exactly 11 digits.');
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const recipients = getRecipientsForSend();
    if (!recipients.length) {
      alert('Select a contact or enter an additional number first.');
      return;
    }

    try {
      sendBtn.disabled = true;
      if (addNumberBtn) addNumberBtn.disabled = true;

      const localIds = addLocalOutgoingMessages(recipients, message);
      renderMessages(lastMessagesData);
      if (composeInput) {
        composeInput.value = '';
      }

      await api.sendSms(recipients, message);
      updateLocalOutgoingStatus(localIds, 'sent');
      renderMessages(lastMessagesData);

      if (composeMultiMode) {
        exitMultiComposeMode();
      }

      await refreshFromPi();
    } catch (err) {
      const localIds = [];
      // Keep failed messages visible in thread so the user gets feedback.
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (item.localStatus !== 'sending' || item.message !== message) return item;
        if (recipients.includes(String(item.number || '').trim())) {
          localIds.push(item.id);
          return { ...item, localStatus: 'failed' };
        }
        return item;
      });
      if (localIds.length) renderMessages(lastMessagesData);

      const reason = err && err.message ? err.message : 'Send failed';
      alert(`Failed to send SMS: ${reason}`);
    } finally {
      sendBtn.disabled = false;
      if (addNumberBtn) addNumberBtn.disabled = false;
    }
  }

  function toggleExtraNumberInput() {
    if (!extraNumberRow || !addNumberBtn) return;
    const hidden = extraNumberRow.hasAttribute('hidden');
    if (hidden) {
      extraNumberRow.removeAttribute('hidden');
      addNumberBtn.classList.add('active');
      updateExtraNumberUi();
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (clean.length === 11) {
      openChatForExtraNumber();
      return;
    }

    if (composeMultiMode && !clean) {
      extraNumberRow.setAttribute('hidden', '');
      addNumberBtn.classList.remove('active');
      addNumberBtn.classList.remove('added');
      return;
    }

    extraNumberRow.setAttribute('hidden', '');
    addNumberBtn.classList.remove('active');
    addNumberBtn.classList.remove('added');
    if (extraNumberInput) extraNumberInput.value = '';
    if (extraNumberHint) {
      extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
      extraNumberHint.className = 'sms-extra-hint';
    }
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', onSend);
  }

  if (composeInput) {
    composeInput.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        onSend();
      }
    });
  }

  if (addNumberBtn) {
    addNumberBtn.addEventListener('click', toggleExtraNumberInput);
  }

  if (newMessageBtn) {
    newMessageBtn.addEventListener('click', () => {
      void openNewMessageModal();
    });
  }

  if (openArchiveBtn) {
    openArchiveBtn.addEventListener('click', () => {
      if (composeMultiMode) exitMultiComposeMode();
      toggleArchiveView();
    });
  }

  if (cameraModeLiveBtn) {
    cameraModeLiveBtn.addEventListener('click', () => setCameraMode('live'));
  }

  if (cameraModeSnapshotBtn) {
    cameraModeSnapshotBtn.addEventListener('click', () => setCameraMode('snapshot'));
  }

  if (cameraRefreshBtn) {
    cameraRefreshBtn.addEventListener('click', () => {
      refreshCameras();
      setCameraActionIndicator('Refreshing camera feeds...');
    });
  }

  [
    [cameraMenuRecordStartBtn, 'Recording started', 'start'],
    [cameraMenuRecordStopBtn, 'Recording stopped', 'stop'],
    [cameraMenuPowerOffBtn, 'Camera power off command queued'],
    [cameraMenuPowerOnBtn, 'Camera power on command queued'],
    [cameraMenuCaptureBtn, 'Snapshot capture queued'],
    [cameraMenuIncidentBtn, 'Incident flag queued'],
  ].forEach(([btn, actionText, recordingCommand]) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      flashCameraAction(btn);
      queueCameraUiAction(actionText, cameraMenuTargetIndex);
      if (recordingCommand) applyRecordingCommand(recordingCommand, cameraMenuTargetIndex);
      hideCameraSlotMenu();
    });
  });

  [cameraMenuAutoRecordChip, cameraMenuAudioMuteChip, cameraMenuNightVisionChip]
    .filter(Boolean)
    .forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        chip.setAttribute('aria-checked', chip.classList.contains('active') ? 'true' : 'false');
        const state = chip.classList.contains('active') ? 'enabled' : 'disabled';
        const label = (chip.textContent || 'Policy').trim();
        queueCameraUiAction(`${label} ${state}`, cameraMenuTargetIndex);
      });
    });

  if (cameraSlotMenu) {
    cameraSlotMenu.addEventListener('contextmenu', (evt) => evt.preventDefault());
  }

  if (cameraSlotBackdrop) {
    cameraSlotBackdrop.addEventListener('click', hideCameraSlotMenu);
  }

  if (cameraSlotMenuCloseBtn) {
    cameraSlotMenuCloseBtn.addEventListener('click', hideCameraSlotMenu);
  }

  document.addEventListener('click', (evt) => {
    if (!cameraSlotMenu || cameraSlotMenu.hidden) return;
    const target = evt.target;
    if (target && target.closest && target.closest('#cameraSlotMenu')) return;
    hideCameraSlotMenu();
  });

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') hideCameraSlotMenu();
  });

  if (extraNumberInput) {
    extraNumberInput.addEventListener('input', updateExtraNumberUi);
    extraNumberInput.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        openChatForExtraNumber();
      }
    });
  }

  if (messagesWrap) {
    messagesWrap.addEventListener('click', (evt) => {
      const target = evt.target;
      if (!target || !target.closest) return;
      const resendBtn = target.closest('.msg-resend-btn');
      if (!resendBtn) return;
      evt.preventDefault();
      resendFailedMessage(resendBtn.getAttribute('data-msg-id'));
    });
  }

  document.addEventListener('click', (evt) => {
    const target = evt.target;
    if (!target || !target.closest) return;
    const renameControl = target.closest('#smsRenameBtn');
    if (!renameControl) return;
    evt.preventDefault();
    renameSelectedContact();
  });

  [smsThreadNameEl, smsThreadSubEl, smsThreadAvatarEl].filter(Boolean).forEach((el) => {
    el.style.cursor = 'pointer';
    el.title = 'Double-click to rename (local only)';
    el.addEventListener('dblclick', () => renameSelectedContact());
  });

  const devicePanelClose = document.getElementById('devicePanelClose');
  if (devicePanelClose) {
    devicePanelClose.addEventListener('click', closeDevicePanel);
  }

  manualContacts = loadManualContacts();
  contactAliases = loadContactAliases();
  archivedContacts = loadArchivedContacts();
  updateArchiveButtonUi();
  updateNewMessageButtonUi();
  cameraPanelActive = !!document.getElementById('panel-camera')?.classList.contains('active');
  setCameraMode('live');
  renderCameraPanel();
  refreshCameras();

  // Backend mode toggle
  const backendModeToggle = document.getElementById('backendModeToggle');
  const backendModeLabel = document.getElementById('backendModeLabel');

  function updateBackendModeUI() {
    const isBackendMode = api.getUseBackend();
    if (backendModeToggle) backendModeToggle.checked = isBackendMode;
    if (backendModeLabel) {
      backendModeLabel.textContent = isBackendMode ? 'Backend WS' : 'Pi Direct';
      backendModeLabel.style.color = isBackendMode ? 'var(--primary)' : 'var(--muted)';
    }
  }

  function setBackendMode(enabled) {
    api.setUseBackend(enabled);
    updateBackendModeUI();
    console.log(`[API] Mode switched to: ${enabled ? 'Backend WebSocket' : 'Pi Direct'}`);
    // Trigger a refresh to use the new mode
    refreshFromPi();
  }

  if (backendModeToggle) {
    backendModeToggle.addEventListener('change', () => {
      setBackendMode(backendModeToggle.checked);
    });
  }

  if (backendModeLabel) {
    backendModeLabel.addEventListener('click', () => {
      if (backendModeToggle) {
        backendModeToggle.checked = !backendModeToggle.checked;
        setBackendMode(backendModeToggle.checked);
      }
    });
  }

  updateBackendModeUI();

  refreshFromPi();
  setInterval(refreshFromPi, 10000);
  setInterval(refreshCameras, 30000);

  window.centerOnTracker = function () {
    if (piCarMarker && typeof map !== 'undefined') {
      map.setView(piCarMarker.getLatLng(), map.getMaxZoom(), { animate: true });
    }
  };

  window.onDashboardPanelChange = function (name) {
    cameraPanelActive = name === 'camera';
    if (cameraPanelActive) {
      refreshCameras();
      syncCameraMedia();
    } else {
      stopCameraMedia();
    }
  };

  window.openDevicePanel = openDevicePanel;
})();
