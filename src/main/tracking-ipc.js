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

function buildSafeError(err, fallback = 'Unknown error') {
  if (!err) return fallback;
  if (typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  return fallback;
}

function registerTrackingIPC(adminClient) {
  if (isRegistered) return;
  if (!adminClient) {
    throw new Error('registerTrackingIPC requires adminClient');
  }
  isRegistered = true;

  ipcMain.handle('get-device-list', async () => {
    try {
      return {
        success: true,
        data: trackingHandler.getDeviceList(),
      };
    } catch (err) {
      return { success: false, error: buildSafeError(err, 'Failed to fetch device list') };
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
      return { success: true, data };
    } catch (err) {
      return { success: false, error: buildSafeError(err, 'Failed to send command') };
    }
  });

  adminClient.on('mobile:device_online', (data) => {
    broadcast('mobile:device_online', data);
  });

  adminClient.on('mobile:device_offline', (data) => {
    broadcast('mobile:device_offline', data);
  });

  adminClient.on('mobile:location', (data) => {
    broadcast('mobile:location', data);
  });

  console.log('[TrackingIPC] Registered mobile tracking IPC handlers');
}

module.exports = {
  registerTrackingIPC,
};
