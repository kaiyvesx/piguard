const { contextBridge } = require('electron');

const BASE_CANDIDATES = [
  'http://raspi44:8000',
  'http://raspi44.local:8000',
  'http://10.10.218.109:8000',
];

let cachedBase = null;

async function fetchJson(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const detail = payload && typeof payload === 'object' && payload.detail
        ? String(payload.detail)
        : `HTTP ${response.status}`;
      throw new Error(detail);
    }

    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBinaryDataUrl(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${contentType};base64,${buffer.toString('base64')}`;
  } finally {
    clearTimeout(timeout);
  }
}

async function detectBase() {
  if (cachedBase) {
    try {
      await fetchJson(`${cachedBase}/status`, { method: 'GET' }, 3000);
      return cachedBase;
    } catch {
      cachedBase = null;
    }
  }

  for (const base of BASE_CANDIDATES) {
    try {
      await fetchJson(`${base}/status`, { method: 'GET' }, 3000);
      cachedBase = base;
      return base;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Pi backend unreachable. Tried: ${BASE_CANDIDATES.join(', ')}`);
}

async function request(path, method = 'GET', body = undefined, timeoutMs = 10000) {
  const base = await detectBase();
  const options = { method };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  return fetchJson(`${base}${path}`, options, timeoutMs);
}

contextBridge.exposeInMainWorld('piBridge', {
  detectBase,
  getStatus: () => request('/status', 'GET', undefined, 8000),
  getGpsLatest: () => request('/gps_latest', 'GET', undefined, 8000),
  getGpsTrack:  () => request('/gps_track',  'GET', undefined, 12000),
  getCameras:   () => request('/cameras',    'GET', undefined, 12000),
  getCameraSnapshot: async (cameraIndex) => {
    const base = await detectBase();
    return fetchBinaryDataUrl(`${base}/camera/${cameraIndex}/snapshot.jpg?t=${Date.now()}`, 15000);
  },
  getContacts:  () => request('/contacts',   'GET', undefined, 8000),
  getMessages:  () => request('/messages',   'GET', undefined, 8000),
  sendSms: (numbers, message) => request('/send_sms', 'POST', { to: numbers, message }, 20000),
});
