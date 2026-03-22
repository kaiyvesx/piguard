(function () {
  const api = window.piBridge;
  if (!api) {
    return;
  }

  const connStatusEl = document.getElementById('piConnStatus');
  const gpsStatusEl = document.getElementById('gpsConnStatus');
  const piStatusDotEl = document.getElementById('piStatusDot');
  const gpsStatusDotEl = document.getElementById('gpsStatusDot');
  const contactsWrap = document.getElementById('smsContactsList');
  const messagesWrap = document.getElementById('smsMessagesArea');
  const composeInput = document.getElementById('smsComposeInput');
  const addNumberBtn = document.getElementById('smsAddNumberBtn');
  const extraNumberRow = document.getElementById('smsExtraRow');
  const extraNumberInput = document.getElementById('smsExtraNumberInput');
  const extraNumberHint = document.getElementById('smsExtraHint');
  const sendBtn = document.getElementById('smsSendBtn');
  const smsBadgeEl = document.getElementById('smsBadge');
  const smsThreadAvatarEl = document.getElementById('smsThreadAvatar');
  const smsThreadNameEl = document.getElementById('smsThreadName');
  const smsThreadSubEl = document.getElementById('smsThreadSub');
  const cameraGrid = document.getElementById('cameraGrid');
  const cameraRefreshBtn = document.getElementById('cameraRefreshBtn');
  const cameraModeLiveBtn = document.getElementById('cameraModeLiveBtn');
  const cameraModeSnapshotBtn = document.getElementById('cameraModeSnapshotBtn');
  const cameraConnectionLabel = document.getElementById('cameraConnectionLabel');
  const cameraActionIndicator = document.getElementById('cameraActionIndicator');
  const cameraSlotBackdrop = document.getElementById('cameraSlotBackdrop');
  const cameraSlotMenu = document.getElementById('cameraSlotMenu');
  const cameraSlotMenuTarget = document.getElementById('cameraSlotMenuTarget');
  const cameraSlotMenuCloseBtn = document.getElementById('cameraSlotMenuCloseBtn');
  const cameraMenuRecordStartBtn = document.getElementById('cameraMenuRecordStartBtn');
  const cameraMenuRecordStopBtn = document.getElementById('cameraMenuRecordStopBtn');
  const cameraMenuPowerOffBtn = document.getElementById('cameraMenuPowerOffBtn');
  const cameraMenuPowerOnBtn = document.getElementById('cameraMenuPowerOnBtn');
  const cameraMenuCaptureBtn = document.getElementById('cameraMenuCaptureBtn');
  const cameraMenuIncidentBtn = document.getElementById('cameraMenuIncidentBtn');
  const cameraMenuAutoRecordChip = document.getElementById('cameraMenuAutoRecordChip');
  const cameraMenuAudioMuteChip = document.getElementById('cameraMenuAudioMuteChip');
  const cameraMenuNightVisionChip = document.getElementById('cameraMenuNightVisionChip');
  const cameraSidebarList = document.getElementById('cameraSidebarList');
  const cameraDetectedCountEl = document.getElementById('cameraDetectedCount');
  const cameraDetectedBarEl = document.getElementById('cameraDetectedBar');
  const cameraModeLabelEl = document.getElementById('cameraModeLabel');
  const cameraStreamStatusEl = document.getElementById('cameraStreamStatus');
  const cameraRecordingStateEl = document.getElementById('cameraRecordingState');
  const cameraRecordingActiveCountEl = document.getElementById('cameraRecordingActiveCount');
  const cameraRecordingListEl = document.getElementById('cameraRecordingList');
  const cameraRecordingLastActionEl = document.getElementById('cameraRecordingLastAction');

  let selectedNumber = null;
  let lastBase = null;
  let contacts = [];
  let manualContacts = [];
  const MANUAL_CONTACTS_KEY = 'pi-sms-manual-contacts';
  const CONTACT_ALIASES_KEY = 'pi-sms-contact-aliases';
  let contactAliases = {};
  let lastMessagesData = { sms: [] };
  let localOutgoingSms = [];
  let localOutgoingCounter = 0;
  let lastStatusData = null;
  let trackPolyline = null;
  let piCarMarker = null;
  let lastPanelData = null; // { gps, track, lat, lon, speed, satCount, locEl } for re-fill when panel opens
  let lastCameraData = { count: 0, cameras: [] };
  let cameraMode = 'live';
  let cameraPanelActive = false;
  let cameraRefreshInFlight = false;
  const cameraSnapshotIntervals = new Map();
  const cameraSnapshotRequests = new Map();
  const recordingCameraIndexes = new Set();
  let cameraMenuTargetIndex = 'all';
  let lastRecordingActionLabel = 'No recording command sent';

  function setConnectionState(connected, message) {
    if (!connStatusEl) return;
    connStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
    connStatusEl.textContent = message;
    if (piStatusDotEl) piStatusDotEl.style.background = connected ? 'var(--success)' : 'var(--danger)';
  }

  function setGpsState(connected, message) {
    if (gpsStatusEl) {
      gpsStatusEl.style.color = connected ? 'var(--success)' : 'var(--danger)';
      gpsStatusEl.textContent = message;
    }
    if (gpsStatusDotEl) gpsStatusDotEl.style.background = connected ? 'var(--success)' : 'var(--danger)';
    const floatGpsEl = document.getElementById('floatGpsStatus');
    if (floatGpsEl) floatGpsEl.textContent = connected ? 'On' : 'Disconnected';
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

  function getDisplayName(number, fallbackName = '') {
    const key = String(number || '').trim();
    if (!key) return String(fallbackName || '').trim() || 'No contact selected';
    const alias = (contactAliases[key] || '').trim();
    return alias || String(fallbackName || key).trim();
  }

  function setSelectedNumber(number) {
    selectedNumber = number;

    const activeEls = contactsWrap ? contactsWrap.querySelectorAll('.contact-item') : [];
    activeEls.forEach((el) => {
      const isActive = el.getAttribute('data-number') === number;
      el.classList.toggle('active', isActive);
    });

    const c = contacts.find((item) => String(item.number || '') === String(number || ''));
    const baseName = c && c.name ? String(c.name) : (number ? String(number) : 'No contact selected');
    const labelName = number ? getDisplayName(number, baseName) : baseName;
    if (smsThreadAvatarEl) smsThreadAvatarEl.textContent = pickInitials(labelName);
    if (smsThreadNameEl) smsThreadNameEl.textContent = labelName;
    if (smsThreadSubEl) {
      smsThreadSubEl.textContent = number ? `${number} -+ Pi backend SMS` : 'Select a contact to view messages';
    }

    renderMessages(lastMessagesData);
  }

  function renderContacts() {
    if (!contactsWrap || !Array.isArray(contacts)) return;

    if (!contacts.length) {
      contactsWrap.innerHTML = '<div style="padding:12px 14px;color:var(--muted);font-size:.72rem">No contacts or message threads yet.</div>';
      return;
    }

    const activeNumber = selectedNumber || (contacts[0] && contacts[0].number) || '';
    contactsWrap.innerHTML = contacts.map((c) => {
      const name = escapeHtml(getDisplayName(c.number, c.name || 'Unnamed'));
      const number = escapeHtml(c.number || '');
      const preview = escapeHtml(getLatestMessagePreview(c.number));
      const initials = escapeHtml(pickInitials(getDisplayName(c.number, c.name)));
      return `
        <div class="contact-item${number === activeNumber ? ' active' : ''}" data-number="${number}">
          <div class="contact-avatar">${initials}</div>
          <div class="contact-info">
            <div class="contact-name">${name}</div>
            <div class="contact-preview">${preview}</div>
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
      el.addEventListener('dblclick', () => {
        renameSelectedContact(el.getAttribute('data-number'));
      });
    });

    setSelectedNumber(activeNumber);
  }

  function getBackendSentMessages(messagesData) {
    const sent = messagesData && Array.isArray(messagesData.sms) ? messagesData.sms : [];
    return sent.map((item) => ({
      ...item,
      number: String(item.number || '').trim(),
      direction: item.ok ? 'out' : 'in',
    }));
  }

  function getBackendInboxMessages(messagesData) {
    const inbox = messagesData && Array.isArray(messagesData.sms_inbox) ? messagesData.sms_inbox : [];
    return inbox.map((item, idx) => ({
      id: item.id || `inbox-${idx}-${item.ts || ''}-${item.from_number || ''}`,
      number: String(item.from_number || '').trim(),
      message: item.message || '',
      ts: item.ts,
      ok: false,
      direction: 'in',
    }));
  }

  function getAllBackendThreadMessages(messagesData) {
    return [...getBackendSentMessages(messagesData), ...getBackendInboxMessages(messagesData)].filter((item) => item.number);
  }

  function getLatestMessagePreview(number) {
    const key = String(number || '').trim();
    if (!key) return '';

    const allSms = [...getAllBackendThreadMessages(lastMessagesData), ...localOutgoingSms]
      .filter((item) => String(item.number || '').trim() === key)
      .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());

    if (!allSms.length) return key;

    const latestText = String(allSms[0].message || '').replace(/\s+/g, ' ').trim();
    if (!latestText) return key;
    return latestText.length > 42 ? `${latestText.slice(0, 42)}...` : latestText;
  }

  function renderMessages(messagesData) {
    if (!messagesWrap) return;

    const backendSms = getAllBackendThreadMessages(messagesData);
    const allSms = [...backendSms, ...localOutgoingSms].sort((a, b) => {
      const ta = new Date(a.ts || 0).getTime();
      const tb = new Date(b.ts || 0).getTime();
      return ta - tb;
    });
    if (smsBadgeEl) smsBadgeEl.textContent = String(allSms.length);

    const sms = selectedNumber
      ? allSms.filter((item) => String(item.number || '') === String(selectedNumber))
      : allSms;

    if (!sms.length) {
      messagesWrap.innerHTML = `<div class="date-divider">${selectedNumber ? 'No messages for this contact yet' : 'No message logs yet'}</div>`;
      return;
    }

    const rows = sms.slice(-20).map((item) => {
      const number = escapeHtml(item.number || 'Unknown');
      const msg = escapeHtml(item.message || '');
      const time = escapeHtml(fmtTime(item.ts));
      const itemId = escapeHtml(item.id || '');
      const msgStatus = item.localStatus
        ? (item.localStatus === 'sending' ? 'Sending...' : (item.localStatus === 'sent' ? 'Sent' : 'Failed'))
        : '';
      const ok = item.localStatus ? 'out' : (item.direction === 'in' ? 'in' : 'out');
      const metaParts = [number];
      if (time) metaParts.push(time);
      if (msgStatus) metaParts.push(msgStatus);
      return `
        <div class="msg ${ok}">
          <div class="msg-bubble">${msg}</div>
          <div class="msg-time">${metaParts.join(' -+ ')}</div>
          ${item.localStatus === 'failed' ? `<button class="msg-resend-btn" type="button" data-msg-id="${itemId}">Resend</button>` : ''}
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
    const allSms = getAllBackendThreadMessages(messagesData);
    const incoming = allSms.filter((m) => m.direction === 'in').length;

    if (unreadEl) unreadEl.textContent = String(incoming);
    if (totalEl) totalEl.textContent = String(allSms.length);
    if (onlineEl) onlineEl.textContent = String(contacts.length);
  }

  function addLocalOutgoingMessages(recipients, message) {
    const nowTs = new Date().toISOString();
    const ids = recipients.map((recipient) => {
      const id = `local-${Date.now()}-${localOutgoingCounter++}`;
      localOutgoingSms.push({
        id,
        number: String(recipient).trim(),
        message,
        ts: nowTs,
        ok: true,
        localStatus: 'sending',
      });
      return id;
    });
    return ids;
  }

  function updateLocalOutgoingStatus(ids, status) {
    const idSet = new Set(ids);
    localOutgoingSms = localOutgoingSms.map((item) => {
      if (!idSet.has(item.id)) return item;
      return { ...item, localStatus: status };
    });
  }

  async function resendFailedMessage(localId) {
    const id = String(localId || '').trim();
    if (!id) return;

    const failedItem = localOutgoingSms.find((item) => String(item.id || '') === id);
    if (!failedItem || failedItem.localStatus !== 'failed') return;

    localOutgoingSms = localOutgoingSms.map((item) => {
      if (String(item.id || '') !== id) return item;
      return { ...item, localStatus: 'sending', ts: new Date().toISOString() };
    });
    renderMessages(lastMessagesData);

    try {
      await api.sendSms([String(failedItem.number || '').trim()], String(failedItem.message || ''));
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (String(item.id || '') !== id) return item;
        return { ...item, localStatus: 'sent', ts: new Date().toISOString() };
      });
      renderMessages(lastMessagesData);
      await refreshFromPi();
    } catch {
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (String(item.id || '') !== id) return item;
        return { ...item, localStatus: 'failed', ts: new Date().toISOString() };
      });
      renderMessages(lastMessagesData);
    }
  }

  function pruneDeliveredLocalMessages(backendSms) {
    if (!Array.isArray(backendSms) || !backendSms.length || !localOutgoingSms.length) return;
    localOutgoingSms = localOutgoingSms.filter((localItem) => {
      if (localItem.localStatus !== 'sent') return true;
      const localMsg = String(localItem.message || '').trim();
      const localNumber = String(localItem.number || '').trim();
      return !backendSms.some((serverItem) => {
        const serverMsg = String(serverItem.message || '').trim();
        const serverNumber = String(serverItem.number || '').trim();
        return serverMsg === localMsg && serverNumber === localNumber;
      });
    });
  }

  function normalizeExtraNumber(raw) {
    return String(raw || '').replace(/\D/g, '').slice(0, 11);
  }

  function loadManualContacts() {
    try {
      const raw = localStorage.getItem(MANUAL_CONTACTS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      const seen = new Set();
      return parsed
        .map((entry) => {
          const number = normalizeExtraNumber(entry && entry.number);
          if (number.length !== 11 || seen.has(number)) return null;
          seen.add(number);
          return { name: number, number };
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  function loadContactAliases() {
    try {
      const raw = localStorage.getItem(CONTACT_ALIASES_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
      return parsed;
    } catch {
      return {};
    }
  }

  function saveManualContacts() {
    try {
      localStorage.setItem(MANUAL_CONTACTS_KEY, JSON.stringify(manualContacts));
    } catch {
      // ignore storage write errors
    }
  }

  function saveContactAliases() {
    try {
      localStorage.setItem(CONTACT_ALIASES_KEY, JSON.stringify(contactAliases));
    } catch {
      // ignore storage write errors
    }
  }

  function ensureSelectedNumber() {
    if (selectedNumber) return String(selectedNumber).trim();
    const first = contacts && contacts[0] ? String(contacts[0].number || '').trim() : '';
    if (first) {
      setSelectedNumber(first);
      return first;
    }
    return '';
  }

  function openRenameDialog(number, currentName) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;z-index:9999;';

      const card = document.createElement('div');
      card.style.cssText = 'width:min(92vw,360px);background:var(--card-bg,#0f1724);border:1px solid var(--card-border,#2a3446);border-radius:12px;padding:14px;box-shadow:0 10px 30px rgba(0,0,0,.45);color:var(--text,#e7edf5);';

      const title = document.createElement('div');
      title.textContent = 'Rename Contact';
      title.style.cssText = 'font-size:.9rem;font-weight:700;margin-bottom:6px;';

      const subtitle = document.createElement('div');
      subtitle.textContent = number;
      subtitle.style.cssText = 'font-size:.72rem;color:var(--muted,#9ab0c8);margin-bottom:10px;';

      const input = document.createElement('input');
      input.type = 'text';
      input.value = currentName || '';
      input.placeholder = 'Enter display name';
      input.style.cssText = 'width:100%;height:36px;border-radius:10px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);padding:0 10px;outline:none;';

      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;margin-top:12px;';

      const mkBtn = (label) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.style.cssText = 'height:32px;padding:0 10px;border-radius:8px;border:1px solid var(--card-border,#2a3446);background:var(--surface-1,#111c2e);color:var(--text,#e7edf5);cursor:pointer;';
        return btn;
      };

      const btnCancel = mkBtn('Cancel');
      const btnReset = mkBtn('Reset');
      const btnSave = mkBtn('Save');
      btnSave.style.borderColor = 'var(--primary,#00c8ff)';

      actions.appendChild(btnCancel);
      actions.appendChild(btnReset);
      actions.appendChild(btnSave);

      card.appendChild(title);
      card.appendChild(subtitle);
      card.appendChild(input);
      card.appendChild(actions);
      overlay.appendChild(card);
      document.body.appendChild(overlay);
      input.focus();
      input.select();

      const close = (value) => {
        overlay.remove();
        resolve(value);
      };

      overlay.addEventListener('click', (evt) => {
        if (evt.target === overlay) close(null);
      });
      btnCancel.addEventListener('click', () => close(null));
      btnReset.addEventListener('click', () => close(''));
      btnSave.addEventListener('click', () => close(input.value));
      input.addEventListener('keydown', (evt) => {
        if (evt.key === 'Enter') {
          evt.preventDefault();
          close(input.value);
        } else if (evt.key === 'Escape') {
          evt.preventDefault();
          close(null);
        }
      });
    });
  }

  async function renameSelectedContact(targetNumber) {
    const key = String(targetNumber || ensureSelectedNumber()).trim();
    if (!key) {
      alert('No contact to rename yet.');
      return;
    }

    const current = getDisplayName(key, key);
    const next = await openRenameDialog(key, current);
    if (next === null) return;

    const clean = String(next).trim();
    if (!clean || clean === key) {
      delete contactAliases[key];
    } else {
      contactAliases[key] = clean;
    }
    saveContactAliases();

    renderContacts();
    setSelectedNumber(key);
  }

  function updateExtraNumberUi() {
    if (!addNumberBtn) return;
    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    const isValid = clean.length === 11;

    if (extraNumberInput && extraNumberInput.value !== clean) {
      extraNumberInput.value = clean;
    }

    if (extraNumberHint) {
      if (!clean) {
        extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
        extraNumberHint.className = 'sms-extra-hint';
      } else if (isValid) {
        extraNumberHint.textContent = `Added: ${clean}`;
        extraNumberHint.className = 'sms-extra-hint ok';
      } else {
        extraNumberHint.textContent = `Enter 11 digits (${clean.length}/11)`;
        extraNumberHint.className = 'sms-extra-hint warn';
      }
    }

    addNumberBtn.classList.toggle('active', !extraNumberRow || !extraNumberRow.hasAttribute('hidden'));
    addNumberBtn.classList.toggle('added', isValid);
  }

  function upsertManualContact(number) {
    const clean = normalizeExtraNumber(number);
    if (clean.length !== 11) return null;

    const existsInBackend = contacts.some((item) => String(item.number || '') === clean);
    const existsInManual = manualContacts.some((item) => String(item.number || '') === clean);
    if (!existsInBackend && !existsInManual) {
      manualContacts.unshift({ name: clean, number: clean });
      saveManualContacts();
    }
    return clean;
  }

  function combineContacts(backendContacts) {
    const merged = [];
    const seen = new Set();

    const add = (entry) => {
      const num = String((entry && entry.number) || '').trim();
      if (!num || seen.has(num)) return;
      seen.add(num);
      merged.push({
        name: entry && entry.name ? entry.name : num,
        number: num,
      });
    };

    (backendContacts || []).forEach(add);
    getAllBackendThreadMessages(lastMessagesData).forEach((item) => {
      add({ name: item.number, number: item.number });
    });
    manualContacts.forEach(add);
    return merged;
  }

  function openChatForExtraNumber() {
    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (clean.length !== 11) {
      if (extraNumberHint) {
        extraNumberHint.textContent = `Enter 11 digits (${clean.length}/11)`;
        extraNumberHint.className = 'sms-extra-hint warn';
      }
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const selected = upsertManualContact(clean);
    contacts = combineContacts(contacts);
    renderContacts();
    if (selected) setSelectedNumber(selected);

    if (extraNumberRow) extraNumberRow.setAttribute('hidden', '');
    if (addNumberBtn) {
      addNumberBtn.classList.remove('active');
      addNumberBtn.classList.remove('added');
    }
    if (extraNumberInput) extraNumberInput.value = '';
    if (extraNumberHint) {
      extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
      extraNumberHint.className = 'sms-extra-hint';
    }
    if (composeInput) composeInput.focus();
  }

  function getRecipientsForSend() {
    const recipients = [];
    if (selectedNumber) recipients.push(String(selectedNumber).trim());
    const extra = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (extra) recipients.push(extra);
    return Array.from(new Set(recipients.filter(Boolean)));
  }

  function setCameraMode(nextMode) {
    cameraMode = nextMode === 'snapshot' ? 'snapshot' : 'live';
    if (cameraModeLiveBtn) cameraModeLiveBtn.classList.toggle('active', cameraMode === 'live');
    if (cameraModeSnapshotBtn) cameraModeSnapshotBtn.classList.toggle('active', cameraMode === 'snapshot');
    if (cameraModeLabelEl) cameraModeLabelEl.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
    syncCameraMedia();
    updateCameraSidebar();
  }

  function setCameraConnectionState(message) {
    if (cameraConnectionLabel) cameraConnectionLabel.textContent = message;
  }

  function getCameraTargetLabel(targetIndex) {
    if (targetIndex === 'all') return 'All Cameras';
    const num = Number(targetIndex);
    return Number.isFinite(num) ? `Camera ${num}` : 'Selected Camera';
  }

  function setCameraActionIndicator(message) {
    if (!cameraActionIndicator) return;
    cameraActionIndicator.textContent = message;
  }

  function flashCameraAction(btn) {
    if (!btn) return;
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 220);
  }

  function hideCameraSlotMenu() {
    if (cameraSlotBackdrop) cameraSlotBackdrop.hidden = true;
    if (!cameraSlotMenu) return;
    cameraSlotMenu.hidden = true;
  }

  function updateCameraSlotMenuTarget() {
    if (!cameraSlotMenuTarget) return;
    cameraSlotMenuTarget.textContent = `${getCameraTargetLabel(cameraMenuTargetIndex)} controls`;
  }

  function openCameraSlotMenuAt(cameraIndex) {
    if (!cameraSlotMenu) return;
    cameraMenuTargetIndex = String(cameraIndex || 'all');
    updateCameraSlotMenuTarget();
    if (cameraSlotBackdrop) cameraSlotBackdrop.hidden = false;
    cameraSlotMenu.hidden = false;
    const firstMenuBtn = cameraSlotMenu.querySelector('.cam-admin-btn');
    if (firstMenuBtn && typeof firstMenuBtn.focus === 'function') firstMenuBtn.focus();
  }

  function queueCameraUiAction(actionText, targetIndex) {
    const label = getCameraTargetLabel(String(targetIndex || cameraMenuTargetIndex || 'all'));
    setCameraActionIndicator(`${actionText} for ${label} (UI preview only).`);
  }

  function getAvailableCameraIndexes() {
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras.slice(0, 4) : [];
    const indexes = cameras
      .map((camera) => String(Number(camera && camera.index)))
      .filter((idx) => /^\d+$/.test(idx));
    if (indexes.length) return Array.from(new Set(indexes));
    return ['1', '2', '3', '4'];
  }

  function resolveRecordingTargetIndexes(targetIndex) {
    const normalized = String(targetIndex || '').trim();
    if (!normalized || normalized === 'all') return getAvailableCameraIndexes();
    return /^\d+$/.test(normalized) ? [normalized] : [];
  }

  function updateCameraRecordingBadges() {
    if (!cameraGrid) return;
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      const idx = String(card.getAttribute('data-camera-index') || '').trim();
      const dot = card.querySelector('.cam-dot');
      if (!dot) return;
      dot.classList.remove('online', 'rec');
      if (recordingCameraIndexes.has(idx)) {
        dot.classList.add('rec');
        return;
      }
      if (card.classList.contains('is-live')) {
        dot.classList.add('online');
      }
    });
  }

  function applyRecordingCommand(command, targetIndex) {
    const targets = resolveRecordingTargetIndexes(targetIndex);
    if (!targets.length) return;

    targets.forEach((idx) => {
      if (command === 'start') recordingCameraIndexes.add(idx);
      else recordingCameraIndexes.delete(idx);
    });

    const timeLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const scopeLabel = getCameraTargetLabel(String(targetIndex || 'all'));
    lastRecordingActionLabel = `${command === 'start' ? 'Start recording' : 'Stop recording'} -> ${scopeLabel} (${timeLabel})`;
    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  function cameraTitle(camera, slotIndex) {
    if (!camera) return `Camera Slot ${slotIndex + 1}`;
    const idx = Number(camera.index);
    return Number.isFinite(idx) ? `Camera ${idx}` : `Camera ${slotIndex + 1}`;
  }

  function cameraMeta(camera) {
    if (!camera) return 'Waiting for signal';
    const parts = [];
    if (camera.device) parts.push(String(camera.device));
    if (camera.width && camera.height) parts.push(`${camera.width}x${camera.height}`);
    if (camera.fps) parts.push(`${Math.round(Number(camera.fps))} fps`);
    return parts.join(' | ') || 'Detected camera';
  }

  function buildCameraMediaUrl(cameraIndex) {
    if (!lastBase) return '';
    return `${lastBase}/camera/${cameraIndex}/snapshot.jpg?t=${Date.now()}`;
  }

  function clearCameraSnapshotIntervals() {
    cameraSnapshotIntervals.forEach((timerId) => {
      clearInterval(timerId);
    });
    cameraSnapshotIntervals.clear();
  }

  async function refreshCameraCardFrame(card) {
    if (!card) return;
    const idx = card.getAttribute('data-camera-index');
    const img = card.querySelector('.cam-feed-media');
    const placeholder = card.querySelector('.cam-placeholder');
    const status = card.querySelector('.cam-status');
    const key = String(idx || '').trim();
    if (!key || !img || !api.getCameraSnapshot) return;
    if (cameraSnapshotRequests.has(key)) return;

    const request = (async () => {
      try {
        const dataUrl = await api.getCameraSnapshot(Number(key));
        img.src = dataUrl;
        if (status) {
          status.className = 'cam-status online';
          status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
        }
      } catch {
        img.hidden = true;
        img.removeAttribute('src');
        if (placeholder) placeholder.hidden = false;
        card.classList.add('is-offline');
        card.classList.remove('is-live');
        if (status) {
          status.className = 'cam-status offline';
          status.textContent = 'Offline';
        }
      } finally {
        cameraSnapshotRequests.delete(key);
      }
    })();

    cameraSnapshotRequests.set(key, request);
    return request;
  }

  function updateCameraSidebar() {
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras : [];
    if (cameraSidebarList) {
      if (!cameras.length) {
        cameraSidebarList.innerHTML = `
          <div style="background:var(--surface-1);border:1px solid var(--card-border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:.78rem;font-weight:600;color:var(--text)">No cameras detected</div>
            <span class="cam-status offline">Offline</span>
          </div>
        `;
      } else {
        cameraSidebarList.innerHTML = cameras.slice(0, 4).map((camera, idx) => `
          <div style="background:var(--surface-1);border:1px solid var(--card-border);border-radius:8px;padding:10px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px">
            <div style="min-width:0">
              <div style="font-size:.78rem;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cameraTitle(camera, idx))}</div>
              <div style="font-size:.64rem;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(cameraMeta(camera))}</div>
            </div>
            <span class="cam-status online">Ready</span>
          </div>
        `).join('');
      }
    }

    if (cameraDetectedCountEl) cameraDetectedCountEl.textContent = String(cameras.length);
    if (cameraDetectedBarEl) cameraDetectedBarEl.style.width = `${Math.min(cameras.length, 4) * 25}%`;
    if (cameraStreamStatusEl) {
      cameraStreamStatusEl.textContent = !cameras.length
        ? 'No signal'
        : (cameraPanelActive ? (cameraMode === 'live' ? 'Streaming' : 'Snapshots') : 'Standby');
    }

    if (cameraRecordingStateEl) {
      const isRecording = recordingCameraIndexes.size > 0;
      cameraRecordingStateEl.textContent = isRecording ? 'Recording' : 'Stopped';
      cameraRecordingStateEl.style.color = isRecording ? 'var(--danger)' : 'var(--success)';
    }
    if (cameraRecordingActiveCountEl) {
      cameraRecordingActiveCountEl.textContent = `${recordingCameraIndexes.size} camera(s)`;
    }
    if (cameraRecordingListEl) {
      const activeIndexes = Array.from(recordingCameraIndexes)
        .map((idx) => Number(idx))
        .filter((idx) => Number.isFinite(idx))
        .sort((a, b) => a - b);

      if (!activeIndexes.length) {
        cameraRecordingListEl.innerHTML = '<div style="font-size:.66rem;color:var(--muted)">No cameras recording</div>';
      } else {
        cameraRecordingListEl.innerHTML = activeIndexes
          .map((idx) => `<div style="font-size:.67rem;color:var(--text)">Camera ${idx} recording</div>`)
          .join('');
      }
    }
    if (cameraRecordingLastActionEl) {
      cameraRecordingLastActionEl.textContent = lastRecordingActionLabel;
    }
  }

  function attachCameraMediaHandlers() {
    if (!cameraGrid) return;
    cameraGrid.querySelectorAll('[data-camera-index]').forEach((card) => {
      const idx = card.getAttribute('data-camera-index');
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');

      card.addEventListener('click', () => {
        if (!idx || !lastBase) return;
        window.open(`${lastBase}/camera/${idx}/snapshot.jpg?t=${Date.now()}`, '_blank', 'noopener');
      });

      card.addEventListener('contextmenu', (evt) => {
        if (!idx) return;
        evt.preventDefault();
        openCameraSlotMenuAt(idx);
      });

      const menuBtn = card.querySelector('.cam-menu-btn');
      if (menuBtn) {
        menuBtn.addEventListener('click', (evt) => {
          evt.preventDefault();
          evt.stopPropagation();
          const btnIdx = menuBtn.getAttribute('data-camera-index') || idx;
          if (!btnIdx) return;
          openCameraSlotMenuAt(btnIdx);
        });
      }

      if (!img || !placeholder) return;

      img.addEventListener('load', () => {
        placeholder.hidden = true;
        img.hidden = false;
        card.classList.remove('is-offline');
        card.classList.add('is-live');
        const status = card.querySelector('.cam-status');
        if (status) {
          status.className = 'cam-status online';
          status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
        }
        updateCameraRecordingBadges();
      });

      img.addEventListener('error', () => {
        img.hidden = true;
        img.removeAttribute('src');
        placeholder.hidden = false;
        card.classList.add('is-offline');
        card.classList.remove('is-live');
        const status = card.querySelector('.cam-status');
        if (status) {
          status.className = 'cam-status offline';
          status.textContent = 'Offline';
        }
        updateCameraRecordingBadges();
      });

    });
  }

  function renderCameraPanel() {
    if (!cameraGrid) return;
    const cameras = Array.isArray(lastCameraData.cameras) ? lastCameraData.cameras.slice(0, 4) : [];
    const slots = Array.from({ length: 4 }, (_, idx) => cameras[idx] || null);

    cameraGrid.innerHTML = slots.map((camera, idx) => {
      const featuredClass = idx === 0 ? ' featured' : '';
      if (!camera) {
        return `
          <div class="cam-cell is-offline${featuredClass}" data-camera-index="${idx + 1}">
            <div class="cam-feed">
              <div class="cam-placeholder">
                <svg width="${idx === 0 ? 80 : 50}" height="${idx === 0 ? 80 : 50}" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
                  <path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect>
                </svg>
                <div>No signal</div>
              </div>
            </div>
            <div class="cam-overlay"></div>
            <div class="cam-corner">
              <button type="button" class="cam-menu-btn" data-camera-index="${idx + 1}" aria-label="Open actions for ${escapeHtml(cameraTitle(camera, idx))}">&#8942;</button>
              <div class="cam-dot"></div>
            </div>
            <div class="cam-label">
              <span class="cam-name">${escapeHtml(cameraTitle(camera, idx))}</span>
              <span class="cam-status offline">Offline</span>
            </div>
            <div class="cam-empty-note"><span>Camera not detected</span></div>
          </div>
        `;
      }

      return `
        <div class="cam-cell${featuredClass}" data-camera-index="${escapeHtml(camera.index)}">
          <div class="cam-feed">
            <img class="cam-feed-media" alt="${escapeHtml(cameraTitle(camera, idx))}" hidden>
            <div class="cam-placeholder">
              <svg width="${idx === 0 ? 80 : 50}" height="${idx === 0 ? 80 : 50}" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
                <path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect>
              </svg>
              <div>${escapeHtml(cameraMeta(camera))}</div>
            </div>
          </div>
          <div class="cam-overlay"></div>
          <div class="cam-corner">
            <button type="button" class="cam-menu-btn" data-camera-index="${escapeHtml(camera.index)}" aria-label="Open actions for ${escapeHtml(cameraTitle(camera, idx))}">&#8942;</button>
            <div class="cam-dot"></div>
          </div>
          <div class="cam-label">
            <span class="cam-name">${escapeHtml(cameraTitle(camera, idx))}</span>
            <span class="cam-status online">${cameraMode === 'live' ? 'Live' : 'Snapshot'}</span>
          </div>
        </div>
      `;
    }).join('');

    attachCameraMediaHandlers();
    syncCameraMedia();
    updateCameraSidebar();
  }

  function stopCameraMedia() {
    if (!cameraGrid) return;
    clearCameraSnapshotIntervals();
    cameraGrid.querySelectorAll('.cam-feed-media').forEach((img) => {
      img.hidden = true;
      img.removeAttribute('src');
    });
    cameraGrid.querySelectorAll('.cam-placeholder').forEach((placeholder) => {
      placeholder.hidden = false;
    });
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      card.classList.remove('is-live');
      card.classList.add('is-offline');
      const status = card.querySelector('.cam-status');
      if (status) {
        status.className = 'cam-status offline';
        status.textContent = 'Standby';
      }
    });
    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  function syncCameraMedia() {
    if (!cameraGrid) return;
    if (!cameraPanelActive || !lastBase) {
      stopCameraMedia();
      return;
    }

    clearCameraSnapshotIntervals();
    cameraGrid.querySelectorAll('.cam-cell[data-camera-index]').forEach((card) => {
      const idx = card.getAttribute('data-camera-index');
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');
      const status = card.querySelector('.cam-status');
      if (!idx || !img) return;

      card.classList.remove('is-offline');
      if (status) {
        status.className = 'cam-status online';
        status.textContent = cameraMode === 'live' ? 'Live' : 'Snapshot';
      }
      if (placeholder) placeholder.hidden = false;

      void refreshCameraCardFrame(card);

      if (cameraMode === 'live') {
        const timerId = setInterval(() => {
          void refreshCameraCardFrame(card);
        }, 1200);
        cameraSnapshotIntervals.set(String(idx), timerId);
      }
    });

    updateCameraRecordingBadges();
    updateCameraSidebar();
  }

  async function refreshCameras() {
    if (!api.getCameras || cameraRefreshInFlight) return;
    cameraRefreshInFlight = true;
    try {
      const base = await api.detectBase();
      if (base !== lastBase) lastBase = base;
      const cameraData = await api.getCameras();
      const cameras = Array.isArray(cameraData && cameraData.cameras) ? cameraData.cameras : [];
      lastCameraData = { count: cameras.length, cameras };
      setCameraConnectionState(cameras.length ? `${cameras.length} camera(s) online` : 'No cameras detected');
      renderCameraPanel();
    } catch (err) {
      lastCameraData = { count: 0, cameras: [] };
      setCameraConnectionState(`Camera offline: ${err && err.message ? err.message : 'unreachable'}`);
      renderCameraPanel();
    } finally {
      cameraRefreshInFlight = false;
    }
  }

  function openDevicePanel() {
    const panel = document.getElementById('devicePanelFloat');
    if (panel) {
      if (lastPanelData) {
        const locEl = document.getElementById('gps-location');
        updateFloatingDevicePanel(
          lastPanelData.gps,
          lastPanelData.track,
          lastStatusData,
          lastPanelData.lat,
          lastPanelData.lon,
          lastPanelData.speed,
          lastPanelData.satCount,
          locEl
        );
      }
      panel.classList.add('open');
      panel.setAttribute('aria-hidden', 'false');
    }
  }

  function closeDevicePanel() {
    const panel = document.getElementById('devicePanelFloat');
    if (panel) {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
    }
  }

  function updateFloatingDevicePanel(gps, track, statusData, lat, lon, speed, satCount, locEl) {
    const st = statusData || {};
    const hb = st.heartbeat || {};
    const points = track && Array.isArray(track.points) ? track.points : [];
    const lastTs = points.length > 0 ? points[points.length - 1].ts : hb.last_seen_ts || null;
    let lastUpdateLabel = 'G��';
    if (lastTs) {
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      if (diff < 10) lastUpdateLabel = 'Just now';
      else if (diff < 60) lastUpdateLabel = `${diff}s ago`;
      else if (diff < 3600) lastUpdateLabel = `${Math.floor(diff / 60)}m ago`;
      else lastUpdateLabel = `${Math.floor(diff / 3600)}h ago`;
    }
    const statusText = (hb.status && String(hb.status)) || 'G��';
    const statusClass = /online/i.test(statusText) ? 'online' : (/moving/i.test(statusText) ? 'moving' : 'offline');
    let connectionLabel = 'G��';
    const cgpaddrRaw = st.CGPADDR ? String(st.CGPADDR) : '';
    const ipMatch = cgpaddrRaw.match(/,(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    const parsedIp = ipMatch ? ipMatch[1] : '';
    if (parsedIp && parsedIp !== '0.0.0.0') connectionLabel = `Cellular / IP: ${parsedIp}`;
    else if (st.CREG_MEANING) connectionLabel = String(st.CREG_MEANING);
    else if (cgpaddrRaw) connectionLabel = 'Cellular (no data IP)';
    const modemLabel = (st.CSQ_MEANING && String(st.CSQ_MEANING)) || (st.AT_MEANING && String(st.AT_MEANING)) || 'G��';
    const netLog = st.latest_network_log;
    let operatorLabel = (netLog && netLog.operator && String(netLog.operator).trim()) ? String(netLog.operator).trim() : 'G��';
    if (operatorLabel === 'G��' && st.COPS) {
      const m = String(st.COPS).match(/,\s*"([^"]+)"/);
      if (m) operatorLabel = m[1];
    }
    const coordsLabel = (lat != null && lon != null) ? `${lat.toFixed(5)} N, ${lon.toFixed(5)} E` : 'G��';
    const locLabel = (locEl && locEl.textContent && locEl.textContent.trim()) ? locEl.textContent.trim() : coordsLabel;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text != null && text !== '' ? String(text) : 'G��';
    };
    set('floatDeviceName', 'RPI-01');
    set('floatDeviceSub', 'Raspberry Pi GPS Tracker');
    set('floatLastUpdate', lastUpdateLabel);
    set('floatSpeed', lat != null ? `${Number(speed || 0).toFixed(0)} km/h` : 'G��');
    set('floatCoords', locLabel);
    set('floatOperator', operatorLabel);
    set('floatConnection', connectionLabel);
    set('floatModem', modemLabel);
    set('floatDeviceType', 'Raspberry Pi 4');
    const statusWrap = document.getElementById('floatDeviceStatus');
    const statusTextEl = document.getElementById('floatDeviceStatusText');
    if (statusWrap) statusWrap.className = 'device-status ' + statusClass;
    if (statusTextEl) statusTextEl.textContent = statusText;
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
    const gpsConnected = Boolean(hasFix && gps.lat != null && gps.lon != null);
    setGpsState(gpsConnected, gpsConnected ? 'GPS: On' : 'GPS: Disconnected');
    const satCount = gps && gps.sat != null ? gps.sat : (points.length > 0 ? points[points.length-1].sat : 'G��');

    if (locEl) {
      if (lat !== null) {
        // show cached name instantly, then update asynchronously
        const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
        locEl.textContent = cached || `${Math.abs(lat).toFixed(5)}-� ${lat>=0?'N':'S'}, ${Math.abs(lon).toFixed(5)}-� ${lon>=0?'E':'W'}`;
        if (!cached) reverseGeocode(lat, lon).then(name => { if (name && locEl) locEl.textContent = name; });
      } else {
        locEl.textContent = 'No fix yet';
      }
    }
    if (subEl) subEl.textContent = hasFix ? 'Live GPS fix active' : (points.length > 0 ? `Last fix: ${fmtTime(points[points.length-1].ts)}` : 'Waiting for GPS fixGǪ');
    if (satEl) satEl.textContent = String(satCount);
    if (altEl) {
      const alt = hasFix && gps.alt != null ? parseFloat(gps.alt).toFixed(0)+'m'
                : (points.length > 0 ? parseFloat(points[points.length-1].alt).toFixed(0)+'m' : 'G��');
      altEl.textContent = alt;
    }
    if (ptsEl) ptsEl.textContent = String(track ? track.count || points.length : 0);

    // --- bottom bar live coords ---
    const coordValEl  = document.getElementById('live-coord-value');
    const coordUpdEl  = document.getElementById('live-last-update');
    if (coordValEl && lat !== null) {
      const cached = _geocodeCache.get(`${lat.toFixed(3)},${lon.toFixed(3)}`);
      coordValEl.textContent = cached || `${Math.abs(lat).toFixed(5)}-� ${lat>=0?'N':'S'} -+ ${Math.abs(lon).toFixed(5)}-� ${lon>=0?'E':'W'}`;
      if (!cached) reverseGeocode(lat, lon).then(name => { if (name && coordValEl) coordValEl.textContent = name; });
    }
    if (coordUpdEl && points.length > 0) {
      const lastTs = points[points.length - 1].ts;
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      coordUpdEl.textContent = diff < 60 ? `Updated ${diff}s ago` : diff < 3600 ? `Updated ${Math.floor(diff/60)}m ago` : `Updated ${Math.floor(diff/3600)}h ago`;
    }

    // --- floating device panel content (updated every refresh; re-filled when panel opens) ---
    lastPanelData = { gps, track, lat, lon, speed, satCount };
    updateFloatingDevicePanel(gps, track, lastStatusData, lat, lon, speed, satCount, locEl);

    // --- draw track log polyline (blue line on map) ---
    if (points.length > 1 && typeof map !== 'undefined') {
      const latlngs = points.map(p => [parseFloat(p.lat), parseFloat(p.lon)]);
      if (trackPolyline) {
        trackPolyline.setLatLngs(latlngs);
      } else {
        trackPolyline = L.polyline(latlngs, {
          color: '#00c8ff',
          weight: 4,
          opacity: 0.85,
          lineJoin: 'round',
          lineCap: 'round',
        }).addTo(map);
      }
    }

    // --- move/create Pi vehicle marker ---
    const lastOnlineAgo = (lastStatusData && lastStatusData.heartbeat && lastStatusData.heartbeat.last_online_ago)
      ? String(lastStatusData.heartbeat.last_online_ago)
      : 'G��';
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
        piCarMarker.bindTooltip('', {
          direction: 'top',
          permanent: false,
          className: 'marker-tooltip-last-seen',
          offset: [0, -24],
        });
        piCarMarker.on('click', function onMarkerClick() {
          openDevicePanel();
          if (piCarMarker && piCarMarker.getTooltip()) piCarMarker.openTooltip();
        });
      }
      if (piCarMarker && piCarMarker.getTooltip()) {
        piCarMarker.setTooltipContent(`Last seen: ${lastOnlineAgo}`);
      }

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
      coordsEl.textContent = `${Math.abs(lat).toFixed(5)}-� ${ns} -+ ${Math.abs(lon).toFixed(5)}-� ${ew}`;
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
        syncCameraMedia();
      }
      setConnectionState(true, `RasPi: Connected (${base})`);

      const [gps, track, contactData, messagesData, statusData] = await Promise.all([
        api.getGpsLatest(),
        api.getGpsTrack(),
        api.getContacts(),
        api.getMessages(),
        api.getStatus(),
      ]);

      lastStatusData = statusData && typeof statusData === 'object' ? statusData : null;
      updateGpsFromBackend(gps, track);

      const backendContacts = Array.isArray(contactData && contactData.contacts) ? contactData.contacts : [];
      lastMessagesData = messagesData && typeof messagesData === 'object' ? messagesData : { sms: [] };
      contacts = combineContacts(backendContacts);
      pruneDeliveredLocalMessages(lastMessagesData.sms);
      renderContacts();
      renderMessages(lastMessagesData);
      updateSmsStats(lastMessagesData);
    } catch (err) {
      const reason = err && err.message ? err.message : 'Cannot reach Pi backend';
      setConnectionState(false, `RasPi: Offline (${reason})`);
      setGpsState(false, 'GPS: Disconnected');
      lastStatusData = null;
      setCameraConnectionState(`Camera offline: ${reason}`);
      stopCameraMedia();
    }
  }

  async function onSend() {
    const message = composeInput ? composeInput.value.trim() : '';
    if (!message) {
      return;
    }

    const extraRaw = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (extraRaw && extraRaw.length !== 11) {
      alert('Additional number must be exactly 11 digits.');
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const recipients = getRecipientsForSend();
    if (!recipients.length) {
      alert('Select a contact or enter an additional number first.');
      return;
    }

    try {
      sendBtn.disabled = true;
      if (addNumberBtn) addNumberBtn.disabled = true;

      const localIds = addLocalOutgoingMessages(recipients, message);
      renderMessages(lastMessagesData);
      if (composeInput) {
        composeInput.value = '';
      }

      await api.sendSms(recipients, message);
      updateLocalOutgoingStatus(localIds, 'sent');
      renderMessages(lastMessagesData);

      await refreshFromPi();
    } catch (err) {
      const localIds = [];
      // Keep failed messages visible in thread so the user gets feedback.
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (item.localStatus !== 'sending' || item.message !== message) return item;
        if (recipients.includes(String(item.number || '').trim())) {
          localIds.push(item.id);
          return { ...item, localStatus: 'failed' };
        }
        return item;
      });
      if (localIds.length) renderMessages(lastMessagesData);

      const reason = err && err.message ? err.message : 'Send failed';
      alert(`Failed to send SMS: ${reason}`);
    } finally {
      sendBtn.disabled = false;
      if (addNumberBtn) addNumberBtn.disabled = false;
    }
  }

  function toggleExtraNumberInput() {
    if (!extraNumberRow || !addNumberBtn) return;
    const hidden = extraNumberRow.hasAttribute('hidden');
    if (hidden) {
      extraNumberRow.removeAttribute('hidden');
      addNumberBtn.classList.add('active');
      updateExtraNumberUi();
      if (extraNumberInput) extraNumberInput.focus();
      return;
    }

    const clean = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (clean.length === 11) {
      openChatForExtraNumber();
      return;
    }

    extraNumberRow.setAttribute('hidden', '');
    addNumberBtn.classList.remove('active');
    addNumberBtn.classList.remove('added');
    if (extraNumberInput) extraNumberInput.value = '';
    if (extraNumberHint) {
      extraNumberHint.textContent = 'Numbers only, up to 11 digits.';
      extraNumberHint.className = 'sms-extra-hint';
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

  if (addNumberBtn) {
    addNumberBtn.addEventListener('click', toggleExtraNumberInput);
  }

  if (cameraModeLiveBtn) {
    cameraModeLiveBtn.addEventListener('click', () => setCameraMode('live'));
  }

  if (cameraModeSnapshotBtn) {
    cameraModeSnapshotBtn.addEventListener('click', () => setCameraMode('snapshot'));
  }

  if (cameraRefreshBtn) {
    cameraRefreshBtn.addEventListener('click', () => {
      refreshCameras();
      setCameraActionIndicator('Refreshing camera feeds...');
    });
  }

  [
    [cameraMenuRecordStartBtn, 'Recording started', 'start'],
    [cameraMenuRecordStopBtn, 'Recording stopped', 'stop'],
    [cameraMenuPowerOffBtn, 'Camera power off command queued'],
    [cameraMenuPowerOnBtn, 'Camera power on command queued'],
    [cameraMenuCaptureBtn, 'Snapshot capture queued'],
    [cameraMenuIncidentBtn, 'Incident flag queued'],
  ].forEach(([btn, actionText, recordingCommand]) => {
    if (!btn) return;
    btn.addEventListener('click', () => {
      flashCameraAction(btn);
      queueCameraUiAction(actionText, cameraMenuTargetIndex);
      if (recordingCommand) applyRecordingCommand(recordingCommand, cameraMenuTargetIndex);
      hideCameraSlotMenu();
    });
  });

  [cameraMenuAutoRecordChip, cameraMenuAudioMuteChip, cameraMenuNightVisionChip]
    .filter(Boolean)
    .forEach((chip) => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('active');
        chip.setAttribute('aria-checked', chip.classList.contains('active') ? 'true' : 'false');
        const state = chip.classList.contains('active') ? 'enabled' : 'disabled';
        const label = (chip.textContent || 'Policy').trim();
        queueCameraUiAction(`${label} ${state}`, cameraMenuTargetIndex);
      });
    });

  if (cameraSlotMenu) {
    cameraSlotMenu.addEventListener('contextmenu', (evt) => evt.preventDefault());
  }

  if (cameraSlotBackdrop) {
    cameraSlotBackdrop.addEventListener('click', hideCameraSlotMenu);
  }

  if (cameraSlotMenuCloseBtn) {
    cameraSlotMenuCloseBtn.addEventListener('click', hideCameraSlotMenu);
  }

  document.addEventListener('click', (evt) => {
    if (!cameraSlotMenu || cameraSlotMenu.hidden) return;
    const target = evt.target;
    if (target && target.closest && target.closest('#cameraSlotMenu')) return;
    hideCameraSlotMenu();
  });

  document.addEventListener('keydown', (evt) => {
    if (evt.key === 'Escape') hideCameraSlotMenu();
  });

  if (extraNumberInput) {
    extraNumberInput.addEventListener('input', updateExtraNumberUi);
    extraNumberInput.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter') {
        evt.preventDefault();
        openChatForExtraNumber();
      }
    });
  }

  if (messagesWrap) {
    messagesWrap.addEventListener('click', (evt) => {
      const target = evt.target;
      if (!target || !target.closest) return;
      const resendBtn = target.closest('.msg-resend-btn');
      if (!resendBtn) return;
      evt.preventDefault();
      resendFailedMessage(resendBtn.getAttribute('data-msg-id'));
    });
  }

  document.addEventListener('click', (evt) => {
    const target = evt.target;
    if (!target || !target.closest) return;
    const renameControl = target.closest('#smsRenameBtn');
    if (!renameControl) return;
    evt.preventDefault();
    renameSelectedContact();
  });

  [smsThreadNameEl, smsThreadSubEl, smsThreadAvatarEl].filter(Boolean).forEach((el) => {
    el.style.cursor = 'pointer';
    el.title = 'Double-click to rename (local only)';
    el.addEventListener('dblclick', () => renameSelectedContact());
  });

  const devicePanelClose = document.getElementById('devicePanelClose');
  if (devicePanelClose) {
    devicePanelClose.addEventListener('click', closeDevicePanel);
  }

  manualContacts = loadManualContacts();
  contactAliases = loadContactAliases();
  cameraPanelActive = !!document.getElementById('panel-camera')?.classList.contains('active');
  setCameraMode('live');
  renderCameraPanel();
  refreshCameras();

  refreshFromPi();
  setInterval(refreshFromPi, 10000);
  setInterval(refreshCameras, 30000);

  window.centerOnTracker = function () {
    if (piCarMarker && typeof map !== 'undefined') {
      map.setView(piCarMarker.getLatLng(), map.getMaxZoom(), { animate: true });
    }
  };

  window.onDashboardPanelChange = function (name) {
    cameraPanelActive = name === 'camera';
    if (cameraPanelActive) {
      refreshCameras();
      syncCameraMedia();
    } else {
      stopCameraMedia();
    }
  };

  window.openDevicePanel = openDevicePanel;
})();
