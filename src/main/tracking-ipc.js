'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const trackingHandler = require('../services/tracking-handler');

let isRegistered = false;

function broadcast(channel, payload) {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

function normalizeDeviceId(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const nestedPayload = payload && typeof payload.payload === 'object' ? payload.payload : {};
  return String(payload.device_id || nestedPayload.device_id || '').trim();
}

function buildSafeError(err, fallback = 'Unknown error') {
  if (!err) return fallback;
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  return fallback;
}

function normalizeAction(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return String(payload.action || '')
    .trim()
    .toLowerCase();
}

function clearQueuedLogStateForDevice(deviceId, queuedLoggedDevices) {
  const id = String(deviceId || '').trim();
  if (!id) return;
  queuedLoggedDevices.delete(id);
}

function buildQueuedLogKey(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return '';
  // Collapse repetitive queued events to one log per device while it remains offline.
  return id;
}

function registerTrackingIPC(adminClient) {
  if (isRegistered) return;
  if (!adminClient) {
    throw new Error('registerTrackingIPC requires adminClient');
  }
  isRegistered = true;

  // Tracks which queued logs were already emitted during the current offline cycle.
  const queuedLoggedDevices = new Set();

  // Renderer -> Main command channels
  ipcMain.handle('tracking:approve', async (_event, deviceId, payload = {}) => {
    try {
      const data = await trackingHandler.approve(deviceId, adminClient, payload);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: buildSafeError(err, 'Failed to approve tracking') };
    }
  });

  ipcMain.handle('tracking:reject', async (_event, deviceId, payload = {}) => {
    try {
      const data = await trackingHandler.reject(deviceId, adminClient, payload);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: buildSafeError(err, 'Failed to reject tracking') };
    }
  });

  ipcMain.handle('send-command', async (_event, deviceId, action, payload = {}) => {
    const targetDeviceId = String(deviceId || '').trim();
    const commandAction = String(action || '').trim();

    if (!targetDeviceId) {
      return { success: false, error: 'deviceId is required' };
    }
    if (!commandAction) {
      return { success: false, error: 'action is required' };
    }

    try {
      const data = await adminClient.sendCommand(commandAction, payload, targetDeviceId);
      trackingHandler.recordCommandEvent(
        targetDeviceId,
        `command_request:${commandAction}`,
        payload,
        { direction: 'outbound', status: 'sent' },
        adminClient
      );
      return { success: true, data };
    } catch (err) {
      trackingHandler.recordCommandEvent(
        targetDeviceId,
        `command_request:${commandAction}`,
        payload,
        {
          direction: 'outbound',
          status: 'error',
          level: 'error',
          error: buildSafeError(err),
        },
        adminClient
      );
      return { success: false, error: buildSafeError(err, 'Failed to send command') };
    }
  });

  ipcMain.handle('get-device-list', async () => {
    try {
      return {
        success: true,
        data: {
          devices: trackingHandler.getDeviceList(),
          message_log: trackingHandler.getMessageLog(),
        },
      };
    } catch (err) {
      return { success: false, error: buildSafeError(err, 'Failed to fetch device list') };
    }
  });

  // Main event channels from tracking handler
  adminClient.on('tracking:device_online', (data) => {
    clearQueuedLogStateForDevice(data?.device_id, queuedLoggedDevices);
    broadcast('tracking:device_online', data);
  });

  adminClient.on('tracking:device_offline', (data) => {
    broadcast('tracking:device_offline', data);
  });

  adminClient.on('tracking:location', (data) => {
    clearQueuedLogStateForDevice(data?.device_id, queuedLoggedDevices);
    broadcast('tracking:location', data);
  });

  adminClient.on('tracking:devices_update', (data) => {
    broadcast('tracking:devices_update', data);
  });

  adminClient.on('tracking:message_log', (data) => {
    broadcast('tracking:message_log', data);
  });

  // Keep compatibility channels for existing tracking approval flow.
  adminClient.on('tracking:request', (data) => {
    broadcast('tracking:request', data);
  });

  adminClient.on('tracking:session_end', (data) => {
    broadcast('tracking:session_end', data);
  });

  adminClient.on('tracking:approved', (data) => {
    broadcast('tracking:approved', data);
  });

  adminClient.on('tracking:rejected', (data) => {
    broadcast('tracking:rejected', data);
  });

  // Feed command lifecycle results into tracking logs.
  adminClient.on('command_accepted', (_data) => {
    // "accepted" is transport-level noise for UI logs; keep command_response/queued as signal.
  });

  adminClient.on('command_response', (data) => {
    const deviceId = normalizeDeviceId(data);
    if (!deviceId) return;
    const queuedKey = buildQueuedLogKey(deviceId);
    if (queuedKey) queuedLoggedDevices.delete(queuedKey);

    const responseStatus = String(data.status || '').trim().toLowerCase() || 'done';
    trackingHandler.recordCommandEvent(
      deviceId,
      `command_response:${String(data.action || '').trim() || 'unknown'}`,
      data,
      {
        direction: 'inbound',
        status: responseStatus,
        level: responseStatus === 'error' ? 'error' : 'info',
      },
      adminClient
    );
  });

  adminClient.on('command_queued', (data) => {
    const deviceId = normalizeDeviceId(data);
    if (!deviceId) return;

    const action = normalizeAction(data);
    const queuedKey = buildQueuedLogKey(deviceId);
    if (queuedKey) {
      if (queuedLoggedDevices.has(queuedKey)) {
        return;
      }
      queuedLoggedDevices.add(queuedKey);
    }

    trackingHandler.recordCommandEvent(
      deviceId,
      `command_queued:${String(data.action || '').trim() || 'unknown'}`,
      data,
      { direction: 'inbound', status: 'queued', level: 'warning' },
      adminClient
    );
  });

  console.log('[TrackingIPC] Registered tracking IPC handlers');
}

module.exports = {
  registerTrackingIPC,
};
