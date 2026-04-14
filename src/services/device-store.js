'use strict';

const Store = require('electron-store');

const store = new Store({
  name: 'piguard-devices',
  defaults: {
    devices: {},
  },
});

function saveDevice(deviceId, deviceData) {
  const id = String(deviceId || '').trim();
  if (!id) return;

  const devices = store.get('devices', {});
  devices[id] = {
    ...devices[id],
    ...deviceData,
    device_id: id,
    updated_at: new Date().toISOString(),
  };
  store.set('devices', devices);
}

function loadDevices() {
  return store.get('devices', {});
}

function updateDeviceStatus(deviceId, status) {
  const id = String(deviceId || '').trim();
  if (!id) return;

  const devices = store.get('devices', {});
  if (!devices[id]) {
    devices[id] = {
      device_id: id,
      first_seen: new Date().toISOString(),
      status: 'offline',
    };
  }

  devices[id].status = status;
  devices[id].last_seen = new Date().toISOString();
  devices[id].updated_at = new Date().toISOString();
  store.set('devices', devices);
}

function updateDeviceLocation(deviceId, lat, lng) {
  const id = String(deviceId || '').trim();
  if (!id) return;

  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const devices = store.get('devices', {});
  if (!devices[id]) {
    devices[id] = {
      device_id: id,
      status: 'offline',
      first_seen: new Date().toISOString(),
    };
  }

  const timestamp = new Date().toISOString();
  devices[id].last_location = {
    lat: latitude,
    lng: longitude,
    latitude,
    longitude,
    timestamp,
  };
  devices[id].last_seen = timestamp;
  devices[id].updated_at = timestamp;
  store.set('devices', devices);
}

function getDevice(deviceId) {
  const id = String(deviceId || '').trim();
  if (!id) return null;

  const devices = store.get('devices', {});
  return devices[id] || null;
}

function getAllDevices() {
  const devices = store.get('devices', {});
  return Object.values(devices);
}

function markAllOfflineOnStartup() {
  const devices = store.get('devices', {});
  let changed = false;

  for (const id of Object.keys(devices)) {
    if (devices[id].status === 'online') {
      devices[id].status = 'offline';
      devices[id].last_seen = devices[id].updated_at || new Date().toISOString();
      devices[id].updated_at = new Date().toISOString();
      changed = true;
    }
  }

  if (changed) {
    store.set('devices', devices);
  }
}

module.exports = {
  saveDevice,
  loadDevices,
  updateDeviceStatus,
  updateDeviceLocation,
  getDevice,
  getAllDevices,
  markAllOfflineOnStartup,
};
