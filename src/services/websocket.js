'use strict';

const WebSocket = require('ws');
const EventEmitter = require('events');
const config = require('./backend.config');
const { getPreferredDeviceId, shouldAutoDetectTarget } = require('./adb');
const { executeAdbFallback } = require('./adb-fallback');

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
    this._adbTrackingTimer = null;
    this._adbTrackingActiveDeviceId = null;
    this._adbTrackingEmittedRequest = false;
    this._adbTrackingIntervalMs = Number(process.env.ADB_TRACK_INTERVAL_MS || 5000);
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

    if (type === 'device_event' || type === 'tracking_request' || type === 'location_update' || type === 'tracking_session_end') {
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
      this._startAdbTracking();
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
      console.log('[AdminWS] Command accepted:', msg.request_id);
      this.emit('command_accepted', msg);
      return;
    }

    // Handle command queued (device offline)
    if (type === 'command_queued') {
      console.log('[AdminWS] Command queued (device offline):', msg.request_id);
      const pending = this._pendingRequests.get(msg.request_id);
      if (pending) {
        // Try a local ADB fallback so USB-only mode can still return useful data.
        this._tryResolveWithAdbFallback(msg, pending);
      }
      this.emit('command_queued', msg);
      return;
    }

    // Handle command response from device
    if (type === 'command_response') {
      console.log('[AdminWS] Command response:', msg.request_id, msg.status);
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
    this._stopAdbTracking();

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

  _startAdbTracking() {
    this._stopAdbTracking();
    const intervalMs = Number.isFinite(this._adbTrackingIntervalMs) && this._adbTrackingIntervalMs > 0
      ? this._adbTrackingIntervalMs
      : 5000;

    // Poll ADB location for USB-only mode (no mobile ws client).
    this._adbTrackingTimer = setInterval(() => {
      this._adbTrackingTick().catch(() => {});
    }, intervalMs);
    this._adbTrackingTick().catch(() => {});
  }

  _stopAdbTracking() {
    if (this._adbTrackingTimer) {
      clearInterval(this._adbTrackingTimer);
      this._adbTrackingTimer = null;
    }
    if (this._adbTrackingActiveDeviceId) {
      this.emit('tracking:session_end', {
        device_id: this._adbTrackingActiveDeviceId,
        session: { ended_by: 'adb-tracking-stop' },
      });
    }
    this._adbTrackingActiveDeviceId = null;
    this._adbTrackingEmittedRequest = false;
  }

  async _adbTrackingTick() {
    if (!this._authenticated) return;
    const deviceId = await getPreferredDeviceId();
    if (!deviceId) {
      if (this._adbTrackingActiveDeviceId) {
        this.emit('tracking:session_end', {
          device_id: this._adbTrackingActiveDeviceId,
          session: { ended_by: 'adb-device-disconnected' },
        });
      }
      this._adbTrackingActiveDeviceId = null;
      this._adbTrackingEmittedRequest = false;
      return;
    }

    this._adbTrackingActiveDeviceId = deviceId;
    if (!this._adbTrackingEmittedRequest) {
      this._adbTrackingEmittedRequest = true;
      this.emit('tracking:request', {
        device_id: deviceId,
        requested_at: new Date().toISOString(),
        source: 'adb-live-tracking',
      });
    }

    const data = await executeAdbFallback('get_gps', {}, deviceId);
    if (!data || !Number.isFinite(data.lat) || !Number.isFinite(data.lng)) return;
    this.emit('tracking:location', {
      device_id: deviceId,
      latitude: data.lat,
      longitude: data.lng,
      timestamp: new Date().toISOString(),
      ts: Date.now(),
      source: 'adb-live-tracking',
    });
  }

  async _tryResolveWithAdbFallback(msg, pending) {
    const requestId = msg.request_id;
    try {
      const data = await executeAdbFallback(msg.action, {}, msg.device_id);
      clearTimeout(pending.timeout);
      this._pendingRequests.delete(requestId);
      if (data == null) {
        pending.resolve({ queued: true, ...msg });
        return;
      }
      const response = {
        type: 'command_response',
        request_id: requestId,
        device_id: msg.device_id,
        action: msg.action,
        status: 'success',
        data,
        via: 'adb-fallback',
      };
      console.log('[AdminWS] Resolved via ADB fallback:', msg.action, requestId);
      pending.resolve(response);
      this.emit('command_response', response);
    } catch (err) {
      clearTimeout(pending.timeout);
      this._pendingRequests.delete(requestId);
      pending.reject(new Error(`ADB fallback failed: ${err.message}`));
    }
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

      console.log('[AdminWS] Sending command:', action, reqId);
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
