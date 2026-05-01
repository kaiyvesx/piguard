'use strict';

const { BrowserWindow, ipcMain } = require('electron');
const trackingHandler = require('../services/tracking-handler');
const deviceStore = require('../services/device-store');
const logPoller = require('../services/log-poller');
const {
  loadAllDevices,
  loadGpsHistory,
  savePresenceHistoryLog,
  loadPresenceHistoryLogs,
} = require('../services/supabase');

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

function toFiniteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeSupabaseDevice(device, forceOffline = false) {
  if (!device || typeof device !== 'object') return null;

  const deviceId = String(device.device_id || '').trim();
  if (!deviceId) return null;

  const latitude = toFiniteNumber(device.last_lat);
  const longitude = toFiniteNumber(device.last_lng);
  const lastSeen = device.last_seen || device.first_seen || null;
  const rawStatus = String(device.status || '').trim().toLowerCase();
  const status = forceOffline
    ? 'offline'
    : (rawStatus === 'online' ? 'online' : 'offline');

  return {
    ...device,
    device_id: deviceId,
    status,
    connected_at: device.connected_at || null,
    last_seen: lastSeen,
    last_location: latitude != null && longitude != null
      ? {
          lat: latitude,
          lng: longitude,
          latitude,
          longitude,
          timestamp: lastSeen,
        }
      : null,
  };
}

function normalizePolledDevice(device) {
  if (!device || typeof device !== 'object') return null;

  const deviceId = String(device.deviceId || device.device_id || '').trim();
  if (!deviceId) return null;

  const latitude = toFiniteNumber(device.lat ?? device.latitude ?? device.last_lat);
  const longitude = toFiniteNumber(device.lng ?? device.longitude ?? device.last_lng);
  const lastSeen = device.lastSeen || device.last_seen || null;
  const connectedAt = device.firstSeen || device.connected_at || null;
  const rawStatus = String(device.status || 'offline').trim().toLowerCase();

  return {
    ...device,
    device_id: deviceId,
    status: rawStatus === 'online' || rawStatus === 'active' ? 'online' : rawStatus,
    connected_at: connectedAt,
    last_seen: lastSeen,
    user_id: device.userId || device.user_id || null,
    last_location: latitude != null && longitude != null
      ? {
          lat: latitude,
          lng: longitude,
          latitude,
          longitude,
          timestamp: lastSeen,
        }
      : null,
  };
}

function registerTrackingIPC(adminClient) {
  if (isRegistered) return;
  if (!adminClient) {
    throw new Error('registerTrackingIPC requires adminClient');
  }
  isRegistered = true;

  ipcMain.handle('get-device-list', async () => {
    try {
      const supabaseDevices = await loadAllDevices()
        .then((items) => items.map((item) => normalizeSupabaseDevice(item, true)).filter(Boolean))
        .catch((err) => {
          console.warn('[TrackingIPC] Failed to load Supabase devices for merge:', buildSafeError(err));
          return [];
        });

      const saved = deviceStore
        .getAllDevices()
        .map((item) => normalizeStoredDevice(item))
        .filter(Boolean);

      const active = trackingHandler.getDeviceList();
      const cached = logPoller
        .getCachedDevices()
        .map((item) => normalizePolledDevice(item))
        .filter(Boolean);

      const merged = new Map();

      for (const device of supabaseDevices) {
        merged.set(device.device_id, device);
      }

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

      for (const device of cached) {
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

  ipcMain.handle('get-cached-devices', () => {
    return logPoller.getCachedDevices();
  });

  ipcMain.handle('supabase:get-devices', async (event) => {
    try {
      const devices = await loadAllDevices()
        .then((items) => items.map((item) => normalizeSupabaseDevice(item, true)).filter(Boolean));

      if (event && event.sender && !event.sender.isDestroyed()) {
        event.sender.send('tracking:devices_update', devices);
      }

      return {
        success: true,
        data: devices,
      };
    } catch (err) {
      return {
        success: false,
        error: buildSafeError(err, 'Failed to load Supabase devices'),
        data: [],
      };
    }
  });

  ipcMain.handle('supabase:get-gps-history', async (_event, deviceId, limit = 50) => {
    const targetDeviceId = String(deviceId || '').trim();
    if (!targetDeviceId) {
      return { success: false, error: 'deviceId is required', data: [] };
    }

    try {
      const data = await loadGpsHistory(targetDeviceId, limit);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: buildSafeError(err, 'Failed to load GPS history'),
        data: [],
      };
    }
  });

  ipcMain.handle('supabase:save-presence-history', async (_event, entry = {}) => {
    try {
      await savePresenceHistoryLog(entry);
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: buildSafeError(err, 'Failed to save presence history'),
      };
    }
  });

  ipcMain.handle('supabase:get-presence-history', async (_event, options = {}) => {
    try {
      const data = await loadPresenceHistoryLogs(options);
      return { success: true, data };
    } catch (err) {
      return {
        success: false,
        error: buildSafeError(err, 'Failed to load presence history'),
        data: [],
      };
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

    const deviceRecord = deviceStore.getDevice(targetDeviceId) || null;
    const targetUserId = String(deviceRecord?.user_id || deviceRecord?.userId || '').trim();
    if (!targetUserId) {
      return { success: false, error: `user_id is required for ${targetDeviceId}` };
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      trackingHandler.recordCommandSent(targetDeviceId, commandAction, requestId);
      const data = await adminClient.sendCommand(commandAction, payload, targetUserId, requestId);
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

    const deviceRecord = deviceStore.getDevice(targetDeviceId) || null;
    const targetUserId = String(deviceRecord?.user_id || deviceRecord?.userId || '').trim();
    if (!targetUserId) {
      return { ok: false, error: `user_id is required for ${targetDeviceId}` };
    }

    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      trackingHandler.recordCommandSent(targetDeviceId, 'get_gps', requestId);
      await adminClient.sendCommand('get_gps', {}, targetUserId, requestId);
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
