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
  let useBackend = true; // Prefer backend WebSocket so ADB auto-target can be used by default
  const hasTrackingBridge = !!(window.trackingBridge && typeof window.trackingBridge.on === 'function');

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
      if (!hasTrackingBridge) {
        handleCommandLifecycleEvent('command_response', data);
      }
    });

    backendApi.on('command_queued', (data) => {
      console.log('[API] Command queued (device offline):', data.action);
      if (!hasTrackingBridge) {
        handleCommandLifecycleEvent('command_queued', data);
      }
    });

    backendApi.on('command_accepted', (data) => {
      if (!hasTrackingBridge) {
        handleCommandLifecycleEvent('command_accepted', data);
      }
    });

    backendApi.on('device_event', (data) => {
      if (hasTrackingBridge) {
        const action = getTrackingAction(data);
        if (action === 'device_online' || action === 'device_offline' || action === 'location_update') {
          return;
        }
      }
      handleBackendDeviceEvent(data);
    });

    if (hasTrackingBridge) {
      window.trackingBridge.onDeviceOnline((data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'device_online' }));
      window.trackingBridge.onDeviceOffline((data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'device_offline' }));
      window.trackingBridge.onLocation((data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'location_update' }));
      window.trackingBridge.onDevicesUpdate((data) => applyTrackingDevicesUpdate(data));
      window.trackingBridge.onMessageLog((data) => applyTrackingMessageLog(data));

      window.trackingBridge.on('tracking:request', (data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_request' }));
      window.trackingBridge.on('tracking:session_end', (data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_session_end' }));
      window.trackingBridge.on('tracking:approved', (data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_approved' }));
      window.trackingBridge.on('tracking:rejected', (data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_rejected' }));

      window.trackingBridge.getDeviceList()
        .then((snapshot) => {
          applyTrackingDevicesUpdate(snapshot);
        })
        .catch((err) => {
          console.warn('[Tracking] Failed to load initial device list:', err.message);
        });
    } else if (window.electronAPI && typeof window.electronAPI.on === 'function') {
      window.electronAPI.on('tracking:device_online', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'device_online' }));
      window.electronAPI.on('tracking:device_offline', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'device_offline' }));
      window.electronAPI.on('tracking:location', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'location_update' }));
      window.electronAPI.on('tracking:devices_update', (_evt, data) => applyTrackingDevicesUpdate(data));
      window.electronAPI.on('tracking:message_log', (_evt, data) => applyTrackingMessageLog(data));

      // Legacy fallback channels.
      window.electronAPI.on('tracking:request', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_request' }));
      window.electronAPI.on('tracking:session_end', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_session_end' }));
      window.electronAPI.on('tracking:approved', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_approved' }));
      window.electronAPI.on('tracking:rejected', (_evt, data) => handleBackendDeviceEvent({ type: 'device_event', ...data, action: 'tracking_rejected' }));
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
  const trackingCardsEl = document.getElementById('trackingDeviceCards');
  const trackingLogPanelEl = document.getElementById('trackingLogPanel');
  const trackingLogToggleEl = document.getElementById('trackingLogToggle');
  const trackingLogToggleIconEl = document.getElementById('trackingLogToggleIcon');
  const trackingMessageLogEl = document.getElementById('trackingMessageLog');
  const trackingDevicesPaneEl = document.getElementById('trackingDevicesPane');
  const trackingPaneToggleEl = document.getElementById('trackingPaneToggle');
  const trackingPaneToggleIconEl = document.getElementById('trackingPaneToggleIcon');
  const trackingPaneToggleTextEl = document.getElementById('trackingPaneToggleText');
  const mobileTrackingStatusEl = document.getElementById('mobileTrackingStatus');
  const mobileGpsCoordsEl = document.getElementById('mobileGpsCoords');
  const trackingMapHintEl = document.getElementById('trackingMapHint');
  const trackingRequestsEl = document.getElementById('trackingRequestsMobile') || document.getElementById('trackingRequestsSidebar') || document.getElementById('trackingRequests');

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
  let expandedCameraIndex = null;
  const trackingDevices = new Map();
  const trackingVisuals = new Map();
  const trackingMessageLog = [];
  const trackingMessageKeys = new Set();
  const trackingPendingRequests = new Map();
  const recentTrackingEventKeys = new Map();
  const queuedLifecycleLoggedDevices = new Set();
  const deviceColors = new Map();
  const colorOrder = ['#1e88e5', '#2e7d32', '#f57c00', '#8e24aa', '#d81b60', '#00897b', '#5e35b1'];
  const OFFLINE_MARKER_COLOR = '#98a2b3';
  const TRACKING_MANILA_CENTER = [14.5995, 120.9842];
  const TRACKING_PANE_COLLAPSED_KEY = 'pi-mobile-tracking-pane-collapsed';
  let selectedTrackingDeviceId = '';
  let trackingUiInitialized = false;

  function setTrackingLogCollapsed(collapsed) {
    if (!trackingLogPanelEl) return;

    const isCollapsed = !!collapsed;
    trackingLogPanelEl.classList.toggle('is-collapsed', isCollapsed);

    if (trackingLogToggleEl) {
      trackingLogToggleEl.setAttribute('aria-expanded', String(!isCollapsed));
    }
    if (trackingLogToggleIconEl) {
      trackingLogToggleIconEl.innerHTML = isCollapsed ? '&#9662;' : '&#9652;';
    }
  }

  function setTrackingPaneCollapsed(collapsed) {
    if (!trackingDevicesPaneEl) return;

    const isCollapsed = !!collapsed;
    trackingDevicesPaneEl.classList.toggle('is-collapsed', isCollapsed);
    setTrackingLogCollapsed(isCollapsed);

    if (trackingPaneToggleEl) {
      trackingPaneToggleEl.setAttribute('aria-expanded', String(!isCollapsed));
      trackingPaneToggleEl.title = isCollapsed ? 'Expand devices pane' : 'Collapse devices pane';
    }
    if (trackingPaneToggleTextEl) {
      trackingPaneToggleTextEl.textContent = isCollapsed ? 'Show' : 'Hide';
    }
    if (trackingPaneToggleIconEl) {
      trackingPaneToggleIconEl.innerHTML = isCollapsed ? '&#9656;' : '&#9664;';
    }

    try {
      localStorage.setItem(TRACKING_PANE_COLLAPSED_KEY, isCollapsed ? '1' : '0');
    } catch {
      // Ignore storage errors in restricted runtime contexts.
    }
  }

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

  function getTrackingPayload(event) {
    return event && typeof event.payload === 'object' ? event.payload : {};
  }

  function isMobileTrackingDevice(deviceId) {
    return !!String(deviceId || '').trim();
  }

  function getTrackingMap() {
    return window.mobileMap || (typeof map !== 'undefined' ? map : null);
  }

  function normalizeIsoTime(value, fallback = null) {
    if (!value) return fallback;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return fallback;
    return d.toISOString();
  }

  function getDeviceColor(deviceId) {
    if (deviceColors.has(deviceId)) return deviceColors.get(deviceId);
    const index = deviceColors.size % colorOrder.length;
    const color = colorOrder[index];
    deviceColors.set(deviceId, color);
    return color;
  }

  function buildDeviceIcon(color, isOffline = false, isSelected = false) {
    const base = isOffline ? OFFLINE_MARKER_COLOR : color;
    const ring = isSelected ? '#f6f8fc' : '#ffffff';
    const halo = isSelected ? `${base}CC` : `${base}66`;
    return L.divIcon({
      className: '',
      html: `<div style="width:18px;height:18px;border-radius:50%;background:${base};border:2px solid ${ring};box-shadow:0 0 0 4px ${halo},0 2px 10px rgba(0,0,0,.32);"></div>`,
      iconSize: [18, 18],
      iconAnchor: [9, 9],
    });
  }

  function formatRelativeTime(ts) {
    if (!ts) return 'unknown';
    const when = new Date(ts);
    if (Number.isNaN(when.getTime())) return 'unknown';

    const diffMs = Date.now() - when.getTime();
    if (diffMs <= 10000) return 'just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return '<1m ago';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function shortDeviceId(deviceId) {
    const raw = String(deviceId || '').trim();
    if (raw.length <= 12) return raw;
    return `${raw.slice(0, 8)}...`;
  }

  function getLocationFromEvent(event) {
    const payload = getTrackingPayload(event);
    const nested = payload && typeof payload.payload === 'object' ? payload.payload : null;
    const source = payload.latitude != null || payload.longitude != null
      ? payload
      : (nested && (nested.latitude != null || nested.longitude != null) ? nested : event);

    const latitude = toNum(source?.latitude ?? source?.lat);
    const longitude = toNum(source?.longitude ?? source?.lng);
    if (latitude == null || longitude == null) return null;

    const timestamp = normalizeIsoTime(source?.timestamp, new Date().toISOString());
    return {
      latitude,
      longitude,
      timestamp,
      ts: Number(source?.ts || Date.now()),
    };
  }

  function buildTrackingEventKey(action, deviceId, payload) {
    const ts = payload?.timestamp || payload?.connected_at || payload?.disconnected_at || '';
    const lat = payload?.latitude ?? payload?.lat ?? '';
    const lon = payload?.longitude ?? payload?.lng ?? '';
    return `${action}|${deviceId}|${ts}|${lat}|${lon}`;
  }

  function shouldSkipTrackingEvent(action, deviceId, payload = {}) {
    const key = buildTrackingEventKey(action, deviceId, payload);
    const now = Date.now();
    const lastSeen = recentTrackingEventKeys.get(key) || 0;
    recentTrackingEventKeys.set(key, now);

    if (recentTrackingEventKeys.size > 300) {
      for (const [entryKey, value] of recentTrackingEventKeys.entries()) {
        if (now - value > 5000) {
          recentTrackingEventKeys.delete(entryKey);
        }
      }
    }

    return now - lastSeen < 350;
  }

  function ensureTrackingDeviceState(deviceId) {
    const key = String(deviceId || '').trim();
    if (!key) return null;
    if (!trackingDevices.has(key)) {
      trackingDevices.set(key, {
        device_id: key,
        status: 'offline',
        connected_at: null,
        disconnected_at: null,
        last_seen: null,
        last_location: null,
        route_points: [],
        message_log: [],
      });
    }
    return trackingDevices.get(key);
  }

  function appendTrackingMessage(entry) {
    if (!entry || typeof entry !== 'object') return;
    const normalized = {
      timestamp: normalizeIsoTime(entry.timestamp, new Date().toISOString()),
      device_id: String(entry.device_id || '').trim() || '-',
      action: String(entry.action || 'unknown').trim().toLowerCase(),
      payload: entry.payload && typeof entry.payload === 'object' ? entry.payload : {},
      level: String(entry.level || '').trim().toLowerCase(),
      status: String(entry.status || '').trim().toLowerCase(),
    };

    const signature = `${normalized.timestamp}|${normalized.device_id}|${normalized.action}|${JSON.stringify(normalized.payload)}`;
    if (trackingMessageKeys.has(signature)) return;

    trackingMessageKeys.add(signature);
    trackingMessageLog.push(normalized);

    while (trackingMessageLog.length > 50) {
      trackingMessageLog.shift();
    }
    if (trackingMessageKeys.size > 1000) {
      trackingMessageKeys.clear();
      for (const item of trackingMessageLog) {
        const itemSignature = `${item.timestamp}|${item.device_id}|${item.action}|${JSON.stringify(item.payload)}`;
        trackingMessageKeys.add(itemSignature);
      }
    }
  }

  function applyTrackingMessageLog(data) {
    if (!data) return;

    if (Array.isArray(data.entries)) {
      trackingMessageLog.length = 0;
      trackingMessageKeys.clear();
      data.entries.slice(-50).forEach((entry) => appendTrackingMessage(entry));
    }

    if (data.entry && typeof data.entry === 'object') {
      appendTrackingMessage(data.entry);
    }

    renderTrackingMessageLog();
  }

  function classifyTrackingLogKind(entry) {
    const action = String(entry?.action || '').toLowerCase();
    const level = String(entry?.level || '').toLowerCase();
    if (level === 'error' || action.includes('error') || entry?.status === 'error') return 'error';
    if (action.includes('command')) return 'command';
    if (action.includes('location')) return 'location';
    if (action.includes('offline') || action.includes('session_end')) return 'offline';
    if (action.includes('online')) return 'online';
    return 'location';
  }

  function formatTrackingLogDetail(entry) {
    const payload = entry && typeof entry.payload === 'object' ? entry.payload : {};
    const lat = toNum(payload.latitude ?? payload.lat);
    const lon = toNum(payload.longitude ?? payload.lng);
    if (lat != null && lon != null) {
      return `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    }
    if (payload.error && typeof payload.error === 'string') {
      return payload.error;
    }
    if (payload.message && typeof payload.message === 'string') {
      return payload.message;
    }
    if (payload.status && typeof payload.status === 'string') {
      return payload.status;
    }
    if (payload.connected_at) return `connected ${fmtTime(payload.connected_at)}`;
    if (payload.disconnected_at) return `disconnected ${fmtTime(payload.disconnected_at)}`;
    const keys = Object.keys(payload);
    if (!keys.length) return '-';
    return keys.slice(0, 2).map((k) => `${k}:${String(payload[k])}`).join(' | ');
  }

  function renderTrackingMessageLog() {
    if (!trackingMessageLogEl) return;

    if (!trackingMessageLog.length) {
      trackingMessageLogEl.innerHTML = '<div class="tracking-log-empty">No tracking events yet.</div>';
      return;
    }

    const lines = trackingMessageLog.slice(-50).reverse();
    trackingMessageLogEl.innerHTML = lines.map((entry) => {
      const kind = classifyTrackingLogKind(entry);
      const detail = formatTrackingLogDetail(entry);
      return `<div class="tracking-log-line kind-${kind}">
        <span class="time">[${escapeHtml(fmtTime(entry.timestamp))}]</span>
        <span class="device">${escapeHtml(shortDeviceId(entry.device_id))}</span>
        <span class="action">${escapeHtml(String(entry.action || '').replace(/^command_(request|response|accepted|queued):/, '$1:'))}</span>
        <span class="detail">${escapeHtml(detail)}</span>
      </div>`;
    }).join('');
  }

  function setTrackingHint(message, isError = false) {
    if (!trackingMapHintEl) return;
    trackingMapHintEl.textContent = message;
    trackingMapHintEl.style.color = isError ? '#ffb3bb' : '#d9ecff';
  }

  function renderTrackingRequestBanners() {
    if (!trackingRequestsEl) return;
    const items = Array.from(trackingPendingRequests.values());
    if (!items.length) {
      trackingRequestsEl.innerHTML = '';
      return;
    }

    trackingRequestsEl.innerHTML = items.map((request) => `
      <div class="tracking-request-card" data-device-id="${escapeHtml(request.device_id)}" style="background:rgba(10,22,40,.9);border:1px solid rgba(0,200,255,.35);border-radius:10px;padding:10px 12px;box-shadow:0 6px 16px rgba(0,0,0,.25);">
        <div style="font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px;">Tracking request</div>
        <div style="font-size:.78rem;font-weight:700;color:var(--text);margin-bottom:2px;">${escapeHtml(request.device_id)}</div>
        <div style="font-size:.68rem;color:var(--muted);margin-bottom:8px;">Requested at: ${escapeHtml(request.requested_at || '-')}</div>
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

    try {
      if (window.trackingBridge && typeof window.trackingBridge.approve === 'function' && typeof window.trackingBridge.reject === 'function') {
        if (approved) {
          await window.trackingBridge.approve(targetDeviceId, {});
        } else {
          await window.trackingBridge.reject(targetDeviceId, {});
        }
      } else {
        const action = approved ? 'tracking_approved' : 'tracking_rejected';
        const payload = approved
          ? { approved_by: 'electron-admin', approved_at: new Date().toISOString() }
          : { reason: 'Permission denied by admin', denied_at: new Date().toISOString() };
        await api.sendCommand(action, payload, targetDeviceId);
      }
      trackingPendingRequests.delete(targetDeviceId);
      renderTrackingRequestBanners();
    } catch (err) {
      setTrackingHint(`Failed to respond to tracking request: ${err.message || 'Unknown error'}`, true);
    }
  }

  function ensureTrackingVisual(deviceId) {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return null;
    if (trackingVisuals.has(deviceId)) return trackingVisuals.get(deviceId);

    const color = getDeviceColor(deviceId);
    const marker = L.marker(TRACKING_MANILA_CENTER, {
      icon: buildDeviceIcon(color, true, false),
      opacity: 0,
    }).addTo(trackingMap);
    const routeLine = L.polyline([], {
      color,
      weight: 3,
      opacity: 0.85,
      lineCap: 'round',
      lineJoin: 'round',
    }).addTo(trackingMap);

    const visual = { marker, routeLine, color };
    trackingVisuals.set(deviceId, visual);
    return visual;
  }

  function updateTrackingVisual(deviceId) {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return;

    const device = trackingDevices.get(deviceId);
    if (!device) return;

    const visual = ensureTrackingVisual(deviceId);
    if (!visual) return;

    const loc = device.last_location;
    const hasLocation = loc && Number.isFinite(Number(loc.latitude)) && Number.isFinite(Number(loc.longitude));
    if (!hasLocation) {
      visual.marker.setOpacity(0);
      visual.routeLine.setLatLngs([]);
      return;
    }

    const lat = Number(loc.latitude);
    const lon = Number(loc.longitude);
    const isOnline = device.status === 'online';
    const isSelected = selectedTrackingDeviceId === deviceId;

    visual.marker.setOpacity(1);
    visual.marker.setIcon(buildDeviceIcon(visual.color, !isOnline, isSelected));
    visual.marker.setLatLng([lat, lon]);
    visual.marker.bindTooltip(`${deviceId} (${isOnline ? 'online' : 'offline'})`, { direction: 'top', offset: [0, -12] });

    const routeLatLngs = Array.isArray(device.route_points)
      ? device.route_points
        .filter((point) => Number.isFinite(Number(point.latitude)) && Number.isFinite(Number(point.longitude)))
        .map((point) => [Number(point.latitude), Number(point.longitude)])
      : [];

    visual.routeLine.setLatLngs(routeLatLngs);
    visual.routeLine.setStyle({
      color: isOnline ? visual.color : OFFLINE_MARKER_COLOR,
      opacity: isOnline ? 0.88 : 0.18,
      weight: isSelected ? 4 : 3,
    });
  }

  function refreshTrackingVisuals() {
    for (const deviceId of trackingDevices.keys()) {
      updateTrackingVisual(deviceId);
    }
  }

  function fitMapToOnlineDevices(force = false) {
    const trackingMap = getTrackingMap();
    if (!trackingMap) return;

    const points = Array.from(trackingDevices.values())
      .filter((device) => device.status === 'online' && device.last_location)
      .map((device) => {
        const lat = toNum(device.last_location.latitude);
        const lon = toNum(device.last_location.longitude);
        if (lat == null || lon == null) return null;
        return [lat, lon];
      })
      .filter(Boolean);

    if (!points.length) return;
    if (points.length === 1) {
      trackingMap.setView(points[0], Math.max(trackingMap.getZoom(), 14), { animate: true });
      return;
    }

    if (force) {
      trackingMap.fitBounds(L.latLngBounds(points), { padding: [34, 34], maxZoom: 15, animate: true });
      return;
    }

    trackingMap.fitBounds(L.latLngBounds(points), { padding: [34, 34], maxZoom: 15, animate: true });
  }

  function renderTrackingSummary() {
    const total = trackingDevices.size;
    const online = Array.from(trackingDevices.values()).filter((device) => device.status === 'online').length;

    if (mobileTrackingStatusEl) {
      if (!total) {
        mobileTrackingStatusEl.textContent = 'Waiting for device presence updates...';
      } else {
        mobileTrackingStatusEl.textContent = `${online} online / ${total} total device${total === 1 ? '' : 's'}`;
      }
    }

    if (mobileGpsCoordsEl) {
      if (!total) {
        mobileGpsCoordsEl.textContent = 'No active mobile tracking';
      } else {
        mobileGpsCoordsEl.textContent = `${online} online device${online === 1 ? '' : 's'} • ${total} seen`;
      }
    }
  }

  function renderTrackingCards() {
    if (!trackingCardsEl) return;

    const devices = Array.from(trackingDevices.values()).sort((a, b) => {
      if (a.status !== b.status) {
        return a.status === 'online' ? -1 : 1;
      }
      const aTs = new Date(a.last_seen || 0).getTime();
      const bTs = new Date(b.last_seen || 0).getTime();
      return bTs - aTs;
    });

    if (!devices.length) {
      trackingCardsEl.innerHTML = '<div class="tracking-device-empty">No devices seen yet. Device cards appear automatically when mobile apps connect.</div>';
      return;
    }

    trackingCardsEl.innerHTML = devices.map((device) => {
      const isOnline = device.status === 'online';
      const isSelected = selectedTrackingDeviceId === device.device_id;
      const lastLoc = device.last_location;
      const hasLoc = lastLoc && Number.isFinite(Number(lastLoc.latitude)) && Number.isFinite(Number(lastLoc.longitude));
      const coordsText = hasLoc
        ? `${Number(lastLoc.latitude).toFixed(5)}, ${Number(lastLoc.longitude).toFixed(5)}`
        : 'No coordinates yet';
      const statusText = isOnline
        ? 'online'
        : `offline - ${formatRelativeTime(device.last_seen || device.disconnected_at)}`;
      const recentMessages = Array.isArray(device.message_log) ? device.message_log.slice(-4).reverse() : [];

      return `<div class="tracking-device-card ${isOnline ? 'is-online' : 'is-offline'} ${isSelected ? 'is-selected' : ''}" data-device-id="${escapeHtml(device.device_id)}">
        <div class="tracking-device-top">
          <div class="tracking-device-id" title="${escapeHtml(device.device_id)}">${escapeHtml(shortDeviceId(device.device_id))}</div>
          <div class="tracking-status-wrap"><span class="tracking-status-dot ${isOnline ? 'online' : 'offline'}"></span><span>${escapeHtml(statusText)}</span></div>
        </div>
        <div class="tracking-device-meta">
          <div>Connected: ${escapeHtml(device.connected_at ? fmtTime(device.connected_at) : '-')}</div>
          <div>Last seen: ${escapeHtml(device.last_seen ? formatRelativeTime(device.last_seen) : '-')}</div>
          <div>Coords: ${escapeHtml(coordsText)}</div>
        </div>
        <div class="tracking-device-actions">
          <button type="button" class="tracking-action-btn" data-device-id="${escapeHtml(device.device_id)}" data-action="snapshot" ${isOnline ? '' : 'disabled'}>Take Snapshot</button>
          <button type="button" class="tracking-action-btn" data-device-id="${escapeHtml(device.device_id)}" data-action="get_gps" ${isOnline ? '' : 'disabled'}>Get GPS</button>
          <button type="button" class="tracking-action-btn" data-device-id="${escapeHtml(device.device_id)}" data-action="camera_on" ${isOnline ? '' : 'disabled'}>Cam On</button>
          <button type="button" class="tracking-action-btn" data-device-id="${escapeHtml(device.device_id)}" data-action="camera_off" ${isOnline ? '' : 'disabled'}>Cam Off</button>
        </div>
        ${isSelected ? `<div class="tracking-device-meta" style="margin-top:8px;border-top:1px dashed rgba(159,189,222,.25);padding-top:6px;">
          ${recentMessages.length
            ? recentMessages.map((entry) => `<div>[${escapeHtml(fmtTime(entry.timestamp))}] ${escapeHtml(entry.action || '-')}</div>`).join('')
            : '<div>No recent messages</div>'}
        </div>` : ''}
      </div>`;
    }).join('');

    trackingCardsEl.querySelectorAll('.tracking-device-card').forEach((cardEl) => {
      cardEl.addEventListener('click', () => {
        const deviceId = String(cardEl.getAttribute('data-device-id') || '').trim();
        if (!deviceId) return;
        selectedTrackingDeviceId = deviceId;
        renderTrackingCards();
        refreshTrackingVisuals();

        const visual = trackingVisuals.get(deviceId);
        if (visual && visual.marker && visual.marker.getOpacity() > 0) {
          const trackingMap = getTrackingMap();
          if (trackingMap) {
            trackingMap.setView(visual.marker.getLatLng(), Math.max(trackingMap.getZoom(), 15), { animate: true });
          }
        }
      });
    });

    trackingCardsEl.querySelectorAll('.tracking-action-btn').forEach((btn) => {
      btn.addEventListener('click', (evt) => {
        evt.stopPropagation();
        const deviceId = String(btn.getAttribute('data-device-id') || '').trim();
        const action = String(btn.getAttribute('data-action') || '').trim();
        void sendTrackingCommand(deviceId, action);
      });
    });
  }

  function initializeTrackingPanelUi() {
    if (trackingUiInitialized) return;
    trackingUiInitialized = true;

    const trackingMap = getTrackingMap();
    if (trackingMap) {
      trackingMap.setView(TRACKING_MANILA_CENTER, 12);
    }

    if (trackingLogToggleEl && trackingLogPanelEl) {
      trackingLogToggleEl.addEventListener('click', () => {
        const collapsed = trackingLogPanelEl.classList.contains('is-collapsed');
        setTrackingLogCollapsed(!collapsed);
      });
    }

    if (trackingPaneToggleEl && trackingDevicesPaneEl) {
      let startsCollapsed = true;
      try {
        const savedState = localStorage.getItem(TRACKING_PANE_COLLAPSED_KEY);
        startsCollapsed = savedState == null ? true : savedState === '1';
      } catch {
        startsCollapsed = true;
      }
      setTrackingPaneCollapsed(startsCollapsed);

      trackingPaneToggleEl.addEventListener('click', () => {
        const collapsed = trackingDevicesPaneEl.classList.contains('is-collapsed');
        setTrackingPaneCollapsed(!collapsed);
      });
    }

    renderTrackingSummary();
    renderTrackingCards();
    renderTrackingMessageLog();
    renderTrackingRequestBanners();
  }

  function updateTrackingDeviceFromLocation(deviceId, location, payload = {}) {
    if (!location) return;
    const state = ensureTrackingDeviceState(deviceId);
    if (!state) return;

    state.status = 'online';
    state.connected_at = state.connected_at || normalizeIsoTime(payload.connected_at, location.timestamp || new Date().toISOString());
    state.disconnected_at = null;
    state.last_seen = normalizeIsoTime(location.timestamp, new Date().toISOString());
    state.last_location = {
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      timestamp: normalizeIsoTime(location.timestamp, new Date().toISOString()),
    };

    if (!Array.isArray(state.route_points)) state.route_points = [];
    state.route_points.push({
      latitude: Number(location.latitude),
      longitude: Number(location.longitude),
      timestamp: state.last_location.timestamp,
      ts: Number(location.ts || Date.now()),
    });

    while (state.route_points.length > 2000) {
      state.route_points.shift();
    }
  }

  function mergeDeviceSnapshot(deviceId, snapshot = {}) {
    const state = ensureTrackingDeviceState(deviceId);
    if (!state) return null;

    state.status = snapshot.status === 'online' ? 'online' : (snapshot.status === 'offline' ? 'offline' : state.status);
    state.connected_at = normalizeIsoTime(snapshot.connected_at, state.connected_at);
    state.disconnected_at = normalizeIsoTime(snapshot.disconnected_at, state.disconnected_at);
    state.last_seen = normalizeIsoTime(snapshot.last_seen, state.last_seen);

    if (snapshot.last_location && typeof snapshot.last_location === 'object') {
      const lat = toNum(snapshot.last_location.latitude);
      const lon = toNum(snapshot.last_location.longitude);
      if (lat != null && lon != null) {
        state.last_location = {
          latitude: lat,
          longitude: lon,
          timestamp: normalizeIsoTime(snapshot.last_location.timestamp, state.last_location?.timestamp || new Date().toISOString()),
        };
      }
    }

    const routePoints = Array.isArray(snapshot.route_points)
      ? snapshot.route_points
      : (Array.isArray(snapshot.routePoints) ? snapshot.routePoints : null);
    if (routePoints) {
      state.route_points = routePoints
        .map((point) => ({
          latitude: toNum(point.latitude),
          longitude: toNum(point.longitude),
          timestamp: normalizeIsoTime(point.timestamp, new Date().toISOString()),
          ts: Number(point.ts || Date.now()),
        }))
        .filter((point) => point.latitude != null && point.longitude != null);
      while (state.route_points.length > 2000) state.route_points.shift();
    }

    if (Array.isArray(snapshot.message_log)) {
      state.message_log = snapshot.message_log.slice(-50);
    }

    return state;
  }

  function applyTrackingDevicesUpdate(data) {
    if (!data || typeof data !== 'object') return;

    const payload = data.devices && typeof data.devices === 'object' ? data.devices : data;
    const entries = Array.isArray(payload)
      ? payload.map((item) => [String(item?.device_id || '').trim(), item])
      : Object.entries(payload);

    entries.forEach(([deviceId, snapshot]) => {
      if (!deviceId || !snapshot || typeof snapshot !== 'object') return;
      mergeDeviceSnapshot(deviceId, snapshot);
    });

    if (Array.isArray(data.message_log)) {
      applyTrackingMessageLog({ entries: data.message_log });
    }

    renderTrackingSummary();
    renderTrackingCards();
    refreshTrackingVisuals();
    fitMapToOnlineDevices();
  }

  function applyDeviceLifecycle(action, deviceId, payload = {}) {
    const state = ensureTrackingDeviceState(deviceId);
    if (!state) return;

    if (action === 'device_online') {
      state.status = 'online';
      state.connected_at = state.connected_at || normalizeIsoTime(payload.connected_at, new Date().toISOString());
      state.disconnected_at = null;
      state.last_seen = normalizeIsoTime(payload.connected_at, new Date().toISOString());
      return;
    }

    if (action === 'device_offline' || action === 'tracking_session_end' || action === 'tracking_rejected') {
      const disconnectedAt = normalizeIsoTime(payload.disconnected_at || payload.denied_at, new Date().toISOString());
      state.status = 'offline';
      state.disconnected_at = disconnectedAt;
      state.last_seen = disconnectedAt;
    }
  }

  function handleCommandLifecycleEvent(sourceType, data = {}) {
    const deviceId = String(data?.device_id || '').trim();
    if (!deviceId) return;

    const actionName = String(data?.action || 'unknown').trim().toLowerCase();

    // Suppress transport-level accepted noise in UI logs.
    if (sourceType === 'command_accepted') {
      return;
    }

    if (sourceType === 'command_queued') {
      if (queuedLifecycleLoggedDevices.has(deviceId)) {
        return;
      }
      queuedLifecycleLoggedDevices.add(deviceId);
    }

    if (sourceType === 'command_response') {
      queuedLifecycleLoggedDevices.delete(deviceId);
    }

    const entry = {
      timestamp: new Date().toISOString(),
      device_id: deviceId,
      action: `${sourceType}:${actionName}`,
      payload: data,
      status: String(data?.status || '').trim().toLowerCase(),
      level: data?.status === 'error' ? 'error' : 'info',
    };
    appendTrackingMessage(entry);

    const state = ensureTrackingDeviceState(deviceId);
    if (state) {
      state.message_log.push(entry);
      while (state.message_log.length > 50) state.message_log.shift();
      state.last_seen = normalizeIsoTime(new Date().toISOString(), state.last_seen || new Date().toISOString());
    }

    renderTrackingCards();
    renderTrackingMessageLog();

    if (sourceType === 'command_response' && actionName === 'tracking_approved') {
      handleBackendDeviceEvent({ type: 'device_event', action: 'tracking_approved', ...data });
    }
    if (sourceType === 'command_response' && actionName === 'tracking_rejected') {
      handleBackendDeviceEvent({ type: 'device_event', action: 'tracking_rejected', ...data });
    }
  }

  async function sendTrackingCommand(deviceId, buttonAction) {
    const targetDeviceId = String(deviceId || '').trim();
    if (!targetDeviceId) return;

    const state = trackingDevices.get(targetDeviceId);
    if (!state || state.status !== 'online') {
      setTrackingHint(`Device ${shortDeviceId(targetDeviceId)} is offline`, true);
      return;
    }

    const command = (() => {
      if (buttonAction === 'snapshot') return { action: 'take_photo', payload: {} };
      if (buttonAction === 'get_gps') return { action: 'get_gps', payload: {} };
      if (buttonAction === 'camera_on') return { action: 'camera_on', payload: {} };
      if (buttonAction === 'camera_off') return { action: 'camera_off', payload: {} };
      return null;
    })();

    if (!command) return;

    try {
      if (window.trackingBridge && typeof window.trackingBridge.sendCommand === 'function') {
        await window.trackingBridge.sendCommand(targetDeviceId, command.action, command.payload);
      } else {
        await api.sendCommand(command.action, command.payload, targetDeviceId);
      }
      setTrackingHint(`Command sent: ${command.action} -> ${shortDeviceId(targetDeviceId)}`);
    } catch (err) {
      setTrackingHint(`Command failed for ${shortDeviceId(targetDeviceId)}: ${err.message || 'Unknown error'}`, true);
    }
  }

  function handleBackendDeviceEvent(event) {
    if (!event || typeof event !== 'object') return;

    const action = getTrackingAction(event);
    const deviceId = getTrackingDeviceId(event);
    if (!action || !deviceId) return;
    if (!isMobileTrackingDevice(deviceId)) return;

    const payload = getTrackingPayload(event);
    if (shouldSkipTrackingEvent(action, deviceId, payload)) return;

    initializeTrackingPanelUi();
    const state = ensureTrackingDeviceState(deviceId);
    if (!state) return;

    if (action === 'tracking_request') {
      trackingPendingRequests.set(deviceId, {
        device_id: deviceId,
        requested_at: payload?.payload?.requested_at || payload?.requested_at || new Date().toISOString(),
      });
      renderTrackingRequestBanners();
    }

    if (action === 'tracking_approved') {
      state.status = 'online';
      state.connected_at = state.connected_at || new Date().toISOString();
      state.last_seen = new Date().toISOString();
      trackingPendingRequests.delete(deviceId);
      renderTrackingRequestBanners();
    }

    if (action === 'tracking_rejected') {
      applyDeviceLifecycle(action, deviceId, payload);
      trackingPendingRequests.delete(deviceId);
      renderTrackingRequestBanners();
    }

    if (action === 'device_online' || action === 'device_offline' || action === 'tracking_session_end') {
      applyDeviceLifecycle(action, deviceId, payload);
      if (action === 'device_online') {
        queuedLifecycleLoggedDevices.delete(deviceId);
      }
    }

    if (action === 'location_update') {
      queuedLifecycleLoggedDevices.delete(deviceId);
      const location = getLocationFromEvent(event);
      if (location) {
        updateTrackingDeviceFromLocation(deviceId, location, payload);
      }
    }

    const entry = {
      timestamp: normalizeIsoTime(payload.timestamp || payload.connected_at || payload.disconnected_at, new Date().toISOString()),
      device_id: deviceId,
      action,
      payload,
    };
    appendTrackingMessage(entry);
    state.message_log.push(entry);
    while (state.message_log.length > 50) state.message_log.shift();

    renderTrackingSummary();
    renderTrackingCards();
    renderTrackingMessageLog();
    refreshTrackingVisuals();

    if (action === 'location_update' || action === 'device_online') {
      fitMapToOnlineDevices();
    }
  }

  initializeTrackingPanelUi();

  // --- reverse geocoding (Nominatim, cached) ---
  const _geocodeCache = new Map();
  const _geocodePendingByKey = new Map();
  const PH_TIMEZONE = 'Asia/Manila';
  const MANILA_WEATHER_FALLBACK = { lat: 14.5995, lon: 120.9842 };
  const WEATHER_REFRESH_MS = 5 * 60 * 1000;
  const WEATHER_RETRY_MS = 60 * 1000;
  const phTimeFormatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: PH_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  const phDateFormatter = new Intl.DateTimeFormat('en-PH', {
    timeZone: PH_TIMEZONE,
    weekday: 'short',
    month: 'short',
    day: '2-digit',
    year: 'numeric',
  });
  let lastWeatherKey = '';
  let lastWeatherFetchedAt = 0;
  let lastWeatherAttemptAt = 0;
  let lastWeatherSnapshot = null;
  let weatherPending = null;

  function setTextForIds(ids, text) {
    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    });
  }

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

  function updatePhilippinesClock() {
    const now = new Date();
    setTextForIds(['gps-ph-time', 'mobile-ph-time'], `PH Time: ${phTimeFormatter.format(now)}`);
    setTextForIds(['gps-ph-date', 'mobile-ph-date'], `PH Date: ${phDateFormatter.format(now)}`);
  }

  function getWeatherMeta(code, isDay) {
    switch (code) {
      case 0: return { icon: isDay ? '☀️' : '🌙', text: isDay ? 'Clear sky' : 'Clear night' };
      case 1: return { icon: isDay ? '🌤️' : '🌙', text: 'Mainly clear' };
      case 2: return { icon: '⛅', text: 'Partly cloudy' };
      case 3: return { icon: '☁️', text: 'Overcast' };
      case 45:
      case 48: return { icon: '🌫️', text: 'Foggy' };
      case 51:
      case 53:
      case 55:
      case 56:
      case 57: return { icon: '🌦️', text: 'Drizzle' };
      case 61:
      case 63:
      case 65:
      case 66:
      case 67:
      case 80:
      case 81:
      case 82: return { icon: '🌧️', text: 'Rain showers' };
      case 71:
      case 73:
      case 75:
      case 77:
      case 85:
      case 86: return { icon: '❄️', text: 'Snow' };
      case 95:
      case 96:
      case 99: return { icon: '⛈️', text: 'Thunderstorm' };
      default: return { icon: '⛅', text: 'Weather update' };
    }
  }

  function renderWeather(snapshot) {
    if (!snapshot) {
      setTextForIds(['gps-weather-desc', 'mobile-weather-desc'], 'Weather unavailable');
      return;
    }
    const meta = getWeatherMeta(snapshot.weatherCode, snapshot.isDay);
    setTextForIds(['gps-weather-icon', 'mobile-weather-icon'], meta.icon);
    setTextForIds(['gps-weather-temp', 'mobile-weather-temp'], `${Math.round(snapshot.temperature)}°C`);
    setTextForIds(['gps-weather-desc', 'mobile-weather-desc'], meta.text);
    setTextForIds(['gps-weather-humidity', 'mobile-weather-humidity'], `Humidity: ${Math.round(snapshot.humidity)}%`);
    setTextForIds(['gps-weather-wind', 'mobile-weather-wind'], `Wind: ${Math.round(snapshot.windSpeed)} km/h`);
  }

  function parseWeatherResponse(payload) {
    const current = payload && typeof payload.current === 'object' ? payload.current : null;
    if (!current) return null;

    const temperature = Number(current.temperature_2m);
    const humidity = Number(current.relative_humidity_2m);
    const weatherCode = Number(current.weather_code);
    const windSpeed = Number(current.wind_speed_10m);
    const isDay = Number(current.is_day) === 1;
    if (!Number.isFinite(temperature) || !Number.isFinite(humidity) || !Number.isFinite(weatherCode) || !Number.isFinite(windSpeed)) {
      return null;
    }

    return { temperature, humidity, weatherCode, windSpeed, isDay };
  }

  async function refreshSidebarWeather(lat, lon) {
    updatePhilippinesClock();

    const resolvedLat = Number.isFinite(lat) ? lat : MANILA_WEATHER_FALLBACK.lat;
    const resolvedLon = Number.isFinite(lon) ? lon : MANILA_WEATHER_FALLBACK.lon;
    const key = `${resolvedLat.toFixed(2)},${resolvedLon.toFixed(2)}`;
    const now = Date.now();

    if (lastWeatherSnapshot && key === lastWeatherKey && now - lastWeatherFetchedAt < WEATHER_REFRESH_MS) {
      renderWeather(lastWeatherSnapshot);
      return;
    }

    if (weatherPending && weatherPending.key === key) {
      await weatherPending.promise;
      return;
    }

    if (key === lastWeatherKey && now - lastWeatherAttemptAt < WEATHER_RETRY_MS) {
      renderWeather(lastWeatherSnapshot);
      return;
    }

    lastWeatherAttemptAt = now;

    const url = `https://api.open-meteo.com/v1/forecast?latitude=${resolvedLat.toFixed(4)}&longitude=${resolvedLon.toFixed(4)}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,is_day&timezone=${encodeURIComponent(PH_TIMEZONE)}`;
    const promise = (async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Weather API error: ${response.status}`);
        const payload = await response.json();
        const snapshot = parseWeatherResponse(payload);
        if (!snapshot) throw new Error('Invalid weather payload');

        lastWeatherKey = key;
        lastWeatherFetchedAt = Date.now();
        lastWeatherSnapshot = snapshot;
        renderWeather(snapshot);
      } catch (err) {
        console.warn('[Weather] Failed to refresh sidebar weather:', err && err.message ? err.message : err);
        renderWeather(lastWeatherSnapshot);
      } finally {
        weatherPending = null;
      }
    })();

    weatherPending = { key, promise };
    await promise;
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

  function collapseExpandedCameraCard(silent = false) {
    expandedCameraIndex = null;
    if (!cameraGrid) return;

    cameraGrid.classList.remove('has-expanded');
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      card.classList.remove('is-expanded');
      card.setAttribute('aria-expanded', 'false');
    });

    if (!silent) {
      setCameraActionIndicator('Camera view minimized to equal tiles.');
    }
  }

  function toggleCameraCardExpansion(card) {
    if (!cameraGrid || !card) return;

    const cameraIndex = String(card.getAttribute('data-camera-index') || '').trim();
    if (!cameraIndex) return;

    const shouldCollapse = expandedCameraIndex === cameraIndex && card.classList.contains('is-expanded');
    if (shouldCollapse) {
      collapseExpandedCameraCard(true);
      setCameraActionIndicator(`${getCameraTargetLabel(cameraIndex)} minimized. Click any tile to expand.`);
      return;
    }

    expandedCameraIndex = cameraIndex;
    cameraGrid.classList.add('has-expanded');
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((item) => {
      const isExpanded = item === card;
      item.classList.toggle('is-expanded', isExpanded);
      item.setAttribute('aria-expanded', isExpanded ? 'true' : 'false');
    });

    setCameraActionIndicator(`${getCameraTargetLabel(cameraIndex)} expanded. Click again to minimize.`);
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
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      const idx = card.getAttribute('data-camera-index');
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');

      card.addEventListener('click', () => {
        toggleCameraCardExpansion(card);
      });

      card.addEventListener('keydown', (evt) => {
        if (evt.key !== 'Enter' && evt.key !== ' ') return;
        evt.preventDefault();
        toggleCameraCardExpansion(card);
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
      const cardIndex = camera ? String(camera.index) : String(idx + 1);
      const isExpanded = expandedCameraIndex === cardIndex;
      const expandedClass = isExpanded ? ' is-expanded' : '';
      if (!camera) {
        return `
          <div class="cam-cell is-offline${expandedClass}" data-camera-index="${escapeHtml(cardIndex)}" role="button" tabindex="0" aria-expanded="${isExpanded ? 'true' : 'false'}" aria-label="Toggle ${escapeHtml(cameraTitle(camera, idx))}">
            <div class="cam-feed">
              <div class="cam-placeholder">
                <svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
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
        <div class="cam-cell${expandedClass}" data-camera-index="${escapeHtml(cardIndex)}" role="button" tabindex="0" aria-expanded="${isExpanded ? 'true' : 'false'}" aria-label="Toggle ${escapeHtml(cameraTitle(camera, idx))}">
          <div class="cam-feed">
            <img class="cam-feed-media" alt="${escapeHtml(cameraTitle(camera, idx))}" hidden>
            <div class="cam-placeholder">
              <svg width="50" height="50" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
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

    if (expandedCameraIndex) {
      const expandedCard = cameraGrid.querySelector(`.cam-cell[data-camera-index="${expandedCameraIndex}"]`);
      if (expandedCard) {
        cameraGrid.classList.add('has-expanded');
      } else {
        expandedCameraIndex = null;
        cameraGrid.classList.remove('has-expanded');
      }
    } else {
      cameraGrid.classList.remove('has-expanded');
    }

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

    void refreshSidebarWeather(lat, lon);

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

      // Keep the map where the user panned it.
      // Re-centering is now manual via the Center button (window.centerOnTracker).
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
    const hasSpeedData = lat !== null && lon !== null;
    if (speedEl) speedEl.textContent = hasSpeedData ? String(Math.round(speed)) : '—';
    if (statusEl) {
      if (!hasSpeedData) {
        statusEl.textContent = 'Waiting for GPS';
        statusEl.style.color = 'var(--muted)';
      } else if (speed > 60) {
        statusEl.textContent = 'Over limit';
        statusEl.style.color = 'var(--danger)';
      } else if (speed > 50) {
        statusEl.textContent = 'Near limit';
        statusEl.style.color = 'var(--warning)';
      } else {
        statusEl.textContent = 'Within limit';
        statusEl.style.color = 'var(--success)';
      }
    }
    if (gaugeFill) {
      const circumference = 2 * Math.PI * 27;
      if (!hasSpeedData) {
        gaugeFill.style.stroke = 'var(--muted)';
        gaugeFill.style.strokeDashoffset = String(circumference);
      } else {
        gaugeFill.style.stroke = speed > 60 ? 'var(--danger)' : (speed > 50 ? 'var(--warning)' : 'var(--primary)');
        gaugeFill.style.strokeDashoffset = String(circumference * (1 - Math.min(speed / 80, 1)));
      }
    }

    // --- live insights + quick snapshot ---
    const setSidebarText = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    const heartbeat = lastStatusData && typeof lastStatusData.heartbeat === 'object' ? lastStatusData.heartbeat : {};
    const latestTs = points.length > 0 ? points[points.length - 1].ts : (heartbeat.last_seen_ts || null);
    let packetAge = '--';
    if (latestTs) {
      const diff = Math.round((Date.now() - new Date(latestTs).getTime()) / 1000);
      if (Number.isFinite(diff)) {
        if (diff < 60) packetAge = `${diff}s ago`;
        else if (diff < 3600) packetAge = `${Math.floor(diff / 60)}m ago`;
        else packetAge = `${Math.floor(diff / 3600)}h ago`;
      }
    }

    let operatorLabel = 'Unavailable';
    const netLog = lastStatusData && lastStatusData.latest_network_log;
    if (netLog && netLog.operator && String(netLog.operator).trim()) {
      operatorLabel = String(netLog.operator).trim();
    } else if (lastStatusData && lastStatusData.COPS) {
      const match = String(lastStatusData.COPS).match(/,\s*"([^"]+)"/);
      if (match) operatorLabel = match[1];
    }

    const satNumber = Number(satCount);
    let signalDesc = 'Satellite count unavailable';
    if (Number.isFinite(satNumber)) {
      if (satNumber >= 10) signalDesc = 'Strong GNSS coverage';
      else if (satNumber >= 6) signalDesc = 'Stable GNSS coverage';
      else if (satNumber >= 3) signalDesc = 'Weak GNSS coverage';
      else signalDesc = 'Poor GNSS coverage';
    }
    if (lastStatusData && lastStatusData.CSQ_MEANING) {
      signalDesc = String(lastStatusData.CSQ_MEANING);
    }

    const movementDesc = !hasSpeedData
      ? 'No live coordinates yet'
      : (speed > 2 ? `Moving at ${Math.round(speed)} km/h` : 'Stationary');

    const sourceLabel = hasFix
      ? 'Live GPS fix'
      : (points.length > 0 ? 'Track fallback' : 'No fix');

    const trackerState = !hasSpeedData
      ? 'Awaiting signal'
      : (speed > 2 ? 'Moving' : 'Idle');

    const compactOperator = operatorLabel.length > 16
      ? `${operatorLabel.slice(0, 13)}...`
      : operatorLabel;

    setSidebarText('insight-signal-desc', signalDesc);
    setSidebarText('insight-signal-time', Number.isFinite(satNumber) ? `${satNumber} sat` : '--');
    setSidebarText('insight-move-desc', movementDesc);
    setSidebarText('insight-move-time', hasSpeedData ? `${Math.round(speed)} km/h` : '--');
    setSidebarText('insight-net-desc', operatorLabel === 'Unavailable' ? 'Waiting for network operator' : `Operator: ${operatorLabel}`);
    setSidebarText('insight-net-time', heartbeat.last_online_ago ? String(heartbeat.last_online_ago) : packetAge);

    setSidebarText('snapshot-source', sourceLabel);
    setSidebarText('snapshot-packet', packetAge);
    setSidebarText('snapshot-operator', compactOperator);
    setSidebarText('snapshot-state', trackerState);
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

  updatePhilippinesClock();
  setInterval(updatePhilippinesClock, 1000);

  void refreshSidebarWeather(null, null);
  setInterval(() => {
    const weatherLat = lastPanelData && Number.isFinite(lastPanelData.lat) ? lastPanelData.lat : null;
    const weatherLon = lastPanelData && Number.isFinite(lastPanelData.lon) ? lastPanelData.lon : null;
    void refreshSidebarWeather(weatherLat, weatherLon);
  }, WEATHER_REFRESH_MS);

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
