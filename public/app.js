// สคริปต์หน้า web console: โหลดการตั้งค่าจาก GET /config สร้างแถวจอ แล้วคุยกับ server.js
// ทุกคำขอส่ง header X-Lumivara (server ปฏิเสธคำขอที่ไม่มี — กันเว็บอื่นสั่งจอเกม)
'use strict';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const rowList = $('rowList');
const startPip = $('startPip');
const displaySelect = $('displaySelect');
const H = { 'X-Lumivara': '1', 'Content-Type': 'application/json' };
const get = (url) => fetch(url, { headers: H }).then((r) => r.json());
const post = (url, body) => fetch(url, { method: 'POST', headers: H, body: JSON.stringify(body || {}) }).then((r) => r.json());
const log = (text) => { logEl.textContent = text; };
const fail = (err) => log('เชื่อมต่อ server ไม่ได้: ' + err);
const rowOf = (el) => el.closest('.row');
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };

// ป้าย 📁 บอกว่าจอนี้ (ชื่อจอ) ใช้โฟลเดอร์ข้อมูลไหน เช่น AFK_01 → 📁 Instance1
function setFolder(row, dir) {
  const el = row.querySelector('.folder');
  el.textContent = '📁 ' + dir.split(/[\\/]/).pop();
  el.title = 'โฟลเดอร์ข้อมูลจอนี้: ' + dir;
}

// --- สร้างหน้าจากการตั้งค่า ---
function addRow(n, cfg) {
  const row = $('rowTpl').content.firstElementChild.cloneNode(true);
  row.dataset.n = n;
  row.querySelector('.num').textContent = n;
  setFolder(row, cfg.dirs[n]);
  const inp = row.querySelector('.title-input');
  inp.value = cfg.titles[n] || 'Lumivara #' + n;
  row.querySelector('.auto-cb').checked = cfg.autoStart.includes(n);
  rowList.appendChild(row);
  // ย้ายชื่อเดิมที่เคยเก็บในเบราว์เซอร์ (รุ่นก่อน) ไป config.json ครั้งเดียว
  const old = lsGet('lumivaraTitle_' + n);
  if (!cfg.titles[n] && old && old.trim()) { inp.value = old; saveTitle(inp); }
  return row;
}

// + / − เปลี่ยนเฉพาะแถวสุดท้ายในหน้า ไม่โหลดหน้าใหม่ (ไม่กระพริบ ไม่เด้งขึ้นบนสุด แถบตั้งค่าที่เปิดอยู่ไม่ปิด)
function changeCount(url) {
  const btns = [$('addScreen'), $('removeScreen')];
  btns.forEach((b) => { b.disabled = true; });
  post(url)
    .then((data) => {
      if (!data.ok) return log(data.error);
      if (url === '/add-screen') {
        return get('/config').then((cfg) => {
          const row = addRow(cfg.instanceCount, cfg);
          row.classList.add('row-enter');
          renderAutoList();
          row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          log('เพิ่มจอที่ ' + cfg.instanceCount + ' แล้ว');
          refreshStatus();
        });
      }
      // จอที่ถูกซ่อนคือเลขสูงสุด ซึ่งอาจไม่ใช่แถวล่างสุดถ้าย้ายลำดับไว้
      const last = rowList.querySelector('.row[data-n="' + (data.count + 1) + '"]');
      if (!last) return;
      log('ลดเหลือ ' + data.count + ' จอ (ข้อมูลจอที่ ' + last.dataset.n + ' ยังอยู่ครบ)');
      // ปิด "Animation effects" ใน Windows (= prefers-reduced-motion) → ลบทันที ไม่รอ
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) { last.remove(); return renderAutoList(); }
      // หุบจากความสูงจริงของแถว + จางออก — ตั้งเวลาสำรองไว้เผื่อแท็บอยู่เบื้องหลัง (แอนิเมชันหยุดเดิน)
      const done = () => { if (last.isConnected) { last.remove(); renderAutoList(); } };
      last.style.overflow = 'hidden';
      last.style.pointerEvents = 'none';
      last.animate(
        [{ opacity: 1, height: last.offsetHeight + 'px' },
          { opacity: 0, height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '-8px' }],
        { duration: 180, easing: 'ease-out' }
      ).finished.then(done, done);
      setTimeout(done, 300);
    })
    .catch(fail)
    .finally(() => btns.forEach((b) => { b.disabled = false; }));
}

function fillSettings(cfg) {
  $('cfgExePath').value = cfg.exePath;
  $('cfgInstancesDir').value = cfg.instancesDir;
  for (const v of cfg.fpsChoices) {
    const o = new Option(v ? v + ' FPS' : 'ไม่จำกัด (ค่าเดิม)', v, false, v === cfg.hiddenFps);
    $('cfgFps').appendChild(o);
  }
  $('addScreen').title = 'เพิ่มจอใหม่ต่อท้าย (สูงสุด ' + cfg.maxInstances + ' จอ)';
}

// --- สถานะ ---
const openNow = new Set(); // เลขจอ (string) ที่เปิดอยู่ จาก /status ล่าสุด

// st = สถานะจาก /status (null = จอปิดอยู่)
function setRowState(n, st) {
  n = String(n);
  if (st) openNow.add(n); else openNow.delete(n);
  const dot = $('autoScreens').querySelector('label[data-n="' + n + '"] .dot');
  if (dot) dot.classList.toggle('open', !!st);
  const row = rowList.querySelector('.row[data-n="' + n + '"]');
  if (!row) return;
  const btn = row.querySelector('.toggle-btn');
  btn.textContent = st ? 'ปิด' : 'เปิด';
  btn.dataset.state = st ? 'open' : 'closed';
  btn.classList.toggle('btn-close', !!st);
  const on = st ? { pip: st.pip, fullscreen: st.fullscreen, toggleHide: st.hidden, mute: st.muted || st.hidden } : {};
  row.querySelectorAll('.ctrls button').forEach((b) => {
    b.disabled = !st || (st.hidden && (b.dataset.act === 'pip' || b.dataset.act === 'fullscreen'));
    b.classList.toggle('on', !!on[b.dataset.act]);
  });
  row.querySelector('[data-act="toggleHide"]').textContent = st && st.hidden ? 'แสดง' : 'ซ่อน';
  row.querySelector('[data-act="mute"]').textContent = st && st.muted ? 'เปิดเสียง' : 'ปิดเสียง';
  row.querySelector('.backup-btn').disabled = !!st;
  const stats = row.querySelector('.stats');
  if (!st) { stats.textContent = ''; stats.title = ''; return; }
  stats.innerHTML = st.mem + ' MB · CPU ' + st.cpu + '%'
    + (st.recovering ? ' · <span class="warn">กำลังกู้คืน…</span>' : st.recoveries ? ' · <span class="warn">กู้คืน ' + st.recoveries + '</span>' : '');
  stats.title = stats.textContent; // ข้อความยาวเกินช่องจะถูกตัดด้วย … — ชี้เมาส์ดูเต็ม
}

function refreshStatus() {
  get('/status')
    .then((data) => {
      let open = 0, mem = 0, cpu = 0;
      Object.keys(data).forEach((n) => {
        setRowState(n, data[n]);
        if (data[n]) { open++; mem += data[n].mem; cpu += data[n].cpu; }
      });
      $('totals').textContent = open
        ? 'เปิดอยู่ ' + open + ' จอ · RAM รวม ' + (mem / 1024).toFixed(1) + ' GB · CPU รวม ' + cpu.toFixed(1) + '%'
        : '';
      if (open && !displaySelect.options.length) loadDisplays();
    })
    .catch(() => {});
}

// รายชื่อจอภาพ (ต้องมีจอเกมเปิดอยู่อย่างน้อย 1 จอ) — แสดงตัวเลือกเมื่อมีมากกว่า 1 จอ
function loadDisplays() {
  get('/displays').then((list) => {
    if (!Array.isArray(list) || !list.length) return;
    displaySelect.innerHTML = '';
    const saved = lsGet('lumivaraDisplay');
    for (const d of list) {
      const selected = saved ? String(d.id) === saved : d.primary;
      displaySelect.appendChild(new Option(d.label + (d.primary ? ' — จอหลัก' : ''), d.id, false, selected));
    }
    displaySelect.hidden = list.length < 2;
  }).catch(() => {});
}

// --- คำสั่งของแต่ละจอ ---
// ชื่อจอเก็บใน config.json — แก้แล้วบันทึกทันที (ถ้าจอเปิดอยู่ title หน้าต่างเปลี่ยนตาม)
function saveTitle(inp) {
  const n = rowOf(inp).dataset.n;
  return post('/title/' + n, { title: inp.value })
    .then((data) => {
      if (!data.ok) return log('จอที่ ' + n + ': ' + data.error);
      inp.value = data.title;
      renderAutoList();
      log('จอที่ ' + n + ': ตั้งชื่อ "' + data.title + '" แล้ว');
    })
    .catch(fail);
}

function openInstance(n) {
  return post('/launch/' + n, { pip: startPip.checked })
    .then((data) => {
      log(data.ok ? 'กำลังเปิดจอที่ ' + n : 'จอที่ ' + n + ' ผิดพลาด: ' + data.error);      setTimeout(refreshStatus, 1500);
    })
    .catch(fail);
}

function instanceAction(n, act) {
  return post('/instance/' + n + '/' + act)
    .then((data) => {
      if (!data.ok) return log('จอที่ ' + n + ' ทำคำสั่งไม่สำเร็จ: ' + data.error);
      setRowState(n, act === 'quit' ? null : data.state);
      if (act === 'quit') log('ปิดจอที่ ' + n + ' แล้ว');
    })
    .catch(fail);
}

function backup(n, btn) {
  btn.disabled = true;
  log('กำลังสำรองข้อมูลจอที่ ' + n + '…');
  post('/backup/' + n).then((data) => {
    log(data.ok ? 'สำรองข้อมูลจอที่ ' + n + ' ไว้ที่ ' + data.path : 'สำรองจอที่ ' + n + ' ไม่สำเร็จ: ' + data.error);
  }).catch(fail).finally(refreshStatus);
}

// ปุ่มในแถว (ใช้ event delegation — แถวสร้างทีหลัง)
rowList.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const n = rowOf(btn).dataset.n;
  if (btn.classList.contains('toggle-btn')) {
    if (btn.dataset.state === 'open') instanceAction(n, 'quit');
    else openInstance(n);
  } else if (btn.classList.contains('backup-btn')) {
    backup(n, btn);
  } else if (btn.dataset.act) {
    instanceAction(n, btn.dataset.act);
  }
});

rowList.addEventListener('change', (e) => {
  const el = e.target;
  if (el.classList.contains('title-input')) saveTitle(el);
  if (el.classList.contains('auto-cb')) {
    const n = rowOf(el).dataset.n;
    post('/autostart/' + n, { on: el.checked }).then((data) => {
      log(data.ok
        ? (el.checked ? 'จอที่ ' + n + ' จะเปิดเองเมื่อเปิด launcher' : 'ยกเลิกเปิดอัตโนมัติจอที่ ' + n)
        : data.error);
    }).catch(fail);
  }
});

// --- ย้ายลำดับแถว (ลากที่ ⋮⋮ หรือคลิก ⋮⋮ แล้วกด ↑ / ↓) ---
// เปลี่ยนแค่ลำดับที่แสดง/จัดเรียง/เปิดทั้งหมด — จอที่ N ยังใช้ข้อมูลและพอร์ตเดิม ย้ายได้แม้จอเปิดอยู่
function saveOrder() {
  const order = Array.from(rowList.children, (r) => Number(r.dataset.n));
  renderAutoList();
  post('/order', { order })
    .then((data) => log(data.ok ? 'บันทึกลำดับจอแล้ว: ' + order.join(', ') : data.error))
    .catch(fail);
}

let dragged = null;
// ให้ลากได้เฉพาะตอนจับที่ ⋮⋮ (ไม่งั้นลากเลือกข้อความในช่องชื่อไม่ได้)
rowList.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.handle');
  if (handle) rowOf(handle).draggable = true;
});
rowList.addEventListener('pointerup', (e) => {
  const row = e.target.closest('.row');
  if (row && !dragged) row.draggable = false; // คลิก ⋮⋮ เฉยๆ ไม่ได้ลาก
});
rowList.addEventListener('dragstart', (e) => {
  dragged = e.target.closest('.row');
  if (!dragged) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragged.dataset.n);
  dragged.classList.add('dragging');
});
rowList.addEventListener('dragover', (e) => {
  if (!dragged) return;
  e.preventDefault();
  const over = e.target.closest('.row');
  if (!over || over === dragged) return;
  const box = over.getBoundingClientRect();
  rowList.insertBefore(dragged, e.clientY < box.top + box.height / 2 ? over : over.nextElementSibling);
});
rowList.addEventListener('drop', (e) => e.preventDefault());
rowList.addEventListener('dragend', () => {
  if (!dragged) return;
  dragged.classList.remove('dragging');
  dragged.draggable = false;
  dragged = null;
  saveOrder();
});
rowList.addEventListener('keydown', (e) => {
  const handle = e.target.closest('.handle');
  if (!handle || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const row = rowOf(handle);
  const sibling = e.key === 'ArrowUp' ? row.previousElementSibling : row.nextElementSibling;
  if (!sibling) return;
  rowList.insertBefore(row, e.key === 'ArrowUp' ? sibling : sibling.nextElementSibling);
  handle.focus();
  saveOrder();
});

// --- แถบข้าง Automation ---
// เลือกจอ (จำไว้ในเบราว์เซอร์) แล้วสั่งคำสั่งกับทุกจอที่เลือกและเปิดอยู่
const autoSel = new Set((() => { try { return JSON.parse(lsGet('lumivaraAutoSel') || '[]').map(String); } catch (_) { return []; } })());
const saveAutoSel = () => lsSet('lumivaraAutoSel', JSON.stringify([...autoSel]));
const nameOf = (n) => { const i = rowList.querySelector('.row[data-n="' + n + '"] .title-input'); return i ? i.value : 'จอ ' + n; };

// รายชื่อจอในแถบข้าง ตามลำดับแถวและชื่อปัจจุบัน — เรียกใหม่เมื่อเปลี่ยนชื่อ/ย้ายลำดับ/เพิ่ม-ลดจอ
function renderAutoList() {
  const box = $('autoScreens');
  box.textContent = '';
  for (const row of rowList.children) {
    const n = row.dataset.n;
    const label = document.createElement('label');
    label.dataset.n = n;
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = autoSel.has(n);
    const dot = document.createElement('span');
    dot.className = 'dot' + (openNow.has(n) ? ' open' : '');
    dot.title = openNow.has(n) ? 'เปิดอยู่' : 'ปิดอยู่';
    const num = document.createElement('span');
    num.className = 'n';
    num.textContent = n;
    const name = document.createElement('span');
    name.textContent = nameOf(n);
    label.append(cb, dot, num, name);
    box.appendChild(label);
  }
}

function setAutoSel(list) {
  autoSel.clear();
  list.forEach((n) => autoSel.add(String(n)));
  saveAutoSel();
  renderAutoList();
}

$('autoScreens').addEventListener('change', (e) => {
  const n = e.target.closest('label').dataset.n;
  if (e.target.checked) autoSel.add(n); else autoSel.delete(n);
  saveAutoSel();
});
$('autoAll').addEventListener('click', () => setAutoSel(Array.from(rowList.children, (r) => r.dataset.n)));
$('autoOpen').addEventListener('click', () => setAutoSel([...openNow]));
$('autoNone').addEventListener('click', () => setAutoSel([]));

// กดปุ่ม key ในทุกจอที่เลือก (พร้อมกัน) แล้วสรุปผล
async function runKey(key, btn) {
  const autoLog = $('autoLog');
  const targets = Array.from(rowList.children, (r) => r.dataset.n).filter((n) => autoSel.has(n));
  if (!targets.length) { autoLog.textContent = 'ยังไม่ได้เลือกจอ'; return; }
  btn.disabled = true;
  const results = await Promise.all(targets.map((n) => (openNow.has(n)
    ? post('/key/' + n, { key }).then((d) => [n, d.ok ? 'ok' : d.error], (err) => [n, String(err)])
    : Promise.resolve([n, 'closed']))));
  btn.disabled = false;
  const names = (want) => results.filter(([, r]) => (want === 'fail' ? r !== 'ok' && r !== 'closed' : r === want));
  const time = new Date().toLocaleTimeString('th-TH');
  const lines = [];
  const ok = names('ok'), closed = names('closed'), failed = names('fail');
  if (ok.length) lines.push('✓ กด ' + key + ' แล้ว: ' + ok.map(([n]) => nameOf(n)).join(', '));
  if (closed.length) lines.push('– ข้าม (ปิดอยู่): ' + closed.map(([n]) => nameOf(n)).join(', '));
  if (failed.length) lines.push('✗ ไม่สำเร็จ: ' + failed.map(([n, r]) => nameOf(n) + ' (' + r + ')').join(', '));
  autoLog.textContent = '[' + time + ']\n' + lines.join('\n');
}
document.querySelectorAll('.auto-key').forEach((b) => b.addEventListener('click', () => runKey(b.dataset.key, b)));

// เปิด/ปิดแถบข้าง (จำไว้ในเบราว์เซอร์)
function setSidebar(open) {
  $('automation').hidden = !open;
  document.body.classList.toggle('side-open', open);
  lsSet('lumivaraSideOpen', open ? '1' : '');
}
$('autoToggle').addEventListener('click', () => setSidebar(true));
$('autoClose').addEventListener('click', () => setSidebar(false));
setSidebar(lsGet('lumivaraSideOpen') === '1');

// --- ปุ่มด้านล่างและการตั้งค่า ---
startPip.checked = lsGet('lumivaraStartPip') === '1';
startPip.addEventListener('change', () => lsSet('lumivaraStartPip', startPip.checked ? '1' : ''));
displaySelect.addEventListener('change', () => lsSet('lumivaraDisplay', displaySelect.value));

$('addScreen').addEventListener('click', () => changeCount('/add-screen'));
$('removeScreen').addEventListener('click', () => changeCount('/remove-screen'));

$('openAll').addEventListener('click', () => {
  const closed = Array.from(rowList.querySelectorAll('.toggle-btn')).filter((b) => b.dataset.state !== 'open');
  closed.forEach((btn, idx) => setTimeout(() => openInstance(rowOf(btn).dataset.n), idx * 500));
});

$('toggleAll').addEventListener('click', () => post('/toggle-all').then(refreshStatus).catch(fail));

$('muteAll').addEventListener('click', () => post('/mute-all').then((data) => {
  log(data.muted ? 'ปิดเสียงทุกจอแล้ว' : 'เปิดเสียงทุกจอแล้ว');
  refreshStatus();
}).catch(fail));

$('tileAll').addEventListener('click', () => post('/tile-all', { display: displaySelect.value || null }).then((data) => {
  log(data.count ? 'จัดเรียง ' + data.count + ' จอแล้ว' : 'ไม่มีจอที่เปิดและแสดงอยู่');
  refreshStatus();
}).catch(fail));

$('quitAll').addEventListener('click', () => {
  if (!confirm('ปิดเกมทุกจอ?')) return;
  post('/quit-all').then(() => { log('ปิดทุกจอแล้ว'); refreshStatus(); }).catch(fail);
});

$('shutdown').addEventListener('click', () => {
  post('/shutdown')
    .then(() => log('ปิด launcher แล้ว ปิดแท็บนี้ได้เลย (จอเกมที่เปิดไปแล้วไม่ถูกปิดตาม)'))
    .catch(() => log('ปิด launcher แล้ว (หรือ server ปิดไปก่อนตอบกลับ)'));
});

$('saveConfig').addEventListener('click', () => {
  post('/config', { exePath: $('cfgExePath').value.trim(), instancesDir: $('cfgInstancesDir').value.trim() })
    .then((data) => { $('cfgLog').textContent = data.ok ? 'บันทึกแล้ว (มีผลกับการเปิดจอครั้งถัดไป)' : 'บันทึกไม่สำเร็จ: ' + data.error; })
    .catch(fail);
});

$('cfgFps').addEventListener('change', (e) => {
  post('/settings', { hiddenFps: Number(e.target.value) }).then((data) => {
    $('cfgLog').textContent = data.ok ? 'ตั้งเฟรมเรตตอนซ่อนเป็น ' + e.target.selectedOptions[0].textContent + ' แล้ว' : data.error;
  }).catch(fail);
});

// --- เริ่มทำงาน ---
get('/config')
  .then((cfg) => {
    fillSettings(cfg);
    for (const n of cfg.order) addRow(n, cfg);
    renderAutoList();
    document.body.classList.remove('loading'); // แสดงหน้าเมื่อแถวครบแล้ว — ไม่เห็นหน้าว่างแล้วแถวเด้งเข้ามา
    refreshStatus();
    setInterval(refreshStatus, 2000);
  })
  .catch((err) => { document.body.classList.remove('loading'); fail(err); });
