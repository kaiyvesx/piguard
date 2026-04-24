'use strict';

const { BrowserWindow } = require('electron');
const config = require('./backend.config');
const BACKEND_URL = String(config.httpBaseUrl || '').trim().replace(/\/+$/, '');

console.log('[LogPoller] Data source:', BACKEND_URL || 'not-configured');

let supabase = null;
try {
  supabase = require('./supabase');
} catch {
  supabase = null;
}

let pollInterval = null;
let pollInFlight = false;

const deviceCache = new Map();
const processedLogIds = new Set();
const processedResponseIds = new Set();
const lastSeenLogIdByDevice = new Map();

function nowIso() {
  return new Date().toISOString();
}

function buildSafeError(err, fallback = 'Unknown error') {
  if (!err) return fallback;
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  return fallback;
}

function sendToRenderer(channel, data) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, data);
  }
}

function trimSet(setRef, maxSize) {
  while (setRef.size > maxSize) {
    const first = setRef.values().next().value;
    if (first == null) break;
    setRef.delete(first);
  }
}

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function extractDeviceId(value) {
  if (typeof value === 'string') {
    const id = value.trim();
    return id || '';
  }
  if (value && typeof value === 'object') {
    const raw = value.device_id || value.deviceId || value.id;
    const id = String(raw || '').trim();
    return id;
  }
  return '';
}

function normalizePayload(log) {
  if (!log || typeof log !== 'object') return {};
  const payload = log.payload;

  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return payload;
  }

  if (typeof payload === 'string') {
    try {
      const parsed = JSON.parse(payload);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      return {};
    }
  }

  return log;
}

function getLogTimestamp(log, payload) {
  return (
    payload.timestamp ||
    payload.ts ||
    payload.recorded_at ||
    payload.event_at ||
    log.received_at ||
    log.created_at ||
    nowIso()
  );
}

function extractCoordinates(payload, fallback = null) {
  const source = payload && typeof payload === 'object' ? payload : {};

  const latitude = toFiniteNumber(
    source.latitude ??
    source.lat ??
    source.gps?.latitude ??
    source.gps?.lat ??
    source.location?.latitude ??
    source.location?.lat ??
    source.coords?.latitude ??
    source.coords?.lat
  );

  const longitude = toFiniteNumber(
    source.longitude ??
    source.lng ??
    source.lon ??
    source.gps?.longitude ??
    source.gps?.lng ??
    source.gps?.lon ??
    source.location?.longitude ??
    source.location?.lng ??
    source.location?.lon ??
    source.coords?.longitude ??
    source.coords?.lng ??
    source.coords?.lon
  );

  if (latitude == null || longitude == null) {
    return fallback;
  }

  return { latitude, longitude };
}

function buildLogId(log, payload, deviceId, index) {
  return (
    log.id ||
    log.log_id ||
    payload.id ||
    payload.log_id ||
    payload.request_id ||
    `${deviceId}_${log.received_at || payload.timestamp || payload.ts || index}`
  );
}

function getDeviceDefaults(deviceId) {
  const iso = nowIso();
  return {
    deviceId,
    userId: null,
    status: 'active',
    firstSeen: iso,
    lastSeen: iso,
    lat: null,
    lng: null,
    lastSeenLogId: null,
  };
}

function isNewDevice(deviceId) {
  return !deviceCache.has(deviceId);
}

function updateDeviceCache(deviceId, data = {}) {
  const id = extractDeviceId(deviceId);
  if (!id) return null;

  const existing = deviceCache.get(id) || getDeviceDefaults(id);

  const latitude = toFiniteNumber(data.lat ?? data.latitude ?? existing.lat);
  const longitude = toFiniteNumber(data.lng ?? data.longitude ?? existing.lng);

  const merged = {
    ...existing,
    ...data,
    deviceId: id,
    lat: latitude,
    lng: longitude,
    userId: data.userId != null ? data.userId : existing.userId,
    status: String(data.status || existing.status || 'active').trim() || 'active',
    lastSeen: data.lastSeen || nowIso(),
    lastSeenLogId: data.lastSeenLogId || existing.lastSeenLogId || null,
  };

  deviceCache.set(id, merged);
  return merged;
}

function getAllCachedDevices() {
  return Array.from(deviceCache.values())
    .sort((a, b) => new Date(b.lastSeen || 0).getTime() - new Date(a.lastSeen || 0).getTime())
    .map((device) => ({ ...device }));
}

function emitDevicesList() {
  const devices = getAllCachedDevices();
  if (!devices.length) return;

  sendToRenderer('mobile:devices_list', {
    devices,
    count: devices.length,
    timestamp: nowIso(),
  });
}

function emitDeviceOnline(deviceId, userId, connectedAt, status = 'active') {
  sendToRenderer('mobile:device_online', {
    deviceId,
    userId: userId || null,
    status,
    connectedAt: connectedAt || nowIso(),
  });
}

function ensureKnownDevice(deviceId, options = {}) {
  const id = extractDeviceId(deviceId);
  if (!id) return null;

  const discovered = isNewDevice(id);
  const device = updateDeviceCache(id, {
    userId: options.userId || null,
    status: options.status || 'active',
    lastSeen: options.lastSeen || nowIso(),
  });

  if (discovered) {
    console.log('[LogPoller] New device:', id);
    emitDeviceOnline(id, device.userId, options.lastSeen || nowIso(), device.status);
  }

  return device;
}

async function saveGpsIfPossible(deviceId, latitude, longitude, requestId) {
  if (!supabase || typeof supabase !== 'object') return;

  try {
    if (typeof supabase.upsertDevice === 'function') {
      await supabase.upsertDevice(deviceId, 'online', latitude, longitude);
    }
    if (typeof supabase.saveGpsLog === 'function') {
      await supabase.saveGpsLog(deviceId, latitude, longitude, requestId || null);
    }
  } catch (err) {
    console.warn('[LogPoller] Supabase GPS persistence failed:', buildSafeError(err));
  }
}

async function fetchWithAuth(path) {
  const endpoint = String(path || '').trim();
  if (!BACKEND_URL || !endpoint) return null;

  const url = `${BACKEND_URL}${endpoint}`;

  let controller = null;
  let timeout = null;
  let signal = null;

  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    signal = AbortSignal.timeout(5000);
  } else if (typeof AbortController !== 'undefined') {
    controller = new AbortController();
    signal = controller.signal;
    timeout = setTimeout(() => controller.abort(), 5000);
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.adminToken}`,
        'Content-Type': 'application/json',
      },
      signal,
    });

    if (response.status === 204) return null;

    if (!response.ok) {
      console.warn('[LogPoller] Request failed:', endpoint, response.status);
      return null;
    }

    const text = await response.text();
    if (!text || !text.trim()) return null;

    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  } catch (err) {
    console.warn('[LogPoller] Request failed:', endpoint, buildSafeError(err));
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function processLogs(logs) {
  if (!Array.isArray(logs) || logs.length === 0) return;

  const sorted = [...logs].reverse();

  for (const log of sorted) {
    const safeLog = log && typeof log === 'object' ? log : {};

    const logId = String(safeLog.id || '').trim();
    if (!logId) continue;
    if (processedLogIds.has(logId)) continue;
    processedLogIds.add(logId);

    if (processedLogIds.size > 2000) {
      const first = processedLogIds.values().next().value;
      if (first) processedLogIds.delete(first);
    }

    const deviceId = extractDeviceId(safeLog.device_id);
    if (!deviceId) continue;

    const payload = safeLog.payload && typeof safeLog.payload === 'object'
      ? safeLog.payload
      : {};

    const rawSeenAt = payload.timestamp || safeLog.timestamp || safeLog.ts || safeLog.received_at;
    const seenAt = Number.isFinite(Number(rawSeenAt))
      ? new Date(Number(rawSeenAt)).toISOString()
      : String(rawSeenAt || nowIso());

    if (isNewDevice(deviceId)) {
      console.log('[LogPoller] New device:', deviceId);
      updateDeviceCache(deviceId, {
        userId: payload.user_id || null,
        status: 'active',
      });
      sendToRenderer('mobile:device_online', {
        deviceId,
        connectedAt: payload.timestamp || seenAt,
        userId: payload.user_id || null,
      });
    }

    updateDeviceCache(deviceId, {
      userId: payload.user_id || null,
      status: 'active',
      lastSeen: seenAt,
      lastSeenLogId: logId,
    });
    lastSeenLogIdByDevice.set(deviceId, logId);

    const logType = String(safeLog.type || '').trim().toLowerCase();
    const payloadType = String(payload.type || '').trim().toLowerCase();
    const payloadAction = String(payload.action || '').trim().toLowerCase();

    const isLocationUpdate =
      logType === 'location_update' ||
      payloadType === 'location_update' ||
      payloadAction === 'location_update';

    if (!isLocationUpdate) continue;

    const rawLat = payload.latitude;
    const rawLng = payload.longitude;
    const latitude = toFiniteNumber(rawLat);
    const longitude = toFiniteNumber(rawLng);

    if (latitude == null || longitude == null) continue;

    console.log('[LogPoller] GPS from', deviceId, latitude, longitude);

    const gpsTs = payload.timestamp || seenAt;

    updateDeviceCache(deviceId, {
      lat: latitude,
      lng: longitude,
      userId: payload.user_id || null,
      status: 'active',
      lastGpsTimestamp: gpsTs,
      lastSeen: gpsTs,
      lastSeenLogId: logId,
    });

    sendToRenderer('mobile:location', {
      deviceId,
      latitude,
      longitude,
      timestamp: gpsTs,
      userId: payload.user_id || null,
    });

    try {
      if (supabase && typeof supabase.upsertDevice === 'function') {
        await supabase.upsertDevice(deviceId, 'online', latitude, longitude);
      }
      if (supabase && typeof supabase.saveGpsLog === 'function') {
        await supabase.saveGpsLog(deviceId, latitude, longitude, logId);
      }
    } catch (err) {
      console.error('[LogPoller] Supabase error:', buildSafeError(err));
    }
  }

  sendToRenderer('mobile:devices_list', {
    devices: getAllCachedDevices(),
    count: deviceCache.size,
  });
}

function normalizeDevicesResponse(data) {
  if (!data) return [];

  if (Array.isArray(data.devices)) return data.devices;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

async function fetchAndProcessDevices() {
  const data = await fetchWithAuth('/admin/devices');
  if (!data) return;

  const devices = normalizeDevicesResponse(data);
  console.log('[LogPoller] Known devices from server:', devices.length);

  for (const entry of devices) {
    const deviceId = extractDeviceId(entry);
    if (!deviceId) continue;

    const deviceObj = entry && typeof entry === 'object' ? entry : {};
    const userId = deviceObj.user_id || deviceObj.userId || null;
    const status = deviceObj.status || 'known';
    const lastSeen = deviceObj.last_seen || deviceObj.lastSeen || nowIso();

    ensureKnownDevice(deviceId, {
      userId,
      status,
      lastSeen,
    });

    const coords = extractCoordinates(deviceObj, null);
    if (coords) {
      updateDeviceCache(deviceId, {
        userId,
        status,
        lastSeen,
        lat: coords.latitude,
        lng: coords.longitude,
      });
    }
  }

  emitDevicesList();
}

function normalizeResponses(data) {
  if (!data) return [];

  if (Array.isArray(data.responses)) return data.responses;
  if (Array.isArray(data.data)) return data.data;
  if (Array.isArray(data)) return data;
  return [];
}

function buildResponseId(response, index) {
  return (
    response.id ||
    response.response_id ||
    response.request_id ||
    `${extractDeviceId(response.device_id || response.deviceId)}_${response.action || response.type || 'response'}_${response.executed_at || index}`
  );
}

async function processResponses(responseData) {
  const responses = normalizeResponses(responseData);
  if (!responses.length) return;

  for (let index = 0; index < responses.length; index += 1) {
    const response = responses[index] || {};
    const responseId = buildResponseId(response, index);
    if (processedResponseIds.has(responseId)) continue;

    processedResponseIds.add(responseId);
    trimSet(processedResponseIds, 5000);

    const deviceId = extractDeviceId(response.device_id || response.deviceId);
    if (!deviceId) continue;

    const result = response.result && typeof response.result === 'object' ? response.result : {};
    const payload = {
      ...response,
      ...result,
    };

    const coords = extractCoordinates(payload, null);
    if (!coords) continue;

    const action = String(response.action || '').trim().toLowerCase();
    const status = String(response.status || '').trim().toLowerCase();
    if (action !== 'get_gps' || status !== 'success') continue;

    const seenAt = response.executed_at || response.created_at || nowIso();

    ensureKnownDevice(deviceId, {
      userId: response.user_id || null,
      status: 'active',
      lastSeen: seenAt,
    });

    updateDeviceCache(deviceId, {
      userId: response.user_id || null,
      status: 'active',
      lastSeen: seenAt,
      lat: coords.latitude,
      lng: coords.longitude,
      lastSeenLogId: String(response.request_id || ''),
    });

    sendToRenderer('mobile:location', {
      deviceId,
      userId: response.user_id || null,
      latitude: coords.latitude,
      longitude: coords.longitude,
      timestamp: seenAt,
      requestId: response.request_id || null,
    });

    await saveGpsIfPossible(deviceId, coords.latitude, coords.longitude, response.request_id || null);
  }

  emitDevicesList();
}

async function poll() {
  if (pollInFlight) return;
  pollInFlight = true;

  console.log('[LogPoller] Polling admin logs...');

  try {
    await fetchAndProcessDevices();

    const logsData = await fetchWithAuth('/admin/logs?limit=100');
    if (logsData) {
      const logs = Array.isArray(logsData.logs)
        ? logsData.logs
        : (Array.isArray(logsData.data) ? logsData.data : []);
      await processLogs(logs);
    }

    const responsesData = await fetchWithAuth('/admin/responses');
    if (responsesData) {
      await processResponses(responsesData);
    }

    emitDevicesList();
  } catch (err) {
    console.warn('[LogPoller] Poll cycle failed:', buildSafeError(err));
  } finally {
    pollInFlight = false;
  }
}

function startPolling(intervalMs = 5000) {
  if (pollInterval) return;

  const safeInterval = Math.max(1000, Number(intervalMs) || 5000);
  console.log('[LogPoller] Data source:', BACKEND_URL || 'not-configured');
  console.log('[LogPoller] Starting - supports unlimited devices');

  poll().catch((err) => {
    console.warn('[LogPoller] Initial poll failed:', buildSafeError(err));
  });

  pollInterval = setInterval(() => {
    poll().catch((err) => {
      console.warn('[LogPoller] Poll failed:', buildSafeError(err));
    });
  }, safeInterval);
}

function stopPolling() {
  if (!pollInterval) return;
  clearInterval(pollInterval);
  pollInterval = null;
}

function getCachedDevices() {
  return getAllCachedDevices();
}

module.exports = {
  startPolling,
  stopPolling,
  getCachedDevices,
};
