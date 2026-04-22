'use strict';

const { adminClient } = require('../services/websocket');
const trackingHandler = require('../services/tracking-handler');

const originalHandleMessage = typeof adminClient._handleMessage === 'function'
  ? adminClient._handleMessage.bind(adminClient)
  : null;
const offlineQueuedDevices = new Set();

function getMessageDeviceId(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(msg?.device_id || payload?.device_id || '').trim();
}

function getMessageAction(msg) {
  const payload = msg && typeof msg.payload === 'object' ? msg.payload : {};
  return String(msg?.action || msg?.event || payload?.action || payload?.type || '')
    .trim()
    .toLowerCase();
}

adminClient._handleMessage = function patchedHandleMessage(msg, connectResolve, connectReject, connectTimeout) {
  const type = msg && msg.type;
  const deviceId = getMessageDeviceId(msg);

  if (type === 'command_queued') {
    const key = deviceId || '__unknown__';
    if (!offlineQueuedDevices.has(key)) {
      offlineQueuedDevices.add(key);
    }
  } else {
    if (type === 'command_response' && deviceId) {
      offlineQueuedDevices.delete(deviceId);
    }
    if (type === 'device_event') {
      const action = getMessageAction(msg);
      if ((action === 'device_online' || action === 'location_update') && deviceId) {
        offlineQueuedDevices.delete(deviceId);
      }
    }

    // Transport accepted acknowledgements are noisy during offline periods.
    if (type !== 'accepted' && type !== 'pong') {
      console.log('[AdminWS] Message type:', type || 'unknown', 'device:', deviceId || 'none');
    }
  }

  if (type === 'device_event') {
    this._refreshOfflineLogState(msg);
    trackingHandler.handle(msg, this);
    this.emit('device_event', msg);
    return;
  }

  if (originalHandleMessage) {
    return originalHandleMessage(msg, connectResolve, connectReject, connectTimeout);
  }

  return undefined;
};

module.exports = {
  adminClient,
};
