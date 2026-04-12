'use strict';

const { adminClient } = require('../services/websocket');
const trackingHandler = require('../services/tracking-handler');

const originalHandleMessage = typeof adminClient._handleMessage === 'function'
  ? adminClient._handleMessage.bind(adminClient)
  : null;

adminClient._handleMessage = function patchedHandleMessage(msg, connectResolve, connectReject, connectTimeout) {
  const type = msg && msg.type;

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
