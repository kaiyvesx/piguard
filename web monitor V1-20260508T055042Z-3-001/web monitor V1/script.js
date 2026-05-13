// Pi Monitor Script
// Basic handlers for the Raspberry Pi monitor page

const CONFIG_KEY = "pi-monitor-config";

function getConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveConfig(partial) {
  try {
    const current = getConfig();
    localStorage.setItem(CONFIG_KEY, JSON.stringify({ ...current, ...partial }));
  } catch {
    // ignore
  }
}

function loadConfigToUI() {
  const config = getConfig();
  const piBase = document.getElementById("piBase");
  const backendBase = document.getElementById("backendBase");
  const adminToken = document.getElementById("adminToken");
  const refreshMs = document.getElementById("refreshMs");

  if (piBase) piBase.value = config.piBase || "";
  if (backendBase) backendBase.value = config.backendBase || "";
  if (adminToken) adminToken.value = config.adminToken || "";
  if (refreshMs) refreshMs.value = config.refreshMs || 5000;
}

function initHandlers() {
  const saveBtn = document.getElementById("saveBtn");
  const runBtn = document.getElementById("runBtn");
  const autoBtn = document.getElementById("autoBtn");

  if (saveBtn) {
    saveBtn.addEventListener("click", () => {
      const piBase = document.getElementById("piBase")?.value || "";
      const backendBase = document.getElementById("backendBase")?.value || "";
      const adminToken = document.getElementById("adminToken")?.value || "";
      const refreshMs = parseInt(document.getElementById("refreshMs")?.value || 5000);
      saveConfig({ piBase, backendBase, adminToken, refreshMs });
      alert("Config saved");
    });
  }

  if (runBtn) {
    runBtn.addEventListener("click", () => {
      alert("Manual refresh not implemented yet");
    });
  }

  if (autoBtn) {
    autoBtn.addEventListener("click", () => {
      alert("Auto refresh not implemented yet");
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    loadConfigToUI();
    initHandlers();
  });
} else {
  loadConfigToUI();
  initHandlers();
}
