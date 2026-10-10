(() => {
  if (window.__lumivaraBackgroundShim) return;

  const realRequest = window.requestAnimationFrame.bind(window);
  const realCancel = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let nextId = 1;

  // Phaser normally uses requestAnimationFrame for its update loop. When a
  // minimized window stops receiving paint frames, a timer takes its place.
  // window.__lvHiddenMs is set by client/main.cjs only while the window is hidden and a
  // frame cap is chosen: then real frames are skipped and only the timer drives the loop
  // (hidden windows otherwise keep rendering at full monitor refresh rate).
  window.requestAnimationFrame = callback => {
    const id = nextId++;
    const complete = timestamp => {
      const job = pending.get(id);
      if (!job) return;
      pending.delete(id);
      realCancel(job.frame);
      clearTimeout(job.timer);
      callback(timestamp);
    };
    const hiddenMs = window.__lvHiddenMs;
    const frame = hiddenMs ? 0 : realRequest(complete);
    const timer = setTimeout(() => complete(performance.now()), hiddenMs || 50);
    pending.set(id, { frame, timer });
    return id;
  };
  window.cancelAnimationFrame = id => {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    realCancel(job.frame);
    clearTimeout(job.timer);
  };

  // The game and Phaser read these properties when the window is minimized.
  for (const [name, value] of [['hidden', false], ['visibilityState', 'visible']]) {
    try {
      Object.defineProperty(document, name, { configurable: true, get: () => value });
    } catch { /* A future browser may make this property unchangeable. */ }
  }
  try {
    Object.defineProperty(document, 'hasFocus', { configurable: true, value: () => true });
  } catch { /* Keep the native method if it cannot be replaced. */ }

  Object.defineProperty(window, '__lumivaraBackgroundShim', { value: true });
})();
