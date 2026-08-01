// pet.js — draws and animates Clawd on a transparent canvas.
//
// Runs inside Electron (state arrives over IPC via window.clawd) and also plain
// in a browser, where it falls back to a scripted demo so the art can be checked
// without launching the app: index.html?demo=1

const params = new URLSearchParams(location.search);
const COLOR = params.get('color') || '#D97757';
const LABEL = params.get('label') || 'Claude';
const SCALE = Number(params.get('scale') || 5);
const SPEED = Number(params.get('speed') || 26); // px per second
const FPS_AWAKE = Number(params.get('fps') || 15);
const FPS_ASLEEP = Number(params.get('fpsAsleep') || 5);

const canvas = document.getElementById('pet');
const ctx = canvas.getContext('2d');
const bubbleEl = document.getElementById('bubble');
const bubbleTextEl = document.getElementById('bubble-text');
const tailEl = bubbleEl.querySelector('.tail');

// ------------------------------------------------------------------ sprite
// 'X' = shell, '.' = transparent. Eyes are drawn separately so they can blink.

const BODY = [
  '...XXXXXX...',
  '..XXXXXXXX..',
  '.XXXXXXXXXX.',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
  'XXXXXXXXXXXX',
];

// Row 1 is the leg stubs (always all four), row 2 is the feet — alternating them
// reads as a walk cycle without needing more frames.
const LEGS = [
  ['.X..X..X..X.', '.X.....X....'],
  ['.X..X..X..X.', '....X.....X.'],
];

const SPRITE_W = BODY[0].length;      // 12
const SPRITE_H = BODY.length + 2;     // 8
const EYE_ROW = 3;
const EYE_COLS = [3, 8];

const PX = SCALE;
const PET_W = SPRITE_W * PX;
const PET_H = SPRITE_H * PX;

// --------------------------------------------------------------- animation

const pet = {
  x: 40,
  dir: 1,          // 1 = right, -1 = left
  status: 'idle',  // idle | working | waiting | absent
  label: LABEL,
  message: '',
  folder: '',
  sessions: 0,
  // motion
  moving: true,
  pauseUntil: 0,
  legFrame: 0,
  legTimer: 0,
  bob: 0,
  // eyes
  blinkUntil: 0,
  nextBlink: 0,
  // sleep
  lastBusy: performance.now(),
  asleep: false,
  zs: [],
  // alert
  alertBounce: 0,
  // pick-up
  hovered: false,
  held: false,
  lift: 0,
  // finished a turn
  cheerUntil: 0,
  hop: 0,
};

const CHEER_MS = 5000;

let W = 0;
let H = 0;

function resize() {
  const dpr = window.devicePixelRatio || 1;
  W = window.innerWidth;
  H = window.innerHeight;
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
}

window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ colors

function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, ((n >> 16) & 255) + amount));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 255) + amount));
  const b = Math.max(0, Math.min(255, (n & 255) + amount));
  return `rgb(${r},${g},${b})`;
}

const SHELL = COLOR;
const SHELL_DARK = shade(COLOR, -34);
const INK = '#1c1917';

// ------------------------------------------------------------------- draw

function drawPixel(col, row, x0, y0, flip, color) {
  const c = flip ? SPRITE_W - 1 - col : col;
  ctx.fillStyle = color;
  ctx.fillRect(x0 + c * PX, y0 + row * PX, PX, PX);
}

// The sprite is drawn in PX-sized blocks, so snapping the drawn position to that same
// grid is just what pixel art does — the crab steps one block at a time instead of
// sliding along in fractions of one. It also collapses the redraw rate: unsnapped, a
// pet walking at 26px/s changes its rounded x 26 times a second, so the frame skip
// below never skipped a single frame while he was moving. Snapped, the image changes
// about 5 times a second — the same beat as the leg swap, so each step now moves him
// exactly one block, which reads better rather than worse.
function drawX() {
  return Math.round(pet.x / PX) * PX;
}

function baseline() {
  return (
    H - PET_H - 6 + Math.round(pet.bob) + Math.round(pet.alertBounce)
    - Math.round(pet.lift) - Math.round(pet.hop)
  );
}

function drawClawd(t) {
  const baseY = baseline();
  const x0 = drawX();
  const flip = pet.dir < 0;

  // body
  for (let r = 0; r < BODY.length; r++) {
    for (let c = 0; c < SPRITE_W; c++) {
      if (BODY[r][c] !== 'X') continue;
      // bottom two body rows slightly darker for a bit of depth
      drawPixel(c, r, x0, baseY, flip, r >= BODY.length - 2 ? SHELL_DARK : SHELL);
    }
  }

  // legs
  const legs = LEGS[pet.legFrame % LEGS.length];
  for (let r = 0; r < legs.length; r++) {
    for (let c = 0; c < SPRITE_W; c++) {
      if (legs[r][c] !== 'X') continue;
      drawPixel(c, BODY.length + r, x0, baseY, flip, SHELL_DARK);
    }
  }

  // eyes
  const blinking = t < pet.blinkUntil;
  const closed = pet.asleep || blinking;
  const wide = pet.status === 'waiting';

  for (const col of EYE_COLS) {
    const c = flip ? SPRITE_W - 1 - col : col;
    const ex = x0 + c * PX;
    const ey = baseY + EYE_ROW * PX;

    ctx.fillStyle = INK;
    if (closed) {
      ctx.fillRect(ex, ey + PX * 0.45, PX, Math.max(1, PX * 0.28));
    } else if (wide) {
      ctx.fillRect(ex - PX * 0.15, ey - PX * 0.25, PX * 1.3, PX * 1.45);
    } else {
      ctx.fillRect(ex, ey, PX, PX);
    }
  }

  // sleep z's
  if (pet.asleep) {
    ctx.fillStyle = 'rgba(245,245,244,0.75)';
    for (const z of pet.zs) {
      ctx.font = `${Math.round(z.size)}px -apple-system, system-ui, sans-serif`;
      ctx.globalAlpha = z.life;
      ctx.fillText('z', x0 + PET_W * 0.8 + z.dx, baseY - z.dy);
      ctx.globalAlpha = 1;
    }
  }

  // just finished a long turn: a ✓ over the head, fading out
  if (t < pet.cheerUntil) {
    const left = (pet.cheerUntil - t) / CHEER_MS;
    ctx.globalAlpha = Math.min(1, left * 3); // full for most of it, then fades
    ctx.strokeStyle = '#4ade80';
    ctx.lineWidth = Math.max(2, PX * 0.5);
    ctx.lineCap = 'square';
    const tx = x0 + PET_W / 2;
    const ty = baseY - PX * 3.2;
    ctx.beginPath();
    ctx.moveTo(tx - PX * 0.9, ty + PX * 0.5);
    ctx.lineTo(tx - PX * 0.2, ty + PX * 1.2);
    ctx.lineTo(tx + PX * 1.0, ty - PX * 0.6);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // waiting: a little exclamation over the head
  if (pet.status === 'waiting') {
    const pulse = 0.55 + 0.45 * Math.sin(t / 140);
    ctx.globalAlpha = pulse;
    ctx.fillStyle = '#fbbf24';
    const bx = x0 + PET_W / 2 - PX * 0.35;
    const by = baseY - PX * 3.6;
    ctx.fillRect(bx, by, PX * 0.7, PX * 1.9);
    ctx.fillRect(bx, by + PX * 2.4, PX * 0.7, PX * 0.7);
    ctx.globalAlpha = 1;
  }
}

// ------------------------------------------------------------------ bubble

let bubbleShownFor = '';

function updateBubble() {
  const shouldShow = pet.status === 'waiting';
  const text = shouldShow ? bubbleMessage() : '';

  if (text !== bubbleShownFor) {
    bubbleShownFor = text;
    if (text) {
      bubbleTextEl.textContent = text;
      bubbleEl.hidden = false;
      requestAnimationFrame(() => bubbleEl.classList.add('show'));
    } else {
      bubbleEl.classList.remove('show');
      setTimeout(() => {
        if (!bubbleShownFor) bubbleEl.hidden = true;
      }, 200);
    }
  }

  if (!bubbleEl.hidden) {
    // The bubble is centred on the pet, so keep half of it inside the strip or it
    // clips at the edges. Sits clear of the alert mark above the pet's head.
    const width = bubbleEl.offsetWidth;
    const half = width / 2;
    const cx = drawX() + PET_W / 2;
    const clamped = Math.max(half + 6, Math.min(W - half - 6, cx));
    bubbleEl.style.left = `${clamped}px`;
    bubbleEl.style.bottom = `${PET_H + 38}px`;

    // Once clamped, the bubble is no longer centred on the pet, so walk the tail
    // over to keep it pointing at him.
    const tailX = Math.max(12, Math.min(width - 12, cx - (clamped - half)));
    tailEl.style.left = `${tailX}px`;
  }
}

function bubbleMessage() {
  const base = pet.message && pet.message.trim() ? pet.message.trim() : 'Needs your permission';
  // Which project, then which account. With several sessions open, "needs permission"
  // on its own sends you to whichever window is frontmost — which is usually the wrong
  // one, and a correct alert that sends you to the wrong window looks like a false one.
  const tags = [];
  if (pet.folder) tags.push(pet.folder);
  if (pet.sessions > 1) tags.push(pet.label);
  const suffix = tags.length ? `\n(${tags.join(' · ')})` : '';
  return base.length > 110 ? base.slice(0, 107) + '…' + suffix : base + suffix;
}

// -------------------------------------------------------------------- tick
//
// Deliberately NOT requestAnimationFrame. rAF pins this to the display's 60Hz, and
// with hardware acceleration off every one of those frames is a software rasterise
// on the CPU — two windows of it measured ~27% of a core, on a machine already
// running two Claude accounts. A 12x8 sprite crawling at 26px/s cannot use 60Hz:
// it advances 0.4px per frame, well under one 5px pixel-art block, so most of that
// work redrew an identical image.
//
// setTimeout also lets the rate drop when nothing is happening, which rAF can't do.
//
// A hidden window is stopped outright, via `offscreen` from main. Electron does NOT
// throttle timers in a hidden BrowserWindow the way Chromium throttles a background
// tab — measured: an account with no sessions, window hidden, still burned ~5% of a
// core animating a pet nobody could see.
//
// Note it is main that says so, not `document.hidden`. On macOS that flag also means
// "occluded", and a pet frozen mid-strip while plainly on screen is a far worse bug
// than the CPU this saves.
// Rates come from config.behavior.fps / fpsAsleep — 15 and 5 by default. Lowering
// them is the one-line lever if the machine ever needs the CPU back.
let last = performance.now();
let lastSig = null;
let running = false;
let draws = 0;   // frames that actually touched the canvas — see CLAWD_SELFTEST=fps
let ticks = 0;   // frames attempted, so a clamped timer can be told from a skipped frame

// Everything the drawn image actually depends on. Drawing rounds to whole pixels and
// picks between discrete leg/eye frames, so two ticks with the same signature produce
// byte-identical output — and touching the canvas is not free: any change forces the
// compositor to re-upload a transparent always-on-top window, which under software
// rendering is the single most expensive thing here. A dawdling idle pet holds one
// signature for seconds at a time and now costs nothing at all.
function visualSignature(t) {
  const eyes = pet.asleep || t < pet.blinkUntil ? 'shut' : pet.status === 'waiting' ? 'wide' : 'open';
  const base = [
    drawX(),
    pet.dir,
    Math.round(pet.bob) + Math.round(pet.alertBounce) - Math.round(pet.lift) - Math.round(pet.hop),
    pet.legFrame % LEGS.length,
    eyes,
    pet.asleep ? 1 : 0,
    pet.status,
    // Not motion, but it's what the bubble renders — a message that changed while the
    // pet stood still would otherwise never be redrawn.
    pet.message,
    pet.folder,
    pet.sessions,
  ];
  // Both of these are continuously animated, so they belong in the signature only
  // when they're on screen — otherwise nothing would ever be skippable.
  if (pet.asleep) {
    base.push(pet.zs.map((z) => `${Math.round(z.dx)},${Math.round(z.dy)},${z.life.toFixed(2)}`).join('|'));
  }
  // One decimal, not two: the `!` pulses between 0.55 and 1.0 alpha, and a step of
  // 0.045 in that is invisible. Two decimals meant a redraw on literally every frame
  // of the one state that also has a bubble on screen.
  if (pet.status === 'waiting') base.push(Math.sin(t / 140).toFixed(1));
  // Quantized so the ✓ fade redraws about four times a second rather than every frame
  // — it is a five-second fade, nobody can see the steps.
  if (t < pet.cheerUntil) base.push(`c${Math.round((pet.cheerUntil - t) / 250)}`);
  return base.join(':');
}

function frame() {
  if (!running) return;

  ticks++;
  const t = performance.now();
  // Clamp generously: at 5fps a real interval is ~200ms, and clamping below that
  // would slow the sleep animation down instead of just absorbing stalls.
  const dt = Math.min(250, t - last);
  last = t;

  step(t, dt);
  releaseIfStuck(t);

  const sig = visualSignature(t);
  if (sig !== lastSig) {
    lastSig = sig;
    draws++;
    ctx.clearRect(0, 0, W, H);
    drawClawd(t);
    updateBubble();
  }

  const fps = pet.asleep && pet.status !== 'waiting' ? FPS_ASLEEP : FPS_AWAKE;
  setTimeout(frame, 1000 / fps);
}

// Driven by `offscreen` from main — the only side that knows whether it hid the
// window. Resetting `last` on resume stops the pet animating through the gap.
function setRunning(on) {
  if (on === running) return;
  running = on;
  if (on) {
    last = performance.now();
    frame();
  }
}

function step(t, dt) {
  // A hop for the first second of the cheer, then he settles and the tick keeps
  // fading. Whether he is walking, idling or asleep is none of this block's business.
  const cheerElapsed = CHEER_MS - (pet.cheerUntil - t);
  pet.hop = t < pet.cheerUntil && cheerElapsed < 1000
    ? Math.abs(Math.sin(cheerElapsed / 150)) * PX * 1.3
    : 0;

  // Held or about to be: stop dead. A crab that strolls out from under the cursor
  // can't be picked up, and the hit box would be chasing him the whole time.
  pet.lift += ((pet.held ? PX * 1.4 : 0) - pet.lift) * 0.3;
  if (pet.held || pet.hovered) {
    if (pet.held) {
      // legs paddling in mid-air
      pet.legTimer += dt;
      if (pet.legTimer > 90) {
        pet.legTimer = 0;
        pet.legFrame++;
      }
    }
    pet.lastBusy = t;
    pet.asleep = false;
    return;
  }

  const busy = pet.status === 'working' || pet.status === 'waiting';
  if (busy) {
    pet.lastBusy = t;
    pet.asleep = false;
  } else if (t - pet.lastBusy > 45000) {
    pet.asleep = true;
  }

  // --- waiting: stop, face forward, bounce
  if (pet.status === 'waiting') {
    pet.alertBounce = -Math.abs(Math.sin(t / 190)) * PX * 1.6;
    pet.bob = 0;
    pet.legFrame = 0;
    return;
  }
  pet.alertBounce += (0 - pet.alertBounce) * 0.2;

  // --- sleeping: no walking, emit z's
  if (pet.asleep) {
    pet.bob = Math.sin(t / 900) * 1.2;
    pet.zs = pet.zs.filter((z) => (z.life -= dt / 2200) > 0);
    pet.zs.forEach((z) => {
      z.dy += dt * 0.012;
      z.dx += dt * 0.004;
    });
    if (pet.zs.length < 3 && Math.random() < dt / 900) {
      pet.zs.push({ dx: 0, dy: PX * 2, size: 9 + Math.random() * 5, life: 1 });
    }
    return;
  }

  // --- blinking
  if (t > pet.nextBlink) {
    pet.blinkUntil = t + 120;
    pet.nextBlink = t + 2200 + Math.random() * 4200;
  }

  // --- walking with occasional pauses
  const speed = pet.status === 'working' ? SPEED * 1.7 : SPEED;

  if (t < pet.pauseUntil) {
    pet.moving = false;
  } else if (!pet.moving) {
    pet.moving = true;
    if (Math.random() < 0.5) pet.dir *= -1;
  }

  if (pet.moving) {
    pet.x += (speed * dt) / 1000 * pet.dir;

    const minX = 0;
    const maxX = W - PET_W;
    if (pet.x <= minX) { pet.x = minX; pet.dir = 1; }
    if (pet.x >= maxX) { pet.x = maxX; pet.dir = -1; }

    // step animation
    pet.legTimer += dt;
    const stepEvery = pet.status === 'working' ? 110 : 190;
    if (pet.legTimer > stepEvery) {
      pet.legTimer = 0;
      pet.legFrame++;
      pet.bob = pet.legFrame % 2 === 0 ? 0 : -1;
    }

    // idle pets dawdle
    if (pet.status === 'idle' && Math.random() < dt / 5200) {
      pet.pauseUntil = t + 700 + Math.random() * 2600;
    }
  } else {
    pet.bob += (0 - pet.bob) * 0.2;
    pet.legFrame = 0;
  }
}

// ------------------------------------------------------------- pick me up
//
// The window is a 460px strip and it is click-through on purpose — anything else
// would swallow clicks meant for the app underneath it. That also makes the crab
// unclickable, so grabbing him works in two beats:
//
//   1. `setIgnoreMouseEvents(true, {forward: true})` in main keeps clicks falling
//      through but still delivers mousemove here. So the renderer can see the cursor
//      cross the sprite's actual box, which is the only part worth being solid.
//   2. On entering that box it asks main for the mouse back; on leaving, it hands it
//      straight back. The window is solid for a 60x40 patch around a crab, and only
//      while you're touching him.
//
// Dragging then moves the *window*, not the pet inside it — the whole strip he patrols
// goes with him, which is the point: the default lane for account 2 lands mid-screen on
// a laptop display, right where you're trying to work.

const GRAB_PAD = 10;
let interactive = false;
let lastMouseAt = 0;

function petBox() {
  const y = baseline();
  return { x: drawX(), y, w: PET_W, h: PET_H };
}

function overPet(x, y) {
  const b = petBox();
  return (
    x >= b.x - GRAB_PAD && x <= b.x + b.w + GRAB_PAD &&
    y >= b.y - GRAB_PAD && y <= b.y + b.h + GRAB_PAD
  );
}

function setInteractive(on) {
  if (on === interactive) return;
  interactive = on;
  pet.hovered = on;
  document.body.style.cursor = on ? 'grab' : 'default';
  window.clawd?.setInteractive?.(on);
}

window.addEventListener('mousemove', (e) => {
  lastMouseAt = performance.now();
  // While held the window is following the cursor, so the pointer stays put relative
  // to it and there is nothing here to update — main is doing the moving.
  if (pet.held) return;
  setInteractive(overPet(e.clientX, e.clientY));
});

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !overPet(e.clientX, e.clientY)) return;
  e.preventDefault();
  pet.held = true;
  document.body.style.cursor = 'grabbing';
  window.clawd?.dragStart?.();
});

function drop() {
  if (!pet.held) return;
  pet.held = false;
  document.body.style.cursor = interactive ? 'grab' : 'default';
  window.clawd?.dragEnd?.();
}

window.addEventListener('mouseup', drop);
// A drag that ends outside the window still has to let go, or the crab stays glued
// to the cursor with no way to release him.
window.addEventListener('blur', drop);
document.addEventListener('mouseleave', () => {
  drop();
  setInteractive(false);
});

// Last resort. If the cursor leaves without a final in-bounds event — a fast flick to
// another display, a Space switch mid-hover — the window would stay solid and quietly
// eat clicks meant for whatever is behind it. That is the worst thing this feature
// could do, so a few seconds of no mouse movement at all releases it; the next twitch
// re-arms it instantly, because forwarding resumes the moment we let go.
function releaseIfStuck(t) {
  if (interactive && !pet.held && t - lastMouseAt > 3000) setInteractive(false);
}

// -------------------------------------------------------------- state feed

function applyState(s) {
  pet.status = s.status || 'idle';
  pet.message = s.message || '';
  pet.sessions = s.sessions || 0;
  pet.label = s.label || LABEL;
  pet.folder = s.cwd ? s.cwd.split('/').filter(Boolean).pop() || '' : '';
  // Absent unless main says otherwise, so the browser preview — which sends no
  // `offscreen` — always animates.
  if (s.offscreen) {
    // The frame loop is about to stop, and with it the stuck-interactive guard.
    drop();
    setInteractive(false);
  }
  setRunning(!s.offscreen);
}

// lets the browser preview drive states directly: __clawdSetState({status:'waiting'})
window.__clawdSetState = applyState;

// Top-level `let`/`const` here are script-scoped, not window properties, so main's
// executeJavaScript can't reach them. This is how the drag self-test looks inside.
// Last, not next to the loop it starts. `frame()` reaches `releaseIfStuck`, which reads
// the pick-up module's `let interactive` — hoisting makes the *function* visible early
// but leaves the binding in its temporal dead zone, so starting the loop any earlier
// throws on the very first frame and the pet never moves at all.
setRunning(true);

window.__clawdDebug = () => ({
  interactive,
  running,
  draws,
  ticks,
  asleep: pet.asleep,
  pageHidden: document.hidden,
  visibility: document.visibilityState,
  held: pet.held,
  hovered: pet.hovered,
  status: pet.status,
  x: drawX(),
  box: petBox(),
});

if (window.clawd?.onState) {
  window.clawd.onState(applyState);
  window.clawd.onCheer?.(() => {
    pet.cheerUntil = performance.now() + CHEER_MS;
    pet.lastBusy = performance.now(); // don't nod off mid-celebration
    pet.asleep = false;
  });
} else if (params.get('demo')) {
  // browser preview: cycle through the states so the art can be reviewed
  const script = [
    { status: 'idle', message: '' },
    { status: 'working', message: '', tool: 'Edit' },
    { status: 'waiting', message: 'Claude needs your permission to run Bash', sessions: 1 },
    { status: 'working', message: '' },
    { status: 'idle', message: '' },
  ];
  let i = 0;
  applyState(script[0]);
  setInterval(() => {
    i = (i + 1) % script.length;
    applyState(script[i]);
  }, 4000);
} else {
  applyState({ status: 'idle' });
}
