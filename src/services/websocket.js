'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('./backend.config');
const { getPreferredDeviceId, shouldAutoDetectTarget } = require('./adb');

let trackingHandler;
try {
  trackingHandler = require('./tracking-handler');
} catch {
  trackingHandler = {
    handle(msg) {
      const deviceId = msg?.device_id || msg?.payload?.device_id || 'unknown';
      const action = msg?.action || msg?.event || msg?.payload?.action || msg?.payload?.type;
      const payload = msg?.payload || {};
      if (action === 'tracking_request') {
        console.log(`[Tracking] Request from device: ${deviceId}`);
        return;
      }
      if (action === 'location_update') {
        const lat = payload?.latitude ?? payload?.lat ?? msg?.latitude ?? msg?.lat;
        const lon = payload?.longitude ?? payload?.lng ?? msg?.longitude ?? msg?.lng;
        console.log(`[Tracking] Location update from ${deviceId}: ${lat}, ${lon}`);
        return;
      }
      if (action === 'tracking_session_end') {
        const duration = payload?.session?.duration_seconds ?? msg?.session?.duration_seconds ?? 'unknown';
        console.log(`[Tracking] Session ended for ${deviceId}. Duration: ${duration}s`);
      }
    },
  };
}

/**
 * WebSocket client for admin connection to the backend server.
 * Handles authentication, commands, responses, and auto-reconnection.
 */
class AdminWebSocketClient extends EventEmitter {
  constructor() {
    super();
    this._ws = null;
    this._authenticated = false;
    this._reconnectTimer = null;
    this._pingTimer = null;
    this._pendingRequests = new Map(); // request_id -> { resolve, reject, timeout }
    this._connectionPromise = null;
    this._shouldReconnect = true;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._baseReconnectDelay = config.reconnectDelay;
    this._offlineLoggedDevices = new Set();
  }

  /**
   * Connect to the backend WebSocket server.
   * @param {boolean} resetAttempts - Reset reconnect attempts counter (default: true for manual connects)
   * @returns {Promise<void>} Resolves when authenticated and ready
   */
  async connect(resetAttempts = true) {
    if (this._ws && this._authenticated) {
      return;
    }

    if (this._connectionPromise) {
      return this._connectionPromise;
    }

    if (resetAttempts) {
      this._reconnectAttempts = 0;
    }
    this._shouldReconnect = true;
    this._connectionPromise = this._doConnect();

    try {
      await this._connectionPromise;
    } finally {
      this._connectionPromise = null;
    }
  }

  async _doConnect() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this._ws) {
          this._ws.terminate();
        }
        reject(new Error('Connection timeout'));
      }, config.connectionTimeout);

      console.log('[AdminWS] Connecting to', config.adminWsUrl);

      this._ws = new WebSocket(config.adminWsUrl);

      this._ws.on('open', () => {
        console.log('[AdminWS] Connected, sending hello');
        this._sendHello();
      });

      this._ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch (err) {
          console.error('[AdminWS] Invalid JSON:', err);
          return;
        }

        this._handleMessage(msg, resolve, reject, timeout);
      });

      this._ws.on('close', (code, reason) => {
        console.log('[AdminWS] Connection closed:', code, reason.toString());
        this._cleanup();
        clearTimeout(timeout);

        if (!this._authenticated) {
          reject(new Error(`Connection closed: ${code}`));
        }

        this._authenticated = false;
        this.emit('disconnected', { code, reason: reason.toString() });
        this._scheduleReconnect();
      });

      this._ws.on('error', (err) => {
        console.error('[AdminWS] WebSocket error:', err.message);
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  _sendHello() {
    if (!this._ws) return;

    this._ws.send(JSON.stringify({
      type: 'hello',
      role: 'admin',
      token: config.adminToken,
    }));
  }

  _handleMessage(msg, connectResolve, connectReject, connectTimeout) {
    const type = msg.type;

    if (type === 'device_event') {
      this._refreshOfflineLogState(msg);
      trackingHandler.handle(msg, this);
      this.emit('device_event', msg);
      return;
    }

    // Handle ready response (authentication successful)
    if (type === 'ready') {
      console.log('[AdminWS] Authenticated and ready');
      clearTimeout(connectTimeout);
      this._authenticated = true;
      this._reconnectAttempts = 0; // Reset on successful connection
      this._startPing();
      this.emit('connected');
      if (connectResolve) connectResolve();
      return;
    }

    // Handle pong response
    if (type === 'pong') {
      return;
    }

    // Handle command accepted acknowledgement
    if (type === 'accepted') {
      this.emit('command_accepted', msg);
      return;
    }

    // Handle command queued (device offline)
    if (type === 'command_queued') {
      this._logOfflineDevice(msg.device_id);
      const pending = this._pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this._pendingRequests.delete(msg.request_id);
        pending.reject(new Error(`${this._normalizeOfflineDeviceLabel(msg.device_id)} is offline`));
      }
      this.emit('command_queued', msg);
      return;
    }

    // Handle command response from device
    if (type === 'command_response') {
      this._clearOfflineLogForDevice(msg?.device_id);
      const pending = this._pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timeout);
        this._pendingRequests.delete(msg.request_id);

        if (msg.status === 'error') {
          pending.reject(new Error(msg.error?.message || 'Command failed'));
        } else {
          pending.resolve(msg);
        }
      }
      this.emit('command_response', msg);
      return;
    }

    // Handle error messages
    if (type === 'error') {
      console.error('[AdminWS] Server error:', msg.message);
      this.emit('error', new Error(msg.message));
      return;
    }

    // Unknown message type
    console.log('[AdminWS] Unknown message type:', type, msg);
  }

  _normalizeOfflineDeviceLabel(deviceId) {
    const raw = String(deviceId || '').trim();
    if (!raw) return 'mobile-01';
    const compact = raw.toLowerCase();
    if (compact.includes('mobile')) return raw;
    if (compact === '13e1b5b146eba495') return 'mobile-01';
    return raw;
  }

  _normalizeEventAction(msg) {
    const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
    return String(msg?.action || msg?.event || payload?.action || payload?.type || msg?.type || '')
      .trim()
      .toLowerCase();
  }

  _normalizeEventDeviceId(msg) {
    const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
    return String(msg?.device_id || payload?.device_id || '')
      .trim();
  }

  _clearOfflineLogForDevice(deviceId) {
    const label = this._normalizeOfflineDeviceLabel(deviceId);
    this._offlineLoggedDevices.delete(label);
  }

  _refreshOfflineLogState(msg) {
    const deviceId = this._normalizeEventDeviceId(msg);
    if (!deviceId) return;

    const action = this._normalizeEventAction(msg);
    // Once we see the device sending events again, allow a future offline log once.
    if (action === 'device_online' || action === 'location_update') {
      this._clearOfflineLogForDevice(deviceId);
    }
  }

  _logOfflineDevice(deviceId) {
    const label = this._normalizeOfflineDeviceLabel(deviceId);
    if (this._offlineLoggedDevices.has(label)) return;
    this._offlineLoggedDevices.add(label);
    console.log(`[AdminWS] ${label} is offline`);
  }

  _startPing() {
    this._stopPing();
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === WebSocket.OPEN) {
        this._ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, config.pingInterval);
  }

  _stopPing() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _cleanup() {
    this._stopPing();

    // Reject all pending requests
    for (const [requestId, pending] of this._pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Connection closed'));
    }
    this._pendingRequests.clear();
  }

  _scheduleReconnect() {
    if (!this._shouldReconnect) return;

    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      console.log(`[AdminWS] Max reconnect attempts (${this._maxReconnectAttempts}) reached. Stopping.`);
      this.emit('max_reconnect_reached');
      return;
    }

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }

    this._reconnectAttempts++;
    // Exponential backoff: delay doubles each attempt, capped at 30 seconds
    const delay = Math.min(
      this._baseReconnectDelay * Math.pow(2, this._reconnectAttempts - 1),
      30000
    );

    console.log(`[AdminWS] Reconnect attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts} in ${delay}ms...`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect(false).catch((err) => {
        console.error('[AdminWS] Reconnect failed:', err.message);
      });
    }, delay);
  }

  /**
   * Send a command to a device via the backend server.
   * @param {string} action - Command action (e.g., 'get_gps', 'take_photo')
   * @param {object} payload - Command payload
   * @param {string} [deviceId] - Target device ID (defaults to config)
   * @param {string} [requestId] - Custom request ID (auto-generated if not provided)
   * @returns {Promise<object>} Command response
   */
  async sendCommand(action, payload = {}, deviceId = null, requestId = null) {
    if (!this._ws || !this._authenticated) {
      await this.connect();
    }

    const reqId = requestId || `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    let devId = deviceId || config.targetDeviceId;
    if (!deviceId && shouldAutoDetectTarget()) {
      const adbDeviceId = await getPreferredDeviceId();
      if (adbDeviceId) {
        devId = adbDeviceId;
        console.log('[AdminWS] Auto-selected ADB device:', devId);
      }
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingRequests.delete(reqId);
        reject(new Error('Command timeout'));
      }, config.commandTimeout);

      this._pendingRequests.set(reqId, { resolve, reject, timeout });

      const msg = {
        type: 'command_request',
        device_id: devId,
        action,
        request_id: reqId,
        payload,
      };

      this._ws.send(JSON.stringify(msg));
    });
  }

  /**
   * Check if connected and authenticated.
   * @returns {boolean}
   */
  isConnected() {
    return this._ws && this._ws.readyState === WebSocket.OPEN && this._authenticated;
  }

  /**
   * Get reconnection status info.
   * @returns {{attempts: number, maxAttempts: number, canRetry: boolean}}
   */
  getReconnectInfo() {
    return {
      attempts: this._reconnectAttempts,
      maxAttempts: this._maxReconnectAttempts,
      canRetry: this._reconnectAttempts < this._maxReconnectAttempts,
    };
  }

  /**
   * Disconnect from the server.
   */
  disconnect() {
    this._shouldReconnect = false;

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    this._cleanup();

    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }

    this._authenticated = false;
    console.log('[AdminWS] Disconnected');
  }
}

// Singleton instance
const adminClient = new AdminWebSocketClient();

module.exports = {
  AdminWebSocketClient,
  adminClient,
};
