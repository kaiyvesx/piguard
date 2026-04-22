'use strict';

/**
 * Backend server configuration.
 *
 * For development, set ALLOW_UNAUTHENTICATED=true on the server
 * or use matching tokens here and in the server's .env file.
 */

// Backend server URL - change this to your server's address
const BACKEND_HTTP_URL = process.env.BACKEND_HTTP_URL || 'http://10.10.218.105:8000';
const BACKEND_WS_URL = process.env.BACKEND_WS_URL || 'ws://10.10.218.105:8000';

// Admin bearer token - must match ADMIN_BEARER_TOKEN in server's .env
const ADMIN_BEARER_TOKEN = process.env.ADMIN_BEARER_TOKEN || 'C9EQlRRiBTWUCltF6yGBKIT0NXuW3OgZ';

// Target device ID - the device to send commands to
const TARGET_DEVICE_ID = process.env.TARGET_DEVICE_ID || 'raspi-device-001';

module.exports = {
  // HTTP endpoints
  httpBaseUrl: BACKEND_HTTP_URL,
  healthEndpoint: `${BACKEND_HTTP_URL}/health`,
  adminCommandEndpoint: `${BACKEND_HTTP_URL}/admin/command`,

  // WebSocket endpoint for admin
  adminWsUrl: `${BACKEND_WS_URL}/ws/admin`,

  // Authentication
  adminToken: ADMIN_BEARER_TOKEN,

  // Device targeting
  targetDeviceId: TARGET_DEVICE_ID,

  // Timeouts (ms)
  connectionTimeout: 10000,
  commandTimeout: 30000,
  reconnectDelay: 3000,
  pingInterval: 25000,
};
