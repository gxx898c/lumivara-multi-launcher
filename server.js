// Lumivara Multi-Launcher
// เปิดหลายจอของเกม (client/main.cjs บน Electron runtime) แยก --user-data-dir ให้แต่ละจอ
// และเป็น web console คุมทุกจอ: เปิด/ปิด, PiP, เต็มหน้าจอ, ซ่อน/แสดง, ปิดเสียง, รีเฟรช, จัดเรียง,
// เปลี่ยนชื่อ, เปิดอัตโนมัติ, สำรองข้อมูล (คัดลอกเท่านั้น ไม่ลบ), ดู RAM/CPU
// ไฟล์นี้มีแค่ logic + API — หน้าเว็บอยู่ใน public/ (index.html, style.css, app.js)

const http = require('http');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = 4321;
const CONTROL_BASE_PORT = 4400; // จอที่ N ฟังคำสั่งที่พอร์ต 4400+N
const CONFIG_PATH = path.join(__dirname, 'config.json');
const BACKUP_DIR = path.join(__dirname, 'backups');
const MAX_INSTANCES = 50; // พอร์ตควบคุมใช้ 4401-4450
const FPS_CHOICES = [0, 20, 10, 5]; // เฟรมเรตเกมตอนซ่อน — 0 = ไม่จำกัด (ค่าเดิม)
const ACTIONS = ['pip', 'fullscreen', 'refresh', 'mute', 'focus', 'hide', 'show', 'toggleHide', 'quit'];
// โฟลเดอร์แคชของ Chromium — ไม่ต้องสำรอง (ใหญ่ ~130 MB/จอ และสร้างใหม่เองได้)
const CACHE_DIRS = new Set(['cache', 'code cache', 'gpucache', 'dawngraphitecache', 'dawnwebgpucache', 'grshadercache', 'shadercache', 'gpupersistentcache', 'scriptcache']);

const DEFAULT_CONFIG = {
  exePath: 'runtime\\LumivaraClient.exe', instancesDir: '.', instanceCount: 10,
  titles: {}, autoStart: [], hiddenFps: 0,
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
  ];
  if (pip) args.push('--lv-pip');
  const child = spawn(exePath, args, { detached: true, stdio: 'ignore', cwd: path.dirname(exePath) });
  child.on('error', (err) => console.error(`เปิดจอที่ ${n} ไม่สำเร็จ:`, err.message));
  child.unref();
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

function configView() {
  const dirs = {};
  for (let n = 1; n <= CONFIG.instanceCount; n++) dirs[n] = relDir(instanceDir(n));
  return { ...CONFIG, order: screenOrder(), dirs, maxInstances: MAX_INSTANCES, fpsChoices: FPS_CHOICES };
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
    if (req.method === 'GET' && req.url === '/status') return sendJson(res, 200, await getStatusSnapshot());
    if (req.method === 'GET' && req.url === '/displays') return sendJson(res, 200, await getDisplays());
    if (req.method === 'GET' && req.url === '/config') return sendJson(res, 200, configView());
    if (req.method !== 'POST') return sendJson(res, 404, { ok: false, error: 'not found' });

    // คำสั่งที่ระบุจอ: /<คำสั่ง>/<n> หรือ /instance/<n>/<action>
    const screenMatch = req.url.match(/^\/(launch|title|autostart|backup|key)\/(\d+)$/);
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
        case 'key': {
          // กดปุ่ม 1 ครั้งในจอเกม (ตัวอักษร/ตัวเลข/ปุ่มพื้นฐาน — จอเกมตรวจรายการซ้ำอีกชั้น)
          const key = typeof body.key === 'string' ? body.key : '';
          if (!/^([a-z0-9]|Space|Enter|Escape|Tab|Arrow(Up|Down|Left|Right))$/i.test(key)) {
            return sendJson(res, 400, { ok: false, error: 'ปุ่มนี้ใช้ไม่ได้' });
          }
          const result = await callInstance(n, 'POST', '/action/key?k=' + encodeURIComponent(key));
          return sendJson(res, 200, result || { ok: false, error: 'จอนี้ไม่ได้เปิดอยู่' });
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
});
