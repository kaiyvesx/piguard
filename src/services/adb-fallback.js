'use strict';

const { runAdbForDevice } = require('./adb');

function parseBattery(raw) {
  const out = String(raw || '');
  const get = (re) => {
    const m = out.match(re);
    return m ? m[1] : null;
  };
  const level = get(/level:\s*(\d+)/i);
  const status = get(/status:\s*(\d+)/i);
  const plugged = get(/plugged:\s*(\d+)/i);
  return {
    level: level == null ? null : Number(level),
    status_code: status == null ? null : Number(status),
    charging: plugged != null && Number(plugged) !== 0,
    raw: out,
  };
}

function parseGpsFromDumpsys(raw) {
  const out = String(raw || '');
  const m = out.match(/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/);
  if (!m) return null;
  return {
    lat: Number(m[1]),
    lng: Number(m[2]),
    source: 'adb-dumpsys-location',
  };
}

async function getProp(serial, prop) {
  return (await runAdbForDevice(serial, ['shell', 'getprop', prop])).trim();
}

async function executeAdbFallback(action, payload = {}, deviceId) {
  const serial = String(deviceId || '').trim();
  if (!serial) return null;

  if (action === 'get_device_info') {
    const [brand, model, android, sdk, manufacturer] = await Promise.all([
      getProp(serial, 'ro.product.brand'),
      getProp(serial, 'ro.product.model'),
      getProp(serial, 'ro.build.version.release'),
      getProp(serial, 'ro.build.version.sdk'),
      getProp(serial, 'ro.product.manufacturer'),
    ]);
    return {
      device_id: serial,
      brand,
      model,
      manufacturer,
      android_version: android,
      sdk,
      source: 'adb-fallback',
    };
  }

  if (action === 'get_battery') {
    const raw = await runAdbForDevice(serial, ['shell', 'dumpsys', 'battery']);
    return { ...parseBattery(raw), source: 'adb-fallback' };
  }

  if (action === 'get_gps') {
    const raw = await runAdbForDevice(serial, ['shell', 'dumpsys', 'location']);
    const parsed = parseGpsFromDumpsys(raw);
    if (!parsed) {
      return {
        source: 'adb-fallback',
        note: 'GPS not available from dumpsys location',
      };
    }
    return parsed;
  }

  if (action === 'get_gps_track') {
    return {
      track: [],
      source: 'adb-fallback',
      note: 'Track history requires mobile client/app storage.',
    };
  }

  if (action === 'get_cameras') {
    return {
      cameras: [],
      source: 'adb-fallback',
      note: 'Camera list not exposed via generic adb shell reliably.',
    };
  }

  if (action === 'get_contacts') {
    return {
      contacts: [],
      source: 'adb-fallback',
      note: 'Contacts require on-device app permissions.',
    };
  }

  if (action === 'get_messages') {
    return {
      messages: [],
      source: 'adb-fallback',
      note: 'SMS inbox requires on-device app permissions.',
    };
  }

  return null;
}

module.exports = {
  executeAdbFallback,
};
