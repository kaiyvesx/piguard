const { app, BrowserWindow, session } = require('electron');
const os = require('os');
const path = require('path');

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

function createWindow() {
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
  });

  win.loadFile(path.join(__dirname, 'frontend', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
