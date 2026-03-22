// ══════════════════════════════════════════
//  PANEL SWITCHING
// ══════════════════════════════════════════
const panels     = { gps: 'panel-gps', sms: 'panel-sms', camera: 'panel-camera' };
const navBtns    = { gps: 'navGps',    sms: 'navSms',    camera: 'navCamera'    };
const sidebarCtx = { gps: 'sidebarGps', sms: 'sidebarSms', camera: 'sidebarCamera' };
let currentPanel = 'gps';

function switchPanel(name) {
  if (name === currentPanel) return;
  document.getElementById(panels[currentPanel]).classList.remove('active');
  document.getElementById(navBtns[currentPanel]).classList.remove('active');
  document.getElementById(sidebarCtx[currentPanel]).style.display = 'none';
  document.getElementById(panels[name]).classList.add('active');
  document.getElementById(navBtns[name]).classList.add('active');
  document.getElementById(sidebarCtx[name]).style.display = 'block';
  currentPanel = name;
  if (name === 'gps') {
    setTimeout(() => { if (typeof map !== 'undefined') map.invalidateSize(); }, 50);
  }
  if (typeof window.onDashboardPanelChange === 'function') {
    window.onDashboardPanelChange(name);
  }
}

// ══════════════════════════════════════════
//  MAP
// ══════════════════════════════════════════
const map = L.map('map', {
  zoomControl: false,
  attributionControl: false
}).setView([14.5820, 120.9865], 14);

// Keep map in a clear light style to match road-map references/screenshots.
const darkTileUrl  = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const lightTileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
const tileOptions  = { maxZoom: 19, subdomains: 'abcd' };

let tileLayer = L.tileLayer(lightTileUrl, tileOptions).addTo(map);
let searchMarker = null;
let searchBoundaryLayer = null;

function updateMapTiles(theme) {
  // Intentionally keep a light basemap in both UI themes.
  tileLayer.setUrl(lightTileUrl);
}

// Map starts centered on Philippines; js/api.js will pan to real GPS.
map.setView([12.8797, 121.7740], 6);


// ── Speedometer & ETA (deferred — runs after GPS sidebar partial is injected) ──
function initGaugeParts() {
  const circumference = 2 * Math.PI * 27;
  const gaugeFill   = document.getElementById('gaugeFill');
  const speedNum    = document.getElementById('speedNum');
  const speedStatus = document.getElementById('speedStatus');
  const speeds = [42, 38, 55, 48, 35, 50, 44, 30, 58, 46, 40, 52];
  let sIdx = 0;

  function updateSpeed() {
    const sp = speeds[sIdx++ % speeds.length];
    gaugeFill.style.strokeDashoffset = circumference * (1 - Math.min(sp / 80, 1));
    speedNum.textContent = sp;
    if (sp > 60) {
      gaugeFill.style.stroke = 'var(--danger)';
      speedStatus.style.color = 'var(--danger)';
      speedStatus.textContent = 'Over limit!';
    } else if (sp > 50) {
      gaugeFill.style.stroke = 'var(--warning)';
      speedStatus.style.color = 'var(--warning)';
      speedStatus.textContent = 'Near limit';
    } else {
      gaugeFill.style.stroke = 'var(--primary)';
      speedStatus.style.color = 'var(--success)';
      speedStatus.textContent = 'Within limit';
    }
  }
  updateSpeed();
  setInterval(updateSpeed, 3000);

  let etaMin = 14;
  setInterval(() => {
    if (etaMin > 1) {
      etaMin--;
      document.getElementById('stat-eta').innerHTML = `${etaMin}<sup style="font-size:.55rem">min</sup>`;
      document.getElementById('stat-dist').innerHTML = `${(etaMin * 0.59).toFixed(1)}<sup style="font-size:.55rem">km</sup>`;
    }
  }, 8000);

  function updateArrival() {
    const now = new Date();
    now.setMinutes(now.getMinutes() + etaMin);
    let h = now.getHours(), m = now.getMinutes();
    const ampm = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    document.getElementById('stat-arr').innerHTML = `${h}:${String(m).padStart(2,'0')}<sup style="font-size:.55rem">${ampm}</sup>`;
  }
  updateArrival();
  setInterval(updateArrival, 60000);
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

// ── Action buttons ──
function rerouteAlert() {
  const toast = document.getElementById('liveToast');
  const orig = toast.innerHTML;
  toast.innerHTML = '<div style="color:#ffb300;font-size:1rem">&#x21BA;</div>&nbsp;Calculating faster route&hellip;';
  setTimeout(() => { toast.innerHTML = orig; }, 2500);
}

function stopNav() {
  if (confirm('Stop navigation?')) {
    document.getElementById('liveToast').innerHTML =
      '<div style="color:var(--danger);font-size:1rem">&#x25A0;</div>&nbsp;Navigation stopped';
  }
}

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
