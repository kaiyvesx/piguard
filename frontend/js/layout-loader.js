(function () {
  const PARTIALS = {
    header: "layout/header.html",
    sidebar: "layout/sidebar.html",
    gps: "layout/panel-gps.html",
    sms: "layout/panel-sms.html",
    camera: "layout/panel-camera.html"
  };

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error("Failed to load script: " + src));
      document.body.appendChild(el);
    });
  }

  async function loadPartial(path) {
    const res = await fetch(path);
    if (!res.ok) {
      throw new Error("Failed to load partial: " + path);
    }
    return res.text();
  }

  async function bootstrapLayout() {
    const root = document.getElementById("appRoot");
    if (!root) return;

    const [headerHtml, sidebarHtml, gpsHtml, smsHtml, cameraHtml] = await Promise.all([
      loadPartial(PARTIALS.header),
      loadPartial(PARTIALS.sidebar),
      loadPartial(PARTIALS.gps),
      loadPartial(PARTIALS.sms),
      loadPartial(PARTIALS.camera)
    ]);

    root.innerHTML = [
      headerHtml,
      '<div class="main">',
      sidebarHtml,
      gpsHtml,
      smsHtml,
      cameraHtml,
      '</div>'
    ].join("\n");

    await loadScript("js/index.js");
    await loadScript("pi-integration.js");
  }

  bootstrapLayout().catch((err) => {
    console.error("Layout bootstrap failed:", err);
  });
})();
