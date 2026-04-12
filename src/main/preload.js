const { contextBridge, ipcRenderer } = require('electron');

// =====================================================
// LEGACY Pi Bridge (Direct HTTP to Raspberry Pi)
// Kept for backward compatibility with existing code
// =====================================================

const BASE_CANDIDATES = [
  'http://raspi44:8000',
  'http://raspi44.local:8000',
  'http://10.10.218.109:8000',
];

let cachedBase = null;

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && payload.detail
        ? String(payload.detail)
        : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinaryDataUrl(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBase() {
  if (cachedBase) {
    try {
      await fetchJson(`${cachedBase}/status`, { method: 'GET' }, 3000);
      return cachedBase;
    } catch {
      cachedBase = null;
    }
  }

  for (const base of BASE_CANDIDATES) {
    try {
      await fetchJson(`${base}/status`, { method: 'GET' }, 3000);
      cachedBase = base;
      return base;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Pi backend unreachable. Tried: ${BASE_CANDIDATES.join(', ')}`);
}

async function request(path, method = 'GET', body = undefined, timeoutMs = 10000) {
  const base = await detectBase();
  const options = { method };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  return fetchJson(`${base}${path}`, options, timeoutMs);
}

// Legacy Pi Bridge API (direct HTTP)
contextBridge.exposeInMainWorld('piBridge', {
  detectBase,
  getStatus: () => request('/status', 'GET', undefined, 8000),
  getGpsLatest: () => request('/gps_latest', 'GET', undefined, 8000),
  getGpsTrack:  () => request('/gps_track',  'GET', undefined, 12000),
  getCameras:   () => request('/cameras',    'GET', undefined, 12000),
  getCameraSnapshot: async (cameraIndex) => {
    const base = await detectBase();
    return fetchBinaryDataUrl(`${base}/camera/${cameraIndex}/snapshot.jpg?t=${Date.now()}`, 15000);
  },
  getContacts:  () => request('/contacts',   'GET', undefined, 8000),
  getMessages:  () => request('/messages',   'GET', undefined, 8000),
  sendSms: (numbers, message) => request('/send_sms', 'POST', { to: numbers, message }, 20000),
});

// =====================================================
// NEW Backend Bridge (WebSocket via Central Server)
// Uses IPC to communicate with main process
// =====================================================

// Event listeners storage
const eventListeners = new Map();

// Set up event listener from main process
ipcRenderer.on('backend:event', (_event, data) => {
  const listeners = eventListeners.get(data.type) || [];
  listeners.forEach(callback => {
    try {
      callback(data);
    } catch (err) {
      console.error('[BackendBridge] Event handler error:', err);
    }
  });

  // Also notify 'all' listeners
  const allListeners = eventListeners.get('all') || [];
  allListeners.forEach(callback => {
    try {
      callback(data);
    } catch (err) {
      console.error('[BackendBridge] Event handler error:', err);
    }
  });
});

// Helper to unwrap IPC response
async function unwrapResponse(promise) {
  const result = await promise;
  if (result && result.success === false) {
    throw new Error(result.error || 'Unknown error');
  }
  return result?.data ?? result;
}

// Backend Bridge API (WebSocket via central server)
contextBridge.exposeInMainWorld('backendBridge', {
  // =====================
  // Connection Management
  // =====================

  connect: () => ipcRenderer.invoke('backend:connect'),
  disconnect: () => ipcRenderer.invoke('backend:disconnect'),
  getStatus: () => ipcRenderer.invoke('backend:status'),
  isConnected: () => ipcRenderer.invoke('backend:isConnected'),

  // =====================
  // GPS Commands
  // =====================

  getGps: () => unwrapResponse(ipcRenderer.invoke('backend:getGps')),
  getGpsTrack: (options) => unwrapResponse(ipcRenderer.invoke('backend:getGpsTrack', options)),

  // =====================
  // Camera Commands
  // =====================

  takePhoto: (options) => unwrapResponse(ipcRenderer.invoke('backend:takePhoto', options)),
  getCameras: () => unwrapResponse(ipcRenderer.invoke('backend:getCameras')),
  startRecording: (options) => unwrapResponse(ipcRenderer.invoke('backend:startRecording', options)),
  stopRecording: () => unwrapResponse(ipcRenderer.invoke('backend:stopRecording')),

  // =====================
  // SMS Commands
  // =====================

  getMessages: (options) => unwrapResponse(ipcRenderer.invoke('backend:getMessages', options)),
  getContacts: () => unwrapResponse(ipcRenderer.invoke('backend:getContacts')),
  sendSms: (to, message) => unwrapResponse(ipcRenderer.invoke('backend:sendSms', to, message)),

  // =====================
  // Call Commands
  // =====================

  makeCall: (number) => unwrapResponse(ipcRenderer.invoke('backend:makeCall', number)),
  getCallLog: (options) => unwrapResponse(ipcRenderer.invoke('backend:getCallLog', options)),

  // =====================
  // Device Info Commands
  // =====================

  getDeviceInfo: () => unwrapResponse(ipcRenderer.invoke('backend:getDeviceInfo')),
  getBatteryStatus: () => unwrapResponse(ipcRenderer.invoke('backend:getBatteryStatus')),

  // =====================
  // Generic Command
  // =====================

  sendCommand: (action, payload, deviceId) =>
    unwrapResponse(ipcRenderer.invoke('backend:sendCommand', action, payload, deviceId)),

  // =====================
  // USB / ADB Device Detection
  // =====================
  listAdbDevices: () => unwrapResponse(ipcRenderer.invoke('adb:listDevices')),
  getPreferredDevice: () => unwrapResponse(ipcRenderer.invoke('adb:getPreferredDevice')),

  // =====================
  // Event Handling
  // =====================

  on: (eventType, callback) => {
    if (!eventListeners.has(eventType)) {
      eventListeners.set(eventType, []);
    }
    eventListeners.get(eventType).push(callback);
  },

  off: (eventType, callback) => {
    const listeners = eventListeners.get(eventType);
    if (listeners) {
      const index = listeners.indexOf(callback);
      if (index !== -1) {
        listeners.splice(index, 1);
      }
    }
  },

  removeAllListeners: (eventType) => {
    if (eventType) {
      eventListeners.delete(eventType);
    } else {
      eventListeners.clear();
    }
  },
});

const TRACKING_RECEIVE_CHANNELS = new Set([
  'mobile:device_online',
  'mobile:device_offline',
  'mobile:location',
  // Legacy compatibility channels.
  'tracking:device_online',
  'tracking:device_offline',
  'tracking:location',
  'tracking:devices_update',
  'tracking:message_log',
  'tracking:request',
  'tracking:session_end',
  'tracking:approved',
  'tracking:rejected',
]);

const trackingEventListeners = new Map();

function addTrackingListener(channel, callback) {
  if (!TRACKING_RECEIVE_CHANNELS.has(channel)) {
    throw new Error(`Unsupported tracking channel: ${channel}`);
  }
  if (typeof callback !== 'function') {
    throw new Error('Tracking callback must be a function');
  }

  const wrapped = (_event, data) => {
    try {
      callback(data);
    } catch (err) {
      console.error('[TrackingBridge] Event handler error:', err);
    }
  };

  ipcRenderer.on(channel, wrapped);

  if (!trackingEventListeners.has(channel)) {
    trackingEventListeners.set(channel, new Map());
  }
  trackingEventListeners.get(channel).set(callback, wrapped);
}

function removeTrackingListener(channel, callback) {
  const listenersForChannel = trackingEventListeners.get(channel);
  if (!listenersForChannel) return;
  const wrapped = listenersForChannel.get(callback);
  if (!wrapped) return;

  ipcRenderer.removeListener(channel, wrapped);
  listenersForChannel.delete(callback);
  if (!listenersForChannel.size) {
    trackingEventListeners.delete(channel);
  }
}

contextBridge.exposeInMainWorld('trackingBridge', {
  on: (channel, callback) => addTrackingListener(channel, callback),
  off: (channel, callback) => removeTrackingListener(channel, callback),

  onDeviceOnline: (callback) => addTrackingListener('mobile:device_online', callback),
  onDeviceOffline: (callback) => addTrackingListener('mobile:device_offline', callback),
  onLocation: (callback) => addTrackingListener('mobile:location', callback),
  onDevicesUpdate: (callback) => addTrackingListener('tracking:devices_update', callback),
  onMessageLog: (callback) => addTrackingListener('tracking:message_log', callback),

  sendCommand: (deviceId, action, payload = {}) =>
    unwrapResponse(ipcRenderer.invoke('send-command', deviceId, action, payload)),
  getDeviceList: () => unwrapResponse(ipcRenderer.invoke('get-device-list')),
});

contextBridge.exposeInMainWorld('electronAPI', {
  on: (channel, cb) => ipcRenderer.on(channel, cb),
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  onMobileDeviceOnline: (callback) => addTrackingListener('mobile:device_online', callback),
  onMobileDeviceOffline: (callback) => addTrackingListener('mobile:device_offline', callback),
  onMobileLocation: (callback) => addTrackingListener('mobile:location', callback),
  getDeviceList: () => unwrapResponse(ipcRenderer.invoke('get-device-list')),
  sendCommand: (deviceId, action, payload = {}) =>
    unwrapResponse(ipcRenderer.invoke('send-command', deviceId, action, payload)),
});
