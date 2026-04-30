(function () {
  const PARTIALS = {
    header: "components/header.html",
    sidebar: "components/sidebar.html",
    gps: "pages/panel-gps.html",
    mobile: "pages/panel-mobile.html",
    sms: "pages/panel-sms.html",
    camera: "pages/panel-camera.html"
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

    const [headerHtml, sidebarHtml, gpsHtml, mobileHtml, smsHtml, cameraHtml] = await Promise.all([
      loadPartial(PARTIALS.header),
      loadPartial(PARTIALS.sidebar),
      loadPartial(PARTIALS.gps),
      loadPartial(PARTIALS.mobile),
      loadPartial(PARTIALS.sms),
      loadPartial(PARTIALS.camera)
    ]);

    root.innerHTML = [
      headerHtml,
      '<div class="main">',
      sidebarHtml,
      gpsHtml,
      mobileHtml,
      smsHtml,
      cameraHtml,
      '</div>'
    ].join("\n");

    await loadScript("js/index.js");
    await loadScript("js/mobile-shared.js");
    await loadScript("js/panel-mobile.js");
    await loadScript("js/sidebar-mobile.js");
    await loadScript("js/api.js");
  }

  bootstrapLayout().catch((err) => {
    console.error("Layout bootstrap failed:", err);
  });
})();
