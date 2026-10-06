// sidePanel.open only works inside the click itself, so the window id is
// looked up ahead of time instead of awaited in the handler.
let windowId;
chrome.windows.getCurrent().then((w) => { windowId = w.id; });
document.querySelector(".cta").addEventListener("click", () => {
  if (windowId != null) chrome.sidePanel.open({ windowId }).catch((e) => console.warn("sidePanel.open", e));
});

// One confetti burst from the congrats heading, then the canvas is removed.
(() => {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const c = document.querySelector(".confetti"), x = c.getContext("2d");
  const dpr = devicePixelRatio || 1;
  const size = () => { c.width = innerWidth * dpr; c.height = innerHeight * dpr; x.setTransform(dpr, 0, 0, dpr, 0, 0); };
  size(); addEventListener("resize", size);
  const colors = ["#ffe15a", "#f5cf1b", "#1f2440", "#7aa7e0", "#ffffff", "#2bb3a3"];
  const r = document.querySelector(".congrats").getBoundingClientRect();
  const ox = r.left + r.width / 2, oy = r.top + r.height / 2;
  const bits = Array.from({ length: 160 }, () => {
    const a = Math.random() * Math.PI * 2, v = 6 + Math.random() * 10;
    return { x: ox, y: oy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 7,
      w: 6 + Math.random() * 6, h: 4 + Math.random() * 4, rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.4, c: colors[(Math.random() * colors.length) | 0] };
  });
  const t0 = performance.now();
  const tick = (t) => {
    const age = t - t0;
    x.clearRect(0, 0, innerWidth, innerHeight);
    x.globalAlpha = Math.max(0, 1 - Math.max(0, age - 2600) / 900);
    for (const b of bits) {
      b.vx *= 0.985; b.vy = b.vy * 0.985 + 0.32;
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      x.save(); x.translate(b.x, b.y); x.rotate(b.rot);
      x.scale(1, Math.cos(b.rot * 2));
      x.fillStyle = b.c; x.fillRect(-b.w / 2, -b.h / 2, b.w, b.h); x.restore();
    }
    if (age < 3500) requestAnimationFrame(tick); else c.remove();
  };
  requestAnimationFrame(tick);
})();
