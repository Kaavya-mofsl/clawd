// Drives the pick-up-and-drag path without a human hand on the trackpad.
// Loaded only when CLAWD_SELFTEST=drag:
//
//   CLAWD_SELFTEST=drag npm start
//
// What this proves and what it can't. `sendInputEvent` injects at the renderer, which
// is where Electron's `forward: true` delivers a forwarded mousemove too — so the hit
// test, the interactivity handshake and the mousedown/mouseup handling are genuinely
// exercised. The drag *arithmetic* is driven through `applyDrag` with fabricated cursor
// points, because the real drag reads `getCursorScreenPoint()` and no amount of
// synthetic input moves the actual mouse.
//
// Two things still need a real hand: that macOS forwards live cursor movement over a
// click-through window at all, and that the crab looks right being carried.

const fs = require('fs');
const path = require('path');
const { STATE_DIR } = require('./state');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(
    `[selftest] ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ` +
      `${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`
  );
}

async function look(win) {
  return JSON.parse(await win.webContents.executeJavaScript('JSON.stringify(window.__clawdDebug())'));
}

function move(win, x, y) {
  win.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) });
}

function click(win, type, x, y) {
  win.webContents.sendInputEvent({
    type, x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1,
  });
}

// How many frames a second actually reach the canvas, per state. This is the number
// the CPU cost is made of: a skipped frame costs a signature comparison, a drawn one
// costs a software rasterise plus a recomposite of a transparent always-on-top window.
async function fps(windows) {
  const [profileId, wins] = [...windows.entries()][0];
  const win = wins[0];

  // The window has to be genuinely on screen or the numbers are meaningless: a hidden
  // page is clamped by Chromium to 2 timer ticks a second, which reads as a wonderfully
  // cheap pet and measures nothing. `showInactive()` alone does not survive — the next
  // 400ms poll sees no sessions for this profile and hides it straight back. So give it
  // a session to believe in.
  const fake = path.join(STATE_DIR, profileId, 'selftest-fps.json');
  fs.writeFileSync(fake, JSON.stringify({
    profile: profileId, session_id: 'selftest-fps', state: 'idle',
    event: 'Stop', tool: '', message: '', cwd: '/tmp/selftest', pid: '1',
  }) + '\n');
  await sleep(1200);
  console.log(`[fps] window visible: ${win.isVisible()}`);

  const states = [
    ['idle (dawdling)', { status: 'idle', sessions: 1 }],
    ['working', { status: 'working', sessions: 1 }],
    ['waiting on a prompt', { status: 'waiting', sessions: 1, message: 'Needs permission for Bash' }],
  ];

  for (const [label, state] of states) {
    await win.webContents.executeJavaScript(`window.__clawdSetState(${JSON.stringify(state)})`);
    await sleep(800); // let it settle into the state before counting
    const a = await look(win);
    await sleep(6000);
    const b = await look(win);
    console.log(
      `[fps] ${label.padEnd(22)} ${((b.draws - a.draws) / 6).toFixed(1)} draws/sec ` +
      `of ${((b.ticks - a.ticks) / 6).toFixed(1)} ticks/sec` +
      `  (hidden=${b.pageHidden} ${b.visibility}, visible=${win.isVisible()})`);
  }

  // asleep: force it rather than waiting out the 45s idle timer. Order matters — while
  // the status is still `waiting` the step loop refreshes lastBusy on every frame, so
  // winding the clock back does nothing until he is idle again.
  await win.webContents.executeJavaScript('window.__clawdSetState({status:"idle",sessions:1})');
  await sleep(400);
  await win.webContents.executeJavaScript('pet.lastBusy = performance.now() - 60000');
  await sleep(1200);
  const a = await look(win);
  await sleep(6000);
  const after = await look(win);
  console.log(
    `[fps] ${'asleep'.padEnd(22)} ${((after.draws - a.draws) / 6).toFixed(1)} draws/sec ` +
    `of ${((after.ticks - a.ticks) / 6).toFixed(1)} ticks/sec  (asleep=${after.asleep})`);

  fs.unlinkSync(fake);
}

async function run(windows, { applyDrag, loadPositions, stopDragTimer }) {
  if (process.env.CLAWD_SELFTEST === 'fps') return fps(windows);

  for (const [, wins] of windows) {
    for (const w of wins) {
      w.webContents.on('console-message', (_e, _lvl, msg, line, src) => {
        if (/Security Warning/.test(msg)) return;
        console.log(`[renderer] ${msg}  (${src}:${line})`);
      });
    }
  }

  await sleep(2500); // let the pets settle into a walk

  for (const [profileId, wins] of windows) {
    const win = wins[0];
    if (!win || win.isDestroyed()) continue;

    console.log(`\n[selftest] --- ${profileId} ---`);
    // An account with no live sessions is hidden, and macOS drags a *hidden* window
    // back on screen behind your back (verified: x=-188 became x=0 within 400ms, while
    // a visible window at the same spot stayed put). Nobody can drag a pet they can't
    // see, so show him first rather than testing a state that can't happen.
    if (!win.isVisible()) win.showInactive();
    await sleep(300);
    const before = win.getBounds();
    const { box } = await look(win);
    const cx = box.x + box.w / 2;
    const cy = box.y + box.h / 2;

    // 1. cursor on the crab -> the window stops being click-through
    move(win, cx, cy);
    await sleep(200);
    check('cursor on the crab makes the window solid', (await look(win)).interactive, true);

    // 2. and off it -> handed straight back, so clicks fall through again
    move(win, 5, 5);
    await sleep(200);
    check('cursor off the crab restores click-through', (await look(win)).interactive, false);

    // 3. a click on empty strip must not grab anything
    click(win, 'mouseDown', 5, 5);
    click(win, 'mouseUp', 5, 5);
    await sleep(150);
    check('clicking empty strip does not pick him up', (await look(win)).held, false);

    // 4. pick him up
    move(win, cx, cy);
    await sleep(150);
    click(win, 'mouseDown', cx, cy);
    await sleep(150);
    check('mousedown on the crab picks him up', (await look(win)).held, true);

    // 5. carry him: pretend the cursor moved 200 left and 60 up.
    //    The live drag timer has to be stopped first or it re-reads the *real* cursor
    //    16ms later and snaps the window straight back — which is exactly what it is
    //    supposed to do, and exactly what makes a fabricated cursor untestable.
    stopDragTimer(win);
    const grabbed = win.getBounds();
    // The grab offset was taken from the *real* cursor at mousedown, not the synthetic
    // one, so fabricated positions have to be expressed relative to it. Reconstruct the
    // cursor position that corresponds to where the window is sitting right now.
    const { grabX, grabY } = win.__clawd.drag;
    const at = (dx, dy) => ({ x: grabbed.x + grabX + dx, y: grabbed.y + grabY + dy });

    applyDrag(win, at(-200, -60));
    await sleep(120);
    const moved = win.getBounds();
    check('window follows the cursor', [moved.x - before.x, moved.y - before.y], [-200, -60]);

    // 6. and shove him far off the bottom right — the clamp has to keep a grabbable
    //    sliver on screen or he is gone for good
    applyDrag(win, { x: 99999, y: 99999 });
    await sleep(120);
    const shoved = win.getBounds();
    const d = require('electron').screen.getPrimaryDisplay().bounds;
    check('clamped: a grabbable sliver stays on screen',
      [shoved.x <= d.x + d.width - 80, shoved.y <= d.y + d.height - 80], [true, true]);

    // 7. back to where the drag left him, then drop
    applyDrag(win, at(-200, -60));
    await sleep(120);
    click(win, 'mouseUp', cx, cy);
    await sleep(300);
    check('mouseup drops him', (await look(win)).held, false);

    const landed = win.getBounds();
    const saved = loadPositions()[`${profileId}@${win.__clawd.displayId}`];
    check('position remembered on drop', saved, { x: landed.x, y: landed.y });

    move(win, 5, 5);
    await sleep(100);
  }

  console.log(failures ? `\n[selftest] ${failures} FAILURES\n` : '\n[selftest] all passed\n');
}

module.exports = { run };
