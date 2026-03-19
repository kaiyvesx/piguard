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
  const sendBtn = document.getElementById('smsSendBtn');
  const smsForwardModal = document.getElementById('smsForwardModal');
  const smsModalTitle = document.getElementById('smsModalTitle');
  const smsModalSubtitle = document.getElementById('smsModalSubtitle');
  const smsModalMessage = document.getElementById('smsModalMessage');
  const smsModalRecipientList = document.getElementById('smsModalRecipientList');
  const smsModalExtraNumber = document.getElementById('smsModalExtraNumber');
  const smsModalSendBtn = document.getElementById('smsModalSend');
  const smsModalCancelBtn = document.getElementById('smsModalCancel');
  const smsModalCloseBtn = document.getElementById('smsModalClose');
  const smsArchiveCloseBtn = document.getElementById('smsArchiveBackBtn');
  const smsBadgeEl = document.getElementById('smsBadge');
  const smsThreadAvatarEl = document.getElementById('smsThreadAvatar');
  const smsThreadNameEl = document.getElementById('smsThreadName');
  const smsThreadSubEl = document.getElementById('smsThreadSub');
  const smsArchiveViewBtn = document.getElementById('smsArchiveViewBtn');
  const smsArchiveBackBtn = document.getElementById('smsArchiveBackBtn');
  const smsArchivePage = document.getElementById('smsArchivePage');
  const smsArchiveList = document.getElementById('smsArchiveList');
  const cameraGrid = document.getElementById('cameraGrid');
  const cameraRefreshBtn = document.getElementById('cameraRefreshBtn');
  const cameraModeLiveBtn = document.getElementById('cameraModeLiveBtn');
  const cameraModeSnapshotBtn = document.getElementById('cameraModeSnapshotBtn');
  const cameraConnectionLabel = document.getElementById('cameraConnectionLabel');
  const cameraSidebarList = document.getElementById('cameraSidebarList');
  const cameraDetectedCountEl = document.getElementById('cameraDetectedCount');
  const cameraDetectedBarEl = document.getElementById('cameraDetectedBar');
  const cameraModeLabelEl = document.getElementById('cameraModeLabel');
  const cameraStreamStatusEl = document.getElementById('cameraStreamStatus');

  let selectedNumber = null;
  let lastBase = null;
  let contacts = [];
  let manualContacts = [];
  const MANUAL_CONTACTS_KEY = 'pi-sms-manual-contacts';
  const CONTACT_ALIASES_KEY = 'pi-sms-contact-aliases';
  const ARCHIVED_SMS_KEY = 'pi-sms-archived-messages';
  let contactAliases = {};
  let lastMessagesData = { sms: [] };
  let localOutgoingSms = [];
  let archivedMessages = [];
  let archivedMessageKeys = new Set();
  let archivePageOpen = false;
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

  function getAddNumberBtn() {
    return document.getElementById('smsAddNumberBtn');
  }

  function getNewMessageBtn() {
    return document.getElementById('smsNewMessageBtn');
  }

  function getOpenArchiveBtn() {
    return document.getElementById('smsOpenArchiveBtn');
  }

  function getExtraNumberRow() {
    return document.getElementById('smsExtraRow');
  }

  function getExtraNumberInput() {
    return document.getElementById('smsExtraNumberInput');
  }

  function getExtraNumberHint() {
    return document.getElementById('smsExtraHint');
  }

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

  function buildArchiveKey(item) {
    const rawId = String(item && item.id ? item.id : '').trim();
    if (rawId) return `id:${rawId}`;
    const direction = String(item && item.direction ? item.direction : 'out').trim() || 'out';
    const number = String(item && item.number ? item.number : '').trim();
    const ts = String(item && item.ts ? item.ts : '').trim();
    const message = String(item && item.message ? item.message : '').trim();
    return `msg:${direction}|${number}|${ts}|${message}`;
  }

  function rebuildArchivedMessageKeys() {
    archivedMessageKeys = new Set(archivedMessages.map((item) => String(item.archiveKey || '').trim()).filter(Boolean));
  }

  function loadArchivedMessages() {
    try {
      const raw = localStorage.getItem(ARCHIVED_SMS_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((item) => ({
        id: item && item.id ? String(item.id) : '',
        number: item && item.number ? String(item.number) : '',
        message: item && item.message ? String(item.message) : '',
        ts: item && item.ts ? String(item.ts) : '',
        direction: item && item.direction === 'in' ? 'in' : 'out',
        archivedAt: item && item.archivedAt ? String(item.archivedAt) : new Date().toISOString(),
        archiveKey: item && item.archiveKey ? String(item.archiveKey) : buildArchiveKey(item),
      }));
    } catch {
      return [];
    }
  }

  function saveArchivedMessages() {
    try {
      localStorage.setItem(ARCHIVED_SMS_KEY, JSON.stringify(archivedMessages));
    } catch {
      // ignore storage write errors
    }
  }

  function isArchivedMessage(item) {
    return archivedMessageKeys.has(buildArchiveKey(item));
  }

  function findMessageByArchiveKey(key) {
    const clean = String(key || '').trim();
    if (!clean) return null;
    const candidates = [...getAllBackendThreadMessages(lastMessagesData), ...localOutgoingSms];
    return candidates.find((item) => buildArchiveKey(item) === clean) || null;
  }

  function renderArchivedMessages() {
    if (!smsArchiveList) return;

    const sorted = [...archivedMessages].sort((a, b) => {
      const ta = new Date(a.archivedAt || a.ts || 0).getTime();
      const tb = new Date(b.archivedAt || b.ts || 0).getTime();
      return tb - ta;
    });

    if (!sorted.length) {
      smsArchiveList.innerHTML = '<div class="date-divider">No archived messages yet</div>';
      return;
    }

    smsArchiveList.innerHTML = sorted.map((item) => {
      const archiveKey = escapeHtml(item.archiveKey || '');
      const number = escapeHtml(item.number || 'Unknown');
      const message = escapeHtml(item.message || '');
      const msgTime = escapeHtml(fmtTime(item.ts));
      const archivedTime = escapeHtml(fmtTime(item.archivedAt));
      const direction = item.direction === 'in' ? 'Incoming' : 'Outgoing';
      const timeLabel = msgTime ? `${direction} · ${number} · ${msgTime}` : `${direction} · ${number}`;
      const archivedLabel = archivedTime ? `Archived at ${archivedTime}` : 'Archived';
      return `
        <div class="sms-archive-card">
          <div class="sms-archive-meta">${timeLabel}</div>
          <div class="sms-archive-message">${message}</div>
          <div class="sms-archive-meta">${archivedLabel}</div>
          <div class="sms-archive-actions">
            <button class="btn-add-number sms-unarchive-btn" type="button" data-archive-key="${archiveKey}">Unarchive</button>
          </div>
        </div>
      `;
    }).join('');
  }

  function setArchivePageOpen(open) {
    const nextOpen = !!open;
    archivePageOpen = nextOpen;
    if (smsArchivePage) {
      smsArchivePage.classList.toggle('open', nextOpen);
      smsArchivePage.setAttribute('aria-hidden', nextOpen ? 'false' : 'true');
    }
    if (nextOpen) {
      renderArchivedMessages();
    }
  }

  function archiveMessageByKey(key) {
    const item = findMessageByArchiveKey(key);
    if (!item) return;
    const archiveKey = buildArchiveKey(item);
    if (archivedMessageKeys.has(archiveKey)) return;

    archivedMessages.unshift({
      id: String(item.id || ''),
      number: String(item.number || ''),
      message: String(item.message || ''),
      ts: String(item.ts || ''),
      direction: item.direction === 'in' ? 'in' : 'out',
      archivedAt: new Date().toISOString(),
      archiveKey,
    });
    rebuildArchivedMessageKeys();
    saveArchivedMessages();
    renderContacts();
    renderMessages(lastMessagesData);
    updateSmsStats(lastMessagesData);
    if (archivePageOpen) renderArchivedMessages();
  }

  function unarchiveMessageByKey(key) {
    const clean = String(key || '').trim();
    if (!clean) return;
    archivedMessages = archivedMessages.filter((item) => String(item.archiveKey || '').trim() !== clean);
    rebuildArchivedMessageKeys();
    saveArchivedMessages();
    renderContacts();
    renderMessages(lastMessagesData);
    updateSmsStats(lastMessagesData);
    renderArchivedMessages();
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
      smsThreadSubEl.textContent = number ? `${number} · Pi backend SMS` : 'Select a contact to view messages';
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
    return sent.map((item, idx) => ({
      ...item,
      id: item.id || `sent-${idx}-${item.ts || ''}-${item.number || ''}-${item.message || ''}`,
      number: String(item.number || '').trim(),
      direction: 'out',
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
      .filter((item) => String(item.number || '').trim() === key && !isArchivedMessage(item))
      .sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());

    if (!allSms.length) return key;

    const latestText = String(allSms[0].message || '').replace(/\s+/g, ' ').trim();
    if (!latestText) return key;
    return latestText.length > 42 ? `${latestText.slice(0, 42)}...` : latestText;
  }

  function renderMessages(messagesData) {
    if (!messagesWrap) return;

    const backendSms = getAllBackendThreadMessages(messagesData).filter((item) => !isArchivedMessage(item));
    const localVisible = localOutgoingSms.filter((item) => !isArchivedMessage(item));
    const allSms = [...backendSms, ...localVisible].sort((a, b) => {
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
      const archiveKey = escapeHtml(buildArchiveKey(item));
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
          <div class="msg-time">${metaParts.join(' · ')}</div>
          <div class="msg-actions">
            <button class="msg-forward-btn" type="button">Forward</button>
            <button class="msg-archive-btn" type="button" data-archive-key="${archiveKey}">Archive</button>
            ${item.localStatus === 'failed' ? `<button class="msg-resend-btn" type="button" data-msg-id="${itemId}">Resend</button>` : ''}
          </div>
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
    const allSms = getAllBackendThreadMessages(messagesData).filter((item) => !isArchivedMessage(item));
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
    const addNumberBtn = getAddNumberBtn();
    const extraNumberRow = getExtraNumberRow();
    const extraNumberInput = getExtraNumberInput();
    const extraNumberHint = getExtraNumberHint();
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
    const extraNumberRow = getExtraNumberRow();
    const extraNumberInput = getExtraNumberInput();
    const extraNumberHint = getExtraNumberHint();
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
    const addNumberBtn = getAddNumberBtn();
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
    const extraNumberInput = getExtraNumberInput();
    const recipients = [];
    if (selectedNumber) recipients.push(String(selectedNumber).trim());
    const extra = normalizeExtraNumber(extraNumberInput ? extraNumberInput.value : '');
    if (extra) recipients.push(extra);
    return Array.from(new Set(recipients.filter(Boolean)));
  }

  function getRecipientPool() {
    const unique = new Map();
    contacts.forEach((entry) => {
      const number = String((entry && entry.number) || '').trim();
      if (!number) return;
      if (!unique.has(number)) {
        unique.set(number, {
          number,
          name: getDisplayName(number, entry && entry.name ? entry.name : number),
        });
      }
    });
    return Array.from(unique.values()).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }

  function renderModalRecipients() {
    if (!smsModalRecipientList) return;
    const items = getRecipientPool();
    if (!items.length) {
      smsModalRecipientList.innerHTML = '<div class="sms-modal-empty">No contacts yet. Add a number first.</div>';
      return;
    }

    smsModalRecipientList.innerHTML = items.map((entry) => {
      const number = escapeHtml(entry.number);
      const name = escapeHtml(entry.name || entry.number);
      return `
        <label class="sms-modal-recipient">
          <input type="checkbox" class="sms-modal-recipient-check" value="${number}">
          <div>
            <div class="sms-modal-recipient-name">${name}</div>
            <div class="sms-modal-recipient-num">${number}</div>
          </div>
        </label>
      `;
    }).join('');
  }

  function setModalSelection(numbers) {
    const chosen = new Set((numbers || []).map((num) => String(num || '').trim()).filter(Boolean));
    if (!smsModalRecipientList) return;
    smsModalRecipientList.querySelectorAll('.sms-modal-recipient-check').forEach((input) => {
      input.checked = chosen.has(String(input.value || '').trim());
    });
  }

  function collectModalRecipients() {
    const recipients = [];
    if (smsModalRecipientList) {
      smsModalRecipientList.querySelectorAll('.sms-modal-recipient-check:checked').forEach((input) => {
        recipients.push(String(input.value || '').trim());
      });
    }

    const extra = normalizeExtraNumber(smsModalExtraNumber ? smsModalExtraNumber.value : '');
    if (smsModalExtraNumber && smsModalExtraNumber.value !== extra) {
      smsModalExtraNumber.value = extra;
    }
    if (extra) recipients.push(extra);

    return Array.from(new Set(recipients.filter(Boolean)));
  }

  function openSmsModal(opts = {}) {
    if (!smsForwardModal) return;
    const title = opts.title || 'New message';
    const subtitle = opts.subtitle || 'Choose one or more recipients.';
    const message = opts.message || '';
    const preselect = Array.isArray(opts.preselect) ? opts.preselect : [];

    renderModalRecipients();

    if (smsModalTitle) smsModalTitle.textContent = title;
    if (smsModalSubtitle) smsModalSubtitle.textContent = subtitle;
    if (smsModalMessage) smsModalMessage.value = message;
    if (smsModalExtraNumber) smsModalExtraNumber.value = '';

    setModalSelection(preselect);

    smsForwardModal.classList.add('open');
    smsForwardModal.setAttribute('aria-hidden', 'false');
    if (smsModalMessage) smsModalMessage.focus();
  }

  function closeSmsModal() {
    if (!smsForwardModal) return;
    smsForwardModal.classList.remove('open');
    smsForwardModal.setAttribute('aria-hidden', 'true');
    if (smsModalMessage) smsModalMessage.value = '';
    if (smsModalExtraNumber) smsModalExtraNumber.value = '';
  }

  async function sendMessageToRecipients(recipients, message, options = {}) {
    const cleanMessage = String(message || '').trim();
    const cleanRecipients = Array.from(new Set((recipients || []).map((num) => String(num || '').trim()).filter(Boolean)));
    if (!cleanMessage) {
      alert('Type a message first.');
      return false;
    }
    if (!cleanRecipients.length) {
      alert('Select at least one recipient.');
      return false;
    }

    if (options.pendingInputEl) {
      const maybeNum = normalizeExtraNumber(options.pendingInputEl.value);
      if (maybeNum && maybeNum.length !== 11) {
        alert('Additional number must be exactly 11 digits.');
        options.pendingInputEl.focus();
        return false;
      }
    }

    const disableEls = Array.isArray(options.disableEls) ? options.disableEls.filter(Boolean) : [];

    try {
      disableEls.forEach((el) => { el.disabled = true; });

      cleanRecipients.forEach((num) => { upsertManualContact(num); });
      contacts = combineContacts(contacts);
      renderContacts();

      const localIds = addLocalOutgoingMessages(cleanRecipients, cleanMessage);
      renderMessages(lastMessagesData);

      await api.sendSms(cleanRecipients, cleanMessage);
      updateLocalOutgoingStatus(localIds, 'sent');
      renderMessages(lastMessagesData);
      await refreshFromPi();
      return true;
    } catch (err) {
      const localIds = [];
      localOutgoingSms = localOutgoingSms.map((item) => {
        if (item.localStatus !== 'sending' || item.message !== cleanMessage) return item;
        if (cleanRecipients.includes(String(item.number || '').trim())) {
          localIds.push(item.id);
          return { ...item, localStatus: 'failed' };
        }
        return item;
      });
      if (localIds.length) renderMessages(lastMessagesData);

      const reason = err && err.message ? err.message : 'Send failed';
      alert(`Failed to send SMS: ${reason}`);
      return false;
    } finally {
      disableEls.forEach((el) => { el.disabled = false; });
    }
  }

  async function onModalSend() {
    const message = smsModalMessage ? smsModalMessage.value.trim() : '';
    const recipients = collectModalRecipients();
    const ok = await sendMessageToRecipients(recipients, message, {
      pendingInputEl: smsModalExtraNumber,
      disableEls: [smsModalSendBtn, smsModalCancelBtn, smsModalCloseBtn],
    });
    if (ok) closeSmsModal();
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
    return parts.join(' · ') || 'Detected camera';
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
  }

  function attachCameraMediaHandlers() {
    if (!cameraGrid) return;
    cameraGrid.querySelectorAll('[data-camera-index]').forEach((card) => {
      const img = card.querySelector('.cam-feed-media');
      const placeholder = card.querySelector('.cam-placeholder');
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
      });

      card.addEventListener('click', () => {
        const idx = card.getAttribute('data-camera-index');
        if (!idx || !lastBase) return;
        window.open(`${lastBase}/camera/${idx}/snapshot.jpg?t=${Date.now()}`, '_blank', 'noopener');
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
          <div class="cam-cell is-offline${featuredClass}">
            <div class="cam-feed">
              <div class="cam-placeholder">
                <svg width="${idx === 0 ? 80 : 50}" height="${idx === 0 ? 80 : 50}" viewBox="0 0 24 24" fill="none" stroke="#00c8ff" stroke-width="1">
                  <path d="M23 7l-7 5 7 5V7z"></path><rect x="1" y="5" width="15" height="14" rx="2"></rect>
                </svg>
                <div>No signal</div>
              </div>
            </div>
            <div class="cam-overlay"></div>
            <div class="cam-corner"><div class="cam-dot"></div></div>
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
          <div class="cam-corner"><div class="cam-dot"></div></div>
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
    let lastUpdateLabel = '—';
    if (lastTs) {
      const diff = Math.round((Date.now() - new Date(lastTs).getTime()) / 1000);
      if (diff < 10) lastUpdateLabel = 'Just now';
      else if (diff < 60) lastUpdateLabel = `${diff}s ago`;
      else if (diff < 3600) lastUpdateLabel = `${Math.floor(diff / 60)}m ago`;
      else lastUpdateLabel = `${Math.floor(diff / 3600)}h ago`;
    }
    const statusText = (hb.status && String(hb.status)) || '—';
    const statusClass = /online/i.test(statusText) ? 'online' : (/moving/i.test(statusText) ? 'moving' : 'offline');
    let connectionLabel = '—';
    const cgpaddrRaw = st.CGPADDR ? String(st.CGPADDR) : '';
    const ipMatch = cgpaddrRaw.match(/,(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    const parsedIp = ipMatch ? ipMatch[1] : '';
    if (parsedIp && parsedIp !== '0.0.0.0') connectionLabel = `Cellular / IP: ${parsedIp}`;
    else if (st.CREG_MEANING) connectionLabel = String(st.CREG_MEANING);
    else if (cgpaddrRaw) connectionLabel = 'Cellular (no data IP)';
    const modemLabel = (st.CSQ_MEANING && String(st.CSQ_MEANING)) || (st.AT_MEANING && String(st.AT_MEANING)) || '—';
    const netLog = st.latest_network_log;
    let operatorLabel = (netLog && netLog.operator && String(netLog.operator).trim()) ? String(netLog.operator).trim() : '—';
    if (operatorLabel === '—' && st.COPS) {
      const m = String(st.COPS).match(/,\s*"([^"]+)"/);
      if (m) operatorLabel = m[1];
    }
    const coordsLabel = (lat != null && lon != null) ? `${lat.toFixed(5)} N, ${lon.toFixed(5)} E` : '—';
    const locLabel = (locEl && locEl.textContent && locEl.textContent.trim()) ? locEl.textContent.trim() : coordsLabel;

    const set = (id, text) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text != null && text !== '' ? String(text) : '—';
    };
    set('floatDeviceName', 'RPI-01');
    set('floatDeviceSub', 'Raspberry Pi GPS Tracker');
    set('floatLastUpdate', lastUpdateLabel);
    set('floatSpeed', lat != null ? `${Number(speed || 0).toFixed(0)} km/h` : '—');
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
      : '—';
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
      renderArchivedMessages();
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
    const extraNumberInput = getExtraNumberInput();
    const message = composeInput ? composeInput.value.trim() : '';
    if (!message) {
      return;
    }
    const recipients = getRecipientsForSend();
    if (!recipients.length) {
      alert('Select a contact or enter an additional number first.');
      return;
    }

    const ok = await sendMessageToRecipients(recipients, message, {
      pendingInputEl: extraNumberInput,
      disableEls: [sendBtn, getAddNumberBtn(), getNewMessageBtn()],
    });
    if (!ok) return;

    if (composeInput) composeInput.value = '';
  }

  function toggleExtraNumberInput() {
    const addNumberBtn = getAddNumberBtn();
    const extraNumberRow = getExtraNumberRow();
    const extraNumberInput = getExtraNumberInput();
    const extraNumberHint = getExtraNumberHint();
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

  if (smsModalSendBtn) {
    smsModalSendBtn.addEventListener('click', onModalSend);
  }

  if (smsModalCancelBtn) {
    smsModalCancelBtn.addEventListener('click', closeSmsModal);
  }

  if (smsModalCloseBtn) {
    smsModalCloseBtn.addEventListener('click', closeSmsModal);
  }

  if (smsForwardModal) {
    smsForwardModal.addEventListener('click', (evt) => {
      if (evt.target === smsForwardModal) closeSmsModal();
    });
  }

  if (smsModalMessage) {
    smsModalMessage.addEventListener('keydown', (evt) => {
      if ((evt.ctrlKey || evt.metaKey) && evt.key === 'Enter') {
        evt.preventDefault();
        onModalSend();
      }
    });
  }

  if (smsModalExtraNumber) {
    smsModalExtraNumber.addEventListener('input', () => {
      const clean = normalizeExtraNumber(smsModalExtraNumber.value);
      if (smsModalExtraNumber.value !== clean) smsModalExtraNumber.value = clean;
    });
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
    });
  }

  document.addEventListener('input', (evt) => {
    const target = evt.target;
    if (!target || target.id !== 'smsExtraNumberInput') return;
    updateExtraNumberUi();
  });

  document.addEventListener('keydown', (evt) => {
    const target = evt.target;
    if (!target || target.id !== 'smsExtraNumberInput') return;
    if (evt.key === 'Enter') {
      evt.preventDefault();
      openChatForExtraNumber();
    }
  });

  if (messagesWrap) {
    messagesWrap.addEventListener('click', (evt) => {
      const target = evt.target;
      if (!target || !target.closest) return;
      const forwardBtn = target.closest('.msg-forward-btn');
      if (forwardBtn) {
        evt.preventDefault();
        const msgRow = forwardBtn.closest('.msg');
        const bubble = msgRow ? msgRow.querySelector('.msg-bubble') : null;
        const message = bubble ? String(bubble.textContent || '').trim() : '';
        openSmsModal({
          title: 'Forward message',
          subtitle: 'Choose recipients for this forwarded SMS.',
          message,
        });
        return;
      }
      const archiveBtn = target.closest('.msg-archive-btn');
      if (archiveBtn) {
        evt.preventDefault();
        archiveMessageByKey(archiveBtn.getAttribute('data-archive-key'));
        return;
      }
      const resendBtn = target.closest('.msg-resend-btn');
      if (!resendBtn) return;
      evt.preventDefault();
      resendFailedMessage(resendBtn.getAttribute('data-msg-id'));
    });
  }

  if (smsArchiveList) {
    smsArchiveList.addEventListener('click', (evt) => {
      const target = evt.target;
      if (!target || !target.closest) return;
      const unarchiveBtn = target.closest('.sms-unarchive-btn');
      if (!unarchiveBtn) return;
      evt.preventDefault();
      unarchiveMessageByKey(unarchiveBtn.getAttribute('data-archive-key'));
    });
  }

  document.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Escape') return;
    if (smsForwardModal && smsForwardModal.classList.contains('open')) {
      closeSmsModal();
      return;
    }
    if (archivePageOpen) {
      setArchivePageOpen(false);
    }
  });

  document.addEventListener('click', (evt) => {
    const target = evt.target;
    if (!target || !target.closest) return;

    const addNumberControl = target.closest('#smsAddNumberBtn');
    if (addNumberControl) {
      evt.preventDefault();
      toggleExtraNumberInput();
      return;
    }

    const newMessageControl = target.closest('#smsNewMessageBtn');
    if (newMessageControl) {
      evt.preventDefault();
      openSmsModal({
        title: 'New message',
        subtitle: 'Select recipients and send.',
        message: composeInput ? composeInput.value.trim() : '',
        preselect: selectedNumber ? [selectedNumber] : [],
      });
      return;
    }

    const openArchiveControl = target.closest('#smsOpenArchiveBtn, #smsArchiveViewBtn');
    if (openArchiveControl) {
      evt.preventDefault();
      setArchivePageOpen(true);
      return;
    }

    const archiveBackControl = target.closest('#smsArchiveBackBtn');
    if (archiveBackControl) {
      evt.preventDefault();
      setArchivePageOpen(false);
      return;
    }

    const renameControl = target.closest('#smsRenameBtn');
    if (!renameControl) return;
    evt.preventDefault();
    renameSelectedContact();
  });

  if (smsArchivePage) {
    smsArchivePage.addEventListener('click', (evt) => {
      if (evt.target === smsArchivePage) {
        setArchivePageOpen(false);
      }
    });
  }

  if (smsArchiveCloseBtn) {
    smsArchiveCloseBtn.addEventListener('click', () => setArchivePageOpen(false));
  }

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
  archivedMessages = loadArchivedMessages();
  rebuildArchivedMessageKeys();
  cameraPanelActive = !!document.getElementById('panel-camera')?.classList.contains('active');
  setCameraMode('live');
  renderCameraPanel();
  refreshCameras();
  renderArchivedMessages();
  setArchivePageOpen(false);

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
