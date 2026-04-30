(function () {
  if (window.PiguardMobileShared) {
    return;
  }

  var COLORS = ["#2196F3", "#4CAF50", "#FF9800", "#9C27B0", "#F44336", "#00BCD4", "#FF5722", "#8BC34A", "#E91E63", "#607D8B"];

  function getEl(id) {
    return document.getElementById(id);
  }

  function toNum(v) {
    var n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function getDeviceId(v) {
    if (!v) {
      return "";
    }
    return String(v.deviceId || v.device_id || "").trim();
  }

  function safeTs(ts) {
    var raw = ts != null ? ts : Date.now();
    if (Number.isFinite(Number(raw))) {
      var msDate = new Date(Number(raw));
      if (!Number.isNaN(msDate.getTime())) {
        return msDate.toISOString();
      }
    }
    var d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return new Date().toISOString();
    }
    return d.toISOString();
  }

  function friendlyName(deviceId) {
    if (!deviceId) {
      return "Unknown";
    }
    if (String(deviceId).startsWith("mobile-")) {
      return "User " + String(deviceId).split("-")[1];
    }
    return "User " + String(deviceId).slice(0, 8);
  }

  function lastSeenText(ts) {
    if (!ts) {
      return "never";
    }
    var mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
    if (!Number.isFinite(mins)) {
      return "never";
    }
    if (mins < 1) {
      return "just now";
    }
    if (mins < 60) {
      return mins + "m ago";
    }
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) {
      return hrs + "h ago";
    }
    return Math.floor(hrs / 24) + "d ago";
  }

  function isActive(ts) {
    if (!ts) {
      return false;
    }
    return Date.now() - new Date(ts).getTime() < 30000;
  }

  function colorFromIndex(idx) {
    var color = COLORS[idx];
    if (!color) {
      return "hsl(" + ((idx * 47) % 360) + ",72%,54%)";
    }
    return color;
  }

  window.PiguardMobileShared = {
    COLORS: COLORS,
    getEl: getEl,
    toNum: toNum,
    getDeviceId: getDeviceId,
    safeTs: safeTs,
    friendlyName: friendlyName,
    lastSeenText: lastSeenText,
    isActive: isActive,
    colorFromIndex: colorFromIndex
  };
})();
