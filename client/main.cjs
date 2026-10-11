// Lumivara game client — หนึ่งโปรเซสต่อหนึ่งจอ (แยก --user-data-dir)
// ฟีเจอร์ตาม Lumivara Online 4.4.5: PiP, เต็มหน้าจอ, ซ่อน+ปิดเสียง, รีเฟรช, เล่นต่อตอนย่อ/ซ่อน
// เพิ่ม: กู้คืนเองเมื่อเกมค้าง/แครช/เน็ตหลุด, จำตำแหน่งหน้าต่าง, เปลี่ยนชื่อระหว่างเปิด, จัดเรียงบนจอที่เลือก,
//       รายงาน RAM/CPU, ลดเฟรมเรตตอนซ่อนเพื่อประหยัด CPU
// ไม่มีคำสั่งล้างข้อมูลเข้าสู่ระบบโดยตั้งใจ — เล่นแบบ Guest ข้อมูลหายแล้วกู้ไม่ได้
// ไม่มีแถบปุ่มในหน้าต่าง — สั่งงานทั้งหมดจาก web console (server.js) ผ่าน HTTP 127.0.0.1:<lv-control-port>
'use strict';
const path = require('node:path'), fs = require('node:fs'), http = require('node:http');
const { app, BaseWindow, WebContentsView, screen, globalShortcut, powerSaveBlocker, dialog, session, nativeImage } = require('electron');

const arg = (name) => { const a = process.argv.find((x) => x.startsWith(`--lv-${name}=`)); return a ? a.slice(name.length + 6) : ''; };
const instance = arg('instance') || '1';
const controlPort = Number(arg('control-port'));
const launcherPort = Number(arg('launcher-port')) || 4321;
const cleanTitle = (t) => (typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '');
let title = cleanTitle(arg('title')) || `Lumivara #${instance}`;
const FPS_CHOICES = [0, 20, 10, 5]; // 0 = ไม่จำกัด (เหมือนเดิม)
let hiddenFps = FPS_CHOICES.includes(Number(arg('hidden-fps'))) ? Number(arg('hidden-fps')) : 0;
// เวอร์ชันโค้ดหน้าต่างเกม — เพิ่มทุกครั้งที่เพิ่ม/เปลี่ยนคำสั่ง ให้ตรงกับ CLIENT_VERSION ใน server.js
// launcher ใช้เทียบว่าจอที่เปิดอยู่ต้องปิด-เปิดใหม่เพื่อใช้โค้ดใหม่หรือไม่
const CLIENT_VERSION = 7;
// ชื่อบนแถบหน้าต่าง/taskbar = ชื่อจอ + เวอร์ชัน (launcher ที่เปิดหน้าต่างนี้ ส่งมาทาง --lv-launcher-version) ไว้เทียบเวลามีปัญหา
// เช่น "Main — Launcher v1.1.0 · build a7de5d4 · client v5" · แถบ PiP ใช้แค่ชื่อจอ (พื้นที่เล็ก)
const launcherVersion = arg('launcher-version').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
const windowTitle = () => `${title} — ${launcherVersion ? 'Launcher ' + launcherVersion + ' · ' : ''}client v${CLIENT_VERSION}`;
const gameUrl = 'https://lumivaraonline.com/';
const gameIcon = path.join(__dirname, 'game.ico');
const REF_W = 1100, REF_H = 750, PIP_BAR = 24;
const RETRY_MS = 10000, HANG_MS = 30000;

// ให้เกมทำงานต่อเมื่อหน้าต่างถูกย่อ/ซ่อน
for (const flag of ['disable-background-timer-throttling', 'disable-renderer-backgrounding', 'disable-backgrounding-occluded-windows']) {
  app.commandLine.appendSwitch(flag);
}

let normalWindow, pipWindow, gameView, pipBar, lastPiPBounds;
let moving = false, hidden = false, userMuted = false, quitting = false, hiddenWindows = [];
let recoveries = 0, recovering = false, retryTimer, lastPong = Date.now();
// สถานะในเกม (อ่านทุก 5 วิ พร้อมตัวตรวจเกมค้าง): loads = จำนวนครั้งที่หน้าเกมโหลดเสร็จ (เพิ่มเมื่อเปิด/รีเฟรช/กู้คืน)
// bot = ข้อความ #bot-status ("Running"/"Stopped") · saver = อยู่หน้าประหยัดพลังงาน (#battery-saver แสดงอยู่)
let loads = 0, botText = null, inSaver = false;
// หมายเหตุ: ห้ามใช้ offsetParent ตรวจว่าแสดงอยู่ — องค์ประกอบ position:fixed (เช่น #battery-saver ที่คลุมทั้งจอ) มี offsetParent เป็น null เสมอ
const GAME_PROBE = `(() => { const s = document.getElementById('bot-status'), b = document.getElementById('battery-saver');
  const shown = (e) => { if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && c.display !== 'none' && c.visibility !== 'hidden' && c.opacity !== '0'; };
  return [s ? s.textContent.trim() : null, shown(b)]; })()`;
const popups = new Set();
const allWindows = () => [normalWindow, pipWindow, ...popups].filter((w) => w && !w.isDestroyed());
const allContents = () => [gameView?.webContents, pipBar?.webContents, ...Array.from(popups, (w) => w.webContents)].filter((c) => c && !c.isDestroyed());

// RAM/CPU รวมทุกโปรเซสของจอนี้ (browser, GPU, renderer, utility)
function metrics() {
  let mem = 0, cpu = 0;
  for (const m of app.getAppMetrics()) { mem += m.memory.workingSetSize; cpu += m.cpu.percentCPUUsage; }
  return { mem: Math.round(mem / 1024), cpu: Math.round(cpu * 10) / 10 };
}

function state() {
  return {
    ver: CLIENT_VERSION, title, hidden, muted: userMuted, pip: !!pipWindow, recoveries, recovering,
    loads, bot: botText ? botText.toLowerCase() : null, saver: inSaver,
    fullscreen: !!normalWindow && !normalWindow.isDestroyed() && normalWindow.isFullScreen(),
    ...metrics(),
  };
}

// --- จำตำแหน่ง/ขนาดหน้าต่าง (เก็บใน InstanceN/lv-window.json) ---
const boundsFile = () => path.join(app.getPath('userData'), 'lv-window.json');
function onScreen(b) {
  return b && Number.isFinite(b.x) && Number.isFinite(b.y) && b.width >= 64 && b.height >= 48
    && screen.getAllDisplays().some(({ workArea: a }) =>
      Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x) >= 50 && Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y) >= 50);
}
function loadBounds() {
  try { return JSON.parse(fs.readFileSync(boundsFile(), 'utf8')); } catch { return {}; }
}
function saveBounds() {
  if (!normalWindow || normalWindow.isDestroyed()) return;
  if (pipWindow && !pipWindow.isDestroyed()) lastPiPBounds = pipWindow.getBounds();
  try {
    fs.writeFileSync(boundsFile(), JSON.stringify({ normal: normalWindow.getNormalBounds(), maximized: normalWindow.isMaximized(), pip: lastPiPBounds }));
  } catch { /* ไม่สำคัญถ้าบันทึกไม่ได้ */ }
}

// ย่อภาพเกมให้พอดีหน้าต่าง (อ้างอิงขนาด 1100x750) โดยไม่โหลดเกมใหม่
function layout() {
  const win = pipWindow || normalWindow;
  if (!win || win.isDestroyed() || !gameView) return;
  const bar = pipWindow ? PIP_BAR : 0;
  const [width, height] = win.getContentSize();
  const h = Math.max(1, height - bar);
  // เว้นขอบ 4px ให้ลากย่อ/ขยาย PiP ได้
  if (pipWindow && pipBar) pipBar.setBounds({ x: 4, y: 4, width: Math.max(1, width - 8), height: bar - 4 });
  gameView.setBounds({ x: 0, y: bar, width, height: h });
  gameView.webContents.setZoomFactor(Math.max(0.01, Math.min(1, width / REF_W, h / REF_H)));
}

function applyMute() { allContents().forEach((c) => c.setAudioMuted(hidden || userMuted)); }
function toggleMute() { userMuted = !userMuted; applyMute(); }
function setMute(params) { userMuted = params.get('on') === '1'; applyMute(); }

// ตอนซ่อน: จำกัดเฟรมเรตเกมตาม hiddenFps เพื่อประหยัด CPU (0 = ไม่จำกัด)
// ไม่จำกัด → หน้าต่างที่ซ่อนยังวาดเต็มรีเฟรชเรตจอ (เช่น 144–180 FPS) เพราะ flag กันการพักเบื้องหลัง
function applyFrameRate() {
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed()) return;
  const ms = hidden && hiddenFps ? Math.round(1000 / hiddenFps) : 0;
  wc.executeJavaScript(`window.__lvHiddenMs=${ms}`).catch(() => {});
}
function setFps(params) {
  const v = Number(params.get('v'));
  if (!FPS_CHOICES.includes(v)) throw new Error('invalid fps');
  hiddenFps = v;
  applyFrameRate();
}

function setHidden(hide) {
  if (moving || hide === hidden) return;
  if (hide) {
    hiddenWindows = allWindows().filter((w) => w.isVisible());
    hiddenWindows.forEach((w) => { w.setSkipTaskbar(true); w.hide(); });
  } else {
    hiddenWindows.forEach((w) => { if (!w.isDestroyed()) { w.setSkipTaskbar(false); w.show(); } });
    hiddenWindows = [];
  }
  hidden = hide;
  applyMute();
  applyFrameRate();
}

function focus() {
  setHidden(false);
  const w = pipWindow || normalWindow;
  if (!w || w.isDestroyed()) return;
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

function toggleHidden() { if (hidden) focus(); else setHidden(true); }

function refresh() {
  if (moving || !gameView) return;
  gameView.webContents.reload();
  if (!hidden) gameView.webContents.focus();
}

function setTitle(params) {
  const t = cleanTitle(params.get('t'));
  if (!t) throw new Error('invalid title');
  title = t;
  for (const w of [normalWindow, pipWindow]) if (w && !w.isDestroyed()) w.setTitle(windowTitle());
  if (pipBar) pipBar.webContents.executeJavaScript(`document.getElementById('t').textContent=${JSON.stringify(title + ' · PiP')}`).catch(() => {});
}

function toggleFullscreen() {
  if (moving || hidden) return;
  if (pipWindow) { restoreNormal(); normalWindow.setFullScreen(true); }
  else normalWindow.setFullScreen(!normalWindow.isFullScreen());
}

function togglePiP() {
  if (moving || hidden) return;
  if (pipWindow) restoreNormal();
  else return enterPiP();
}

async function enterPiP() {
  if (pipWindow || moving) return;
  moving = true;
  try {
    const area = screen.getDisplayMatching(normalWindow.getBounds()).workArea;
    if (normalWindow.isFullScreen()) normalWindow.setFullScreen(false);
    const width = Math.min(lastPiPBounds?.width || 360, area.width);
    const height = Math.min(lastPiPBounds?.height || 260, area.height);
    const remembered = onScreen(lastPiPBounds);
    pipWindow = new BaseWindow({
      icon: gameIcon, title: windowTitle(),
      x: remembered ? lastPiPBounds.x : area.x + area.width - width - 16,
      y: remembered ? lastPiPBounds.y : area.y + area.height - height - 16,
      width, height, minWidth: 64, minHeight: 48,
      frame: false, resizable: true, alwaysOnTop: true, show: false, backgroundColor: '#17294e',
    });
    pipWindow.on('resize', layout);
    pipWindow.on('resized', saveBounds);
    pipWindow.on('moved', saveBounds);
    pipWindow.on('closed', () => { pipWindow = null; if (!moving) app.quit(); });

    pipBar = new WebContentsView();
    pipWindow.contentView.addChildView(pipBar);
    installShortcuts(pipBar.webContents);
    await pipBar.webContents.loadFile(path.join(__dirname, 'pip-bar.html'), { query: { t: title } });

    // ย้าย view เดิมไปหน้าต่าง PiP — เกมไม่โหลดใหม่
    normalWindow.contentView.removeChildView(gameView);
    pipWindow.contentView.addChildView(gameView, 0);
    layout();
    pipWindow.show();
    gameView.webContents.focus();
    normalWindow.hide();
  } catch (error) {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.contentView.removeChildView(gameView);
      normalWindow.contentView.addChildView(gameView);
      pipWindow.destroy();
    }
    pipWindow = null; pipBar = null;
    layout();
    normalWindow.show();
    throw error;
  } finally {
    moving = false;
  }
}

function restoreNormal() {
  if (!pipWindow || moving) return;
  moving = true;
  try {
    const old = pipWindow;
    lastPiPBounds = old.getBounds();
    old.contentView.removeChildView(gameView);
    normalWindow.contentView.addChildView(gameView);
    pipWindow = null;
    layout();
    normalWindow.show();
    normalWindow.focus();
    pipBar.webContents.close();
    pipBar = null;
    old.destroy();
    saveBounds();
  } finally {
    moving = false;
  }
}

// รายชื่อจอภาพ ให้ console เลือกจอสำหรับจัดเรียง
function displays() {
  const primary = screen.getPrimaryDisplay().id;
  return screen.getAllDisplays().map((d, i) => ({
    id: d.id, primary: d.id === primary,
    label: `${d.label || 'จอ ' + (i + 1)} (${d.size.width}×${d.size.height})`,
  }));
}

// จัดหน้าต่างนี้ลงช่องที่ i (จากทั้งหมด n ช่อง) ในตารางเต็มจอภาพ d (ไม่ระบุ/หาไม่เจอ = จอหลัก)
// เลือกจำนวนคอลัมน์ที่ทำให้ภาพเกม (1100x750) ใหญ่ที่สุด
async function tile(params) {
  const n = Number(params.get('n')), i = Number(params.get('i'));
  if (!Number.isInteger(n) || !Number.isInteger(i) || n < 1 || n > 50 || i < 0 || i >= n) throw new Error('invalid tile slot');
  if (moving || hidden) return;
  if (pipWindow) restoreNormal();
  if (normalWindow.isFullScreen()) {
    await new Promise((resolve) => { normalWindow.once('leave-full-screen', resolve); normalWindow.setFullScreen(false); setTimeout(resolve, 1000); });
  }
  if (normalWindow.isMinimized()) normalWindow.restore();
  if (normalWindow.isMaximized()) normalWindow.unmaximize();
  const display = screen.getAllDisplays().find((d) => String(d.id) === params.get('d')) || screen.getPrimaryDisplay();
  const area = display.workArea;
  let cols = 1, best = 0;
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c);
    const scale = Math.min(area.width / c / REF_W, area.height / r / REF_H);
    if (scale > best) { best = scale; cols = c; }
  }
  const rows = Math.ceil(n / cols);
  const col = i % cols, row = Math.floor(i / cols);
  const x = area.x + Math.floor((col * area.width) / cols), y = area.y + Math.floor((row * area.height) / rows);
  normalWindow.setBounds({
    x, y,
    width: area.x + Math.floor(((col + 1) * area.width) / cols) - x,
    height: area.y + Math.floor(((row + 1) * area.height) / rows) - y,
  });
  normalWindow.show();
  saveBounds();
}

// --- กู้คืนอัตโนมัติ: เกมแครช / ค้างเกิน 30 วิ / โหลดไม่สำเร็จ (เน็ตหลุด) ---
// ติดตั้ง shim ก่อนสคริปต์เกมรัน (ผ่าน CDP) เพื่อให้เกมคิดว่าหน้าต่างยังมองเห็นอยู่ — ทำใหม่ทุกครั้งที่ renderer ใหม่
async function loadGame() {
  const wc = gameView.webContents;
  clearTimeout(retryTimer);
  await wc.loadURL('about:blank');
  if (wc.debugger.isAttached()) wc.debugger.detach();
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('Page.enable');
  await wc.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
    source: fs.readFileSync(path.join(__dirname, 'visibility-spoof.js'), 'utf8'),
  });
  await wc.loadURL(gameUrl).catch(() => {}); // โหลดไม่สำเร็จ → did-fail-load จัดการลองใหม่
}

function recover(reason) {
  if (quitting || recovering || !gameView || gameView.webContents.isDestroyed()) return;
  recovering = true;
  recoveries++;
  console.log(`[${title}] กู้คืน (${reason}) ครั้งที่ ${recoveries}`);
  setTimeout(() => loadGame().catch(() => scheduleRetry()).finally(() => { recovering = false; }), 3000);
}

function scheduleRetry() {
  if (quitting) return;
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => recover('โหลดไม่สำเร็จ'), RETRY_MS);
}

function watchHealth(wc) {
  wc.on('render-process-gone', (_e, details) => recover('renderer ' + details.reason));
  wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && url.startsWith(gameUrl)) scheduleRetry(); // -3 = ERR_ABORTED (ถูกแทนด้วยการโหลดใหม่)
  });
  // ตรวจเกมค้าง: ถามหน้าเว็บทุก 5 วิ ถ้าไม่ตอบเกิน 30 วิ → ปิด renderer แล้วกู้คืน
  // (event 'unresponsive' ของ Electron จับได้เฉพาะตอนมีคนคลิก/พิมพ์ — จอ AFK ที่ซ่อนอยู่จะไม่มี)
  setInterval(() => {
    if (wc.isDestroyed() || recovering || wc.isLoading()) { lastPong = Date.now(); return; }
    if (Date.now() - lastPong > HANG_MS) {
      lastPong = Date.now();
      wc.forcefullyCrashRenderer(); // → render-process-gone → recover()
      return;
    }
    wc.executeJavaScript(GAME_PROBE).then(([bot, saver]) => { lastPong = Date.now(); botText = bot; inSaver = saver; }, () => {});
  }, 5000);
}

// กดปุ่มคีย์บอร์ด 1 ครั้งในหน้าเกม ผ่าน CDP (debugger ที่ต่อไว้แล้วใน loadGame)
// ใช้ได้แม้หน้าต่างไม่ได้โฟกัสหรือซ่อนอยู่ · จำกัดเฉพาะตัวอักษร ตัวเลข และปุ่มพื้นฐาน — ไม่รับโค้ดอิสระ
const NAMED_KEYS = {
  Space: [' ', 'Space', 32], Enter: ['Enter', 'Enter', 13], Escape: ['Escape', 'Escape', 27], Tab: ['Tab', 'Tab', 9],
  ArrowUp: ['ArrowUp', 'ArrowUp', 38], ArrowDown: ['ArrowDown', 'ArrowDown', 40],
  ArrowLeft: ['ArrowLeft', 'ArrowLeft', 37], ArrowRight: ['ArrowRight', 'ArrowRight', 39],
};
async function pressKey(params) {
  const k = params.get('k') || '';
  let key, code, vk;
  if (/^[a-z]$/i.test(k)) [key, code, vk] = [k.toLowerCase(), 'Key' + k.toUpperCase(), k.toUpperCase().charCodeAt(0)];
  else if (/^\d$/.test(k)) [key, code, vk] = [k, 'Digit' + k, k.charCodeAt(0)];
  else if (Object.hasOwn(NAMED_KEYS, k)) [key, code, vk] = NAMED_KEYS[k];
  else throw new Error('invalid key');
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('เกมยังโหลดไม่เสร็จ');
  const text = key.length === 1 ? key : key === 'Enter' ? '\r' : undefined;
  const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', text, ...base });
  await wc.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// จับภาพเฉพาะหน้าเกม (WebContentsView ของเกม ไม่รวมกรอบหน้าต่าง/แถบ PiP) สำหรับ OCR
// ขยาย 2 เท่าให้ Tesseract อ่านตัวหนังสือเล็กในเกมได้ดีขึ้น · scale = พิกเซลภาพ ต่อ 1 CSS px ของหน้าเกม
// mode 'white': เก็บเฉพาะพิกเซลขาว/เทาอ่อนที่ "ไม่มีสี" (ตัวหนังสือสีขาวบนปุ่มสีเข้ม) เป็นตัวดำบนพื้นขาว — Tesseract อ่านตัวขาวบนพื้นเข้มไม่ออก
// ค่าที่ทดสอบแล้ว (หน้าต่างเล็กแบบจัดเรียง 2×2 และหน้าต่างใหญ่): สว่าง > 160, ต่างสี < 30
//  - สว่าง > 185 อ่านหน้าต่างเล็กไม่ได้เลย (ตัวหนังสือบาง ขอบเทา ถูกตัดทิ้ง)
//  - ต่างสี < 30 กันพื้นสีครีมของแผงในเกมไม่ให้กลายเป็นตัวหนังสือ
// ขยายภาพให้ได้ ~2 พิกเซลภาพต่อ 1 CSS px เสมอ (หน้าต่างเล็กที่เกมย่อภาพ → ขยาย ~3 เท่า, หน้าต่างใหญ่ → ~2 เท่า)
// ขยายตายตัว 3 เท่ากับหน้าต่างเต็มจอทำให้ภาพใหญ่ ~5800×3000 และช้ามาก (~19 วินาที)
const OCR_TARGET_SCALE = 2, WHITE_MIN = 160, WHITE_SPREAD = 30;
async function captureGame(mode) {
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed()) throw new Error('เกมยังไม่พร้อม');
  const img = await wc.capturePage();
  if (img.isEmpty()) throw new Error('จับภาพหน้าเกมไม่ได้');
  const [cssW, cssH] = await wc.executeJavaScript('[innerWidth, innerHeight]');
  const { width, height } = img.getSize();
  // ปัดเป็นจำนวนเต็ม: ขยายแบบเศษ (เช่น 3.14 เท่า) ทำให้ขอบตัวหนังสือเบลอ ความมั่นใจ OCR ตกจาก ~92% เหลือ ~14%
  const up = Math.min(4, Math.max(1, Math.round(OCR_TARGET_SCALE / (width / cssW))));
  let big = img.resize({ width: Math.round(width * up), height: Math.round(height * up), quality: 'best' });
  if (mode === 'white') {
    const size = big.getSize();
    const px = big.toBitmap(); // BGRA
    for (let i = 0; i < px.length; i += 4) {
      const mx = Math.max(px[i], px[i + 1], px[i + 2]), mn = Math.min(px[i], px[i + 1], px[i + 2]);
      const v = mn > WHITE_MIN && mx - mn < WHITE_SPREAD ? 0 : 255;
      px[i] = px[i + 1] = px[i + 2] = v;
      px[i + 3] = 255;
    }
    big = nativeImage.createFromBitmap(px, size);
  }
  return { png: big.toPNG(), scale: big.getSize().width / cssW, cssW, cssH };
}

// คลิกซ้าย 1 ครั้งที่ตำแหน่ง (x, y) เป็น CSS px ของหน้าเกม ผ่าน CDP — ใช้ได้แม้หน้าต่างซ่อน/ไม่ได้โฟกัส
// หาปุ่ม/องค์ประกอบในหน้าเกมจาก id (อ่านอย่างเดียว ไม่แก้หน้าเกม) — คืนข้อความ ตำแหน่งกึ่งกลาง (CSS px) และว่ามองเห็นอยู่ไหม
// ใช้แทน OCR เมื่อปุ่มเป็น HTML จริง (เช่น #bot-battery-saver) — เร็วกว่าและไม่ขึ้นกับขนาดหน้าต่าง/สีปุ่ม
async function findElement(id) {
  if (!/^[\w-]{1,64}$/.test(id || '')) throw new Error('invalid element id');
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed()) throw new Error('เกมยังไม่พร้อม');
  return wc.executeJavaScript(`(() => {
    const el = document.getElementById(${JSON.stringify(id)});
    if (!el) return { found: false };
    const r = el.getBoundingClientRect(), s = getComputedStyle(el);
    // ไม่ใช้ offsetParent: องค์ประกอบ position:fixed มี offsetParent = null แม้แสดงอยู่ (เคยทำให้ตรวจหน้าประหยัดพลังงานผิด)
    const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'
      && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    return { found: true, visible, text: el.textContent.trim().slice(0, 100), x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
}

async function clickAt(params) {
  const x = Number(params.get('x')), y = Number(params.get('y'));
  const wc = gameView?.webContents;
  if (!wc || wc.isDestroyed() || !wc.debugger.isAttached()) throw new Error('เกมยังโหลดไม่เสร็จ');
  const [w, h] = await wc.executeJavaScript('[innerWidth, innerHeight]');
  if (!(x >= 0 && y >= 0 && x < w && y < h)) throw new Error('ตำแหน่งคลิกอยู่นอกหน้าเกม');
  const send = (type, extra) => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra });
  await send('mouseMoved', {});
  await send('mousePressed', { button: 'left', buttons: 1, clickCount: 1 });
  await send('mouseReleased', { button: 'left', buttons: 0, clickCount: 1 });
}

let globalHide = false;
function installShortcuts(contents) {
  contents.setIgnoreMenuShortcuts(true);
  contents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    const key = input.key.toLowerCase();
    const plain = !input.control && !input.alt && !input.shift && !input.meta;
    const cs = input.control && input.shift && !input.alt;
    let action;
    if (key === 'f5' && plain) action = refresh;
    else if (key === 'f8' || (key === 'h' && cs && !globalHide)) action = toggleHidden;
    else if (key === 'f11' || (key === 'enter' && input.alt && !input.control)) action = toggleFullscreen;
    else if (key === 'p' && cs) action = togglePiP;
    else if (key === 'escape' && (pipWindow || normalWindow.isFullScreen())) action = () => (pipWindow ? restoreNormal() : normalWindow.setFullScreen(false));
    if (!action) return;
    event.preventDefault();
    Promise.resolve(action()).catch(() => {});
  });
}

// Ctrl+Shift+H ซ่อน/เรียกกลับทุกจอ: จอแรกที่จองคีย์ได้จะส่งต่อให้ launcher สั่งทุกจอ
// ponytail: ถ้าจอที่จองคีย์ปิดไป จอที่เหลือจะลองจองใหม่ทุก 5 วินาที
function registerGlobalHide() {
  if (globalHide) return;
  globalHide = globalShortcut.register('Control+Shift+H', () => {
    const req = http.request({ host: '127.0.0.1', port: launcherPort, path: '/toggle-all', method: 'POST', headers: { 'X-Lumivara': '1' } });
    req.on('error', toggleHidden); // launcher ปิดอยู่ → ซ่อนเฉพาะจอนี้
    req.end();
  });
}

const actions = {
  pip: togglePiP, fullscreen: toggleFullscreen, refresh, mute: toggleMute, muteSet: setMute, focus,
  hide: () => setHidden(true), show: focus, toggleHide: toggleHidden, quit: () => app.quit(), tile,
  title: setTitle, fps: setFps, key: pressKey, click: clickAt,
};

function startControlServer() {
  http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    // header พิเศษบังคับ CORS preflight และเช็ค Host กัน DNS rebinding — เว็บอื่นในเบราว์เซอร์สั่งไม่ได้
    if (req.headers['x-lumivara'] !== '1' || !/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) return send(403, { ok: false });
    if (req.method === 'GET' && req.url === '/state') return send(200, state());
    if (req.method === 'GET' && req.url === '/displays') return send(200, displays());
    if (req.method === 'GET' && /^\/element(\?|$)/.test(req.url)) {
      try {
        return send(200, await findElement(new URL(req.url, 'http://127.0.0.1').searchParams.get('id')));
      } catch (err) {
        return send(400, { ok: false, error: String(err.message || err) });
      }
    }
    if (req.method === 'GET' && /^\/capture(\?|$)/.test(req.url)) {
      try {
        const shot = await captureGame(new URL(req.url, 'http://127.0.0.1').searchParams.get('mode'));
        res.writeHead(200, { 'Content-Type': 'image/png', 'X-Scale': String(shot.scale), 'X-Css-Size': `${shot.cssW}x${shot.cssH}` });
        return res.end(shot.png);
      } catch (err) {
        return send(500, { ok: false, error: String(err.message || err) });
      }
    }
    const url = new URL(req.url, 'http://127.0.0.1');
    const m = url.pathname.match(/^\/action\/(\w+)$/);
    if (req.method !== 'POST' || !m || !Object.hasOwn(actions, m[1])) return send(404, { ok: false, error: 'not found' });
    try {
      await actions[m[1]](url.searchParams);
      send(200, { ok: true, state: state() });
    } catch (err) {
      send(500, { ok: false, error: String(err.message || err) });
    }
  }).on('error', (err) => {
    dialog.showErrorBox(title, `เปิดพอร์ตควบคุม ${controlPort} ไม่ได้ — หน้าเว็บจะคุมจอนี้ไม่ได้: ${err.message}`);
  }).listen(controlPort, '127.0.0.1');
}

async function createApp() {
  const gameSession = session.fromPartition('persist:lumivara'); // ชื่อเดียวกับ Lumivara.exe เดิม → ใช้ข้อมูลล็อกอินเดิมได้
  const saved = loadBounds();
  if (onScreen(saved.pip)) lastPiPBounds = saved.pip;
  const normal = onScreen(saved.normal) ? saved.normal : { width: 1100, height: 750 };
  normalWindow = new BaseWindow({
    icon: gameIcon, title: windowTitle(), ...normal, minWidth: 320, minHeight: 240,
    autoHideMenuBar: true, backgroundColor: '#17294e', show: false,
  });
  normalWindow.setMenu(null);
  if (saved.maximized) normalWindow.maximize();
  if (!process.argv.includes('--lv-pip')) normalWindow.show();
  for (const ev of ['resize', 'enter-full-screen', 'leave-full-screen']) normalWindow.on(ev, layout);
  for (const ev of ['resized', 'moved', 'maximize', 'unmaximize']) normalWindow.on(ev, saveBounds);
  normalWindow.on('close', saveBounds);
  normalWindow.on('closed', () => app.quit());

  gameView = new WebContentsView({ webPreferences: { session: gameSession, backgroundThrottling: false, sandbox: true } });
  gameView.webContents.setZoomMode('isolated');
  installShortcuts(gameView.webContents);
  watchHealth(gameView.webContents);
  normalWindow.contentView.addChildView(gameView);
  layout();

  gameView.webContents.on('page-title-updated', (e) => e.preventDefault());
  gameView.webContents.on('did-finish-load', () => {
    layout();
    applyFrameRate();
    if (gameView.webContents.getURL().startsWith(gameUrl)) { loads++; botText = null; inSaver = false; }
  });
  gameView.webContents.setWindowOpenHandler(({ url }) => (url.startsWith('https://')
    ? { action: 'allow', overrideBrowserWindowOptions: { webPreferences: { session: gameSession, backgroundThrottling: false, sandbox: true } } }
    : { action: 'deny' }));
  gameView.webContents.on('did-create-window', (popup) => {
    popups.add(popup);
    popup.on('closed', () => popups.delete(popup));
    popup.webContents.setAudioMuted(hidden || userMuted);
    if (hidden) { hiddenWindows.push(popup); popup.setSkipTaskbar(true); popup.hide(); }
  });

  if (process.argv.includes('--lv-pip')) {
    gameView.webContents.once('did-finish-load', () => Promise.resolve(togglePiP()).catch(() => normalWindow.show()));
  }
  await loadGame();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', focus);
  app.on('before-quit', () => { quitting = true; clearTimeout(retryTimer); });
  app.whenReady().then(() => {
    powerSaveBlocker.start('prevent-app-suspension');
    startControlServer();
    registerGlobalHide();
    setInterval(registerGlobalHide, 5000).unref();
    return createApp();
  }).catch((error) => {
    console.error('เปิดเกมไม่สำเร็จ:', error);
    app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
