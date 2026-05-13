// ══════════════════════════════════════════
//  PANEL SWITCHING
// ══════════════════════════════════════════
const PANELS = {
  gps: 'panel-gps',
  mobile: 'panel-mobile',
  sms: 'panel-sms',
  camera: 'panel-camera',
  'mobile-recordings': 'panel-mobile-recordings',
  'mobile-images': 'panel-mobile-images',
};

const SIDEBAR_ROUTES = {
  gps: 'navRsp',
  mobile: 'navMobile',
  sms: 'navSms',
  camera: 'navCamera',
  'mobile-recordings': 'navMobileRecordings',
  'mobile-images': 'navMobileImages',
};

const PANEL_TO_PARENT = {
  gps: 'rsp',
  sms: 'rsp',
  camera: 'rsp',
  mobile: 'mobile',
  'mobile-recordings': 'mobile',
  'mobile-images': 'mobile',
};

const PARENT_TO_ROUTE = {
  rsp: 'gps',
  mobile: 'mobile',
};

const PARENT_GROUPS = {
  rsp: 'navRspGroup',
  mobile: 'navMobileGroup',
};

const SIDEBAR_PANELS = {
  rsp: 'sidebarGps',
  mobile: 'sidebarMobile',
  sms: 'sidebarSms',
  camera: 'sidebarCamera',
};

let currentPanel = 'gps';
let expandedParent = null;

function safeGetElement(id) {
  return id ? document.getElementById(id) : null;
}

function setPanelVisibility(panelName, visible) {
  const panelId = PANELS[panelName];
  const panelEl = safeGetElement(panelId);
  if (!panelEl) return;
  panelEl.classList.toggle('active', !!visible);
}

function syncSidebarContent(panelName) {
  const parentName = PANEL_TO_PARENT[panelName] || 'rsp';

  Object.entries(SIDEBAR_PANELS).forEach(([sidebarName, elementId]) => {
    const sidebarEl = safeGetElement(elementId);
    if (!sidebarEl) return;
    sidebarEl.style.display = sidebarName === parentName ? 'block' : 'none';
  });
}

function syncSidebarState(routeName) {
  const activeRoute = PANELS[routeName] ? routeName : 'gps';

  Object.entries(SIDEBAR_ROUTES).forEach(([panelName, elementId]) => {
    const el = safeGetElement(elementId);
    if (el) el.classList.toggle('active', panelName === activeRoute);
  });

  Object.entries(PARENT_GROUPS).forEach(([parentName, groupId]) => {
    const button = safeGetElement(parentName === 'rsp' ? 'navRsp' : 'navMobile');
    const group = safeGetElement(groupId);
    const isOpen = expandedParent === parentName;
    if (button) {
      button.classList.toggle('active', PANEL_TO_PARENT[activeRoute] === parentName || activeRoute === PARENT_TO_ROUTE[parentName]);
      button.classList.toggle('is-expanded', isOpen);
      button.setAttribute('aria-expanded', String(isOpen));
    }
    if (group) group.hidden = !isOpen;
  });
}

function switchPanel(name, options = {}) {
  const nextPanel = PANELS[name] ? name : 'gps';
  const previousPanel = currentPanel;

  if (previousPanel !== nextPanel) {
    setPanelVisibility(previousPanel, false);
  }

  currentPanel = nextPanel;
  setPanelVisibility(nextPanel, true);
  syncSidebarContent(nextPanel);
  if (Object.prototype.hasOwnProperty.call(options, 'expandedParent')) {
    expandedParent = options.expandedParent;
  } else {
    expandedParent = PANEL_TO_PARENT[nextPanel] || expandedParent;
  }
  syncSidebarState(nextPanel);

  if (nextPanel === 'gps') {
    setTimeout(() => { if (typeof map !== 'undefined' && map && typeof map.invalidateSize === 'function') map.invalidateSize(); }, 50);
  }
  if (nextPanel === 'mobile') {
    setTimeout(() => { if (typeof mobileMap !== 'undefined' && mobileMap && typeof mobileMap.invalidateSize === 'function') mobileMap.invalidateSize(); }, 50);
  }

  if (typeof window.onDashboardPanelChange === 'function') {
    window.onDashboardPanelChange(nextPanel);
  }
  if (typeof window.onDashboardMediaChange === 'function' && (nextPanel === 'mobile-recordings' || nextPanel === 'mobile-images')) {
    window.onDashboardMediaChange(nextPanel);
  }
}

function toggleParent(parentName) {
  const route = PARENT_TO_ROUTE[parentName];
  if (!route) return;
  const nextExpanded = expandedParent === parentName ? null : parentName;
  switchPanel(route, { expandedParent: nextExpanded });
}

function bindSidebarNavigation() {
  const rspButton = safeGetElement('navRsp');
  const mobileButton = safeGetElement('navMobile');
  const smsButton = safeGetElement('navSms');
  const cameraButton = safeGetElement('navCamera');
  const mobileRecordingsButton = safeGetElement('navMobileRecordings');
  const mobileImagesButton = safeGetElement('navMobileImages');

  if (rspButton) rspButton.addEventListener('click', () => toggleParent('rsp'));
  if (mobileButton) mobileButton.addEventListener('click', () => toggleParent('mobile'));
  if (smsButton) smsButton.addEventListener('click', () => switchPanel('sms'));
  if (cameraButton) cameraButton.addEventListener('click', () => switchPanel('camera'));
  if (mobileRecordingsButton) mobileRecordingsButton.addEventListener('click', () => switchPanel('mobile-recordings'));
  if (mobileImagesButton) mobileImagesButton.addEventListener('click', () => switchPanel('mobile-images'));
}

bindSidebarNavigation();
setPanelVisibility(currentPanel, true);
syncSidebarContent(currentPanel);
syncSidebarState(currentPanel);

// ══════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════
const map = L.map('map', {
  zoomControl: false,
  attributionControl: false
}).setView([14.5820, 120.9865], 14);

const mobileMap = document.getElementById('mobile-map')
  ? L.map('mobile-map', {
      zoomControl: false,
      attributionControl: false
    }).setView([14.5820, 120.9865], 14)
  : null;
window.mobileMap = mobileMap;

// Keep map in a clear light style to match road-map references/screenshots.
const darkTileUrl  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const lightTileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const tileOptions  = { maxZoom: 19, subdomains: 'abcd' };

let tileLayer = L.tileLayer(lightTileUrl, tileOptions).addTo(map);
let mobileTileLayer = mobileMap ? L.tileLayer(lightTileUrl, tileOptions).addTo(mobileMap) : null;
let searchMarker = null;
let searchBoundaryLayer = null;

function updateMapTiles(theme) {
  // Intentionally keep a light basemap in both UI themes.
  tileLayer.setUrl(lightTileUrl);
  if (mobileTileLayer) mobileTileLayer.setUrl(lightTileUrl);
}

// Map starts centered on Philippines; js/api.js will pan to real GPS.
map.setView([12.8797, 121.7740], 6);
if (mobileMap) mobileMap.setView([12.8797, 121.7740], 6);


// ── Speedometer & ETA (deferred — runs after GPS sidebar partial is injected) ──
function initGaugeParts() {
  const gaugeFill = document.getElementById('gaugeFill');
  const speedNum = document.getElementById('speedNum');
  const speedStatus = document.getElementById('speedStatus');
  if (!gaugeFill || !speedNum || !speedStatus) return;

  const circumference = 2 * Math.PI * 27;
  gaugeFill.style.strokeDasharray = String(circumference);
  gaugeFill.style.strokeDashoffset = String(circumference);
  speedNum.textContent = '—';
  speedStatus.textContent = 'Waiting for GPS';
  speedStatus.style.color = 'var(--muted)';
}

// ── Map button toggles ──
document.querySelectorAll('.map-btn:not([data-no-toggle])').forEach(btn => {
  btn.addEventListener('click', function () { this.classList.toggle('active'); });
});

// btnFollow: immediately re-center on tracker when follow mode is re-enabled
const btnFollow = document.getElementById('btnFollow');
if (btnFollow) {
  btnFollow.addEventListener('click', function () {
    if (this.classList.contains('active') && typeof centerOnTracker === 'function') centerOnTracker();
  });
}

// btnCenter: one-shot center on current tracker position
const btnCenter = document.getElementById('btnCenter');
if (btnCenter) {
  btnCenter.addEventListener('click', function () {
    if (typeof centerOnTracker === 'function') centerOnTracker();
    this.classList.add('active');
    setTimeout(() => this.classList.remove('active'), 400);
  });
}

// btnDeviceInfo: open floating device info panel
const btnDeviceInfo = document.getElementById('btnDeviceInfo');
if (btnDeviceInfo) {
  btnDeviceInfo.addEventListener('click', function () {
    if (typeof openDevicePanel === 'function') openDevicePanel();
    this.classList.add('active');
    setTimeout(() => this.classList.remove('active'), 400);
  });
}

// ── Search ──
async function searchPlace() {
  const input = document.getElementById('searchInput');
  const query = input ? input.value.trim() : '';
  if (!query) return;

  const toast = document.getElementById('liveToast');
  const orig = toast.innerHTML;
  toast.innerHTML = '<div class="status-dot"></div>&nbsp;Searching…';

  try {
    const res = await fetch(
      `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&polygon_geojson=1&addressdetails=1`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await res.json();
    if (data.length) {
      const result = data[0];
      const lat = parseFloat(result.lat);
      const lon = parseFloat(result.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        throw new Error('Invalid coordinates');
      }

      const placeRank = Number(result.place_rank) || 0;
      const isExactAddress = placeRank >= 28;

      if (searchBoundaryLayer) {
        map.removeLayer(searchBoundaryLayer);
        searchBoundaryLayer = null;
      }

      if (isExactAddress) {
        map.setView([lat, lon], 16, { animate: true });

        const searchPinIcon = L.divIcon({
          className: 'search-pin-icon',
          html: '<div class="search-pin-wrap"><div class="search-pin-core"></div><div class="search-pin-pulse"></div></div>',
          iconSize: [26, 26],
          iconAnchor: [13, 26],
        });

        if (!searchMarker) {
          searchMarker = L.marker([lat, lon], { icon: searchPinIcon }).addTo(map);
        } else {
          searchMarker.setLatLng([lat, lon]);
        }

        searchMarker.setZIndexOffset(1000);
        searchMarker
          .bindTooltip(result.display_name || query, {
            direction: 'top',
            offset: [0, -24],
            className: 'marker-tooltip-last-seen',
          })
          .openTooltip();

        setTimeout(() => {
          if (searchMarker) searchMarker.closeTooltip();
        }, 2400);
      } else {
        if (searchMarker) {
          map.removeLayer(searchMarker);
          searchMarker = null;
        }

        if (result.geojson) {
          searchBoundaryLayer = L.geoJSON(result.geojson, {
            style: {
              color: '#ff6b35',
              weight: 3,
              opacity: 0.95,
              fillColor: '#ff6b35',
              fillOpacity: 0.08,
            },
          }).addTo(map);

          const bounds = searchBoundaryLayer.getBounds();
          if (bounds && bounds.isValid()) {
            map.fitBounds(bounds, {
              padding: [24, 24],
              animate: true,
              maxZoom: 14,
            });
          } else {
            map.setView([lat, lon], 12, { animate: true });
          }
        } else {
          map.setView([lat, lon], 12, { animate: true });
        }
      }

      toast.innerHTML = orig;
    } else {
      toast.innerHTML = '<div style="color:var(--danger)">&#x26A0;</div>&nbsp;Place not found';
      setTimeout(() => { toast.innerHTML = orig; }, 2500);
    }
  } catch {
    toast.innerHTML = '<div style="color:var(--danger)">&#x26A0;</div>&nbsp;Search failed';
    setTimeout(() => { toast.innerHTML = orig; }, 2500);
  }
}

const searchBtn = document.getElementById('searchBtn');
const searchInput = document.getElementById('searchInput');
if (searchBtn) searchBtn.addEventListener('click', searchPlace);
if (searchInput) searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') searchPlace(); });

// ══════════════════════════════════════════
//  THEME TOGGLE
// ══════════════════════════════════════════
const themeToggle = document.getElementById('themeToggle');
const THEME_KEY = 'admin-dashboard-theme';
const sunIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>';
const moonIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1111.21 3c0 .28.02.57.05.85A7 7 0 0021 12.79z"/></svg>';

function setTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  const isDark = theme === 'dark';
  themeToggle.innerHTML = isDark ? sunIcon : moonIcon;
  themeToggle.title = isDark ? 'Switch to light mode' : 'Switch to dark mode';
  localStorage.setItem(THEME_KEY, theme);
  if (typeof updateMapTiles === 'function') updateMapTiles(theme);
}

// Keep dashboard UI dark by default; map tiles stay light via updateMapTiles().
setTheme('dark');
themeToggle.addEventListener('click', () => {
  const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  setTheme(next);
});

// ══════════════════════════════════════════
//  LOAD SIDEBAR PARTIALS
// ══════════════════════════════════════════
async function loadSidebarPartials() {
  const partials = [
    { file: 'components/sidebar-gps.html',    wrap: 'sidebar-gps-wrap'    },
    { file: 'components/sidebar-mobile.html', wrap: 'sidebar-mobile-wrap' },
    { file: 'components/sidebar-sms.html',    wrap: 'sidebar-sms-wrap'    },
    { file: 'components/sidebar-camera.html', wrap: 'sidebar-camera-wrap' },
  ];
  await Promise.all(partials.map(async ({ file, wrap }) => {
    try {
      const html = await fetch(file).then(r => r.text());
      document.getElementById(wrap).innerHTML = html;
    } catch (e) {
      console.warn('Could not load sidebar partial:', file, e);
    }
  }));
  initGaugeParts();
}
loadSidebarPartials();
