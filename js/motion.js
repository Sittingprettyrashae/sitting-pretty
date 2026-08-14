// Sitting Pretty — living imagery. Every [data-video] image upgrades to a
// silent seamless video loop, as pure enhancement: the stills are the page,
// and anyone on reduced motion, data saver, or a browser that refuses
// autoplay simply keeps them. The hero pair loads right away; the signature
// cards wait until they are scrolled near, and pause when they leave.
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const conn = navigator.connection;
  if (conn && conn.saveData) return;

  function upgrade(img, onLive) {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.autoplay = true;
    v.playsInline = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.preload = "auto";
    v.poster = img.currentSrc || img.src;
    // The video takes the image's exact place: same classes, same inline
    // styles, so every CSS rule (radius, object-fit, crops) carries over.
    v.className = img.className;
    const style = img.getAttribute("style");
    if (style) v.setAttribute("style", style);
    v.setAttribute("aria-hidden", "true");
    v.src = img.getAttribute("data-video");
    v.addEventListener("canplay", () => {
      if (img.parentNode) img.replaceWith(v);
      const p = v.play();
      if (p && p.catch) p.catch(() => { v.replaceWith(img); });
      // Only now is the video actually in the document, so only now can an
      // observer meaningfully track it (a detached node reports nothing).
      if (onLive) onLive(v);
    }, { once: true });
    // If the file fails to arrive, nothing happens: the still stays.
    return v;
  }

  const eager = [];
  const lazy = [];
  document.querySelectorAll("img[data-video]").forEach((img) => {
    (img.hasAttribute("data-eager") ? eager : lazy).push(img);
  });

  eager.forEach(upgrade);

  if (!lazy.length) return;
  if (typeof IntersectionObserver !== "function") { lazy.forEach(upgrade); return; }
  const started = new WeakSet();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      const el = e.target;
      // A video's own entries mean play or rest, never re-upgrade: without
      // this branch coming first, a video's arrival entry would fall into
      // the upgrade path and unobserve it forever.
      if (el.tagName === "VIDEO") {
        if (e.isIntersecting) { const p = el.play(); if (p && p.catch) p.catch(() => {}); }
        else el.pause();
        return;
      }
      if (e.isIntersecting && !started.has(el)) {
        started.add(el);
        // Keep observing the video once it lands, so it rests when away.
        upgrade(el, (v) => io.observe(v));
        io.unobserve(el);
      }
    });
  }, { rootMargin: "200px" });
  lazy.forEach((img) => io.observe(img));
})();
