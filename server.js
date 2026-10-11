// Lumivara Multi-Launcher
// เปิดหลายจอของเกม (client/main.cjs บน Electron runtime) แยก --user-data-dir ให้แต่ละจอ
// และเป็น web console คุมทุกจอ: เปิด/ปิด, PiP, เต็มหน้าจอ, ซ่อน/แสดง, ปิดเสียง, รีเฟรช, จัดเรียง,
// เปลี่ยนชื่อ, เปิดอัตโนมัติ, สำรองข้อมูล (คัดลอกเท่านั้น ไม่ลบ), ดู RAM/CPU
// ไฟล์นี้มีแค่ logic + API — หน้าเว็บอยู่ใน public/ (index.html, style.css, app.js)

const http = require('http');
const { spawn, exec, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4321;
const CONTROL_BASE_PORT = 4400; // จอที่ N ฟังคำสั่งที่พอร์ต 4400+N
const CONFIG_PATH = path.join(__dirname, 'config.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_INSTANCES = 50; // พอร์ตควบคุมใช้ 4401-4450
// เวอร์ชันโค้ดหน้าต่างเกมที่ต้องการ (ตรงกับ CLIENT_VERSION ใน client/main.cjs) — จอที่ต่ำกว่านี้ต้องปิด-เปิดใหม่
// 1 = ไม่มี ver (ก่อน capture/click), 2 = มี capture/click (OCR), 3 = OCR อ่านหน้าต่างเล็กได้ (ขยาย 3 เท่า + ปรับเกณฑ์ตัวขาว)
// 4 = มี GET /element (หาปุ่ม HTML จาก id — AFK ใช้แทน OCR), 5 = ชื่อหน้าต่างแสดงเวอร์ชัน launcher/client
// 6 = /state มี loads/bot/saver (AFK อัตโนมัติหลังโหลดใหม่ + สถานะบอท), 7 = แก้การตรวจว่าแสดงอยู่ (องค์ประกอบ fixed)
const CLIENT_VERSION = 7;
const OUTDATED = 'จอนี้ยังใช้โค้ดหน้าต่างเกมรุ่นเก่า — ปิดจอแล้วเปิดใหม่ 1 ครั้ง';
const FPS_CHOICES = [0, 20, 10, 5]; // เฟรมเรตเกมตอนซ่อน — 0 = ไม่จำกัด (ค่าเดิม)
const ACTIONS = ['pip', 'fullscreen', 'refresh', 'mute', 'focus', 'hide', 'show', 'toggleHide', 'quit'];
// โฟลเดอร์แคชของ Chromium — ไม่ต้องสำรอง (ใหญ่ ~130 MB/จอ และสร้างใหม่เองได้)
const CACHE_DIRS = new Set(['cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache', 'grshadercache', 'shadercache', 'gpupersistentcache', 'scriptcache']);

const DEFAULT_CONFIG = {
  exePath: 'runtime\\LumivaraClient.exe', instancesDir: '.', instanceCount: 10,
  titles: {}, autoStart: [], hiddenFps: 0,
  autoAfk: [], // จอที่ให้เข้าหน้าประหยัดพลังงานเองทุกครั้งที่เกมโหลดใหม่ (เปิด/รีเฟรช/กู้คืน)
  dataDirs: {}, // โฟลเดอร์ข้อมูลเฉพาะจอ เช่น { "6": "saved\\Instance6" } — ไม่ระบุ = <instancesDir>\InstanceN
  order: [], // ลำดับแถวในหน้าเว็บ/การจัดเรียง (เลขจอ) — ไม่ระบุ = 1, 2, 3, …
};

const cleanTitle = (t) => (typeof t === 'string' ? t.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60) : '');
const isScreen = (n) => Number.isInteger(n) && n >= 1 && n <= MAX_INSTANCES;

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim() : d);
    const titles = {};
    if (parsed.titles && typeof parsed.titles === 'object') {
      for (const [k, v] of Object.entries(parsed.titles)) if (isScreen(Number(k)) && cleanTitle(v)) titles[k] = cleanTitle(v);
    }
    const dataDirs = {};
    if (parsed.dataDirs && typeof parsed.dataDirs === 'object') {
      for (const [k, v] of Object.entries(parsed.dataDirs)) {
        if (isScreen(Number(k)) && typeof v === 'string' && v.trim() && !/[\x00-\x1f]/.test(v)) dataDirs[k] = v.trim();
      }
    }
    return {
      exePath: str(parsed.exePath, DEFAULT_CONFIG.exePath),
      instancesDir: str(parsed.instancesDir, DEFAULT_CONFIG.instancesDir),
      instanceCount: isScreen(parsed.instanceCount) ? parsed.instanceCount : DEFAULT_CONFIG.instanceCount,
      titles,
      autoStart: Array.isArray(parsed.autoStart) ? [...new Set(parsed.autoStart.filter(isScreen))].sort((a, b) => a - b) : [],
      autoAfk: Array.isArray(parsed.autoAfk) ? [...new Set(parsed.autoAfk.filter(isScreen))].sort((a, b) => a - b) : [],
      hiddenFps: FPS_CHOICES.includes(parsed.hiddenFps) ? parsed.hiddenFps : DEFAULT_CONFIG.hiddenFps,
      dataDirs,
      order: Array.isArray(parsed.order) ? parsed.order.filter(isScreen) : [],
    };
  } catch (_) {
    saveConfig(DEFAULT_CONFIG);
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

let CONFIG = loadConfig();
function updateConfig(patch) {
  CONFIG = { ...CONFIG, ...patch };
  saveConfig(CONFIG);
}

const titleOf = (n) => CONFIG.titles[n] || `Lumivara #${n}`;

function resolveExePath() {
  return path.isAbsolute(CONFIG.exePath) ? CONFIG.exePath : path.join(__dirname, CONFIG.exePath);
}

function resolveInstancesDir() {
  return path.isAbsolute(CONFIG.instancesDir) ? CONFIG.instancesDir : path.join(__dirname, CONFIG.instancesDir);
}

// โฟลเดอร์ข้อมูลของจอที่ n: ใช้ dataDirs[n] ถ้าตั้งไว้ (path เต็ม หรือเทียบกับโฟลเดอร์ launcher)
function instanceDir(n) {
  const d = CONFIG.dataDirs[n];
  if (d) return path.isAbsolute(d) ? d : path.join(__dirname, d);
  return path.join(resolveInstancesDir(), `Instance${n}`);
}

const relDir = (dir) => path.relative(__dirname, dir) || '.';

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

// คุยกับจอที่ n ผ่าน HTTP ภายในเครื่อง — คืนค่า JSON หรือ null ถ้าจอนั้นไม่ได้เปิดอยู่
function callInstance(n, method, urlPath) {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port: CONTROL_BASE_PORT + n, path: urlPath, method, headers: { 'X-Lumivara': '1' }, timeout: method === 'GET' ? 800 : 15000 },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function getStatusSnapshot() {
  const status = {};
  await Promise.all(Array.from({ length: CONFIG.instanceCount }, async (_, i) => {
    status[i + 1] = await callInstance(i + 1, 'GET', '/state');
  }));
  return status;
}

const openScreens = (status) => Object.keys(status).filter((n) => status[n]).map(Number).sort((a, b) => a - b);

const backingUp = new Set();

// --- OCR (Tesseract) สำหรับ automation ---
// หา tesseract.exe ที่ติดตั้งไว้ (ตัวติดตั้งปกติไม่ได้เพิ่มใน PATH) ไม่เจอค่อยลองเรียกจาก PATH
const TESSERACT = ['C:\\Program Files\\Tesseract-OCR\\tesseract.exe', 'C:\\Program Files (x86)\\Tesseract-OCR\\tesseract.exe']
  .find((p) => fs.existsSync(p)) || 'tesseract';
const OCR_DEBUG_DIR = path.join(__dirname, 'ocr-debug');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ภาพหน้าเกม (เฉพาะส่วนเกม) จากจอที่ n — คืน { png, scale } (scale = พิกเซลภาพ ต่อ 1 CSS px ของหน้าเกม)
function captureScreen(n, mode) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: CONTROL_BASE_PORT + n, path: '/capture' + (mode ? '?mode=' + mode : ''), headers: { 'X-Lumivara': '1' }, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        if (res.statusCode === 404) return reject(new Error(OUTDATED)); // หน้าต่างเกมรุ่นเก่ายังไม่มี /capture
        if (res.statusCode !== 200) return reject(new Error('จับภาพไม่ได้: ' + body.toString().slice(0, 200)));
        resolve({ png: body, scale: Number(res.headers['x-scale']) || 1 });
      });
    });
    req.on('timeout', () => req.destroy(new Error('จับภาพนานเกินไป')));
    req.on('error', () => reject(new Error('จอนี้ไม่ได้เปิดอยู่')));
    req.end();
  });
}

// OCR ภาพ PNG → รายการคำ { text, left, top, width, height, conf } (พิกัดเป็นพิกเซลภาพ)
function ocrWords(png) {
  return new Promise((resolve, reject) => {
    const p = spawn(TESSERACT, ['stdin', 'stdout', '-l', 'eng', '--psm', '11', 'tsv'], { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { err += c; });
    p.on('error', () => reject(new Error('ไม่พบ Tesseract — ติดตั้งที่ C:\\Program Files\\Tesseract-OCR')));
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error('Tesseract ผิดพลาด: ' + err.trim().slice(0, 200)));
      const words = [];
      for (const line of out.split(/\r?\n/).slice(1)) {
        const c = line.split('\t');
        if (c.length < 12 || !c[11].trim() || Number(c[10]) < 0) continue;
        words.push({ text: c[11].trim(), left: +c[6], top: +c[7], width: +c[8], height: +c[9], conf: +c[10] });
      }
      resolve(words);
    });
    p.stdin.end(png);
  });
}

// หาวลี (เช่น "Battery saver screen") จากคำที่ OCR ได้: คำแรกตรง แล้วคำถัดไปต้องอยู่ทางขวาในแถวเดียวกัน
// เทียบแบบไม่สนตัวพิมพ์/เครื่องหมาย และยอมให้ OCR สะกดผิดได้ 1 ตัวอักษรต่อคำ (คำยาว ≥ 5)
function findPhrase(words, phrase) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const near = (a, b) => {
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++edits > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  };
  const want = phrase.split(/\s+/).map(norm);
  for (const first of words) {
    if (!near(norm(first.text), want[0])) continue;
    const chain = [first];
    for (const w of want.slice(1)) {
      const prev = chain[chain.length - 1];
      const midY = prev.top + prev.height / 2;
      const next = words
        .filter((x) => x.left > prev.left && x.top < midY && x.top + x.height > midY && x.left - (prev.left + prev.width) < prev.height * 3 && near(norm(x.text), w))
        .sort((a, b) => a.left - b.left)[0];
      if (!next) break;
      chain.push(next);
    }
    if (chain.length === want.length) {
      const left = Math.min(...chain.map((x) => x.left)), top = Math.min(...chain.map((x) => x.top));
      const right = Math.max(...chain.map((x) => x.left + x.width)), bottom = Math.max(...chain.map((x) => x.top + x.height));
      return { text: chain.map((x) => x.text).join(' '), x: (left + right) / 2, y: (top + bottom) / 2, conf: Math.min(...chain.map((x) => x.conf)) };
    }
  }
  return null;
}

// OCR หน้าเกมของจอ n หาวลี — ลองแบบ "ตัวขาว" ก่อน (ปุ่มสีเข้ม) แล้วแบบภาพปกติ
// คืน { found: {text,x,y,conf} เป็น CSS px ของหน้าเกม | null, last: {png, words} สำหรับดีบัก }
// ลองแบบที่เจอครั้งล่าสุดก่อน — เกมเปลี่ยนปุ่มจากสีเข้ม (ต้องใช้ white) เป็นสีน้ำเงิน (ภาพปกติอ่านได้) แล้ว
let lastOcrMode = 'white';
// คืน { found: {text,x,y,conf} | null, tries: [{mode, png, words}] } — tries เก็บทุกแบบที่ลอง ไว้ทำไฟล์ดีบัก
async function ocrFind(n, phrase) {
  const tries = [];
  for (const mode of lastOcrMode === 'white' ? ['white', ''] : ['', 'white']) {
    const shot = await captureScreen(n, mode);
    const words = await ocrWords(shot.png);
    tries.push({ mode: mode || 'normal', png: shot.png, words });
    const hit = findPhrase(words, phrase);
    if (hit) {
      lastOcrMode = mode;
      return { found: { ...hit, x: hit.x / shot.scale, y: hit.y / shot.scale }, tries };
    }
  }
  return { found: null, tries };
}

// ไฟล์ดีบักเมื่อ OCR หาไม่เจอ: screenN-last.png = ภาพปกติ (ดูง่าย), screenN-last-white.png = ภาพกรองตัวขาว,
// screenN-last.txt = คำที่ OCR อ่านได้จากทั้งสองแบบ
function saveOcrDebug(n, tries, note) {
  fs.mkdirSync(OCR_DEBUG_DIR, { recursive: true });
  const base = path.join(OCR_DEBUG_DIR, `screen${n}-last`);
  let txt = note + '\n';
  for (const t of tries) {
    fs.writeFileSync(base + (t.mode === 'white' ? '-white' : '') + '.png', t.png);
    txt += `\n=== ${t.mode} (${t.words.length} words) ===\n` + t.words.map((w) => `${w.text}\t(${w.left},${w.top}) conf ${Math.round(w.conf)}`).join('\n') + '\n';
  }
  fs.writeFileSync(base + '.txt', txt, 'utf8');
  return path.relative(__dirname, base) + '.png';
}

const clickPoint = async (n, x, y) => {
  const r = await callInstance(n, 'POST', `/action/click?x=${x.toFixed(1)}&y=${y.toFixed(1)}`);
  if (!r || !r.ok) throw new Error('คลิกไม่สำเร็จ: ' + (r ? r.error : 'จอปิดไปแล้ว'));
};

// Automation "AFK": เข้าหน้าประหยัดพลังงานของเกม (ปุ่ม "Battery saver screen" ในหน้า Bot Settings ที่เปิดด้วย B)
// วิธีหลัก: ถามหน้าเกมหาปุ่ม HTML id="bot-battery-saver" → คลิกกึ่งกลาง (ไม่ต้องจับภาพ/OCR, ไม่ขึ้นกับขนาดหน้าต่างหรือสีปุ่ม)
//   ปุ่มซ่อนอยู่ (แผงปิด) → กด B แล้วรอให้ปุ่มขึ้น · ไม่กด B ถ้าแผงเปิดอยู่แล้ว เพราะ B จะปิดแผง
// สำรอง: ถ้าหน้าเกมไม่มีปุ่ม id นี้ (ผู้พัฒนาเปลี่ยน id) → ใช้ OCR หาข้อความแทน (วิธีเดิม)
const AFK_BUTTON_ID = 'bot-battery-saver';
const AFK_PHRASE = 'Battery saver screen';
async function runAfk(n) {
  const st = await callInstance(n, 'GET', '/state');
  if (!st) throw new Error('จอนี้ไม่ได้เปิดอยู่');
  if ((st.ver || 1) < CLIENT_VERSION) throw new Error(OUTDATED);
  const pressB = async () => {
    const r = await callInstance(n, 'POST', '/action/key?k=b');
    if (!r || !r.ok) throw new Error(r ? r.error : 'จอนี้ไม่ได้เปิดอยู่');
  };
  // ปุ่มต้องมีคำว่า battery ด้วย กันกรณี id เดิมถูกเอาไปใช้กับปุ่มอื่น
  const findButton = async () => {
    const el = await callInstance(n, 'GET', '/element?id=' + AFK_BUTTON_ID);
    return el && el.found && /battery/i.test(el.text) ? el : null;
  };

  // หน้าประหยัดพลังงานแสดงอยู่ไหม (section#battery-saver คลุมทั้งจอ)
  const inSaver = async () => {
    const el = await callInstance(n, 'GET', '/element?id=battery-saver');
    return !!(el && el.found && el.visible);
  };
  if (await inSaver()) return { method: 'button', already: true }; // อยู่หน้าประหยัดพลังงานแล้ว — กด B ตอนนี้ไม่มีผล

  let btn = await findButton();
  if (btn) {
    // คลิกแล้วต้องเห็นหน้าประหยัดพลังงานจริงภายใน 10 วิ ไม่งั้นลองใหม่อีก 1 รอบ
    // (ตอนเกมเพิ่งโหลด UI อาจยังไม่พร้อม คลิกแล้วไม่เข้า หรือเข้าแล้วถูกรีเซ็ตกลับ)
    for (let round = 1; round <= 2; round++) {
      let pressedB = false;
      btn = await findButton();
      if (!btn) break;
      if (!btn.visible) {
        await pressB();
        pressedB = true;
        for (let i = 0; i < 15 && !(btn && btn.visible); i++) { // รอแผงเปิด สูงสุด ~3 วินาที
          await sleep(200);
          btn = await findButton();
        }
        if (!btn || !btn.visible) {
          if (round === 2) throw new Error('กด B แล้วแต่ปุ่ม "Battery saver screen" ไม่ขึ้น (หน้าเกมอาจมีหน้าต่างอื่นบังอยู่)');
          continue;
        }
      }
      await clickPoint(n, btn.x, btn.y);
      for (let i = 0; i < 20; i++) {
        await sleep(500);
        if (await inSaver()) return { method: 'button', found: btn.text, x: Math.round(btn.x), y: Math.round(btn.y), pressedB, round };
      }
    }
    if (btn) throw new Error('คลิก "Battery saver screen" แล้ว แต่เกมไม่เข้าหน้าประหยัดพลังงาน (ลอง 2 รอบ)');
  }

  // --- สำรอง: OCR (หน้าเกมไม่มีปุ่ม id นี้แล้ว) ---
  let result = await ocrFind(n, AFK_PHRASE);
  let pressedB = false;
  for (let attempt = 1; attempt <= 3 && !result.found; attempt++) {
    if (attempt === 1) { await pressB(); pressedB = true; }
    await sleep(attempt === 1 ? 800 : 1000);
    result = await ocrFind(n, AFK_PHRASE);
  }
  if (result.found) {
    const { x, y, text, conf } = result.found;
    await clickPoint(n, x, y);
    return { method: 'ocr', found: text, conf, x: Math.round(x), y: Math.round(y), pressedB };
  }
  const file = saveOcrDebug(n, result.tries, `ไม่พบปุ่ม id="${AFK_BUTTON_ID}" ในหน้าเกม และ OCR หา "${AFK_PHRASE}" ไม่เจอ`);
  throw new Error(`ไม่พบ "${AFK_PHRASE}" บนหน้าเกม (ภาพล่าสุด: ${file})`);
}

// --- AFK อัตโนมัติ (จอใน CONFIG.autoAfk) ---
// ทุก 5 วิ ดู loads ของแต่ละจอ: เพิ่มขึ้น = เกมเพิ่งโหลดใหม่ (launcher เปิด/ปิด-เปิดใหม่, รีเฟรช, กู้คืนหลังแครช/ค้าง/เน็ตหลุด)
// → รอ AUTO_AFK_DELAY ให้ UI เกมพร้อม แล้วสั่ง AFK (ข้ามถ้าอยู่หน้าประหยัดพลังงานอยู่แล้ว)
// จอที่เปิดอยู่ก่อน launcher เริ่ม จะไม่ถูกแตะจนกว่าจะโหลดใหม่ครั้งถัดไป (ไม่รบกวนจอที่กำลังเล่นอยู่)
const AUTO_AFK_DELAY = 15000; // 8 วิ เร็วไป: ทดสอบแล้วคลิกได้แต่เกมยังไม่พร้อม ไม่เข้าหน้าประหยัดพลังงาน
const afkSeen = {};               // n → loads ล่าสุดที่เห็น
const afkDue = {};                // n → เวลาที่จะสั่ง AFK
const afkRunning = new Set();
const afkJustLaunched = new Set(); // จอที่ launcher เพิ่งเปิด — การโหลดครั้งแรกนับด้วย
const autoAfkLast = {};           // n → { at, ok, msg } ผลล่าสุด (แสดงในหน้าเว็บ)
let autoAfkTicking = false;
async function autoAfkTick() {
  if (autoAfkTicking) return;
  autoAfkTicking = true;
  try {
    for (const n of CONFIG.autoAfk) {
      if (n > CONFIG.instanceCount || afkRunning.has(n)) continue;
      const st = await callInstance(n, 'GET', '/state');
      if (!st || (st.ver || 1) < CLIENT_VERSION) { delete afkSeen[n]; delete afkDue[n]; continue; }
      const loads = st.loads || 0;
      if (afkSeen[n] === undefined && !afkJustLaunched.has(n)) { afkSeen[n] = loads; continue; }
      if (loads > (afkSeen[n] || 0)) {
        afkSeen[n] = loads;
        afkJustLaunched.delete(n);
        afkDue[n] = Date.now() + AUTO_AFK_DELAY;
      }
      if (afkDue[n] && Date.now() >= afkDue[n]) {
        delete afkDue[n];
        if (st.saver) continue;
        afkRunning.add(n);
        runAfk(n)
          .then(() => { autoAfkLast[n] = { at: Date.now(), ok: true, msg: 'เข้าหน้าประหยัดพลังงานแล้ว' }; })
          .catch((err) => { autoAfkLast[n] = { at: Date.now(), ok: false, msg: err.message }; console.error(`AFK อัตโนมัติ จอที่ ${n}:`, err.message); })
          .finally(() => afkRunning.delete(n));
      }
    }
  } finally {
    autoAfkTicking = false;
  }
}

// ปิดจอ n แล้วเปิดใหม่ (ใช้โค้ดหน้าต่างเกมล่าสุดหลังอัปเดต) — ข้อมูลล็อกอินไม่หาย · อยู่ใน PiP ก็กลับมาเป็น PiP
async function restartInstance(n) {
  const st = await callInstance(n, 'GET', '/state');
  if (!st) throw new Error('จอนี้ไม่ได้เปิดอยู่');
  await callInstance(n, 'POST', '/action/quit');
  for (let i = 0; i < 40; i++) { // รอปิดสนิท สูงสุด ~10 วินาที
    await sleep(250);
    if (!(await callInstance(n, 'GET', '/state'))) break;
    if (i === 39) throw new Error('จอยังไม่ปิด ลองใหม่อีกครั้ง');
  }
  await sleep(1000); // ให้โปรเซสเดิมออกจนปล่อยโฟลเดอร์ข้อมูล ก่อนเปิดตัวใหม่
  launchInstance(n, !!st.pip);
}

function launchInstance(n, pip) {
  if (backingUp.has(n)) throw new Error('กำลังสำรองข้อมูลจอนี้อยู่ รอสักครู่');
  const exePath = resolveExePath();
  if (!fs.existsSync(exePath)) throw new Error('ไม่พบไฟล์ที่ ' + exePath);
  const dataDir = instanceDir(n);
  fs.mkdirSync(dataDir, { recursive: true });
  const args = [
    `--user-data-dir=${dataDir}`,
    `--lv-instance=${n}`,
    `--lv-control-port=${CONTROL_BASE_PORT + n}`,
    `--lv-launcher-port=${PORT}`,
    `--lv-title=${titleOf(n)}`,
    `--lv-hidden-fps=${CONFIG.hiddenFps}`,
    // แสดงบนแถบชื่อหน้าต่างเกม เช่น "Main — Launcher v1.1.0 · build a7de5d4 · client v5"
    `--lv-launcher-version=v${LAUNCHER_VERSION.version}${LAUNCHER_VERSION.build ? ' · build ' + LAUNCHER_VERSION.build : ''}`,
  ];
  if (pip) args.push('--lv-pip');
  const child = spawn(exePath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
  child.on('error', (err) => console.error(`เปิดจอที่ ${n} ไม่สำเร็จ:`, err.message));
  child.unref();
  // AFK อัตโนมัติ: นับการโหลดครั้งแรกของจอที่เพิ่งเปิดด้วย และลืมจำนวนโหลดของหน้าต่างเดิม
  // (หน้าต่างใหม่เริ่มนับ loads จาก 1 เหมือนเดิม — ถ้าไม่ลบ ปิด-เปิดใหม่ระหว่างรอบตรวจ 5 วิ จะไม่ถูกนับว่าโหลดใหม่)
  afkJustLaunched.add(n);
  delete afkSeen[n];
  delete afkDue[n];
}

// ซ่อนทุกจอถ้ามีจอไหนยังแสดงอยู่ ไม่งั้นเรียกกลับทุกจอ (Ctrl+Shift+H หรือปุ่มในหน้าเว็บ)
async function toggleAll() {
  const status = await getStatusSnapshot();
  const open = openScreens(status);
  const hide = open.some((n) => !status[n].hidden);
  await Promise.all(open.map((n) => callInstance(n, 'POST', '/action/' + (hide ? 'hide' : 'show'))));
}

// ปิดเสียงทุกจอถ้ามีจอไหนยังมีเสียง ไม่งั้นเปิดเสียงทุกจอ
async function muteAll() {
  const status = await getStatusSnapshot();
  const open = openScreens(status);
  const mute = open.some((n) => !status[n].muted);
  await Promise.all(open.map((n) => callInstance(n, 'POST', '/action/muteSet?on=' + (mute ? 1 : 0))));
  return mute;
}

// จัดเรียงทุกจอที่เปิดและไม่ได้ซ่อน ให้เต็มจอภาพที่เลือกแบบตาราง เรียงตามลำดับแถวในหน้าเว็บ
async function tileAll(display) {
  const status = await getStatusSnapshot();
  const visible = screenOrder().filter((n) => status[n] && !status[n].hidden);
  const d = /^\d+$/.test(String(display || '')) ? `&d=${display}` : '';
  await Promise.all(visible.map((n, i) => callInstance(n, 'POST', `/action/tile?i=${i}&n=${visible.length}${d}`)));
  return visible.length;
}

async function quitAll() {
  await Promise.all(Array.from({ length: CONFIG.instanceCount }, (_, i) => callInstance(i + 1, 'POST', '/action/quit')));
}

// รายชื่อจอภาพ — ถามจากจอเกมที่เปิดอยู่จอใดก็ได้ (Node เองไม่รู้ขนาดจอ)
async function getDisplays() {
  for (const n of openScreens(await getStatusSnapshot())) {
    const list = await callInstance(n, 'GET', '/displays');
    if (Array.isArray(list)) return list;
  }
  return [];
}

// สำรองข้อมูลจอที่ n → backups/InstanceN-<วันเวลา> (คัดลอกเท่านั้น ไม่ลบอะไร ข้ามโฟลเดอร์แคช)
async function backupInstance(n) {
  if (await callInstance(n, 'GET', '/state')) throw new Error('ปิดจอนี้ก่อนสำรองข้อมูล (กันไฟล์เสียระหว่างเกมกำลังเขียน)');
  const src = instanceDir(n);
  if (!fs.existsSync(src)) throw new Error('จอนี้ยังไม่มีข้อมูลให้สำรอง');
  const p = (v) => String(v).padStart(2, '0');
  const d = new Date();
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  const dest = path.join(BACKUP_DIR, `${path.basename(src)}-${stamp}`);
  backingUp.add(n);
  try {
    await fs.promises.cp(src, dest, {
      recursive: true, force: false, errorOnExist: true,
      filter: (s) => !CACHE_DIRS.has(path.basename(s).toLowerCase()),
    });
  } finally {
    backingUp.delete(n);
  }
  return path.relative(__dirname, dest);
}

// เปิดจอที่ติ๊ก "อัตโนมัติ" ไว้ ตอน launcher เริ่มทำงาน (ข้ามจอที่เปิดอยู่แล้ว)
async function autoStartScreens() {
  const status = await getStatusSnapshot();
  const todo = CONFIG.autoStart.filter((n) => n <= CONFIG.instanceCount && !status[n]);
  todo.forEach((n, i) => setTimeout(() => {
    try { launchInstance(n, false); } catch (err) { console.error(`เปิดจอที่ ${n} อัตโนมัติไม่สำเร็จ:`, err.message); }
  }, i * 1000));
}

// การตั้งค่าสำหรับหน้าเว็บ (public/app.js ใช้สร้างแถวจอและช่องตั้งค่า)
// ลำดับจอที่ใช้จริง: ตาม CONFIG.order (ตัดเลขที่เกินจำนวนจอ/ซ้ำ) แล้วต่อท้ายด้วยจอที่ยังไม่อยู่ในลำดับ
// การย้ายลำดับไม่แตะข้อมูลใดๆ — จอที่ N ยังใช้โฟลเดอร์และพอร์ตเดิม
function screenOrder() {
  const order = [...new Set(CONFIG.order.filter((n) => n <= CONFIG.instanceCount))];
  for (let n = 1; n <= CONFIG.instanceCount; n++) if (!order.includes(n)) order.push(n);
  return order;
}

// เวอร์ชัน launcher สำหรับแสดงในหน้าเว็บ: เลขเวอร์ชันจาก package.json + build = git commit ปัจจุบัน
// (มี "+modified" ถ้ามีไฟล์ที่ยังไม่ commit) — อ่านครั้งเดียวตอนเริ่ม ไม่มี git ก็แสดงแค่เลขเวอร์ชัน
const LAUNCHER_VERSION = (() => {
  let version = '?', build = '';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')).version; } catch (_) {}
  try {
    const git = (args) => execSync('git ' + args, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).toString().trim();
    build = git('rev-parse --short HEAD') + (git('status --porcelain') ? '+modified' : '');
  } catch (_) {}
  return { version, build };
})();

function configView() {
  const dirs = {};
  for (let n = 1; n <= CONFIG.instanceCount; n++) dirs[n] = relDir(instanceDir(n));
  return { ...CONFIG, order: screenOrder(), dirs, maxInstances: MAX_INSTANCES, fpsChoices: FPS_CHOICES, clientVersion: CLIENT_VERSION, launcher: LAUNCHER_VERSION };
}

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// ไฟล์หน้าเว็บใน public/ — เฉพาะรายชื่อนี้ (กัน path traversal)
const PUBLIC_DIR = path.join(__dirname, 'public');
const STATIC_FILES = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  // กัน DNS rebinding: รับเฉพาะ Host ที่เป็นเครื่องนี้
  if (!/^(127\.0\.0\.1|localhost):\d+$/.test(req.headers.host || '')) {
    res.writeHead(403);
    res.end();
    return;
  }

  const file = req.method === 'GET' && STATIC_FILES[req.url];
  if (file) {
    fs.readFile(path.join(PUBLIC_DIR, file[0]), (err, data) => {
      if (err) { res.writeHead(500); res.end('ไม่พบไฟล์หน้าเว็บ ' + file[0]); return; }
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }

  // คำสั่งต้องมี header X-Lumivara (บังคับ CORS preflight) — เว็บอื่นที่เปิดในเบราว์เซอร์สั่งจอเกมไม่ได้
  if (req.headers['x-lumivara'] !== '1') {
    sendJson(res, 403, { ok: false, error: 'forbidden' });
    return;
  }

  try {
    if (req.method === 'GET' && req.url === '/status') {
      const status = await getStatusSnapshot();
      for (const n of Object.keys(status)) if (status[n] && autoAfkLast[n]) status[n].autoAfkLast = autoAfkLast[n]; // ผล AFK อัตโนมัติล่าสุด
      return sendJson(res, 200, status);
    }
    if (req.method === 'GET' && req.url === '/displays') return sendJson(res, 200, await getDisplays());
    if (req.method === 'GET' && req.url === '/config') return sendJson(res, 200, configView());
    if (req.method !== 'POST') return sendJson(res, 404, { ok: false, error: 'not found' });

    // คำสั่งที่ระบุจอ: /<คำสั่ง>/<n> หรือ /instance/<n>/<action>
    const screenMatch = req.url.match(/^\/(launch|title|autostart|autoafk|backup|key|afk|restart)\/(\d+)$/);
    const actionMatch = req.url.match(/^\/instance\/(\d+)\/(\w+)$/);
    const n = Number((screenMatch || actionMatch || [])[screenMatch ? 2 : 1]);
    if ((screenMatch || actionMatch) && !(n >= 1 && n <= CONFIG.instanceCount)) {
      return sendJson(res, 400, { ok: false, error: 'invalid instance number' });
    }

    if (screenMatch) {
      const body = await readJson(req);
      switch (screenMatch[1]) {
        case 'launch':
          launchInstance(n, body.pip === true);
          return sendJson(res, 200, { ok: true });
        case 'title': {
          const title = cleanTitle(body.title) || `Lumivara #${n}`;
          const titles = { ...CONFIG.titles };
          if (title === `Lumivara #${n}`) delete titles[n]; else titles[n] = title;
          updateConfig({ titles });
          await callInstance(n, 'POST', '/action/title?t=' + encodeURIComponent(title)); // เปลี่ยนชื่อหน้าต่างที่เปิดอยู่ด้วย
          return sendJson(res, 200, { ok: true, title });
        }
        case 'restart':
          await restartInstance(n);
          return sendJson(res, 200, { ok: true });
        case 'afk':
          return sendJson(res, 200, { ok: true, ...(await runAfk(n)) });
        case 'key': {
          // กดปุ่ม 1 ครั้งในจอเกม (ตัวอักษร/ตัวเลข/ปุ่มพื้นฐาน — จอเกมตรวจรายการซ้ำอีกชั้น)
          const key = typeof body.key === 'string' ? body.key : '';
          if (!/^([a-z0-9]|Space|Enter|Escape|Tab|Arrow(Up|Down|Left|Right))$/i.test(key)) {
            return sendJson(res, 400, { ok: false, error: 'ปุ่มนี้ใช้ไม่ได้' });
          }
          const result = await callInstance(n, 'POST', '/action/key?k=' + encodeURIComponent(key));
          return sendJson(res, 200, result || { ok: false, error: 'จอนี้ไม่ได้เปิดอยู่' });
        }
        case 'autoafk': {
          const set = new Set(CONFIG.autoAfk);
          if (body.on === true) set.add(n); else set.delete(n);
          updateConfig({ autoAfk: [...set].sort((a, b) => a - b) });
          return sendJson(res, 200, { ok: true });
        }
        case 'autostart': {
          const set = new Set(CONFIG.autoStart);
          if (body.on === true) set.add(n); else set.delete(n);
          updateConfig({ autoStart: [...set].sort((a, b) => a - b) });
          return sendJson(res, 200, { ok: true });
        }
        case 'backup':
          return sendJson(res, 200, { ok: true, path: await backupInstance(n) });
      }
    }

    if (actionMatch) {
      if (!ACTIONS.includes(actionMatch[2])) return sendJson(res, 400, { ok: false, error: 'invalid action' });
      const result = await callInstance(n, 'POST', '/action/' + actionMatch[2]);
      return sendJson(res, 200, result || { ok: false, error: 'จอนี้ไม่ได้เปิดอยู่' });
    }

    switch (req.url) {
      case '/toggle-all':
        await toggleAll();
        return sendJson(res, 200, { ok: true });
      case '/mute-all':
        return sendJson(res, 200, { ok: true, muted: await muteAll() });
      case '/tile-all':
        return sendJson(res, 200, { ok: true, count: await tileAll((await readJson(req)).display) });
      case '/quit-all':
        await quitAll();
        return sendJson(res, 200, { ok: true });
      case '/add-screen':
        if (CONFIG.instanceCount >= MAX_INSTANCES) return sendJson(res, 400, { ok: false, error: `เพิ่มได้สูงสุด ${MAX_INSTANCES} จอ` });
        updateConfig({ instanceCount: CONFIG.instanceCount + 1 });
        return sendJson(res, 200, { ok: true, count: CONFIG.instanceCount });
      case '/remove-screen': {
        // แค่ซ่อนแถวสุดท้าย — ไม่ลบโฟลเดอร์ InstanceN ชื่อจอ หรือการตั้งค่าใดๆ
        const last = CONFIG.instanceCount;
        if (last <= 1) return sendJson(res, 400, { ok: false, error: 'ต้องมีอย่างน้อย 1 จอ' });
        if (await callInstance(last, 'GET', '/state')) return sendJson(res, 400, { ok: false, error: `ปิดจอที่ ${last} ก่อนลดจำนวนจอ` });
        // เอาจอนี้ออกจากลำดับด้วย — กด + กลับมาจะต่อท้ายเหมือนจอใหม่
        updateConfig({ instanceCount: last - 1, order: CONFIG.order.filter((n) => n !== last) });
        return sendJson(res, 200, { ok: true, count: CONFIG.instanceCount });
      }
      case '/config': {
        const body = await readJson(req);
        const exePath = typeof body.exePath === 'string' ? body.exePath.trim() : '';
        const instancesDir = typeof body.instancesDir === 'string' ? body.instancesDir.trim() : '';
        if (!exePath || !instancesDir) return sendJson(res, 400, { ok: false, error: 'กรุณากรอกทั้งสองช่อง' });
        updateConfig({ exePath, instancesDir });
        return sendJson(res, 200, { ok: true });
      }
      case '/order': {
        // ต้องเป็นการสลับลำดับของจอ 1..instanceCount ครบทุกจอ ไม่ขาดไม่ซ้ำ
        const { order } = await readJson(req);
        const ok = Array.isArray(order) && order.length === CONFIG.instanceCount
          && new Set(order).size === order.length && order.every((n) => Number.isInteger(n) && n >= 1 && n <= CONFIG.instanceCount);
        if (!ok) return sendJson(res, 400, { ok: false, error: 'ลำดับจอไม่ถูกต้อง' });
        updateConfig({ order });
        return sendJson(res, 200, { ok: true });
      }
      case '/settings': {
        const { hiddenFps } = await readJson(req);
        if (!FPS_CHOICES.includes(hiddenFps)) return sendJson(res, 400, { ok: false, error: 'ค่าเฟรมเรตไม่ถูกต้อง' });
        updateConfig({ hiddenFps });
        await Promise.all(openScreens(await getStatusSnapshot()).map((s) => callInstance(s, 'POST', '/action/fps?v=' + hiddenFps)));
        return sendJson(res, 200, { ok: true });
      }
      case '/shutdown':
        sendJson(res, 200, { ok: true });
        setTimeout(() => process.exit(0), 200);
        return;
    }
    sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err.message });
  }
});

const openBrowser = () => exec(`start "" "http://localhost:${PORT}"`);

server.on('error', (err) => {
  // launcher เปิดอยู่แล้ว (เช่น ดับเบิลคลิก shortcut ซ้ำ) → แค่เปิดหน้าเว็บของตัวที่รันอยู่ แล้วออก
  if (err.code === 'EADDRINUSE') {
    console.log(`พอร์ต ${PORT} ถูกใช้อยู่ — เปิดหน้าเว็บของ launcher ที่รันอยู่แทน`);
    openBrowser();
    setTimeout(() => process.exit(0), 1000);
    return;
  }
  throw err;
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Lumivara Multi-Launcher: http://localhost:${PORT}`);
  openBrowser();
  autoStartScreens();
  setInterval(autoAfkTick, 5000);
});
