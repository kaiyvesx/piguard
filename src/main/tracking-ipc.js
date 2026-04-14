'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const trackingHandler = require('../services/tracking-handler');
const deviceStore = require('../services/device-store');

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

function normalizeStoredDevice(device) {
  if (!device || typeof device !== 'object') return null;

  const deviceId = String(device.device_id || '').trim();
  if (!deviceId) return null;

  const rawLocation = device.last_location && typeof device.last_location === 'object'
    ? device.last_location
    : null;
  const latitude = rawLocation ? Number(rawLocation.latitude ?? rawLocation.lat) : NaN;
  const longitude = rawLocation ? Number(rawLocation.longitude ?? rawLocation.lng) : NaN;

  const normalized = {
    ...device,
    device_id: deviceId,
    status: String(device.status || '').trim().toLowerCase() === 'online' ? 'online' : 'offline',
  };

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    normalized.last_location = {
      lat: latitude,
      lng: longitude,
      latitude,
      longitude,
      timestamp: rawLocation.timestamp || device.last_seen || null,
    };
  } else {
    normalized.last_location = null;
  }

  return normalized;
}

function registerTrackingIPC(adminClient) {
  if (isRegistered) return;
  if (!adminClient) {
    throw new Error('registerTrackingIPC requires adminClient');
  }
  isRegistered = true;

  ipcMain.handle('get-device-list', async () => {
    try {
      const saved = deviceStore
        .getAllDevices()
        .map((item) => normalizeStoredDevice(item))
        .filter(Boolean);

      const active = trackingHandler.getDeviceList();

      const merged = new Map();

      for (const device of saved) {
        merged.set(device.device_id, device);
      }

      for (const device of active) {
        const deviceId = String(device?.device_id || '').trim();
        if (!deviceId) continue;

        const previous = merged.get(deviceId) || {};
        merged.set(deviceId, {
          ...previous,
          ...device,
          device_id: deviceId,
          last_location: device.last_location || previous.last_location || null,
        });
      }

      const data = Array.from(merged.values()).sort((a, b) => {
        const aOnline = a.status === 'online' ? 1 : 0;
        const bOnline = b.status === 'online' ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;

        const aSeen = new Date(a.last_seen || a.connected_at || 0).getTime();
        const bSeen = new Date(b.last_seen || b.connected_at || 0).getTime();
        return bSeen - aSeen;
      });

      return {
        success: true,
        data,
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

  ipcMain.handle('send-gps-command', async (_event, deviceId) => {
    const targetDeviceId = String(deviceId || '').trim();
    if (!targetDeviceId) {
      return { ok: false, error: 'deviceId is required' };
    }

    const requestId = `req-${Date.now()}`;

    try {
      await adminClient.sendCommand('get_gps', {}, targetDeviceId, requestId);
      return { ok: true, requestId };
    } catch (err) {
      return { ok: false, error: buildSafeError(err, 'Failed to send get_gps command') };
    }
  });

  adminClient.on('command_response', (data) => {
    trackingHandler.handleCommandResponse(data, adminClient);
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

  adminClient.on('mobile:gps_response', (data) => {
    broadcast('mobile:gps_response', data);
  });

  console.log('[TrackingIPC] Registered mobile tracking IPC handlers');
}

module.exports = {
  registerTrackingIPC,
};
