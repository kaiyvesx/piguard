(function () {
  const api = window.piBridge;
  if (!api) {
    return;
  }

  const connStatusEl = document.getElementById('piConnStatus');
  const contactsWrap = document.getElementById('smsContactsList');
  const messagesWrap = document.getElementById('smsMessagesArea');
  const composeInput = document.getElementById('smsComposeInput');
  const sendBtn = document.getElementById('smsSendBtn');
  const smsBadgeEl = document.getElementById('smsBadge');
  const smsThreadAvatarEl = document.getElementById('smsThreadAvatar');
  const smsThreadNameEl = document.getElementById('smsThreadName');
  const smsThreadSubEl = document.getElementById('smsThreadSub');

  let selectedNumber = null;
  let lastBase = null;
  let contacts = [];
  let lastMessagesData = { sms: [] };
  let trackPolyline = null;
  let piCarMarker = null;

  function setConnectionState(connected, message) {
    if (!connStatusEl) return;
    connStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
    connStatusEl.textContent = message;
  }

  function toNum(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return String(ts);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // --- reverse geocoding (Nominatim, cached) ---
  const _geocodeCache = new Map();
  const _geocodePendingByKey = new Map();

  async function reverseGeocode(lat, lon) {
    const key = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (_geocodeCache.has(key)) return _geocodeCache.get(key);
    if (_geocodePendingByKey.has(key)) return _geocodePendingByKey.get(key);

    const request = (async () => {
    try {
      const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1`;
      const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
      if (!res.ok) return null;
      const data = await res.json();
      const a = data.address || {};
      // Build a short human-readable label: road/suburb, city, province
      const parts = [
        a.road || a.neighbourhood || a.hamlet || a.village || '',
        a.city || a.town || a.municipality || a.county || '',
        a.state || a.province || ''
      ].filter(Boolean);
      const label = parts.length ? parts.join(', ') : (data.display_name || `${lat.toFixed(4)}, ${lon.toFixed(4)}`);
      _geocodeCache.set(key, label);
      return label;
    } catch { return null; }
    finally { _geocodePendingByKey.delete(key); }
    })();

    _geocodePendingByKey.set(key, request);
    return request;
  }

  function pickInitials(name) {
    const clean = String(name || '').trim();
    if (!clean) return '??';
    const parts = clean.split(/\s+/).filter(Boolean);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function setSelectedNumber(number) {
    selectedNumber = number;

    const activeEls = contactsWrap ? contactsWrap.querySelectorAll('.contact-item') : [];
    activeEls.forEach((el) => {
      const isActive = el.getAttribute('data-number') === number;
      el.classList.toggle('active', isActive);
    });

    const c = contacts.find((item) => String(item.number || '') === String(number || ''));
    const labelName = c && c.name ? String(c.name) : (number ? String(number) : 'No contact selected');
    if (smsThreadAvatarEl) smsThreadAvatarEl.textContent = pickInitials(labelName);
    if (smsThreadNameEl) smsThreadNameEl.textContent = labelName;
    if (smsThreadSubEl) {
      smsThreadSubEl.textContent = number ? `${number} · Pi backend SMS` : 'Select a contact to view messages';
    }

    renderMessages(lastMessagesData);
  }

  function renderContacts() {
    if (!contactsWrap || !Array.isArray(contacts)) return;

    if (!contacts.length) {
      contactsWrap.innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:.72rem">No contacts from backend yet.</div>';
      return;
    }

    const activeNumber = selectedNumber || (contacts[0] && contacts[0].number) || '';
    contactsWrap.innerHTML = contacts.map((c) => {
      const name = escapeHtml(c.name || 'Unnamed');
      const number = escapeHtml(c.number || '');
      const initials = escapeHtml(pickInitials(c.name));
      return `
        <div class="contact-item${number === activeNumber ? ' active' : ''}" data-number="${number}">
          <div class="contact-avatar">${initials}</div>
          <div class="contact-info">
            <div class="contact-name">${name}</div>
            <div class="contact-preview">${number}</div>
          </div>
          <div class="contact-meta">
            <div class="contact-time">Pi</div>
          </div>
        </div>
      `;
    }).join('');

    contactsWrap.querySelectorAll('.contact-item').forEach((el) => {
      el.addEventListener('click', () => {
        setSelectedNumber(el.getAttribute('data-number'));
      });
    });

    setSelectedNumber(activeNumber);
  }

  function renderMessages(messagesData) {
    if (!messagesWrap) return;

    const allSms = messagesData && Array.isArray(messagesData.sms) ? messagesData.sms : [];
    if (smsBadgeEl) smsBadgeEl.textContent = String(allSms.length);

    const sms = selectedNumber
      ? allSms.filter((item) => String(item.number || '') === String(selectedNumber))
      : allSms;

    if (!sms.length) {
      messagesWrap.innerHTML = `<div class="date-divider">${selectedNumber ? 'No messages for this contact yet' : 'No message logs yet'}</div>`;
      return;
    }

    const rows = sms.slice(-20).reverse().map((item) => {
      const number = escapeHtml(item.number || 'Unknown');
      const msg = escapeHtml(item.message || '');
      const time = escapeHtml(fmtTime(item.ts));
      const ok = item.ok ? 'out' : 'in';
      return `
        <div class="msg ${ok}">
          <div class="msg-bubble">${msg}</div>
          <div class="msg-time">${number} ${time ? '· ' + time : ''}</div>
        </div>
      `;
    });

    messagesWrap.innerHTML = '<div class="date-divider">Latest Backend SMS Log</div>' + rows.join('');
    messagesWrap.scrollTop = messagesWrap.scrollHeight;
  }

  function updateSmsStats(messagesData) {
    const unreadEl = document.getElementById('sms-stat-unread');
    const totalEl = document.getElementById('sms-stat-total');
    const onlineEl = document.getElementById('sms-stat-online');
    const allSms = messagesData && Array.isArray(messagesData.sms) ? messagesData.sms : [];
    const incoming = allSms.filter((m) => !m.ok).length;

    if (unreadEl) unreadEl.textContent = String(incoming);
    if (totalEl) totalEl.textContent = String(allSms.length);
    if (onlineEl) onlineEl.textContent = String(contacts.length);
  }

  function updateGpsFromBackend(gps, track) {
    // --- determine best position ---
    let lat = null, lon = null, speed = 0;
    const points = track && Array.isArray(track.points) ? track.points : [];

    // prefer live fix
    if (gps && gps.fix === '1' && gps.lat != null && gps.lon != null) {
      lat = parseFloat(gps.lat);
      lon = parseFloat(gps.lon);
      speed = Math.max(0, parseFloat(gps.speed) || 0);
    }

    // fall back to latest track point
    if ((lat === null || lon === null) && points.length > 0) {
      const last = points[points.length - 1];
      lat = parseFloat(last.lat);
      lon = parseFloat(last.lon);
      speed = Math.max(0, parseFloat(last.speed) || 0);
    }

    // --- sidebar GPS card ---
    const locEl   = document.getElementById('gps-location');
    const subEl   = document.getElementById('gps-fix-sub');
    const satEl   = document.getElementById('stat-sat');
    const altEl   = document.getElementById('stat-alt');
    const ptsEl   = document.getElementById('stat-pts');

    const hasFix  = gps && gps.fix === '1';
    const satCount = gps && gps.sat != null ? gps.sat : (points.length > 0 ? points[points.length-1].sat : '—');

    if (locEl) {
      if (lat !== null) {
        // show cached name instantly, then update asynchronously
        const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
        locEl.textContent = cached || `${Math.abs(lat).toFixed(5)}° ${lat>=0?'N':'S'}, ${Math.abs(lon).toFixed(5)}° ${lon>=0?'E':'W'}`;
        if (!cached) reverseGeocode(lat, lon).then(name => { if (name && locEl) locEl.textContent = name; });
      } else {
        locEl.textContent = 'No fix yet';
      }
    }
    if (subEl) subEl.textContent = hasFix ? 'Live GPS fix active' : (points.length > 0 ? `Last fix: ${fmtTime(points[points.length-1].ts)}` : 'Waiting for GPS fix…');
    if (satEl) satEl.textContent = String(satCount);
    if (altEl) {
      const alt = hasFix && gps.alt != null ? parseFloat(gps.alt).toFixed(0)+'m'
                : (points.length > 0 ? parseFloat(points[points.length-1].alt).toFixed(0)+'m' : '—');
      altEl.textContent = alt;
    }
    if (ptsEl) ptsEl.textContent = String(track ? track.count || points.length : 0);

    // --- bottom bar live coords ---
    const coordValEl  = document.getElementById('live-coord-value');
    const coordUpdEl  = document.getElementById('live-last-update');
    if (coordValEl && lat !== null) {
      const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
      coordValEl.textContent = cached || `${Math.abs(lat).toFixed(5)}° ${lat>=0?'N':'S'} · ${Math.abs(lon).toFixed(5)}° ${lon>=0?'E':'W'}`;
      if (!cached) reverseGeocode(lat, lon).then(name => { if (name && coordValEl) coordValEl.textContent = name; });
    }
    if (coordUpdEl && points.length > 0) {
      const lastTs = points[points.length - 1].ts;
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      coordUpdEl.textContent = diff < 60 ? `Updated ${diff}s ago` : diff < 3600 ? `Updated ${Math.floor(diff/60)}m ago` : `Updated ${Math.floor(diff/3600)}h ago`;
    }

    // --- right panel track log (last 8 points) ---
    const trackLogEl = document.getElementById('trackLogList');
    if (trackLogEl && points.length > 0) {
      const recent = points.slice(-8).reverse();
      trackLogEl.innerHTML = recent.map((p, i) => {
        const isLatest = i === 0;
        const pLat = parseFloat(p.lat);
        const pLon = parseFloat(p.lon);
        const key = `${pLat.toFixed(3)},${pLon.toFixed(3)}`;
        const cached = _geocodeCache.get(key);
        const fallback = `${pLat.toFixed(4)}°, ${pLon.toFixed(4)}°`;
        return `<div class="route-step${isLatest ? ' active' : ''}">
          <div class="step-num${isLatest ? '' : ' done'}" style="font-size:.6rem">${isLatest ? '●' : '○'}</div>
          <div class="step-body">
            <div class="step-road js-track-place" data-gk="${key}" style="font-size:.72rem">${escapeHtml(cached || fallback)}</div>
            <div class="step-inst">${fmtTime(p.ts)} · ${parseFloat(p.speed||0).toFixed(1)} km/h</div>
          </div>
          <div class="step-meta"><div class="step-km" style="font-size:.62rem">${p.sat} sat</div></div>
        </div>`;
      }).join('');

      // Resolve human-readable place names for rows that are still showing fallback coords.
      recent.forEach((p) => {
        const pLat = parseFloat(p.lat);
        const pLon = parseFloat(p.lon);
        const key = `${pLat.toFixed(3)},${pLon.toFixed(3)}`;
        if (_geocodeCache.has(key)) return;
        reverseGeocode(pLat, pLon).then((name) => {
          if (!name || !trackLogEl) return;
          trackLogEl.querySelectorAll(`.js-track-place[data-gk="${key}"]`).forEach((el) => {
            el.textContent = name;
          });
        });
      });
    }

    // --- right panel GPS summary ---
    const sumPts      = document.getElementById('sum-pts');
    const sumAvg      = document.getElementById('sum-avg-speed');
    const sumMax      = document.getElementById('sum-max-speed');
    const sumSat      = document.getElementById('sum-sat');
    if (points.length > 0) {
      const speeds = points.map(p => parseFloat(p.speed||0));
      const avg = (speeds.reduce((a,b)=>a+b,0) / speeds.length).toFixed(1);
      const max = Math.max(...speeds).toFixed(1);
      if (sumPts) sumPts.textContent = String(track ? track.count || points.length : points.length);
      if (sumAvg) sumAvg.textContent = `${avg} km/h`;
      if (sumMax) sumMax.textContent = `${max} km/h`;
      if (sumSat) sumSat.textContent = String(points[points.length-1].sat || '—');
    }

    // --- draw GPS track polyline ---
    if (points.length > 1 && typeof map !== 'undefined') {
      const latlngs = points.map(p => [parseFloat(p.lat), parseFloat(p.lon)]);
      if (trackPolyline) {
        trackPolyline.setLatLngs(latlngs);
      } else {
        trackPolyline = L.polyline(latlngs, {
          color: '#00c8ff', weight: 4, opacity: 0.85,
          lineJoin: 'round', lineCap: 'round',
        }).addTo(map);
      }
    }

    // --- move/create Pi vehicle marker ---
    if (lat !== null && lon !== null && typeof map !== 'undefined') {
      if (piCarMarker) {
        piCarMarker.setLatLng([lat, lon]);
      } else {
        const icon = L.divIcon({
          className: '',
          html: `<div style="width:28px;height:28px;border-radius:50%;background:#00c8ff;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:13px;box-shadow:0 0 0 6px rgba(0,200,255,.25),0 2px 10px rgba(0,200,255,.5)">&#x1F6F0;</div>`,
          iconSize: [28, 28], iconAnchor: [14, 14],
        });
        piCarMarker = L.marker([lat, lon], { icon }).addTo(map);
      }

      // update popup with last-seen time
      const lastTs = points.length > 0 ? points[points.length - 1].ts : null;
      let sinceLabel = 'unknown time';
      if (lastTs) {
        const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
        if (diff < 60)        sinceLabel = `${diff}s ago`;
        else if (diff < 3600) sinceLabel = `${Math.floor(diff / 60)}m ago`;
        else                  sinceLabel = `${Math.floor(diff / 3600)}h ago`;
      }
      const popupHtml = `<b>Here for ${sinceLabel}</b><br><span style="font-size:.8em;color:#666">${lat.toFixed(5)}° N · ${lon.toFixed(5)}° E</span>`;
      if (piCarMarker.getPopup()) piCarMarker.setPopupContent(popupHtml);
      else piCarMarker.bindPopup(popupHtml);

      // pan map to Pi position
      const follow = document.getElementById('btnFollow');
      if (!follow || follow.classList.contains('active')) {
        map.setView([lat, lon], Math.max(map.getZoom(), 15), { animate: true });
      }
    }

    // --- coords display at bottom of map ---
    const coordsEl = document.getElementById('gpsCoords');
    if (coordsEl && lat !== null && lon !== null) {
      const ns = lat >= 0 ? 'N' : 'S';
      const ew = lon >= 0 ? 'E' : 'W';
      coordsEl.textContent = `${Math.abs(lat).toFixed(5)}° ${ns} · ${Math.abs(lon).toFixed(5)}° ${ew}`;
    }

    // --- speed gauge ---
    const speedEl   = document.getElementById('speedNum');
    const statusEl  = document.getElementById('speedStatus');
    const gaugeFill = document.getElementById('gaugeFill');
    if (speedEl) speedEl.textContent = Math.round(speed);
    if (statusEl) {
      if (speed > 60)      { statusEl.textContent = 'Over limit';   statusEl.style.color = 'var(--danger)';  }
      else if (speed > 50) { statusEl.textContent = 'Near limit';   statusEl.style.color = 'var(--warning)'; }
      else                 { statusEl.textContent = 'Within limit'; statusEl.style.color = 'var(--success)'; }
    }
    if (gaugeFill) {
      const circumference = 2 * Math.PI * 27;
      gaugeFill.style.strokeDashoffset = String(circumference * (1 - Math.min(speed / 80, 1)));
    }
  }

  async function refreshFromPi() {
    try {
      const base = await api.detectBase();
      if (base !== lastBase) {
        lastBase = base;
      }
      setConnectionState(true, `Connected: ${base}`);

      const [gps, track, contactData, messagesData] = await Promise.all([
        api.getGpsLatest(),
        api.getGpsTrack(),
        api.getContacts(),
        api.getMessages(),
      ]);

      updateGpsFromBackend(gps, track);

      contacts = Array.isArray(contactData && contactData.contacts) ? contactData.contacts : [];
      lastMessagesData = messagesData && typeof messagesData === 'object' ? messagesData : { sms: [] };
      renderContacts();
      renderMessages(lastMessagesData);
      updateSmsStats(lastMessagesData);
    } catch (err) {
      const reason = err && err.message ? err.message : 'Cannot reach Pi backend';
      setConnectionState(false, `Offline: ${reason}`);
    }
  }

  async function onSend() {
    const message = composeInput ? composeInput.value.trim() : '';
    if (!message) {
      return;
    }

    if (!selectedNumber) {
      alert('Select a contact first.');
      return;
    }

    try {
      sendBtn.disabled = true;
      await api.sendSms([selectedNumber], message);
      if (composeInput) {
        composeInput.value = '';
      }
      await refreshFromPi();
    } catch (err) {
      const reason = err && err.message ? err.message : 'Send failed';
      alert(`Failed to send SMS: ${reason}`);
    } finally {
      sendBtn.disabled = false;
    }
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', onSend);
  }

  if (composeInput) {
    composeInput.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        onSend();
      }
    });
  }

  refreshFromPi();
  setInterval(refreshFromPi, 10000);
})();
