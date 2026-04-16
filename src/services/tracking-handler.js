'use strict';

const { BrowserWindow } = require('electron');
const deviceStore = require('./device-store');
const {
  upsertDevice,
  saveGpsLog,
  saveCommandLog,
} = require('./supabase');

const devices = new Map();

function handles(messageOrType) {
  const type = typeof messageOrType === 'string'
    ? messageOrType
    : String(messageOrType?.type || '');

  return type.trim().toLowerCase() === 'device_event';
}

function normalizeAction(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(msg?.action || msg?.event || payload?.action || payload?.type || '')
    .trim()
    .toLowerCase();
}

function normalizeIsoTime(value, fallback = null) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed.toISOString();
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function ensureDevice(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return null;

  if (!devices.has(id)) {
    devices.set(id, {
      device_id: id,
      status: 'offline',
      connected_at: null,
      last_seen: null,
      last_location: null,
    });
  }

  return devices.get(id);
}

function logSupabaseError(scope, err) {
  const message = err && err.message ? err.message : String(err || 'Unknown error');
  console.warn(`[TrackingHandler] Supabase ${scope} failed:`, message);
}

function recordCommandSent(deviceId, action, requestId) {
  const id = String(deviceId || '').trim();
  const commandAction = String(action || '').trim().toLowerCase();
  if (!id || !commandAction) return;

  saveCommandLog(id, commandAction, requestId, 'sent')
    .catch((err) => logSupabaseError('saveCommandLog(sent)', err));
}

function recordCommandResponse(msg) {
  const id = String(msg?.device_id || '').trim();
  const action = String(msg?.action || '').trim().toLowerCase();
  if (!id || !action) return;

  const requestId = String(msg?.request_id || '').trim();
  const status = String(msg?.status || '').trim().toLowerCase() || 'unknown';

  saveCommandLog(id, action, requestId, status)
    .catch((err) => logSupabaseError('saveCommandLog(response)', err));
}

function toPublicDevice(device) {
  if (!device) return null;
  const lastLocation = device.last_location && typeof device.last_location === 'object'
    ? device.last_location
    : null;
  const latitude = lastLocation ? toNumber(lastLocation.latitude ?? lastLocation.lat) : null;
  const longitude = lastLocation ? toNumber(lastLocation.longitude ?? lastLocation.lng) : null;

  return {
    device_id: device.device_id,
    status: device.status,
    connected_at: device.connected_at,
    last_seen: device.last_seen,
    last_location: latitude != null && longitude != null
      ? {
          lat: latitude,
          lng: longitude,
          latitude,
          longitude,
          timestamp: lastLocation.timestamp,
        }
      : null,
  };
}

function sendToRenderer(client, channel, data) {
  if (client && typeof client.emit === 'function') {
    client.emit(channel, data);
    return;
  }

  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, data);
  }
}

function _onDeviceOnline(msg, client) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const deviceId = String(payload.device_id || '').trim();
  if (!deviceId) return;

  const connectedAt = normalizeIsoTime(payload.connected_at, new Date().toISOString());
  const device = ensureDevice(deviceId);
  if (!device) return;

  device.status = 'online';
  device.connected_at = connectedAt;
  device.last_seen = connectedAt;

  const existing = deviceStore.getDevice(deviceId);
  deviceStore.saveDevice(deviceId, {
    device_id: deviceId,
    status: 'online',
    first_seen: existing?.first_seen || connectedAt,
    connected_at: connectedAt,
    last_seen: connectedAt,
    last_location: existing?.last_location || device.last_location || null,
  });

  sendToRenderer(client, 'mobile:device_online', {
    ...toPublicDevice(device),
    payload: {
      device_id: deviceId,
      connected_at: connectedAt,
    },
  });
}

function _onLocationUpdate(msg, client) {
  const deviceId = String(msg?.device_id || '').trim();
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const latitude = toNumber(payload.latitude ?? payload.lat);
  const longitude = toNumber(payload.longitude ?? payload.lng);
  if (latitude == null || longitude == null) return;

  const timestamp = normalizeIsoTime(payload.timestamp, new Date().toISOString());
  const device = ensureDevice(deviceId);
  if (!device) return;

  if (!device.connected_at) {
    device.connected_at = timestamp;
  }
  device.status = 'online';
  device.last_seen = timestamp;
  device.last_location = {
    lat: latitude,
    lng: longitude,
    latitude,
    longitude,
    timestamp,
  };

  const existing = deviceStore.getDevice(deviceId);
  deviceStore.updateDeviceLocation(deviceId, latitude, longitude);
  deviceStore.saveDevice(deviceId, {
    device_id: deviceId,
    status: 'online',
    first_seen: existing?.first_seen || timestamp,
    connected_at: device.connected_at || timestamp,
    last_seen: timestamp,
    last_location: device.last_location,
  });

  sendToRenderer(client, 'mobile:location', {
    ...toPublicDevice(device),
    payload: {
      latitude,
      longitude,
      timestamp,
    },
  });
}

function _onDeviceOffline(msg, client) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const deviceId = String(payload.device_id || '').trim();
  if (!deviceId) return;

  const disconnectedAt = normalizeIsoTime(payload.disconnected_at, new Date().toISOString());
  const device = ensureDevice(deviceId);
  if (!device) return;

  device.status = 'offline';
  device.last_seen = disconnectedAt;
  deviceStore.updateDeviceStatus(deviceId, 'offline');

  sendToRenderer(client, 'mobile:device_offline', {
    ...toPublicDevice(device),
    payload: {
      device_id: deviceId,
      disconnected_at: disconnectedAt,
    },
  });
}

function _onGpsCommandResponse(msg, client) {
  const action = String(msg?.action || '').trim().toLowerCase();
  if (action !== 'get_gps') return;

  const status = String(msg?.status || '').trim().toLowerCase();
  if (status !== 'success') return;

  const deviceId = String(msg?.device_id || '').trim();
  if (!deviceId) return;

  const data = msg && typeof msg.data === 'object' ? msg.data : {};
  const latitude = toNumber(data.lat ?? data.latitude);
  const longitude = toNumber(data.lng ?? data.longitude);
  if (latitude == null || longitude == null) return;

  const timestamp = new Date().toISOString();
  const requestId = String(msg?.request_id || '').trim();

  const device = ensureDevice(deviceId);
  if (!device) return;

  if (!device.connected_at) {
    device.connected_at = timestamp;
  }
  device.status = 'online';
  device.last_seen = timestamp;
  device.last_location = {
    lat: latitude,
    lng: longitude,
    latitude,
    longitude,
    timestamp,
  };

  const existing = deviceStore.getDevice(deviceId);
  deviceStore.updateDeviceLocation(deviceId, latitude, longitude);
  deviceStore.saveDevice(deviceId, {
    device_id: deviceId,
    status: 'online',
    first_seen: existing?.first_seen || timestamp,
    connected_at: device.connected_at || timestamp,
    last_seen: timestamp,
    last_location: device.last_location,
  });
  console.log('[TrackingHandler] Saved GPS to disk:', deviceId, latitude, longitude);

  upsertDevice(deviceId, 'online', latitude, longitude)
    .catch((err) => logSupabaseError('upsertDevice', err));

  saveGpsLog(deviceId, latitude, longitude, requestId)
    .catch((err) => logSupabaseError('saveGpsLog', err));

  sendToRenderer(client, 'mobile:gps_response', {
    deviceId,
    lat: latitude,
    lng: longitude,
    requestId,
    timestamp,
  });

  // Keep compatibility with the current renderer tracking flow.
  sendToRenderer(client, 'mobile:location', {
    ...toPublicDevice(device),
    payload: {
      latitude,
      longitude,
      timestamp,
      request_id: requestId,
      source: 'command_response',
    },
  });
}

function handle(msg, client) {
  const type = String(msg?.type || '').trim().toLowerCase();
  if (type === 'command_response') {
    _onGpsCommandResponse(msg, client);
    return;
  }

  const action = normalizeAction(msg);
  if (!action) return;

  if (action === 'device_online') {
    _onDeviceOnline(msg, client);
    return;
  }

  if (action === 'location_update') {
    _onLocationUpdate(msg, client);
    return;
  }

  if (action === 'device_offline') {
    _onDeviceOffline(msg, client);
  }
}

function handleCommandResponse(msg, client) {
  recordCommandResponse(msg);
  _onGpsCommandResponse(msg, client);
}

function getDeviceList() {
  return Array.from(devices.values()).map((device) => toPublicDevice(device));
}

function getState() {
  return { devices };
}

module.exports = {
  handles,
  handle,
  handleCommandResponse,
  recordCommandSent,
  getDeviceList,
  getState,
};
