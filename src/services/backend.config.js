'use strict';

const dotenv = require('dotenv');
dotenv.config();

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
const DEFAULT_ADMIN_BEARER_TOKEN = 'C9EQlRRiBTWUCltF6yGBKIT0NXuW3OgZ';
const RAW_ADMIN_BEARER_TOKEN = String(process.env.ADMIN_BEARER_TOKEN || '').trim();
const ADMIN_BEARER_TOKEN = RAW_ADMIN_BEARER_TOKEN
  ? RAW_ADMIN_BEARER_TOKEN.replace(/^bearer\s+/i, '').trim()
  : DEFAULT_ADMIN_BEARER_TOKEN;

// Target device ID - leave empty unless a specific device target is needed
const TARGET_DEVICE_ID = process.env.TARGET_DEVICE_ID || '';

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
  commandQueueActiveWindowMs: Number(process.env.COMMAND_QUEUE_ACTIVE_WINDOW_MS || 120000),
  reconnectDelay: 3000,
  pingInterval: 25000,
};
