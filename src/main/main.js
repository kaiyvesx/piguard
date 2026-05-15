// Load environment variables from .env file
require('dotenv').config();

const { app, BrowserWindow, session, nativeImage } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupEventForwarding } = require('./ipc-handlers');
const { adminClient } = require('./admin-ws-client');
const deviceStore = require('../services/device-store');
const logPoller = require('../services/log-poller');

let registerTrackingIPC = null;
try {
  ({ registerTrackingIPC } = require('./tracking-ipc'));
} catch {
  registerTrackingIPC = () => {};
}

// Some remote/virtualized Windows setups cannot start Chromium GPU process.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-gpu-compositing');
app.commandLine.appendSwitch('use-angle', 'swiftshader');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('no-sandbox');
app.commandLine.appendSwitch('disable-features', 'RendererCodeIntegrity');

const localAppDataDir = path.join(os.homedir(), 'AppData', 'Roaming', 'piguardd');
const localCacheDir = path.join(os.homedir(), 'AppData', 'Local', 'piguardd-cache');
app.setPath('userData', localAppDataDir);
app.setPath('sessionData', localCacheDir);
app.commandLine.appendSwitch('disk-cache-dir', localCacheDir);

if (process.platform === 'win32') {
  app.setAppUserModelId('com.piguard.desktop');
}

function createWindow() {
  const appIconPath = path.join(app.getAppPath(), 'piguard-logo.png');
  const appIcon = nativeImage.createFromPath(appIconPath);

  // Allow OSM tile images and Pi API calls from the local HTML file.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self' 'unsafe-inline' data:; " +
          "script-src 'self' 'unsafe-inline' https://unpkg.com; " +
          "style-src 'self' 'unsafe-inline' https://unpkg.com; " +
          "img-src * data: blob:; " +
          "connect-src * data: blob:;"
        ],
      },
    });
  });

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    icon: appIcon.isEmpty() ? appIconPath : appIcon,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,   // needed to load OSM tiles and Pi API from file://
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('did-fail-load:', { errorCode, errorDescription, validatedURL });
  });

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('render-process-gone:', details);
  });

  win.webContents.on('unresponsive', () => {
    console.error('renderer became unresponsive');
  });

  win.webContents.on('did-finish-load', () => {
    console.log('renderer loaded:', win.webContents.getURL());
    // Set up backend event forwarding to renderer
    setupEventForwarding(win);
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

// Bundled backend process management
let backendProc = null;
function startBundledBackend() {
  try {
    // Packaged installs should use the configured remote backend endpoint.
    if (app.isPackaged) {
      console.log('[Main] Packaged install using configured backend endpoints');
      return;
    }

    const exeName = process.platform === 'win32' ? 'piguard-backend.exe' : 'piguard-backend';

    // When packaged, resources are located in process.resourcesPath
    let exePath = path.join(process.resourcesPath || '', 'backend', exeName);

    // During development, allow a local build copy under project build/resources/backend
    if (!fs.existsSync(exePath)) {
      exePath = path.join(app.getAppPath(), '..', '..', 'build', 'resources', 'backend', exeName);
    }

    if (!fs.existsSync(exePath)) {
      console.log('[Main] No bundled backend executable found at', exePath);
      return;
    }

    console.log('[Main] Starting bundled backend:', exePath);
    backendProc = spawn(exePath, [], { stdio: 'ignore', detached: false });
    backendProc.unref && backendProc.unref();

    backendProc.on('error', (err) => {
      console.warn('[Main] Backend process error:', err && err.message ? err.message : err);
    });
    backendProc.on('exit', (code, signal) => {
      console.log('[Main] Backend exited', { code, signal });
      backendProc = null;
    });
  } catch (e) {
    console.warn('[Main] Failed to start bundled backend:', e && e.message ? e.message : e);
  }
}

function startDevBackend() {
  try {
    // Spawn local Python Uvicorn server for development testing
    const pythonBin = process.env.PYTHON_BIN || 'python';
    const backendDir = path.join(__dirname, '..', '..', 'tracker_backend', 'backend');
    if (!fs.existsSync(backendDir)) {
      console.log('[Main] Dev backend directory not found:', backendDir);
      return;
    }

    console.log('[Main] Starting dev backend with Python in', backendDir);
    backendProc = spawn(pythonBin, ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', '8000'], {
      cwd: backendDir,
      stdio: 'inherit',
      env: Object.assign({}, process.env),
    });

    backendProc.on('error', (err) => {
      console.warn('[Main] Dev backend error:', err && err.message ? err.message : err);
      backendProc = null;
    });
    backendProc.on('exit', (code, signal) => {
      console.log('[Main] Dev backend exited', { code, signal });
      backendProc = null;
    });
  } catch (e) {
    console.warn('[Main] Failed to start dev backend:', e && e.message ? e.message : e);
  }
}

adminClient.on('connected', () => {
  console.log('[Main] Admin WS ready, starting log poller');
  logPoller.startPolling(15000);
});

app.whenReady().then(() => {
  deviceStore.markAllOfflineOnStartup();
  const saved = deviceStore.getAllDevices();
  console.log('[Main] Loaded', saved.length, 'saved devices from disk');

  // Try starting a bundled backend executable first; if not present and we're in dev, spawn local Python server for end-to-end testing
  startBundledBackend();
  if (!backendProc && !app.isPackaged) {
    startDevBackend();
  }

  createWindow();
  registerTrackingIPC(adminClient);

  setTimeout(() => {
    logPoller.startPolling(15000);
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  logPoller.stopPolling();
  try {
    if (backendProc && !backendProc.killed) {
      backendProc.kill();
    }
  } catch (e) {
    console.warn('[Main] Error while killing backend process:', e && e.message ? e.message : e);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
