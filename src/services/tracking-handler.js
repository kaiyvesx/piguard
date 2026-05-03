'use strict';

const { BrowserWindow } = require('electron');
const deviceStore = require('./device-store');
const {
  upsertDevice,
  saveGpsLog,
  saveCommandLog,
} = require('./supabase');

const devices = new Map();
const lastPersistedByDevice = new Map();
const trackingActiveByDevice = new Map();

const LOCATION_MOVEMENT_THRESHOLD_METERS = 10; // meters

function _deg2rad(deg) {
  return (deg * Math.PI) / 180;
}

function distanceMeters(lat1, lng1, lat2, lng2) {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return Infinity;
  const R = 6371000; // Earth radius meters
  const dLat = _deg2rad(lat2 - lat1);
  const dLon = _deg2rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(_deg2rad(lat1)) * Math.cos(_deg2rad(lat2))
    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function isRaspiDeviceId(deviceId) {
  return String(deviceId || '').trim().toLowerCase().startsWith('raspi');
}

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

function isValidLocation(latitude, longitude) {
  if (latitude == null || longitude == null) return false;
  // Reject obviously invalid zero coordinates which are often placeholders
  if (Math.abs(latitude) < 1e-6 && Math.abs(longitude) < 1e-6) return false;
  if (latitude < -90 || latitude > 90) return false;
  if (longitude < -180 || longitude > 180) return false;
  return true;
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

function setTrackingActive(deviceId, active) {
  const id = String(deviceId || '').trim();
  if (!id) return;
  trackingActiveByDevice.set(id, Boolean(active));
}

function isTrackingActive(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return false;
  return trackingActiveByDevice.get(id) === true;
}

function extractDeviceId(msg) {
  const direct = String(msg?.device_id || '').trim();
  if (direct) return direct;
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(payload.device_id || '').trim();
}

function shouldPersistLocation(deviceId, latitude, longitude) {
  const id = String(deviceId || '').trim();
  if (!id) return false;

  const cached = lastPersistedByDevice.get(id) || { at: 0, lat: null, lng: null };

  // Persist if we don't have a prior persisted location
  if (cached.lat == null || cached.lng == null) return true;

  // Otherwise persist only if movement exceeds threshold (meters)
  const meters = distanceMeters(cached.lat, cached.lng, latitude, longitude);
  return meters >= LOCATION_MOVEMENT_THRESHOLD_METERS;
}

function updatePersistedLocation(deviceId, latitude, longitude) {
  const id = String(deviceId || '').trim();
  if (!id) return;
  lastPersistedByDevice.set(id, {
    at: Date.now(),
    lat: latitude,
    lng: longitude,
  });
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
  const deviceId = extractDeviceId(msg) || String(payload.device_id || '').trim();
  if (!deviceId || isRaspiDeviceId(deviceId)) return;

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
    user_id: payload.user_id || payload.userId || null,
    first_seen: existing?.first_seen || connectedAt,
    connected_at: connectedAt,
    last_seen: connectedAt,
    last_location: existing?.last_location || device.last_location || null,
  });

  upsertDevice(deviceId, 'online')
    .catch((err) => logSupabaseError('upsertDevice(device_online)', err));

  sendToRenderer(client, 'mobile:device_online', {
    ...toPublicDevice(device),
    payload: {
      device_id: deviceId,
      connected_at: connectedAt,
    },
  });
}

function _onLocationUpdate(msg, client) {
  const deviceId = extractDeviceId(msg);
  if (!deviceId || isRaspiDeviceId(deviceId)) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const latitude = toNumber(payload.latitude ?? payload.lat);
  const longitude = toNumber(payload.longitude ?? payload.lng);
  if (latitude == null || longitude == null) return;
  if (!isValidLocation(latitude, longitude)) return;

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
    user_id: payload.user_id || payload.userId || null,
    status: 'online',
    first_seen: existing?.first_seen || timestamp,
    connected_at: device.connected_at || timestamp,
    last_seen: timestamp,
    last_location: device.last_location,
  });

  // Only persist to Supabase if the device has moved beyond the threshold
  // or the save interval has elapsed. This prevents flooding Supabase with
  // identical per-second coordinates.
  if (shouldPersistLocation(deviceId, latitude, longitude)) {
    saveGpsLog(deviceId, latitude, longitude, null)
      .catch((err) => logSupabaseError('saveGpsLog(location_update)', err));

    upsertDevice(deviceId, 'online', latitude, longitude)
      .catch((err) => logSupabaseError('upsertDevice(location_update)', err));

    updatePersistedLocation(deviceId, latitude, longitude);
  }

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
  const deviceId = extractDeviceId(msg) || String(payload.device_id || '').trim();
  if (!deviceId) return;

  const disconnectedAt = normalizeIsoTime(payload.disconnected_at, new Date().toISOString());
  const device = ensureDevice(deviceId);
  if (!device) return;

  device.status = 'offline';
  device.last_seen = disconnectedAt;
  deviceStore.updateDeviceStatus(deviceId, 'offline');
  setTrackingActive(deviceId, false);

  const lastLocation = device.last_location && typeof device.last_location === 'object'
    ? device.last_location
    : null;
  const latitude = lastLocation ? toNumber(lastLocation.latitude ?? lastLocation.lat) : null;
  const longitude = lastLocation ? toNumber(lastLocation.longitude ?? lastLocation.lng) : null;
  if (latitude != null && longitude != null) {
    upsertDevice(deviceId, 'offline', latitude, longitude)
      .catch((err) => logSupabaseError('upsertDevice(device_offline)', err));
  }

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
  const status = String(msg?.status || '').trim().toLowerCase();
  const deviceId = String(msg?.device_id || '').trim();
  if (!deviceId) return;

  const data = (msg && typeof msg.data === 'object' && msg.data)
    || (msg && typeof msg.result === 'object' && msg.result)
    || (msg && typeof msg.payload === 'object' && msg.payload)
    || {};
  const requestId = String(msg?.request_id || '').trim();
  const timestamp = new Date().toISOString();

  // Camera frame response
  if (action === 'camera_frame' || action === 'take_photo') {
    const frameBase64 = data.frame_base64
      || data.frame
      || data.jpeg_base64
      || data.image_base64
      || data.photo_base64
      || data.image
      || data.photo
      || null;
    if (!frameBase64) {
      sendToRenderer(client, 'mobile:camera_status', {
        deviceId,
        requestId: requestId || null,
        status: status || 'success',
        message: status === 'success'
          ? 'Camera command succeeded but no image payload was provided by device response.'
          : 'Camera command did not return an image.',
        timestamp,
      });
      return;
    }
    console.log('[TrackingHandler] Camera frame received', { deviceId, action, requestId: requestId || null, bytes: String(frameBase64).length });
    // forward to renderer
    sendToRenderer(client, 'mobile:camera_frame', {
      deviceId,
      frame_base64: String(frameBase64),
      requestId: requestId || null,
      timestamp,
    });
    return;
  }

  // GPS command response (backwards compatible)
  if (action !== 'get_gps') return;
  if (status !== 'success') return;

  const latitude = toNumber(data.lat ?? data.latitude);
  const longitude = toNumber(data.lng ?? data.longitude);
  if (latitude == null || longitude == null) return;
  if (!isValidLocation(latitude, longitude)) return;

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
    user_id: msg?.user_id || msg?.userId || null,
    status: 'online',
    first_seen: existing?.first_seen || timestamp,
    connected_at: device.connected_at || timestamp,
    last_seen: timestamp,
    last_location: device.last_location,
  });
  console.log('[TrackingHandler] Saved GPS to disk:', deviceId, latitude, longitude);
  if (shouldPersistLocation(deviceId, latitude, longitude)) {
    upsertDevice(deviceId, 'online', latitude, longitude)
      .catch((err) => logSupabaseError('upsertDevice', err));

    saveGpsLog(deviceId, latitude, longitude, requestId)
      .catch((err) => logSupabaseError('saveGpsLog', err));

    updatePersistedLocation(deviceId, latitude, longitude);
  }

  sendToRenderer(client, 'mobile:gps_response', {
    deviceId,
    lat: latitude,
    lng: longitude,
    requestId,
    timestamp,
  });

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

  if (action !== 'location_update') {
    console.log('[TrackingHandler] Handling:', msg?.action, 'from:', msg?.device_id || 'none');
  }

  if (action === 'device_online') {
    _onDeviceOnline(msg, client);
    return;
  }

  if (action === 'tracking_approved') {
    const deviceId = extractDeviceId(msg);
    if (deviceId) setTrackingActive(deviceId, true);
    return;
  }

  if (action === 'location_update') {
    _onLocationUpdate(msg, client);
    return;
  }

  if (action === 'tracking_session_end' || action === 'tracking_rejected') {
    const deviceId = extractDeviceId(msg);
    if (deviceId) {
      setTrackingActive(deviceId, false);
      const device = ensureDevice(deviceId);
      const lastLocation = device && device.last_location && typeof device.last_location === 'object'
        ? device.last_location
        : null;
      const latitude = lastLocation ? toNumber(lastLocation.latitude ?? lastLocation.lat) : null;
      const longitude = lastLocation ? toNumber(lastLocation.longitude ?? lastLocation.lng) : null;
      if (latitude != null && longitude != null) {
        upsertDevice(deviceId, 'offline', latitude, longitude)
          .catch((err) => logSupabaseError('upsertDevice(tracking_end)', err));
      }
    }
    return;
  }

  if (action === 'device_offline') {
    _onDeviceOffline(msg, client);
  }
}

function handleCommandResponse(msg, client) {
  recordCommandResponse(msg);
  const action = String(msg?.action || '').trim().toLowerCase();
  const status = String(msg?.status || '').trim().toLowerCase();
  const deviceId = String(msg?.device_id || '').trim();
  if (deviceId) {
    if (action === 'tracking_approved' && status === 'success') {
      setTrackingActive(deviceId, true);
    }
    if (action === 'tracking_rejected' || action === 'tracking_session_end') {
      setTrackingActive(deviceId, false);
    }
  }
  handle(msg, client);
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
