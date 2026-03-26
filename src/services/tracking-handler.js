'use strict';

const activeDevices = new Map();
const pendingRequests = new Map();

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

function ensureDeviceState(deviceId) {
  if (!activeDevices.has(deviceId)) {
    activeDevices.set(deviceId, {
      marker: null,
      routeLine: null,
      routePoints: [],
      lastUpdate: null,
      lastLat: null,
      lastLon: null,
    });
  }
  return activeDevices.get(deviceId);
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

  console.log(`[Tracking] Request from device: ${deviceId}`);
  client.emit('tracking:request', pendingRequests.get(deviceId));
}

function _onLocationUpdate(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const location = normalizeLocationPayload(msg);
  if (!Number.isFinite(location.latitude) || !Number.isFinite(location.longitude)) return;

  const state = ensureDeviceState(deviceId);
  const point = {
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
    ts: location.ts,
  };
  state.routePoints.push(point);
  state.lastUpdate = point.timestamp;
  state.lastLat = point.latitude;
  state.lastLon = point.longitude;

  console.log(`[Tracking] Location update from ${deviceId}: ${location.latitude}, ${location.longitude}`);
  client.emit('tracking:location', {
    device_id: deviceId,
    latitude: location.latitude,
    longitude: location.longitude,
    timestamp: location.timestamp,
    ts: location.ts,
    routePoints: state.routePoints,
  });
}

function _onSessionEnd(msg, client) {
  const deviceId = normalizeDeviceId(msg);
  if (!deviceId) return;

  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  const session = payload?.session || msg?.session || {};
  const duration = Number(session?.duration_seconds || 0);

  activeDevices.delete(deviceId);
  pendingRequests.delete(deviceId);

  console.log(`[Tracking] Session ended for ${deviceId}. Duration: ${duration}s`);
  client.emit('tracking:session_end', {
    device_id: deviceId,
    session,
  });
}

function handle(msg, client) {
  const action = normalizeAction(msg);
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
  client.emit('tracking:rejected', { device_id: target, payload: body, response: res });
  return res;
}

function getState() {
  return {
    activeDevices,
    pendingRequests,
  };
}

module.exports = {
  handle,
  approve,
  reject,
  getState,
};
