// Map Tracking admin page
const CONFIG_KEY = "pi-monitor-config";

function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function apiFetch(path, opts = {}) {
  const cfg = getConfig();
  const base = cfg.backendBase || window.location.origin;
  const headers = opts.headers || {};
  if (cfg.adminToken) headers["Authorization"] = `Bearer ${cfg.adminToken}`;
  const url = base.replace(/\/$/,"") + path;
  console.log("API Call:", url, "Token:", cfg.adminToken ? "YES" : "NO");
  return fetch(url, { ...opts, headers })
    .then(r => {
      console.log("Response status:", r.status);
      return r.json();
    })
    .catch(e => {
      console.error("Fetch error:", e);
      throw e;
    });
}

let map = null;
let currentLayer = null;
let lastBounds = null;

function initMap() {
  map = L.map('map').setView([0,0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);
}

function clearLayer() {
  if (currentLayer) {
    currentLayer.remove();
    currentLayer = null;
  }
}

function fitToLayer() {
  if (currentLayer) {
    const bounds = currentLayer.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds.pad(0.2));
  }
}

function loadUsers() {
  console.log("loadUsers called");
  apiFetch('/admin/captured_location/users').then(res => {
    console.log("Users response:", res);
    const list = document.getElementById('userList');
    list.innerHTML = '';
    if (!res.ok) {
      list.innerHTML = `<p style="color:red">Error: ${res.reason || 'unknown'}</p>`;
      return;
    }
    if (!res.users || res.users.length === 0) {
      list.innerHTML = '<p>No users found</p>';
      return;
    }
    res.users.forEach(u => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.textContent = u;
      el.onclick = () => loadSummaries(u);
      list.appendChild(el);
    });
  }).catch(e => {
    console.error("loadUsers error:", e);
    document.getElementById('userList').innerHTML = `<p style="color:red">Error loading users</p>`;
  });
}

function loadSummaries(user_id) {
  console.log("loadSummaries called for user:", user_id);
  apiFetch(`/admin/captured_location/summaries?user_id=${encodeURIComponent(user_id)}`).then(res => {
    console.log("Summaries response:", res);
    const list = document.getElementById('sessionList');
    list.innerHTML = '';
    if (!res.ok) {
      list.innerHTML = `<p style="color:red">Error: ${res.reason || 'unknown'}</p>`;
      return;
    }
    if (!res.summaries || res.summaries.length === 0) {
      list.innerHTML = '<p>No sessions found</p>';
      return;
    }
    res.summaries.forEach(s => {
      const el = document.createElement('div');
      el.className = 'list-item';
      el.textContent = `${s.file} (${s.properties?.point_count ?? '?'} pts)`;
      el.onclick = () => loadGeoJson(s.url);
      list.appendChild(el);
    });
  }).catch(e => {
    console.error("loadSummaries error:", e);
    document.getElementById('sessionList').innerHTML = `<p style="color:red">Error loading sessions</p>`;
  });
}

function loadGeoJson(url) {
  const cfg = getConfig();
  const base = cfg.backendBase || window.location.origin;
  const fullUrl = url.startsWith("http") ? url : base.replace(/\/$/, "") + url;
  console.log("Loading GeoJSON from:", fullUrl);
  fetch(fullUrl)
    .then(r => {
      console.log("GeoJSON fetch status:", r.status, fullUrl);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    })
    .then(obj => {
      console.log("GeoJSON loaded:", obj);
      clearLayer();
      currentLayer = L.geoJSON(obj, {
        style: { color: '#ff0000', weight: 4, opacity: 0.8 }
      }).addTo(map);
      if (currentLayer.getBounds && currentLayer.getBounds().isValid()) {
        lastBounds = currentLayer.getBounds();
        map.fitBounds(lastBounds.pad(0.2));
      }
    })
    .catch(e => {
      console.error("GeoJSON load error:", e);
      const list = document.getElementById('sessionList');
      const msg = document.createElement('div');
      msg.style.color = 'red';
      msg.textContent = `Error loading GeoJSON: ${e.message}`;
      list.appendChild(msg);
    });
}

window.addEventListener('DOMContentLoaded', () => {
  console.log("Map page loaded");
  const cfg = getConfig();
  console.log("Config:", cfg);
  if (!cfg.backendBase) {
    console.warn("No backendBase set! Go to Raspberry Monitor and set Backend Base URL");
    document.getElementById('userList').innerHTML = '<p style="color:red"><strong>⚠️ No Backend URL set</strong><br/>Go to Raspberry Monitor tab and set Backend Base URL in Configuration</p>';
  }
  if (!cfg.adminToken) {
    console.warn("No adminToken set! Go to Raspberry Monitor and set Admin Token");
  }
  initMap();
  loadUsers();
  document.getElementById('fitBtn').addEventListener('click', fitToLayer);
  document.getElementById('clearBtn').addEventListener('click', () => { clearLayer(); });
});