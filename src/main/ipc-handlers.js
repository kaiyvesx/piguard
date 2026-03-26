'use strict';

const { ipcMain } = require('electron');
const { backendApi } = require('../services/api');

// Track initialization state
let isInitialized = false;

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

  console.log('[IPC] Backend handlers registered');
}

// Auto-initialize when loaded
initializeIpcHandlers();

// Set up event forwarding to renderer
function setupEventForwarding(mainWindow) {
  if (!mainWindow) return;

  const webContents = mainWindow.webContents;

  backendApi.on('connected', () => {
    webContents.send('backend:event', { type: 'connected' });
  });

  backendApi.on('disconnected', (data) => {
    webContents.send('backend:event', { type: 'disconnected', ...data });
  });

  backendApi.on('command_accepted', (data) => {
    webContents.send('backend:event', { type: 'command_accepted', ...data });
  });

  backendApi.on('command_queued', (data) => {
    webContents.send('backend:event', { type: 'command_queued', ...data });
  });

  backendApi.on('command_response', (data) => {
    webContents.send('backend:event', { type: 'command_response', ...data });
    if (data && data.action === 'tracking_approved') {
      webContents.send('tracking:approved', data);
    }
    if (data && data.action === 'tracking_rejected') {
      webContents.send('tracking:rejected', data);
    }
  });

  backendApi.on('device_event', (data) => {
    webContents.send('backend:event', { type: 'device_event', ...data });
  });

  backendApi.on('tracking:request', (data) => {
    webContents.send('tracking:request', data);
  });

  backendApi.on('tracking:location', (data) => {
    webContents.send('tracking:location', data);
  });

  backendApi.on('tracking:session_end', (data) => {
    webContents.send('tracking:session_end', data);
  });

  backendApi.on('tracking:approved', (data) => {
    webContents.send('tracking:approved', data);
  });

  backendApi.on('tracking:rejected', (data) => {
    webContents.send('tracking:rejected', data);
  });

  backendApi.on('error', (err) => {
    webContents.send('backend:event', { type: 'error', message: err.message });
  });

  console.log('[IPC] Event forwarding set up');
}

module.exports = {
  initializeIpcHandlers,
  setupEventForwarding,
};
