'use strict';

const { ipcMain } = require('electron');
const { backendApi } = require('../services/api');
const backendConfig = require('../services/backend.config');
const { listAdbDevices, getPreferredDeviceId } = require('../services/adb');

// Track initialization state
let isInitialized = false;
const forwardingCleanupByWebContentsId = new Map();

/**
 * Initialize IPC handlers for backend communication.
 * Call this once when the app starts.
 */
function initializeIpcHandlers() {
  if (isInitialized) return;
  isInitialized = true;

  // =====================
  // Connection Management
  // =====================

  ipcMain.handle('backend:connect', async () => {
    try {
      await backendApi.connect();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:disconnect', () => {
    backendApi.disconnect();
    return { success: true };
  });

  ipcMain.handle('backend:status', () => {
    return backendApi.getStatus();
  });

  ipcMain.handle('backend:getHttpBaseUrl', () => {
    return backendConfig.httpBaseUrl || '';
  });

  ipcMain.handle('backend:isConnected', () => {
    return backendApi.isConnected();
  });

  // =====================
  // GPS Commands
  // =====================

  ipcMain.handle('backend:getGps', async () => {
    try {
      const data = await backendApi.getGps();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getGpsTrack', async (_event, options = {}) => {
    try {
      const data = await backendApi.getGpsTrack(options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // Camera Commands
  // =====================

  ipcMain.handle('backend:takePhoto', async (_event, options = {}) => {
    try {
      const data = await backendApi.takePhoto(options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getCameras', async () => {
    try {
      const data = await backendApi.getCameras();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:startRecording', async (_event, options = {}) => {
    try {
      const data = await backendApi.startRecording(options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:stopRecording', async () => {
    try {
      const data = await backendApi.stopRecording();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // SMS Commands
  // =====================

  ipcMain.handle('backend:getMessages', async (_event, options = {}) => {
    try {
      const data = await backendApi.getMessages(options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getContacts', async () => {
    try {
      const data = await backendApi.getContacts();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:sendSms', async (_event, to, message) => {
    try {
      const data = await backendApi.sendSms(to, message);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // Call Commands
  // =====================

  ipcMain.handle('backend:makeCall', async (_event, number) => {
    try {
      const data = await backendApi.makeCall(number);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getCallLog', async (_event, options = {}) => {
    try {
      const data = await backendApi.getCallLog(options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // Device Info Commands
  // =====================

  ipcMain.handle('backend:getDeviceInfo', async () => {
    try {
      const data = await backendApi.getDeviceInfo();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getBatteryStatus', async () => {
    try {
      const data = await backendApi.getBatteryStatus();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getAdminUsers', async () => {
    try {
      const data = await backendApi.getAdminUsers();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getAdminLocationsLatest', async () => {
    try {
      const data = await backendApi.getAdminLocationsLatest();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getAdminCommands', async () => {
    try {
      const data = await backendApi.getAdminCommands();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:getAdminResponses', async () => {
    try {
      const data = await backendApi.getAdminResponses();
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backend:sendRecordCommand', async (_event, target = {}, options = {}) => {
    try {
      const data = await backendApi.sendRecordCommand(target, options);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // Generic Command
  // =====================

  ipcMain.handle('backend:sendCommand', async (_event, action, payload = {}, deviceId = null) => {
    try {
      const data = await backendApi.sendCommand(action, payload, deviceId);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // =====================
  // USB / ADB Device Detection
  // =====================
  ipcMain.handle('adb:listDevices', async () => {
    try {
      const devices = await listAdbDevices();
      return { success: true, data: devices };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('adb:getPreferredDevice', async () => {
    try {
      const deviceId = await getPreferredDeviceId();
      return { success: true, data: { deviceId } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  console.log('[IPC] Backend handlers registered');
}

// Auto-initialize when loaded
initializeIpcHandlers();

// Set up event forwarding to renderer
function setupEventForwarding(mainWindow) {
  if (!mainWindow || !mainWindow.webContents) return;

  const webContents = mainWindow.webContents;
  const webContentsId = webContents.id;

  // did-finish-load can fire repeatedly for the same window; avoid re-subscribing.
  if (forwardingCleanupByWebContentsId.has(webContentsId)) return;

  const safeSend = (channel, payload) => {
    if (webContents.isDestroyed()) return;
    webContents.send(channel, payload);
  };

  const onConnected = () => {
    safeSend('backend:event', { type: 'connected' });
  };

  const onDisconnected = (data) => {
    safeSend('backend:event', { type: 'disconnected', ...data });
  };

  const onCommandAccepted = (data) => {
    safeSend('backend:event', { type: 'command_accepted', ...data });
  };

  const onCommandQueued = (data) => {
    safeSend('backend:event', { type: 'command_queued', ...data });
  };

  const onCommandResponse = (data) => {
    safeSend('backend:event', { type: 'command_response', ...data });
    if (data && data.action === 'tracking_approved') {
      safeSend('tracking:approved', data);
    }
    if (data && data.action === 'tracking_rejected') {
      safeSend('tracking:rejected', data);
    }
  };

  const onDeviceEvent = (data) => {
    safeSend('backend:event', { type: 'device_event', ...data });
  };

  const onTrackingRequest = (data) => {
    safeSend('tracking:request', data);
  };

  const onTrackingLocation = (data) => {
    safeSend('tracking:location', data);
  };

  const onTrackingSessionEnd = (data) => {
    safeSend('tracking:session_end', data);
  };

  const onTrackingApproved = (data) => {
    safeSend('tracking:approved', data);
  };

  const onTrackingRejected = (data) => {
    safeSend('tracking:rejected', data);
  };

  const onMessageLog = (data) => {
    safeSend('backend:event', { type: 'tracking:message_log', ...data });
  };

  const onError = (err) => {
    safeSend('backend:event', { type: 'error', message: err.message });
  };

  const subscriptions = [
    ['connected', onConnected],
    ['disconnected', onDisconnected],
    ['command_accepted', onCommandAccepted],
    ['command_queued', onCommandQueued],
    ['command_response', onCommandResponse],
    ['device_event', onDeviceEvent],
    ['tracking:request', onTrackingRequest],
    ['tracking:location', onTrackingLocation],
    ['tracking:session_end', onTrackingSessionEnd],
    ['tracking:approved', onTrackingApproved],
    ['tracking:rejected', onTrackingRejected],
    ['message_log', onMessageLog],
    ['error', onError],
  ];

  subscriptions.forEach(([eventName, handler]) => {
    backendApi.on(eventName, handler);
  });

  const cleanup = () => {
    if (!forwardingCleanupByWebContentsId.has(webContentsId)) return;
    subscriptions.forEach(([eventName, handler]) => {
      backendApi.off(eventName, handler);
    });
    forwardingCleanupByWebContentsId.delete(webContentsId);
  };

  forwardingCleanupByWebContentsId.set(webContentsId, cleanup);
  webContents.once('destroyed', cleanup);
  mainWindow.once('closed', cleanup);

  console.log('[IPC] Event forwarding set up for webContents', webContentsId);
  return;
}

module.exports = {
  initializeIpcHandlers,
  setupEventForwarding,
};
