'use strict';

const { BrowserWindow } = require('electron');

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

function toPublicDevice(device) {
  if (!device) return null;
  return {
    device_id: device.device_id,
    status: device.status,
    connected_at: device.connected_at,
    last_seen: device.last_seen,
    last_location: device.last_location
      ? {
          latitude: Number(device.last_location.latitude),
          longitude: Number(device.last_location.longitude),
          timestamp: device.last_location.timestamp,
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
    latitude,
    longitude,
    timestamp,
  };

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

  sendToRenderer(client, 'mobile:device_offline', {
    ...toPublicDevice(device),
    payload: {
      device_id: deviceId,
      disconnected_at: disconnectedAt,
    },
  });
}

function handle(msg, client) {
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

function getDeviceList() {
  return Array.from(devices.values()).map((device) => toPublicDevice(device));
}

function getState() {
  return { devices };
}

module.exports = {
  handles,
  handle,
  getDeviceList,
  getState,
};
