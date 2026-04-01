'use strict';

const devices = new Map();
const pendingRequests = new Map();
const globalMessageLog = [];

const MAX_LOG_ENTRIES = 50;
const MAX_ROUTE_POINTS = 2000;

function normalizeAction(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(msg?.action || msg?.event || payload?.action || payload?.type || '').trim().toLowerCase();
}

function normalizeDeviceId(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(msg?.device_id || payload?.device_id || '').trim();
}

function normalizeLocationPayload(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const nested = payload && typeof payload.payload === 'object' ? payload.payload : null;
  const source = payload.latitude != null || payload.longitude != null
    ? payload
    : (nested && (nested.latitude != null || nested.longitude != null) ? nested : msg);

  return {
    latitude: Number(source?.latitude ?? source?.lat),
    longitude: Number(source?.longitude ?? source?.lng),
    timestamp: String(source?.timestamp || new Date().toISOString()),
    ts: Number(source?.ts || Date.now()),
  };
}

function normalizeIsoTime(value, fallback = null) {
  if (!value) return fallback;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toISOString();
}

function trimArray(arr, max) {
  if (!Array.isArray(arr)) return;
  if (arr.length <= max) return;
  arr.splice(0, arr.length - max);
}

function ensureDeviceState(deviceId) {
  if (!devices.has(deviceId)) {
    devices.set(deviceId, {
      device_id: deviceId,
      status: 'offline',
      connected_at: null,
      disconnected_at: null,
      last_seen: null,
      last_location: null,
      route_points: [],
      message_log: [],
    });
  }
  return devices.get(deviceId);
}

function toPublicDeviceState(device) {
  if (!device) return null;
  return {
    device_id: device.device_id,
    status: device.status,
    connected_at: device.connected_at,
    disconnected_at: device.disconnected_at,
    last_seen: device.last_seen,
    last_location: device.last_location,
    route_points: Array.isArray(device.route_points) ? [...device.route_points] : [],
    message_log: Array.isArray(device.message_log) ? [...device.message_log] : [],
  };
}

function getDevicesSnapshot() {
  const out = {};
  for (const [deviceId, state] of devices.entries()) {
    out[deviceId] = toPublicDeviceState(state);
  }
  return out;
}

function emitDevicesUpdate(client, updatedDeviceId = null) {
  client.emit('tracking:devices_update', {
    updated_device_id: updatedDeviceId,
    devices: getDevicesSnapshot(),
  });
}

function buildLogEntry(deviceId, action, payload = {}, metadata = {}) {
  return {
    timestamp: new Date().toISOString(),
    device_id: deviceId,
    action: String(action || 'unknown').trim().toLowerCase(),
    payload,
    ...metadata,
  };
}

function appendLog(deviceId, action, payload = {}, metadata = {}) {
  if (!deviceId) return null;
  const state = ensureDeviceState(deviceId);
  const entry = buildLogEntry(deviceId, action, payload, metadata);
  state.message_log.push(entry);
  trimArray(state.message_log, MAX_LOG_ENTRIES);

  globalMessageLog.push(entry);
  trimArray(globalMessageLog, MAX_LOG_ENTRIES);
  return entry;
}

function emitMessageLog(client, entry) {
  if (!entry) return;
  client.emit('tracking:message_log', {
    entry,
    entries: [...globalMessageLog],
  });
}

function markOnline(deviceId, payload = {}) {
  const state = ensureDeviceState(deviceId);
  const connectedAt = normalizeIsoTime(payload.connected_at, new Date().toISOString());
  state.status = 'online';
  state.connected_at = state.connected_at || connectedAt;
  state.disconnected_at = null;
  state.last_seen = connectedAt;
  return state;
}

function markOffline(deviceId, payload = {}) {
  const state = ensureDeviceState(deviceId);
  const disconnectedAt = normalizeIsoTime(payload.disconnected_at, new Date().toISOString());
  state.status = 'offline';
  state.disconnected_at = disconnectedAt;
  state.last_seen = disconnectedAt;
  return state;
}

function _onTrackingRequest(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const requestedAt = payload?.payload?.requested_at || payload?.requested_at || new Date().toISOString();
  pendingRequests.set(deviceId, {
    device_id: deviceId,
    requested_at: requestedAt,
    payload,
    received_at: Number(msg?.received_at || Date.now()),
  });

  const state = ensureDeviceState(deviceId);
  state.last_seen = normalizeIsoTime(requestedAt, new Date().toISOString());
  const logEntry = appendLog(deviceId, 'tracking_request', payload);

  console.log(`[Tracking] Request from device: ${deviceId}`);
  client.emit('tracking:request', pendingRequests.get(deviceId));
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, deviceId);
}

function _onDeviceOnline(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const state = markOnline(deviceId, payload);
  const logEntry = appendLog(deviceId, 'device_online', payload);

  client.emit('tracking:device_online', {
    device_id: deviceId,
    status: state.status,
    connected_at: state.connected_at,
    last_seen: state.last_seen,
    last_location: state.last_location,
  });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, deviceId);
}

function _onDeviceOffline(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const state = markOffline(deviceId, payload);
  const logEntry = appendLog(deviceId, 'device_offline', payload);

  client.emit('tracking:device_offline', {
    device_id: deviceId,
    status: state.status,
    disconnected_at: state.disconnected_at,
    last_seen: state.last_seen,
    last_location: state.last_location,
  });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, deviceId);
}

function _onLocationUpdate(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const location = normalizeLocationPayload(msg);
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return;

  const state = ensureDeviceState(deviceId);
  if (state.status !== 'online') {
    markOnline(deviceId, {
      connected_at: normalizeIsoTime(location.timestamp, new Date().toISOString()),
    });
  }

  const point = {
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
    ts: location.ts,
  };
  state.route_points.push(point);
  trimArray(state.route_points, MAX_ROUTE_POINTS);
  state.last_location = {
    latitude: point.latitude,
    longitude: point.longitude,
    timestamp: point.timestamp,
  };
  state.last_seen = normalizeIsoTime(point.timestamp, new Date().toISOString());
  const logEntry = appendLog(deviceId, 'location_update', {
    latitude: point.latitude,
    longitude: point.longitude,
    timestamp: point.timestamp,
  });

  console.log(`[Tracking] Location update from ${deviceId}: ${location.latitude}, ${location.longitude}`);
  client.emit('tracking:location', {
    device_id: deviceId,
    status: state.status,
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
    ts: location.ts,
    routePoints: state.route_points,
  });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, deviceId);
}

function _onSessionEnd(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const session = payload?.session || msg?.session || {};
  const duration = Number(session?.duration_seconds || 0);

  const state = markOffline(deviceId, {
    disconnected_at: payload?.disconnected_at || new Date().toISOString(),
  });
  pendingRequests.delete(deviceId);
  const logEntry = appendLog(deviceId, 'tracking_session_end', { session });

  console.log(`[Tracking] Session ended for ${deviceId}. Duration: ${duration}s`);
  client.emit('tracking:session_end', {
    device_id: deviceId,
    session,
  });
  client.emit('tracking:device_offline', {
    device_id: deviceId,
    status: state.status,
    disconnected_at: state.disconnected_at,
    last_seen: state.last_seen,
    last_location: state.last_location,
  });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, deviceId);
}

function handle(msg, client) {
  const action = normalizeAction(msg);
  if (!action) return;

  if (action === 'device_online') {
    _onDeviceOnline(msg, client);
    return;
  }
  if (action === 'device_offline') {
    _onDeviceOffline(msg, client);
    return;
  }
  if (action === 'tracking_request') {
    _onTrackingRequest(msg, client);
    return;
  }
  if (action === 'location_update') {
    _onLocationUpdate(msg, client);
    return;
  }
  if (action === 'tracking_session_end') {
    _onSessionEnd(msg, client);
    return;
  }

  const deviceId = normalizeDeviceId(msg);
  if (deviceId) {
    const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
    const logEntry = appendLog(deviceId, action, payload);
    emitMessageLog(client, logEntry);
    emitDevicesUpdate(client, deviceId);
  }
}

async function approve(deviceId, client, payload = {}) {
  const target = String(deviceId || '').trim();
  if (!target) throw new Error('deviceId is required');
  const body = {
    approved_by: 'electron-admin',
    approved_at: new Date().toISOString(),
    ...payload,
  };
  const res = await client.sendCommand('tracking_approved', body, target);
  pendingRequests.delete(target);
  const logEntry = appendLog(target, 'tracking_approved', body, { source: 'admin' });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, target);
  client.emit('tracking:approved', { device_id: target, payload: body, response: res });
  return res;
}

async function reject(deviceId, client, payload = {}) {
  const target = String(deviceId || '').trim();
  if (!target) throw new Error('deviceId is required');
  const body = {
    reason: 'Permission denied by admin',
    denied_at: new Date().toISOString(),
    ...payload,
  };
  const res = await client.sendCommand('tracking_rejected', body, target);
  pendingRequests.delete(target);
  const logEntry = appendLog(target, 'tracking_rejected', body, { source: 'admin' });
  emitMessageLog(client, logEntry);
  emitDevicesUpdate(client, target);
  client.emit('tracking:rejected', { device_id: target, payload: body, response: res });
  return res;
}

function recordCommandEvent(deviceId, action, payload = {}, metadata = {}, client = null) {
  const target = String(deviceId || '').trim();
  if (!target) return null;

  const state = ensureDeviceState(target);
  if (!state.last_seen) {
    state.last_seen = new Date().toISOString();
  }

  const logEntry = appendLog(target, action, payload, metadata);
  if (client) {
    emitMessageLog(client, logEntry);
    emitDevicesUpdate(client, target);
  }
  return logEntry;
}

function getDeviceList() {
  return getDevicesSnapshot();
}

function getMessageLog() {
  return [...globalMessageLog];
}

function getState() {
  return {
    devices,
    pendingRequests,
    globalMessageLog,
  };
}

module.exports = {
  handle,
  approve,
  reject,
  recordCommandEvent,
  getDeviceList,
  getMessageLog,
  getState,
};
