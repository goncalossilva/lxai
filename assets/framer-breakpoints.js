(() => {
  const preserveAttr = "data-lxai-preserve-hidden";
  const styleId = "lxai-framer-breakpoints";
  let frame = 0;

  function getBreakpoints(main) {
    try {
      return JSON.parse(main.dataset.framerHydrateV2 || "{}").breakpoints || [];
    } catch {
      return [];
    }
  }

  function getActiveHashes(breakpoints) {
    const hashes = [];

    for (const breakpoint of breakpoints) {
      if (!breakpoint?.hash) continue;
      if (!breakpoint.mediaQuery) {
        hashes.push(breakpoint.hash);
        continue;
      }

      try {
        if (window.matchMedia(breakpoint.mediaQuery).matches) {
          hashes.push(breakpoint.hash);
        }
      } catch {}
    }

    if (hashes.length > 0) return hashes;
    return breakpoints[0]?.hash ? [breakpoints[0].hash] : [];
  }

  function getStyleElement() {
    let style = document.getElementById(styleId);
    if (style) return style;

    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
    return style;
  }

  function update() {
    const main = document.getElementById("main");
    if (!main) return;

    const breakpoints = getBreakpoints(main);
    if (breakpoints.length === 0) return;

    const activeHashes = getActiveHashes(breakpoints);
    main.dataset.lxaiActiveBreakpoints = activeHashes.join(" ");

    const style = getStyleElement();
    style.textContent = activeHashes
      .map(
        (hash) =>
          `#main .hidden-${hash}:not([${preserveAttr}~="${hash}"]) { display: none !important; }`
      )
      .join("\n");

    window.__framer_onRewriteBreakpoints?.(breakpoints);
  }

  function scheduleUpdate() {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(update);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", update, { once: true });
  } else {
    update();
  }

  window.addEventListener("resize", scheduleUpdate, { passive: true });
  window.addEventListener("orientationchange", scheduleUpdate);
  window.addEventListener("pageshow", scheduleUpdate);
})();
