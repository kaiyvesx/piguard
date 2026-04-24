'use strict';

const path = require('path');
const dotenv = require('dotenv');
const { createClient } = require('@supabase/supabase-js');

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
  dotenv.config({
    path: path.resolve(__dirname, '..', '..', 'backend1', 'server_backend', '.env'),
    override: false,
  });
}

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();

const supabase = supabaseUrl && supabaseAnonKey
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: false,
      },
    })
  : null;

let warnedMissingConfig = false;
let presenceHistoryUnavailable = false;

function getClient() {
  if (supabase) return supabase;

  if (!warnedMissingConfig) {
    warnedMissingConfig = true;
    console.warn('[Supabase] SUPABASE_URL/SUPABASE_ANON_KEY are missing. Persistence is disabled.');
  }

  return null;
}

function cleanText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function cleanNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function cleanInteger(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Math.trunc(num);
}

function cleanObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value;
}

function isMissingSchemaError(error) {
  const code = String(error?.code || '').trim();
  const message = String(error?.message || '').toLowerCase();
  if (code === '42P01' || code === '42703') return true;
  return message.includes('does not exist') || message.includes('undefined column');
}

function isMissingColumnError(error, columnName) {
  if (!error) return false;
  const message = String(error.message || '').toLowerCase();
  return message.includes(String(columnName || '').toLowerCase()) && isMissingSchemaError(error);
}

async function upsertDevice(deviceId, status, lat, lng) {
  const client = getClient();
  const id = cleanText(deviceId);
  if (!client || !id) return null;

  const now = Date.now();

  const payload = {
    device_id: id,
    status: cleanText(status) || 'online',
    last_seen: new Date().toISOString(),
    last_lat: cleanNumber(lat),
    last_lng: cleanNumber(lng),
    created_at_ms: now,
    updated_at_ms: now,
  };

  let { error } = await client
    .from('devices')
    .upsert(payload, {
      onConflict: 'device_id',
      ignoreDuplicates: false,
    });

  // updated_at_ms is optional in some schemas; retry safely when absent.
  if (error && isMissingColumnError(error, 'updated_at_ms')) {
    const retryPayload = {
      ...payload,
    };
    delete retryPayload.updated_at_ms;

    const retryResult = await client
      .from('devices')
      .upsert(retryPayload, {
        onConflict: 'device_id',
        ignoreDuplicates: false,
      });

    error = retryResult.error;
  }

  if (error) {
    console.error('[Supabase] upsertDevice error:', error.message || error);
    return null;
  }

  return true;
}

async function saveGpsLog(deviceId, latitude, longitude, requestId) {
  const client = getClient();
  const id = cleanText(deviceId);
  if (!client || !id) return null;

  const payload = {
    device_id: id,
    latitude: cleanNumber(latitude),
    longitude: cleanNumber(longitude),
    request_id: cleanText(requestId),
    recorded_at: new Date().toISOString(),
  };

  const { error } = await client
    .from('gps_logs')
    .insert(payload);

  if (error) throw error;
  return null;
}

async function saveCommandLog(deviceId, action, requestId, status) {
  const client = getClient();
  const id = cleanText(deviceId);
  if (!client || !id) return null;

  const payload = {
    device_id: id,
    action: cleanText(action) || 'unknown',
    request_id: cleanText(requestId),
    status: cleanText(status) || 'unknown',
    sent_at: new Date().toISOString(),
  };

  const { error } = await client
    .from('command_logs')
    .insert(payload);

  if (error) throw error;
  return null;
}

async function loadAllDevices() {
  const client = getClient();
  if (!client) return [];

  const { data, error } = await client
    .from('devices')
    .select('*')
    .order('last_seen', { ascending: false });

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function loadGpsHistory(deviceId, limit = 50) {
  const client = getClient();
  const id = cleanText(deviceId);
  if (!client || !id) return [];

  const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));

  const { data, error } = await client
    .from('gps_logs')
    .select('*')
    .eq('device_id', id)
    .order('recorded_at', { ascending: false })
    .limit(safeLimit);

  if (error) throw error;
  return Array.isArray(data) ? data : [];
}

async function savePresenceHistoryLog(entry = {}) {
  const client = getClient();
  if (!client || presenceHistoryUnavailable) return null;

  const source = cleanText(entry.source);
  const deviceId = cleanText(entry.device_id || entry.deviceId);
  const status = cleanText(entry.status) || 'unknown';
  const eventType = cleanText(entry.event_type || entry.eventType) || 'event';

  if (!source || !deviceId) return null;

  const payload = {
    source,
    device_id: deviceId,
    status,
    event_type: eventType,
    latitude: cleanNumber(entry.latitude ?? entry.lat),
    longitude: cleanNumber(entry.longitude ?? entry.lng),
    event_ms: cleanInteger(entry.event_ms || entry.eventMs || Date.now()),
    event_at: new Date(entry.event_at || entry.eventAt || Date.now()).toISOString(),
    meta: cleanObject(entry.meta) || {},
  };

  const { error } = await client
    .from('presence_history_logs')
    .insert(payload);

  if (!error) return null;

  if (isMissingSchemaError(error)) {
    presenceHistoryUnavailable = true;
    console.warn('[Supabase] presence_history_logs is unavailable. History persistence is disabled.');
    return null;
  }

  throw error;
}

async function loadPresenceHistoryLogs(options = {}) {
  const client = getClient();
  if (!client || presenceHistoryUnavailable) return [];

  const source = cleanText(options.source);
  const deviceId = cleanText(options.deviceId || options.device_id);
  const safeLimit = Math.max(1, Math.min(500, Number(options.limit) || 150));

  let query = client
    .from('presence_history_logs')
    .select('*')
    .order('event_ms', { ascending: false })
    .limit(safeLimit);

  if (source && source !== 'all') {
    query = query.eq('source', source);
  }

  if (deviceId) {
    query = query.eq('device_id', deviceId);
  }

  const { data, error } = await query;

  if (!error) return Array.isArray(data) ? data : [];

  if (isMissingSchemaError(error)) {
    presenceHistoryUnavailable = true;
    console.warn('[Supabase] presence_history_logs is unavailable. History reads are disabled.');
    return [];
  }

  throw error;
}

module.exports = {
  upsertDevice,
  saveGpsLog,
  saveCommandLog,
  loadAllDevices,
  loadGpsHistory,
  savePresenceHistoryLog,
  loadPresenceHistoryLogs,
};
