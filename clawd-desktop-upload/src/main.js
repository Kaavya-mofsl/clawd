const { app, BrowserWindow, screen, Notification, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { STATE_DIR, aggregate: sharedAggregate } = require('./state');

// Transparent always-on-top windows on macOS 12 push the GPU path into a stream of
// EGL driver errors and occasional compositing artifacts. The pet is a tiny canvas,
// so software rendering costs nothing and is far better behaved here.
app.disableHardwareAcceleration();

// config.json plus config.local.json if it exists — see src/config.js.
const config = require('./config').load();
const { profiles, strip, behavior } = config;

/** profileId -> BrowserWindow[] (one per display) */
const windows = new Map();
/** sessionId -> { since, notifiedAt } — drives the nag timer */
const waitingSessions = new Map();
/** sessionId -> { since } — when this session last started working, for the done nudge */
const workingSessions = new Map();
/** profileId -> last status string, so we only push on change */
const lastStatus = new Map();

let tray = null;
let muted = false;

// CLAWD_TRACE=1 narrates the notification decisions. Same spirit as ~/.clawd/debug for
// the hook: when a nudge turns out to be wrong, you need to see what it was thinking.
const trace = process.env.CLAWD_TRACE ? (...a) => console.log('[trace]', ...a) : () => {};

// ------------------------------------------------------------- positions
//
// Where the user has dragged each pet, keyed by profile *and* display — a strip
// parked above the dock on the laptop means nothing on an external monitor.
//
// Kept in CLAWD_HOME rather than config.json: config is hand-edited and lives with
// the source, and rewriting it under the user every time a crab is nudged sideways
// would clobber their comments.
const POSITIONS_PATH = path.join(path.dirname(STATE_DIR), 'positions.json');

function loadPositions() {
  try {
    return JSON.parse(fs.readFileSync(POSITIONS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function savePosition(key, x, y) {
  const all = loadPositions();
  all[key] = { x, y };
  try {
    fs.writeFileSync(POSITIONS_PATH, JSON.stringify(all, null, 2) + '\n');
  } catch (err) {
    console.error('[clawd] could not save position:', err.message);
  }
}

const positionKey = (profileId, displayId) => `${profileId}@${displayId}`;

// A window dragged to where it can't be grabbed again is a window the user has lost.
// Keep a decent chunk of it on the display it's nearest to, and never above the menu
// bar. Horizontal slack is generous — parking the crab half off the right edge is a
// legitimate way to get him out of the way.
function clampToDisplay(x, y, w, h) {
  const d = screen.getDisplayNearestPoint({ x: Math.round(x + w / 2), y: Math.round(y + h / 2) });
  const b = d.bounds;
  const keep = 80;
  return {
    x: Math.round(Math.max(b.x - w + keep, Math.min(b.x + b.width - keep, x))),
    y: Math.round(Math.max(d.workArea.y, Math.min(b.y + b.height - keep, y))),
  };
}

// ---------------------------------------------------------------- windows

function createWindowsForProfile(profile) {
  const wins = [];
  const saved = loadPositions();

  for (const display of screen.getAllDisplays()) {
    const area = display.workArea; // already excludes the dock and menu bar
    const width = Math.min(strip.width, area.width);
    const height = strip.height;

    const home = saved[positionKey(profile.id, display.id)];
    const spot = home
      ? clampToDisplay(home.x, home.y, width, height)
      : {
          x: area.x + strip.leftOffset + profile.lane * strip.laneGap,
          y: area.y + area.height - height - strip.bottomOffset,
        };

    const win = new BrowserWindow({
      width,
      height,
      x: spot.x,
      y: spot.y,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      show: false,
      // No `type: 'panel'` — macOS 12 rejects a non-activating panel styleMask and
      // logs on every window. focusable:false already keeps it from taking focus.
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // Above everything, including the dock, on every Space, and in full-screen apps.
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Clicks fall through to whatever is underneath. `forward: true` is what makes the
    // pet grabbable at all: the renderer still receives mousemove while ignoring
    // clicks, so it can notice the cursor is over the crab and ask for the mouse back.
    win.setIgnoreMouseEvents(true, { forward: true });

    // Which pet, on which screen — the drag handlers only get a webContents.
    win.__clawd = { profileId: profile.id, displayId: display.id, drag: null };

    const params = new URLSearchParams({
      profile: profile.id,
      label: profile.label,
      color: profile.color,
      scale: String(behavior.scale),
      speed: String(behavior.walkSpeed),
      fps: String(behavior.fps ?? 15),
      fpsAsleep: String(behavior.fpsAsleep ?? 5),
    });
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'), { search: params.toString() });

    // ready-to-show is unreliable for transparent windows, so don't gate anything on it
    win.webContents.once('did-finish-load', () => {
      if (!behavior.hideWhenNoSessions) win.showInactive();
      pushStatus(profile.id, true);
    });

    const b = win.getBounds();
    console.log(
      `[clawd] ${profile.id} on display ${display.id}: ${b.width}x${b.height} at (${b.x},${b.y}) ` +
        `— dock top ${area.y + area.height}, screen bottom ${display.bounds.y + display.bounds.height}, ` +
        `screen width ${display.bounds.width}`
    );

    wins.push(win);
  }

  windows.set(profile.id, wins);
}

function buildAllWindows() {
  for (const profile of profiles) {
    try {
      createWindowsForProfile(profile);
    } catch (err) {
      console.error(`[clawd] failed to create windows for ${profile.id}:`, err);
    }
  }
  const total = [...windows.values()].reduce((n, w) => n + w.length, 0);
  console.log(`[clawd] ${total} window(s) across ${screen.getAllDisplays().length} display(s)`);
}

// ------------------------------------------------------------------ drag

function senderWindow(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win && !win.isDestroyed() && win.__clawd ? win : null;
}

ipcMain.on('clawd:interactive', (event, on) => {
  const win = senderWindow(event);
  if (!win) return;
  // Only while the cursor is genuinely on the crab. The window is a 460px strip and
  // leaving it solid would eat clicks meant for whatever is underneath.
  win.setIgnoreMouseEvents(!on, { forward: true });
});

// Where the window should sit for a given cursor position. Split out because it is
// the only part of dragging with any arithmetic in it, and the only part a test can
// drive — reading the real cursor is the OS's job, not something worth mocking.
function applyDrag(win, cursor) {
  const drag = win?.__clawd?.drag;
  if (!drag) return;
  const b = win.getBounds();
  const spot = clampToDisplay(cursor.x - drag.grabX, cursor.y - drag.grabY, b.width, b.height);
  win.setPosition(spot.x, spot.y);
}

// The renderer deliberately does not send coordinates. A mouse event's `screenX` is
// derived from the window's own position, and the window is being moved out from under
// the cursor on every frame of a drag — so the reading feeds back into itself and the
// crab bolts across the screen. Measured: dragged left, the window ran right by 507px.
// `getCursorScreenPoint` is the OS's answer and can't chase its own tail.
function stopDragTimer(win) {
  if (win?.__clawd?.timer) {
    clearInterval(win.__clawd.timer);
    win.__clawd.timer = null;
  }
}

ipcMain.on('clawd:drag-start', (event) => {
  const win = senderWindow(event);
  if (!win) return;
  const b = win.getBounds();
  const cursor = screen.getCursorScreenPoint();
  win.__clawd.drag = { grabX: cursor.x - b.x, grabY: cursor.y - b.y, since: Date.now() };

  stopDragTimer(win);
  win.__clawd.timer = setInterval(() => {
    // A renderer that dies mid-drag never sends drag-end, and this would then follow
    // the cursor around the screen forever.
    if (win.isDestroyed() || Date.now() - win.__clawd.drag?.since > 60000) {
      stopDragTimer(win);
      return;
    }
    applyDrag(win, screen.getCursorScreenPoint());
  }, 16);
});

ipcMain.on('clawd:drag-end', (event) => {
  const win = senderWindow(event);
  if (!win?.__clawd.drag) return;
  stopDragTimer(win);
  win.__clawd.drag = null;

  const b = win.getBounds();
  // Re-key on where it *landed*, so dragging a pet onto the second monitor makes it
  // that monitor's remembered spot rather than rewriting the one it came from.
  const displayId = screen.getDisplayNearestPoint({
    x: Math.round(b.x + b.width / 2),
    y: Math.round(b.y + b.height / 2),
  }).id;
  win.__clawd.displayId = displayId;
  savePosition(positionKey(win.__clawd.profileId, displayId), b.x, b.y);
});

function resetPositions() {
  try {
    fs.unlinkSync(POSITIONS_PATH);
  } catch {
    /* nothing saved yet */
  }
  rebuildWindows();
}

function destroyAllWindows() {
  for (const wins of windows.values()) {
    for (const w of wins) if (!w.isDestroyed()) w.destroy();
  }
  windows.clear();
}

function rebuildWindows() {
  destroyAllWindows();
  buildAllWindows();
}

// ------------------------------------------------------------------ state

const aggregate = (profileId) => sharedAggregate(profileId, behavior);

function pushStatus(profileId, force = false) {
  const profile = profiles.find((p) => p.id === profileId);
  const agg = aggregate(profileId);
  const signature = `${agg.status}|${agg.sessions}|${agg.waiting}|${agg.tool}|${agg.message}`;

  if (!force && lastStatus.get(profileId) === signature) return agg;
  lastStatus.set(profileId, signature);

  const wins = windows.get(profileId) || [];
  for (const win of wins) {
    if (win.isDestroyed()) continue;

    if (behavior.hideWhenNoSessions) {
      const shouldShow = agg.status !== 'absent';
      if (shouldShow && !win.isVisible()) {
        win.showInactive();
        // macOS quietly drags a *hidden* window back onto the screen — measured: a
        // hidden window put at x=-188 was at x=0 within 400ms, while a visible one at
        // the same spot stayed put indefinitely. So a pet parked half off the left
        // edge would creep back into view every time his session ended. Reassert the
        // spot the user actually chose.
        const home = loadPositions()[positionKey(profile.id, win.__clawd.displayId)];
        if (home) {
          const b = win.getBounds();
          const spot = clampToDisplay(home.x, home.y, b.width, b.height);
          if (spot.x !== b.x || spot.y !== b.y) win.setPosition(spot.x, spot.y);
        }
      }
      if (!shouldShow && win.isVisible()) win.hide();
    }

    // Electron does NOT throttle a hidden window's timers — measured: an account with
    // zero sessions, window hidden, still burned ~5% of a core animating a pet nobody
    // could see. So say it outright rather than letting the renderer infer it from
    // document.hidden, which on macOS also means "occluded" and would freeze a pet
    // that is plainly on screen.
    const offscreen = Boolean(behavior.hideWhenNoSessions) && agg.status === 'absent';

    win.webContents.send('clawd:state', {
      ...agg,
      offscreen,
      profile: profile.id,
      label: profile.label,
    });
  }

  return agg;
}

// -------------------------------------------------------------------- nag

function updateNags(profileId, agg) {
  const profile = profiles.find((p) => p.id === profileId);
  const now = Date.now();
  const live = new Set(agg.waitingIds);

  // clear sessions that answered the prompt
  for (const id of [...waitingSessions.keys()]) {
    if (!live.has(id)) waitingSessions.delete(id);
  }

  if (behavior.nagDelayMs < 0 || muted) return;

  // A prompt that has ignored three notifications is not going to be rescued by a
  // fourth. Capping matters more than it sounds: every false positive that slips
  // through used to nag once a minute for the full 30-minute stale window, which is
  // what makes a wrong nudge so much more expensive than a missed one.
  const maxNags = behavior.maxNags ?? 3;

  for (const id of live) {
    let entry = waitingSessions.get(id);
    if (!entry) {
      entry = { since: now, notifiedAt: 0, count: 0 };
      waitingSessions.set(id, entry);
    }

    if (entry.count >= maxNags) continue;

    const waitedLongEnough = now - entry.since >= behavior.nagDelayMs;
    const dueForRenag = entry.notifiedAt === 0 || now - entry.notifiedAt >= behavior.renagMs;

    if (waitedLongEnough && dueForRenag) {
      entry.notifiedAt = now;
      entry.count++;
      notify(profile, agg);
    }
  }
}

// ------------------------------------------------------------------ done
//
// "Claude has finished" is the `Stop` hook, which fires at the end of every assistant
// turn — including the one-line answers you were sitting there watching. So it only
// counts as something worth interrupting you for if the turn actually took a while.
//
// `SubagentStop` deliberately does not count. It writes an idle state mid-turn when a
// subagent returns, and announcing that would mean two or three "done" pings for a
// single request. Tracking survives it, so the elapsed time still runs from the start
// of the whole turn rather than restarting at the last subagent.

function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
}

function updateDone(profileId, agg) {
  if (behavior.notifyOnDone === false) return;

  const profile = profiles.find((p) => p.id === profileId);
  const minMs = behavior.doneMinWorkMs ?? 20000;
  const seen = new Set();

  for (const s of agg.all) {
    const id = s.session_id;
    if (!id) continue;
    seen.add(id);

    if (s.state === 'working' || s.state === 'waiting') {
      if (!workingSessions.has(id)) {
        trace('working:', id, 'since', new Date(s.ts).toISOString());
        workingSessions.set(id, { since: s.ts, profileId });
      }
      continue;
    }

    const started = workingSessions.get(id);
    if (!started || s.event !== 'Stop') continue;
    trace('finished:', id, 'after', formatDuration(s.ts - started.since));
    workingSessions.delete(id);

    const took = s.ts - started.since;
    if (took < minMs || muted) continue;

    const where = s.cwd ? path.basename(s.cwd) : '';
    show({
      title: where ? `${profile.label} · ${where}` : profile.label,
      body: `Finished — ${formatDuration(took)}`,
    });
    cheer(profileId);
  }

  // A session that vanished (SessionEnd, or gone stale) never finished anything.
  for (const [id, entry] of workingSessions) {
    if (entry.profileId === profileId && !seen.has(id)) workingSessions.delete(id);
  }
}

/** A little ✓ over the pet's head, so a glance at the dock strip answers the question. */
function cheer(profileId) {
  for (const win of windows.get(profileId) || []) {
    if (!win.isDestroyed()) win.webContents.send('clawd:cheer');
  }
}

function show({ title, body }) {
  // Logged as well as shown. Every notification is an interruption, so when one turns
  // out to be wrong there has to be a record of what Clawd thought at the time.
  console.log(`[clawd] notify: ${title} — ${body}`);
  if (!Notification.isSupported()) return;
  new Notification({ title, body, silent: false }).show();
}

function notify(profile, agg) {
  // The folder goes in the *title*, not buried in the body. With several sessions
  // open across two accounts, "Claude needs you" sends you to whichever window
  // happens to be frontmost — which is usually not the one with the prompt, and
  // reads as a false alarm even when the alert was perfectly correct.
  const where = agg.cwd ? path.basename(agg.cwd) : '';
  show({
    title: where ? `${profile.label} · ${where}` : profile.label,
    body: agg.message || 'Waiting for permission',
  });
}

// ------------------------------------------------------------------- loop

function tick() {
  for (const profile of profiles) {
    const agg = pushStatus(profile.id);
    updateNags(profile.id, agg);
    updateDone(profile.id, agg);
  }
}

// ------------------------------------------------------------------- tray

function buildTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setTitle('🦀');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: 'Clawd Desktop', enabled: false },
    { type: 'separator' },
    {
      label: muted ? 'Unmute notifications' : 'Mute notifications',
      click: () => {
        muted = !muted;
        refreshTrayMenu();
      },
    },
    {
      label: 'Test nudge',
      click: () => {
        notify(profiles[0], { message: 'This is what a nudge looks like.', cwd: '' });
      },
    },
    { type: 'separator' },
    { label: 'Reposition pets', click: rebuildWindows },
    { label: 'Forget dragged positions', click: resetPositions },
    { label: 'Open state folder', click: () => shell.openPath(STATE_DIR) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

// ------------------------------------------------------------------- boot

app.whenReady().then(() => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  for (const profile of profiles) {
    fs.mkdirSync(path.join(STATE_DIR, profile.id), { recursive: true });
  }

  if (app.dock) app.dock.hide(); // menu-bar app, no dock icon

  buildAllWindows();
  buildTray();

  setInterval(tick, 400);
  tick();

  if (process.env.CLAWD_SELFTEST) {
    require('./selftest').run(windows, { applyDrag, loadPositions, stopDragTimer }).catch((err) => console.error('[selftest]', err));
  }

  screen.on('display-added', rebuildWindows);
  screen.on('display-removed', rebuildWindows);
  screen.on('display-metrics-changed', rebuildWindows);
});

app.on('window-all-closed', (e) => e.preventDefault()); // tray app: stay alive
