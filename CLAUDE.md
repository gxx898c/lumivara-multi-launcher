# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

It is also a **complete rebuild spec**: given only this file, a Windows machine with Node.js, and the official Lumivara Online Windows client download, Claude Code can recreate the whole project (see "Building from scratch").

## Working rules (agreed with the user — follow these first)

1. **Running the game: only use screens 10 and 11.** Screen 10 is `testing_01` (`saved\Instance10`, control port 4410) and screen 11 is `testing_02` (`saved\Instance11`, control port 4411). They are the only screens to open, close, reopen, send keys to, or otherwise drive while testing. Never open, close or send anything to the other screens (1–9, 12 "Main", …); they hold the user's real guest characters and may be in the middle of play. Don't use scratch `--user-data-dir` profiles to run the game either; use these two screens.
2. **Don't push to GitHub by default.** Never `git push`, create or edit releases, or change anything on GitHub unless the user explicitly asks for it in that request. Committing locally is fine only when the user asks for a commit.

## What this is

A Windows-only local web console for running and controlling several Lumivara Online game windows (https://lumivaraonline.com/, a Phaser browser game) at once. Each game window is its own Electron process with its own `--user-data-dir`, so each one keeps its own login, including Guest accounts. README and UI strings are in Thai; keep user-facing text in Thai.

The window features (PiP, fullscreen, hide+mute, refresh, background-run shim, shortcuts) are ported from the official Lumivara Online 4.4.5 Electron client (its code is in `resources\app.asar` of the download). The official client's in-window toolbars, profile chooser, tray, i18n and auto-updater were left out because the web console replaces them.

**Hard rule:** never add anything that clears session data or deletes `Instance*/`. The user plays as a Guest, so losing a profile's data loses the character for good. This is why the official client's "clear login data" feature was removed on purpose.

## Layout

```
server.js            launcher logic + JSON API + static file server (Node core modules only, no npm deps)
public/index.html    console page markup, including <template id="rowTpl"> for one screen row
public/style.css     console styles (dark theme)
public/app.js        console behaviour: loads GET /config, builds rows, polls /status, sends commands
config.json          { exePath, instancesDir, instanceCount, titles, autoStart, autoAfk, hiddenFps, dataDirs, order }
package.json         { "name": "lumivara-multi-launcher", "main": "server.js", "scripts": { "start": "node server.js" } }
start.bat            @echo off / title Lumivara Multi-Launcher / cd /d "%~dp0" / node server.js / pause
Lumivara Launcher.lnk  shortcut: target C:\Windows\System32\conhost.exe, args "--headless node server.js",
                       Start in = project folder, icon client\game.ico (runs node with no window; replaces the old
                       VBScript launcher because Windows is phasing VBScript out)
client/main.cjs      Electron main process: one game window per process
client/pip-bar.html  drag bar for the frameless PiP window
client/visibility-spoof.js  page shim injected before the game loads
client/game.ico      window icon
runtime/             Electron runtime copied from the official client (not source)
saved/InstanceN/     Chromium profile per screen (user data, never delete) + lv-window.json (saved window bounds).
                     Folder names stay InstanceN and never follow the screen title (the user tried automatic
                     title-named folders and asked for that to be reverted). The user's instancesDir is "saved"
                     (code default ".").
backups/             <folder>-YYYYMMDD-HHMMSS copies made by the backup button (= InstanceN-…; cache folders skipped)
ocr-debug/           screenN-last.png/.txt written when an OCR automation can't find its text (gitignored)
```

## Running

```bash
node server.js
```

The console is at `http://127.0.0.1:4321` and the browser opens automatically. There is no build, lint or test setup.

**Testing game windows (see Working rule 1): use only screens 10 (`testing_01`) and 11 (`testing_02`).** Through the user's running launcher, use only the per-screen routes for those numbers (`/launch/10`, `/instance/11/...`, `/key/10`, …), never the all-screen routes (`/tile-all`, `/quit-all`, `/toggle-all`, `/mute-all`), because those touch every screen. When a test needs CDP (Chrome DevTools Protocol: `Runtime.evaluate`, `Page.crash`, `Network.emulateNetworkConditions`) to check the background shim or crash/hang/offline recovery, close screen 10 or 11 and start it directly with the same profile and port plus a debugging port, for example:

```bash
runtime/LumivaraClient.exe --user-data-dir=E:\Lumivara\saved\Instance10 --lv-instance=10 --lv-control-port=4410 --lv-title=testing_01 --remote-debugging-port=9379
curl -H "X-Lumivara: 1" http://127.0.0.1:4410/state
```

Close it again afterwards, then reopen it from the console if it was open before. Console or server changes (no game window needed) can still be tried on a copy of `server.js` run from a scratch folder, with `PORT` and `CONTROL_BASE_PORT` changed (for example 4398 and 4460), `openBrowser` turned into a no-op, and a scratch `config.json`. Don't launch game windows from that copy.

## Architecture

### server.js (console + launcher)
- `CONFIG` is loaded from `config.json` and every field is validated, with a default when invalid: `{ exePath: 'runtime\\LumivaraClient.exe', instancesDir: '.', instanceCount: 10, titles: {}, autoStart: [], hiddenFps: 0 }`.
  - `titles` maps a screen number to its name (control characters stripped, at most 60 chars). A name equal to the default `Lumivara #N` is not stored.
  - `autoStart` is a sorted list of screen numbers.
  - `hiddenFps` is one of `[0, 20, 10, 5]`, where 0 means no limit.
  - `dataDirs` is an optional override that maps a screen number to its own data folder (absolute, or relative to `__dirname`), for example `{"6": "D:\\Lumivara\\SAP"}`. It is empty for this user. `instanceDir(n)` resolves it, falling back to `<instancesDir>\InstanceN`, and launch and backup both use it. There is no UI for it. If you edit `config.json` by hand, stop the launcher first: it keeps the config in memory and would overwrite the file.
  - Renaming a screen never renames its folder. The page only *shows* the mapping (title → 📁 `InstanceN`).
  - `order` is the row order: a list of screen numbers. `screenOrder()` normalises it by dropping numbers above `instanceCount` and duplicates, then appending any missing screens in ascending order. It is display order only; screen N keeps its folder, port and title. `/tile-all` and the page's open-all follow it. `/remove-screen` also removes the hidden screen from `order`, so it reappears at the end after `/add-screen`.
  - Relative paths resolve against `__dirname`. Every change goes through `updateConfig(patch)`, which merges and saves.
  - Constants: `PORT = 4321`, `CONTROL_BASE_PORT = 4400` (screen N uses 4400+N), `MAX_INSTANCES = 50`.
- **Client code version:** `CLIENT_VERSION` in `server.js` must equal `CLIENT_VERSION` in `client/main.cjs`. **Bump both whenever you add or change a game-window command.** Running windows keep their old code until they are closed and reopened. `/state` includes `ver` (missing = 1, older than capture/click). The page shows a clickable "⟳ ปิด-เปิดใหม่" (close and reopen) `.update-btn` in the stats of any open screen whose `ver` is below `cfg.clientVersion`. Clicking it asks for confirmation, then posts `/restart/:n` (`restartInstance`): quit, poll `/state` until the screen is closed (up to about 10 s), wait 1 s for the process to release its profile, then launch again, in PiP if it was in PiP. While that runs, the row shows "⟳ กำลังปิด-เปิดใหม่…" (the page's `restarting` Set). `runAfk` rejects such screens with the `OUTDATED` message, and `captureScreen` maps a 404 to the same message.
- **Version display:** `LAUNCHER_VERSION` = `{version, build}`, read once at startup.
  - `version` comes from `package.json` (1.0.0 = the GitHub release v1.0.0; 1.1.0 = OCR/AFK, button method, restart and versioning).
  - `build` = `git rev-parse --short HEAD`, plus `+modified` when `git status --porcelain` isn't empty (empty if git is unavailable).
  - `configView()` returns it as `launcher`. The page header (`#appVersion`) shows "Launcher v… · build … · client v<CLIENT_VERSION>", and each open row shows its screen's `v<ver>` in `.ver` right of the name, orange (`.old`) when below `clientVersion`.
  - Bump `package.json` `version` for user-visible launcher changes.
  - **Game window title bar** (client v5+): `windowTitle()` = "<screen name> — Launcher <launcher-version> · client v<CLIENT_VERSION>", for example "Main — Launcher v1.1.0 · build a7de5d4 · client v5". The launcher passes its own string as `--lv-launcher-version=v<version> · build <build>`. The client part is the window's own code version, so it is always accurate. It is used for the normal window, PiP and renames; the PiP drag bar shows only the name.
- **It keeps no process state.** `/status` sends `GET /state` to every screen's control port (800 ms timeout); a screen that doesn't answer is closed (`null`). Because of this, restarting the launcher doesn't lose track of open screens.
- **Launch** spawns `exePath` detached, with `stdio: 'ignore'` and `cwd` set to the exe's folder. Arguments: `--user-data-dir=<instancesDir>\InstanceN --lv-instance=N --lv-control-port=4400+N --lv-launcher-port=4321 --lv-title=<titles[N] or "Lumivara #N"> --lv-hidden-fps=<hiddenFps>`, plus `--lv-pip` when "เปิดเป็น PiP" is ticked. It refuses while that screen is being backed up.
- **Startup:** `listen` → open the browser → `autoStartScreens()`, which launches the `autoStart` screens that aren't already open, 1 s apart. On `EADDRINUSE` (the launcher is already running), it opens the browser at the existing launcher and exits.
- **Backup** (`/backup/:n`): only works while the screen is closed (`/state` doesn't answer). It runs `fs.promises.cp` from `instanceDir(n)` to `backups/<folder basename>-YYYYMMDD-HHMMSS` with `errorOnExist`, skipping folders whose lowercase basename is in `CACHE_DIRS` (cache, code cache, gpucache, dawn*, grshadercache, shadercache, gpupersistentcache, scriptcache). A profile is about 140 MB but the backup is about 1 MB. Nothing is ever deleted, and there is no restore button on purpose.
- Routes (all POSTs read a JSON body; errors return `{ok:false,error}`):
  - `GET /`, `/app.js`, `/style.css`: static files from `public/`, served only through the `STATIC_FILES` whitelist (no path traversal, `Cache-Control: no-cache`). These are the only routes that don't need the `X-Lumivara` header.
  - `GET /config`: `configView()` returns `CONFIG` plus `dirs` (each screen's data folder relative to `__dirname`), `maxInstances` and `fpsChoices`. The page builds itself from this.
  - `GET /status`
  - `GET /displays`: asks the first open screen for its `/displays`.
  - `POST /launch/:n`, body `{pip}`
  - `POST /title/:n`, body `{title}`: saves the name and forwards `title?t=` to the screen if it is open. Returns `{ok, title}`.
  - `POST /restart/:n`: close the screen and open it again (see Client code version). Fails if the screen isn't open. The page's "⟳ อัปเดตจอที่เก่า (N)" button (`#updateAll`, shown only when a screen is outdated, `restartOutdated()`) calls it for every outdated screen, one at a time in row order.
  - `POST /autoafk/:n`, body `{on}`: adds the screen to or removes it from `CONFIG.autoAfk` (the 🔁 checkbox in the Automation sidebar list).
    - **Auto-AFK monitor:** `setInterval(autoAfkTick, 5000)` checks each `autoAfk` screen's `/state`.
    - When `loads` rises above `afkSeen[n]`, it schedules `runAfk` `AUTO_AFK_DELAY` (15 s) later, skipped if `saver` is already true. 8 s was too early: the click landed but the game wasn't ready.
    - Screens seen for the first time are only recorded, so restarting the launcher never disturbs screens being played. The exception is `afkJustLaunched`: `launchInstance` adds the screen there **and deletes `afkSeen[n]`**. A new window starts at `loads` 1 again, so without that deletion a restart that falls between two ticks would never count as a reload.
    - Results go to `autoAfkLast[n]`, which `/status` attaches as `autoAfkLast`; the page shows "AFK✗" with the reason in a tooltip.
  - **`runAfk` (button method):** returns early (`already`) if `#battery-saver` is visible, because B does nothing on the saver screen. After clicking it polls `#battery-saver` for up to 10 s and retries the whole open-and-click once. It only reports success when the saver screen is really showing.
  - **Bot alerts (page):** `setRowState` remembers `lastBot[n]`. A change from running to stopped adds the screen to `botAlerts` (red ■, a log line, a count in the totals line, and "(🔴 N บอทหยุด)" in `document.title`); running again or closing the screen clears it.
  - **Hidden FPS measurements** (screen 10, Windows process CPU time, 20–30 s): hidden with no cap about 34–48% of one core; 10 FPS about 12–25%; 5 FPS no better than 10; the saver screen alone about 45% (the game still runs underneath). The user's global setting is still "no limit", and the recommendation is 10. Changing the global setting pushes it to every screen, so leave that to the user.
  - `POST /autostart/:n`, body `{on}`
  - `POST /key/:n`, body `{key}`: presses one key in that screen's game page. The server checks `key` against `^([a-z0-9]|Space|Enter|Escape|Tab|Arrow(Up|Down|Left|Right))$` (case-insensitive), then forwards `key?k=`. Returns the screen's `{ok, state}`, or `{ok:false}` if the screen is closed. There is deliberately no route that runs arbitrary JavaScript.
  - `POST /afk/:n`: the "AFK" automation (`runAfk`), which opens the game's battery-saver screen. It returns `{ok, method: 'button'|'ocr', found, x, y, pressedB, conf?}`, or `{ok:false, error}`.
    - **Main method (`button`, about 1 s):** the button is real HTML, `<button id="bot-battery-saver">`, in the Bot Settings panel that B opens.
      1. Ask the screen for `GET /element?id=bot-battery-saver`. The button only counts if its text contains "battery", in case the ID is ever reused.
      2. If it's hidden (panel closed), press `b` and poll every 200 ms, for up to about 3 s, until it's visible.
      3. Click its centre. B is never pressed when the panel is already open, because B toggles the panel closed.
    - **Fallback (`ocr`, about 6–9 s):** used only when the page has no such button (for example if the developer renames the ID).
      1. OCR for `AFK_PHRASE` ("Battery saver screen"); if not found, press `b` and retry up to 3 times.
      2. On failure, `saveOcrDebug` writes `ocr-debug/screen<N>-last.png` (normal capture), `-last-white.png` (white-text capture) and `-last.txt` (the words each mode read). The folder is gitignored.
    - **Why the button method:** OCR proved fragile. It needed retuning for small windows and for the button's colour change, and it still failed on the user's small "Running"-state panel (2026-10-11), where neither mode read the button text.
  - **OCR helpers:**
    - `TESSERACT` is `C:\Program Files\Tesseract-OCR\tesseract.exe` (or the x86 path, falling back to `tesseract` on PATH). The installer doesn't add it to PATH. The user has v5.5.3 with eng and tha.
    - `captureScreen(n, mode)` fetches the screen's `GET /capture[?mode=white]` PNG and its `X-Scale`.
    - `ocrWords(png)` pipes the PNG to `tesseract stdin stdout -l eng --psm 11 tsv` and parses the word boxes.
    - `findPhrase(words, phrase)` matches each phrase word case- and punctuation-insensitively, allowing one character error for words of 5+ letters. Each next word must be to the right on the same row (vertical overlap) within 3 word-heights. It returns the centre of the combined box.
    - `ocrFind` tries both `mode=white` and the normal image, starting with whichever found the phrase last time (`lastOcrMode`, initially white; it lives in launcher memory only). It converts the image-pixel centre to page pixels by dividing by `scale`.
    - **Game UI history:** originally the panel was "Auto Play · Bot Settings" with a dark navy "Battery saver screen" button lower right, readable only through `mode=white`. On 2026-10-11 the developer changed it to "Bot Settings" with a **blue** "☽ Battery saver screen" button under "Start Auto Play". The normal image reads that one (86–95%, including small 2×2 windows) and `mode=white` doesn't, hence `lastOcrMode`. The battery-saver screen itself looks unchanged. If AFK breaks after another UI update, capture test screen 10 after pressing B and compare both modes.
    - Measured on the Auto Play panel: the normal image does **not** find the white-on-dark button text in any page-segmentation mode; `mode=white` does (see Capture for the tuned values). When an automation fails, `ocr-debug/screenN-last.png` is the *normal* capture. To reproduce a failure, size test screen 10 like the failing window (for example `POST 4410/action/tile?i=0&n=4` for a 2×2 grid cell) and compare `GET /capture` with `GET /capture?mode=white` there.
  - `POST /backup/:n`
  - `POST /instance/:n/:action`: forwards to the screen's `/action/:action`. Allowed actions: `pip fullscreen refresh mute focus hide show toggleHide quit`.
  - `POST /toggle-all`: hides every open screen if any is visible, otherwise shows them all.
  - `POST /mute-all`: mutes every open screen if any is unmuted, otherwise unmutes them all (via `muteSet?on=`).
  - `POST /tile-all`, body `{display}`: sends each open, non-hidden screen (sorted by number) `tile?i=&n=&d=`.
  - `POST /quit-all`
  - `POST /add-screen`: increments `instanceCount`.
  - `POST /remove-screen`: decrements `instanceCount`. It refuses if the last screen is open or the count is 1, and it only hides the row; no data is touched.
  - `POST /order`, body `{order}`: must be a permutation of `1..instanceCount`, otherwise 400.
  - `POST /config`, body `{exePath, instancesDir}`
  - `POST /settings`, body `{hiddenFps}`: saves the value and pushes `fps?v=` to every open screen.
  - `POST /shutdown`
- **Page** (`public/`): the HTML is static. `app.js` fetches `GET /config`, fills the settings, and clones `rowTpl` once per screen in `cfg.order`, setting values through DOM properties rather than HTML strings.
  - Each row starts with a ⋮⋮ `.handle` button. The row becomes `draggable` only on `pointerdown` on the handle (and is reset on `pointerup` or `dragend`), so dragging inside the title input still selects text. On `dragover` the row is inserted before or after the row under the pointer (split at its midpoint), and `dragend` posts the DOM order to `/order`. When the handle has focus, ArrowUp/ArrowDown move the row and save.
  - + / − do not reload the page. + fetches `/config` and appends the new row with the `.row-enter` CSS animation. − removes the row whose `data-n` equals the new count + 1, which may not be the bottom row if the order changed. With `prefers-reduced-motion` (Windows "Animation effects" off, as on the user's PC) it removes the row immediately. Otherwise it plays a 180 ms Web Animations collapse from the row's measured height, with a 300 ms fallback timer for background tabs where animations are paused.
  - `body.loading` (opacity 0) is removed once the rows are built, and an inline `<style>` sets the dark background, so the first frame never flashes white. Row buttons and inputs use event delegation on `#rowList` (`click` and `change`), and rows carry `data-n`. One row per screen:
  - number, a title input (`maxlength 60`, fixed width of about 20 characters, saved to the server on `change`), a `.folder` tag showing "📁 <folder basename>" from `cfg.dirs[n]` (tooltip: the full path), which shows the screen name → `InstanceN` mapping, and an open/close button;
  - control buttons (`data-act`): เรียก/focus, PiP, เต็มจอ, ซ่อน↔แสดง/toggleHide, ปิดเสียง↔เปิดเสียง/mute, รีเฟรช;
  - an "อัตโนมัติ" checkbox and a "สำรอง" button (enabled only while the screen is closed);
  - **Automation sidebar** (`<aside id="automation">`, fixed on the right, 280 px wide):
    - It is opened by the fixed "🤖 Automation" tab and closed with ×. Its state is kept in `localStorage` (`lumivaraSideOpen`). While open, `body.side-open` adds right padding so the rows aren't covered; under 900 px it overlays instead.
    - `renderAutoList()` builds one checkbox per screen from the current `#rowList` (row order plus the live title input value), with a `.dot` that `setRowState` turns green via the `openNow` Set. It is re-run after a rename, a reorder, +/− and on page load.
    - The selection is a Set kept in `localStorage` (`lumivaraAutoSel`). Buttons: ทั้งหมด (all), เฉพาะที่เปิด (only open), ไม่เลือก (none).
    - Commands go through `runAuto(label, btn, request)`. It calls `request(n)` in parallel for every selected screen that is open, skips closed ones, disables all `.auto-cmds` buttons while running, and writes a summary of done / skipped / failed to `#autoLog`.
      - `.auto-key[data-key]` buttons (currently "กด I") post `/key/:n`. To add a key command, add another `.auto-key` button.
      - `#autoAfk` posts `/afk/:n` (see the AFK route).
  - a stats span showing `<mem> MB · CPU <cpu>%`, plus "กู้คืน N" or "กำลังกู้คืน…". It holds two parts: `.badge` (the ⟳ tag) and `.nums`. `.nums` is rewritten every poll, but `.badge` is rebuilt only when its `data-mode` changes ('' / 'outdated' / 'restarting'). **Don't rebuild clickable elements on every 2 s poll:** an earlier version re-created the ⟳ button each poll, and a click whose mousedown and mouseup straddled a poll was silently lost, which is why one screen's restart "did nothing".

  A button that is on gets the blue `.on` class. Status is polled every 2 s, and the totals line shows the open count, total RAM in GB and total CPU. On load, a title still kept in the old `localStorage` key `lumivaraTitle_N` is moved to the server once, but only when the server has no title for that screen.

  Below the rows are dashed "+ เพิ่มจอ" and "− ลดจอ" buttons (see above; they do not reload the page). The bottom bar has a "เปิดเป็น PiP" checkbox, open-all (500 ms apart), a monitor picker (filled from `/displays`, shown only when there are 2 or more monitors, choice kept in `localStorage`), arrange-all, hide/show-all, mute/unmute-all, close-all (with confirm) and shutdown. Collapsible panels: "⚙ ตั้งค่า" (paths and the hidden-FPS select, which applies immediately) and "⌨ คีย์ลัด". Dark theme (#12141c).

### client/main.cjs (one game window)
- It reads `--lv-instance`, `--lv-control-port`, `--lv-launcher-port`, `--lv-title` (cleaned the same way as on the server; `title` is mutable) and `--lv-hidden-fps` (one of `[0,20,10,5]`, default 0) from `process.argv`. It calls `app.requestSingleInstanceLock()`, which is per userData, so a second launch of the same screen focuses the existing window. It also calls `powerSaveBlocker.start('prevent-app-suspension')` and appends the switches `disable-background-timer-throttling`, `disable-renderer-backgrounding` and `disable-backgrounding-occluded-windows`.
- **Game window:** a `BaseWindow` (minimum 320×240, background #17294e, no menu, title from the argument, created with `show: false`). Its size and position come from `InstanceN/lv-window.json` (`{normal, maximized, pip}`) when that rectangle overlaps a display's work area by at least 50 px; otherwise it is 1100×750. It is shown unless `--lv-pip`. Bounds are saved on `resized`, `moved`, `maximize`, `unmaximize` and `close` of both windows, after tiling and after leaving PiP, using `getNormalBounds()` and the last PiP bounds. The game runs in a `WebContentsView` using the session `persist:lumivara` (the same partition the old official build used, so existing logins carry over), with `backgroundThrottling: false`, `sandbox: true` and zoom mode `isolated`. `page-title-updated` is prevented so the custom title stays. HTTPS popups are allowed in the same session and tracked, so hiding and muting apply to them too.
- **Background shim:** `loadGame()` loads `about:blank`, detaches the debugger if attached, then runs `debugger.attach('1.3')`, `Page.enable`, and `Page.addScriptToEvaluateOnNewDocument` with the contents of `visibility-spoof.js`. Only then does it load `https://lumivaraonline.com/`. This is redone on every recovery because a new renderer loses the injected script.
- **Auto-recovery** (`recover(reason)`, guarded by `quitting`/`recovering`; it increments `recoveries`, waits 3 s, then calls `loadGame()`):
  - `render-process-gone` triggers it.
  - A main-frame `did-fail-load` of the game URL (except code -3, ERR_ABORTED) schedules a retry in `RETRY_MS` (10 s), repeated until loading succeeds.
  - A hang watchdog runs every 5 s: `executeJavaScript('1')` updates `lastPong`. After `HANG_MS` (30 s) without an answer, while not loading or recovering, it calls `forcefullyCrashRenderer()`, which fires `render-process-gone`. Electron's own `unresponsive` event is not used because it only fires when there is user input, which a hidden AFK window never gets.
- **Hidden frame cap:** `applyFrameRate()` sets `window.__lvHiddenMs` = `1000/hiddenFps` while hidden (and the cap is not 0), otherwise 0. It runs on hide/show, `did-finish-load` and the `fps` action. Without a cap, hidden windows still render at the monitor's full refresh rate (about 180 FPS was measured) because of the anti-backgrounding switches.
- **Game probe (v7):** the hang watchdog's 5 s `executeJavaScript` runs `GAME_PROBE`. It caches `botText` (`#bot-status` text: "Running"/"Stopped") and `inSaver` (`#battery-saver` shown). `did-finish-load` of the game URL increments `loads` and resets both. `state()` adds `loads`, `bot` ('running'|'stopped'|null) and `saver`.
  - **Never use `offsetParent` for visibility:** it's always null for `position:fixed` elements. `#battery-saver` is a fixed full-screen `section`, so v6 always reported it hidden.
  - Visibility is now: rect width and height > 0, plus `display`, `visibility` and `opacity`. `findElement()` uses the same rule.
  - Game element IDs used so far: `#bot-window` (Bot Settings panel), `#bot-status`, `#bot-run` (Start/Stop Auto Play), `#bot-battery-saver`, `#battery-saver` (the saver screen) and `#battery-saver-idle`. The last one is the game's own select, values off/1/3/5 minutes; it's stored in localStorage `pixelrpg.battery-saver`, persists across reloads and works while hidden.
- **Metrics:** `state()` adds `mem` (MB, the sum of `workingSetSize` from `app.getAppMetrics()` across all of this app's processes) and `cpu` (the sum of `percentCPUUsage` since the last call).
- **Layout:** the game view fills the window. In PiP it sits below a 24 px bar, and the bar is inset 4 px so the window edges stay resizable. Zoom factor = `clamp(min(w/1100, h/750), 0.01, 1)`.
- **PiP:** a frameless, always-on-top, resizable `BaseWindow`, minimum 64×48, 360×260 by default, placed 16 px from the bottom-right of the work area. It remembers its last size and position. The existing game view is *moved* into it with `removeChildView`/`addChildView`, so the game doesn't reload, and the normal window is hidden. Restoring moves the view back. The PiP bar is a `WebContentsView` loading `pip-bar.html?t=<title>`: the full area is a drag region (`-webkit-app-region: drag`) showing "<title> · PiP". A `moving` flag blocks other actions while the view is being moved. Closing the PiP window or the normal window quits the app.
- **Hide:** hide every visible window and set `skipTaskbar`. Show reverses this. Audio is muted when `hidden || userMuted`; mute toggles `userMuted`.
- **Fullscreen** toggles on the normal window (leaving PiP first if needed). **Refresh** reloads the game view.
- **Tile** (`i`, `n`, optional display id `d`): leave PiP, leave fullscreen (wait for `leave-full-screen`, at most 1 s), restore if minimized, unmaximize. Then choose the column count from 1 to n that maximizes `min(areaW/cols/1100, areaH/rows/750)` and place the window in cell i of display `d`'s `workArea` (or the primary display's if `d` is missing or unknown). Display ids from `screen.getAllDisplays()` are the same in every process. `GET /displays` returns `[{id, primary, label: "<monitor name> (W×H)"}]`.
- **Rename** (`title?t=`): updates both windows' titles and the PiP bar text through `executeJavaScript`.
- **Shortcuts** (`before-input-event` on the game view and the PiP bar): F5 refresh, F8 hide/show, F11 or Alt+Enter fullscreen, Ctrl+Shift+P PiP, Esc leaves PiP or fullscreen. Ctrl+Shift+H works in-window only when the global hotkey is not registered.
- **Global Ctrl+Shift+H:** `globalShortcut.register`, retried every 5 s. Only one process can own it, so on press it POSTs to the launcher's `/toggle-all`; if the launcher is down it hides only its own window.
- **Control server:** `http.createServer` on `127.0.0.1:<control-port>`. `GET /state` returns `{ver, title, hidden, muted, pip, fullscreen, recoveries, recovering, loads, bot, saver, mem, cpu}`. `GET /displays` is described under Tile. `GET /capture[?mode=white]` is described under Capture. `GET /element?id=<id>` (the id must match `^[\w-]{1,64}$`) is read-only: `findElement()` returns `{found, visible, text, x, y}` for `document.getElementById(id)`, where x/y is the centre in page pixels, and it never changes the page. It is the only page-reading command, and it is fixed code, not arbitrary JavaScript. `POST /action/<name>?<params>` runs the action from the `actions` map (`pip fullscreen refresh mute muteSet focus hide show toggleHide quit tile title fps key click`), which receives `URLSearchParams`, then returns `{ok, state}`. If the port is busy it shows an error dialog.
- **Key** (`key?k=`): `pressKey()` accepts a single letter, a digit, or a name from `NAMED_KEYS` (Space, Enter, Escape, Tab, arrows). It sends `Input.dispatchKeyEvent` `keyDown` (with `text`; `rawKeyDown` for keys without text) then `keyUp` through the debugger that `loadGame()` already attached. Letters are sent lowercase with `code` `KeyX` and the matching virtual key code. These events are trusted and reach the page even when the window is hidden or unfocused; Electron's `sendInputEvent` needs focus, which is why it isn't used.

- **Capture** (`GET /capture`): `captureGame(mode)` grabs only the game `WebContentsView` with `webContents.capturePage()` (no window frame or PiP bar; it works while hidden) and returns a PNG. The `X-Scale` header gives image pixels per page (CSS) pixel, and `X-Css-Size` gives `innerWidth`×`innerHeight`.
  - **Upscale:** the image is enlarged by `round(OCR_TARGET_SCALE / (rawWidth / cssW))`, clamped to 1–4, so the result is about 2 image pixels per CSS pixel whatever the window size. Small tiled windows, which the game shrinks, get about 3×; large windows get about 2×.
  - **`mode=white`:** keeps only bright, colourless pixels (min channel > `WHITE_MIN` 160 and channel spread < `WHITE_SPREAD` 30), drawn black on white through `nativeImage.toBitmap()` / `createFromBitmap()`, because Tesseract can't read white text on dark buttons.
  - **Why these values** (measured on "Battery saver screen" at 2×2-grid, half-screen and full-screen window sizes):
    - a fixed 2× upscale with min > 185 / spread < 45 found nothing in small windows, because the thin anti-aliased letters fell below 185 and the cream panel counted as white;
    - a fixed 3× upscale worked, but full-screen captures became about 5800×3000 and took about 19 s;
    - a fractional upscale (3.14×) dropped confidence to about 14%, hence the rounding.
  - **Current results:** 92% (small), 96% (medium and full). AFK takes about 6 s for small and medium windows and about 9 s full screen.
- **Click** (`click?x=&y=`, page pixels): `clickAt()` checks that the point is inside `innerWidth`/`innerHeight`, then sends `Input.dispatchMouseEvent` `mouseMoved`, `mousePressed`, `mouseReleased` (left button) through the debugger. Like Key, this works while the window is hidden or unfocused.

### client/visibility-spoof.js
An IIFE guarded by `window.__lumivaraBackgroundShim`.
- It replaces `requestAnimationFrame` with a version that runs the callback on the real frame or after a 50 ms `setTimeout`, whichever comes first, and replaces `cancelAnimationFrame` to cancel both. When `window.__lvHiddenMs` is set (non-zero), it skips the real frame and uses only `setTimeout(__lvHiddenMs)`, which is the hidden-window frame cap.
- It defines `document.hidden` = false, `document.visibilityState` = 'visible' and `document.hasFocus` = () => true, each inside a try/catch.
- This keeps the Phaser game loop running while the window is minimized or hidden.

### Security (keep this when adding endpoints)
Both servers return 403 unless the `Host` header matches `127.0.0.1:<port>` or `localhost:<port>`, which blocks DNS rebinding. Every request on the console except the three static files also needs the header `X-Lumivara: 1`. That custom header forces a CORS preflight, which is never answered, so other websites can't send commands. The page's `fetch` calls send this header.

## Repository and releases

The code is on GitHub at `gxx898c/lumivara-multi-launcher` (public, branch `main`). `.gitignore` keeps out `saved/`, `Instance*/`, `backups/` (player data, never commit), `runtime/` (too big: the exe is 235 MB, over GitHub's 100 MB limit), `config.json` (per machine) and `*.lnk` (contains a local path).

`runtime/` is published separately as the release asset `lumivara-runtime-win-x64.zip`, which unzips to a `runtime/` folder. To rebuild it, zip with Windows' own tar (`C:\Windows\System32\tar.exe -a -c -f <zip> -C <project> runtime`); Git Bash's tar treats `C:` as a remote host. It must keep `runtime/LICENSE` (Electron, MIT) and `runtime/LICENSES.chromium.html`. The latter comes from Electron's official `electron-v44.5.1-win32-x64.zip`, because the official game download's copy had been deleted. Commits use the repo-local git name `gxx898c`, and the active `gh` account must be `gxx898c` to push (`pongsathorn-t` has no access).

## Building from scratch

Users who only want to run it: clone the repo and unzip the release asset into the project folder (see README). The steps below rebuild everything from the official client instead.

1. Download and unzip the official **Lumivara Online Windows x64** client (version 4.4.5 was used; the folder is called `Lumivara-Online-Windows-x64`).
2. Copy that whole folder to `<project>\runtime`, then in the copy:
   - Delete `resources\app.asar`.
   - Rename `Lumivara Online.exe` to `LumivaraClient.exe`.
   - Optionally delete `Lumivara Online.ico`, `version`, `อ่านก่อนใช้.txt`, `Start-*.cmd`, and every file in `locales\` except `en-US.pak` and `th.pak`. Keep `LICENSE` and `LICENSES.chromium.html`; they are required if `runtime/` is ever redistributed.
   - Create `resources\app\package.json`: `{ "name": "lumivara-multi-client", "main": "../../../client/main.cjs" }`
3. Copy `Lumivara Online.ico` from the download to `client\game.ico`.
4. Write `client/visibility-spoof.js`, `client/pip-bar.html`, `client/main.cjs`, `server.js`, `public/index.html`, `public/style.css`, `public/app.js`, `config.json`, `package.json` and `start.bat` following the spec above. Each file starts with a short Thai comment explaining its purpose. Create `Lumivara Launcher.lnk` with PowerShell: `$l=(New-Object -ComObject WScript.Shell).CreateShortcut('<project>\Lumivara Launcher.lnk'); $l.TargetPath='C:\Windows\System32\conhost.exe'; $l.Arguments='--headless node server.js'; $l.WorkingDirectory='<project>'; $l.IconLocation='<project>\client\game.ico,0'; $l.Save()`
5. Run `node server.js` and test with a scratch profile as described under "Running".

Step 2 only works because the official exe's Electron fuse **OnlyLoadAppFromAsar is disabled**; otherwise Electron would ignore `resources\app\`. A future client version might change this. To check, find the sentinel `dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX` in the exe: the next byte is the fuse version, the byte after is the fuse count, and then comes one ASCII character per fuse. In 4.4.5 they read `101100011`, where index 5 (OnlyLoadAppFromAsar) is `'0'`, meaning disabled. If it reads `'1'`, use the official Electron build of the same version (found in the `version` file) from npm or GitHub instead.

To read the official app code (for example when porting a new feature from a newer client version), extract `app.asar` with Node. The archive starts with a 16-byte header: `UInt32LE` at offset 4 is the header pickle size, and `UInt32LE` at offset 12 is the JSON length. The JSON at offset 16 is a tree of `files`, where each file has `offset` (a string) and `size`. File data starts at `8 + headerPickleSize + offset`. The relevant files are `client.cjs` (window logic), `controller.cjs`, `pip-layout.cjs` and `visibility-spoof.js`.
