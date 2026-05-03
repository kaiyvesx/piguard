'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const config = require('./backend.config');

const execFileAsync = promisify(execFile);

async function runAdb(args) {
  const adbBin = process.env.ADB_BIN || 'adb';
  const { stdout } = await execFileAsync(adbBin, args, { timeout: 4000 });
  return String(stdout || '');
}

async function runAdbForDevice(serial, args) {
  if (!serial) throw new Error('ADB serial is required');
  return runAdb(['-s', serial, ...args]);
}

function parseAdbDevices(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const start = lines.findIndex((line) => line.toLowerCase().startsWith('list of devices attached'));
  const entries = (start >= 0 ? lines.slice(start + 1) : lines)
    .filter((line) => !line.startsWith('*'));

  const devices = [];
  for (const line of entries) {
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const serial = parts[0];
    const state = parts[1];
    const meta = {};
    for (const token of parts.slice(2)) {
      const idx = token.indexOf(':');
      if (idx > 0) {
        meta[token.slice(0, idx)] = token.slice(idx + 1);
      }
    }
    devices.push({
      serial,
      state,
      model: meta.model || null,
      transport_id: meta.transport_id || null,
      usb: meta.usb || null,
      product: meta.product || null,
      device: meta.device || null,
      is_online: state === 'device',
    });
  }
  return devices;
}

async function listAdbDevices() {
  try {
    const output = await runAdb(['devices', '-l']);
    return parseAdbDevices(output);
  } catch (err) {
    return [];
  }
}

async function getPreferredDeviceId() {
  const devices = await listAdbDevices();
  const online = devices.find((d) => d.is_online);
  return online ? online.serial : null;
}

function shouldAutoDetectTarget() {
  const target = String(config.targetDeviceId || '').trim();
  return !target;
}

module.exports = {
  listAdbDevices,
  getPreferredDeviceId,
  shouldAutoDetectTarget,
  runAdbForDevice,
};
