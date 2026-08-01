# Clawd Desktop

A pixel crab that walks the strip above your dock and reacts to your live Claude Code
sessions. He speeds up when Claude is working, sleeps when it's quiet, cheers when a long
task finishes — and stops dead with a `!` over his head when a session is sitting on a
permission prompt you haven't noticed.

Because the actual problem is this: you give Claude a long job, switch to something else,
come back eleven minutes later and find it stopped after forty seconds waiting for you to
say yes.

macOS · Electron · no network access · reads no transcripts.

## Install

Paste this into Claude Code:

> Install Clawd Desktop for me: clone https://github.com/Kaavya-mofsl/clawd into
> `~/clawd` and follow the steps in its `INSTALL.md`.

It will clone, install, add the hooks to `~/.claude/settings.json` (backing it up first)
and start the app. One step at the end is yours — adding it to Login Items needs System
Settings, which an agent can't drive.

Or do it by hand:

```bash
git clone https://github.com/Kaavya-mofsl/clawd.git ~/clawd
cd ~/clawd
npm install
npm run install-hooks
npm start
```

Then **start a new Claude Code session** — hooks are read at session start, so the one
you're in right now can't see them, and nothing appears until you open a fresh one.
Full detail, including uninstall, in [INSTALL.md](INSTALL.md).

---

## How it hangs together

```
Claude Code session
      │  hooks (SessionStart, PreToolUse, Notification, Stop, …)
      ▼
hooks/clawd-hook.sh          pure bash, no deps, ~14ms over a bare fork
      │  writes one small JSON file per session
      ▼
~/.clawd/state/<profile>/<session-id>.json
      │  polled every 400ms
      ▼
Electron app  →  transparent click-through window above the dock
```

The pet never reads your transcripts — only which account, which state, which tool, and
the notification text.

## Two accounts, two pets

Skip this unless you run two Claude accounts side by side. One account is the default and
needs no configuration at all.

The common way to run a second account isn't a second Claude Code config — it's the same
`/Applications/Claude.app` launched with `--user-data-dir=~/.claude-instances/account2`
(often wrapped in a one-line AppleScript app). That splits the Electron profile — login,
chat list — but **both accounts still share `~/.claude/settings.json` and
`~/.claude/projects`**.

So there is one shared hook script, and it works out which account fired it by walking the
process tree up to the Electron root and reading its `--user-data-dir`:

```
bash (hook)
  └─ claude --output-format stream-json …
      └─ Claude.app/Contents/Helpers/disclaimer
          └─ /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=…/account2
```

No `--user-data-dir` → `account1`, and that path stops before touching the disk, so a
single-account setup never pays for any of this. The result is cached per session, so the
`ps` walk happens once, not on every tool call.

To add the second pet, copy `config.local.example.json` to `config.local.json`, set `match`
to any distinctive substring of that account's `--user-data-dir`, and re-run
`npm run install-hooks` — the installer flattens the profile list into
`~/.clawd/profiles.map`, which is the only form the hook can read without forking a JSON
parser on every tool call.

**Account detection is therefore coupled to how the second instance is launched.** Change
the path in that wrapper and `match` has to change with it.

## States

| Pet | When |
|---|---|
| Walks slowly, dawdles, blinks | session open, idle |
| Walks faster, quick steps | Claude is working (tool calls) |
| Stops, wide eyes, `!`, speech bubble | unanswered permission prompt |
| Hops with a green ✓ | just finished a turn that took a while |
| Sleeps with `z`'s | nothing has happened for 45s |
| Hidden | no live sessions for that account |
| Stops dead, lifts off the ground | you're holding him — see *Moving the pets* |

## Moving the pets

Grab a crab with the cursor and drag him wherever you want. He stays there, per display,
across restarts. `Forget dragged positions` in the tray menu puts both back above the dock.

Worth knowing if you run two pets: the second lane sits at `leftOffset + laneGap` = 482px,
which on a 1280px laptop is **mid-screen**, right where you're working.

The mechanics, since "make a click-through window draggable" is a contradiction:

```
window is click-through          setIgnoreMouseEvents(true, {forward: true})
        │                        clicks pass through, but mousemove still arrives here
        ▼
cursor enters the sprite's box   renderer asks main for the mouse back
        │                        the window is solid for a 60x40 patch, and only then
        ▼
mousedown                        main records the grab offset and starts following
        │                        screen.getCursorScreenPoint() every 16ms
        ▼
mouseup                          position saved to ~/.clawd/positions.json
```

Two traps worth recording:

- **Don't drag with the mouse event's `screenX`.** It's relative to a window that is itself
  being moved out from under the cursor, so the reading feeds back into itself. Measured:
  dragged left, the window bolted 507px to the *right*. `getCursorScreenPoint()` can't chase
  its own tail.
- **macOS quietly moves hidden windows back on screen.** A hidden window placed at x=-188 was
  at x=0 within 400ms; a visible one at the same spot stayed put indefinitely. So a pet parked
  half off the left edge crept back into view every time his session ended. The saved position
  is reasserted on re-show.

The pet freezes while the cursor is on him, otherwise he'd stroll out from under it.

## When a task finishes

Claude ending a turn is the `Stop` hook — which fires for one-line answers too, so a "done"
ping on every one of those would be worse than useless. Only turns longer than
`doneMinWorkMs` (20s) are announced: *"Claude · my-project — Finished — 2m 14s"*, plus a ✓
over the pet's head for five seconds.

`SubagentStop` deliberately doesn't count. It writes an idle state mid-turn whenever a
subagent returns, so counting it would mean two or three "done" pings for one request. The
elapsed time still runs from the start of the whole turn.

Set `behavior.notifyOnDone` to `false` to turn this off.

## How a permission prompt is detected

Not the way you'd expect. The docs say the `Notification` hook fires when Claude needs
permission — **in the desktop app it does not.** Measured directly: a prompt sat unanswered
for 46 seconds and no `Notification` event ever arrived. Only `PreToolUse` did.

So the prompt is inferred from the gap. `PreToolUse` fires, `PostToolUse` never follows:

```
PreToolUse ──────── 4s (promptSuspectMs) ────────▶ probably waiting on you
     └─ PostToolUse arrives first? just a normal tool call
```

**How long a gap has to be depends on the tool.** The first version of this said "every tool
except `Bash` finishes in milliseconds", which is wrong, and it was the single biggest source
of nudges with no prompt behind them. `Task` runs a subagent for minutes. `WebFetch` and
`WebSearch` are network calls. Every `mcp__*` tool is a round trip to a server — Apollo,
Gmail, Supabase, a browser — and those routinely take longer than four seconds while working
perfectly. All of them were being reported as unanswered prompts.

So `FAST_TOOLS` in `src/state.js` is an allowlist, not a denylist:

| | fuse |
|---|---|
| `Read`, `Edit`, `Write`, `Glob`, `Grep`, `TodoWrite`, … | `promptSuspectMs` (4s) |
| `Bash` | 4s, *and* its shell must be gone — see below |
| everything else, including anything new | `slowToolSuspectMs` (90s) |

A tool nobody has classified is assumed slow. When a future Claude release adds one, that
costs a late notification rather than a wrong one.

`Bash` is the one tool that legitimately runs for minutes *and* can be checked, so it gets a
second test: is its shell still alive?

```
ps -axww -o ppid=,command=   →  any child of the `claude` pid running a shell snapshot?
                                yes → still running, stay quiet
                                no  → nothing is executing, so it's a prompt
```

The hook records the `claude` pid for this (`"pid"` in the state file) by walking its own
process ancestry. `ps` is only run when a session is already past `promptSuspectMs`, and if
`ps` can't be read the check refuses to guess — a slow build must never be reported as a
prompt.

Verified in both directions: a 20-second `sleep` stayed `working` the whole way, and a real
prompt flipped to `waiting [inferred]` and back the instant it was answered.

**Tuning.** Between `PreToolUse` firing and the shell actually spawning there is a window
where nothing is running yet, which looks identical to a prompt. Normally that's
milliseconds; on a badly loaded machine it was measured at ~10s. If you see the bubble flash
during heavy builds, raise `promptSuspectMs`.

### The other three ways it used to cry wolf

A wrong nudge costs far more than a missed one — you stop what you're doing, walk over, and
find nothing. Three more causes, all fixed:

- **The idle notification.** The `Notification` hook never fires for permission prompts here,
  but it *does* fire for "Claude is waiting for your input" after a session sits quiet. The
  hook can't tell them apart without parsing, so it marked every notification as a prompt.
  Only messages mentioning permission count now.
- **Wreckage.** Press Esc mid-tool, or kill a session, and its last `PreToolUse` dangles
  forever — a pet insisting on a prompt that no longer exists, renagging every minute until
  the session went stale half an hour later. An *inferred* prompt older than `inferredMaxMs`
  (5 min) is now treated as debris rather than a request.
- **Sending you to the wrong window.** With several sessions open across two accounts,
  "Claude needs you" gives you no way to know which one. The frontmost window is usually the
  wrong one, and a correct alert that sends you somewhere empty is indistinguishable from a
  false one. The project folder is now in the notification title and in the pet's bubble.

Notifications also stop after `maxNags` (3) per prompt. The bubble stays up — that one is
free, and it's attached to the pet you can see.

`CLAWD_TRACE=1 npm start` narrates each decision to stdout, and every notification is logged
whether or not you saw it.

## Config

Defaults live in `config.json`. **Put your own settings in `config.local.json`** beside it
(start from `config.local.example.json`) — it's git-ignored and wins key by key, so
`git pull` never fights you for the file.

- `strip.width` / `height` — the walking area. Anchored to the bottom-left of **every**
  display, using `workArea` so it tracks the dock's real size and position automatically.
- `strip.laneGap` — horizontal spacing between the two pets (`lane: 0` and `lane: 1`).
- `behavior.promptSuspectMs` — how long a `PreToolUse` may go unanswered before it's treated
  as a permission prompt. Default 4s. Applies to instant tools only. See the section above.
- `behavior.slowToolSuspectMs` — the same fuse for tools that legitimately run long
  (`Task`, `WebFetch`, `WebSearch`, every `mcp__*`). Default 90s. Lower it for faster alerts
  and more false ones.
- `behavior.inferredMaxMs` — give up on an inferred prompt this old. Default 5 min.
- `behavior.maxNags` — notifications per prompt before it shuts up. Default 3.
- `behavior.notifyOnDone` / `doneMinWorkMs` — announce a finished turn, if it took at least
  this long. Default on, 20s.
- `behavior.fps` / `fpsAsleep` — animation rate. The lever if the machine needs CPU back;
  see *What it costs to run*.
- `behavior.nagDelayMs` — how long a prompt sits unanswered before a system notification
  fires. `0` = instant, `-1` = never (bubble only). Default 12s. Counted from *detection*,
  so the notification lands roughly `promptSuspectMs + nagDelayMs` ≈ 16s after the prompt
  actually appeared.
- `behavior.renagMs` — how often it re-nudges while still unanswered. Default 60s.
- `profiles[].color` — each pet's shell colour.

Restart the app after editing (`Reposition pets` in the tray menu re-reads geometry only).

## Displays and Spaces

- **Spaces** — one window per display, `setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true})`,
  so the pet follows you as you swipe. Verified working on regular Spaces.
- **Native full-screen apps** — this is the flakiest part on macOS and varies by version. If
  the pet doesn't show over a full-screen window, the system notification still reaches you.
- **Multiple monitors** — one pet per profile per display, rebuilt automatically on
  `display-added` / `display-removed`.

## Tray menu

The app has no dock icon; it lives in the menu bar as 🦀.

Mute notifications · Test nudge · Reposition pets · Forget dragged positions ·
Open state folder · Quit

## Hooks

```bash
npm run install-hooks       # merges into ~/.claude/settings.json, backs it up first
npm run uninstall-hooks     # removes only Clawd's entries
npm run state               # prints what the pet currently sees
npm run state -- --watch    # ...and keeps printing, every 2s
```

`npm run state` runs the *same* code the pet does (`src/state.js`), inferred prompts and
all, so what it prints is what the pet believes. `--watch` is how the detection above was
verified.

Set `touch ~/.clawd/debug` to log every hook event and its full payload to
`~/.clawd/events.log`; delete the file to stop. Off by default — it's one builtin test.

The installer is idempotent and preserves existing hooks (e.g. `strategic-compact`). Every
run writes `~/.claude/settings.json.clawd-backup-<timestamp>`.

### Cost

The hook runs on every tool call, in both accounts, so it is written to stay close to the
cost of simply starting a shell. Absolute timings on this Mac swing wildly with load (a bare
`bash -c "exit 0"` measured anywhere from 13ms to 33ms), so what matters is the overhead
*above* that floor:

| | over a bare fork |
|---|---|
| small `PreToolUse` payload | ~+14ms |
| 40KB `PostToolUse` payload | ~+16ms |

Payload size stopped mattering once three things were fixed, each worth more than it looks:

- **`payload=$(</dev/stdin)` instead of `read -r -d ''`.** Bash consumes a large payload a
  byte at a time; on 40KB that alone was **+105ms**. Reading to EOF also matters — reading
  only a prefix would be faster still, but it hands Claude an EPIPE on the write side.
- **`printf -v` instead of `$(field …)`.** Command substitution forks a subshell; four
  fields meant four forks, which cost more than all the string handling combined.
- **Scan `${payload:0:1200}`, not the payload.** Every key we read is top-level and precedes
  the `tool_input` / `tool_response` blobs, so there is no reason to regex 40KB of tool output.

The state file is also written in place rather than tmp + `mv`, since `mv` is another fork
(~11ms). That trades atomicity for speed, so the app keeps the last good value per session
and reuses it if a poll catches a file mid-write.

If it ever still feels like drag, drop `PostToolUse` from the `EVENTS` list in
`scripts/install-hooks.js` and re-run. Note this disables prompt detection — the inference
depends on noticing that `PostToolUse` *didn't* arrive.

## What it costs to run

This was built on a 2015 dual-core MacBook Pro with 8GB of RAM, running two Claude
accounts — already the expensive thing on the machine — so the budget was real. Steady state, one account working and one
with no sessions: **~8% of a core and ~270MB**, against ~58% and ~1.6GB for the two Claude
apps themselves.

It started at **37%**. What the cost is actually made of is the number of frames that reach
the canvas — a skipped frame costs one string comparison, a drawn one costs a software
rasterise plus a recomposite of a transparent always-on-top window. Measured per state
(`CLAWD_SELFTEST=fps npm start`):

| pet is | draws/sec | of ticks/sec |
|---|---|---|
| idle, dawdling | 8.3 | 15 |
| working | 11.8 | 15 |
| waiting on a prompt | 14.8 | 15 |
| asleep | 3.3 | 5 |
| hidden | 0 | 0 |

Four things got it there:

- **The frame loop ran at 60fps via `requestAnimationFrame`.** With hardware acceleration
  off, every one of those frames is a software rasterise. A 12×8 sprite moving at 26px/s
  advances 0.4px per frame, so most of that work redrew an identical image. Now a paced
  `setTimeout` at 15fps awake, 5 asleep — `behavior.fps`, if you want it cheaper still.
- **Nothing skipped redundant frames.** Frames are compared by a signature of what the
  image actually depends on. Note `waiting` skips nothing: the `!` pulses every frame. That
  is the one state where the animation *is* the message, so it stays.
- **Nothing was snapped to the pixel grid.** The sprite draws in 5px blocks but moved in
  fractions of one, so the rounded position changed 26 times a second and the frame skip
  above never skipped anything while he walked. Snapping the drawn position to the same
  grid the art uses cut idle draws roughly in half — and each step now moves him exactly
  one block, on the beat of the leg swap, which reads better rather than worse.
- **A hidden window kept animating.** Main now tells the renderer it's `offscreen` and the
  loop stops dead. Deliberately not `document.hidden` — on macOS that also means "occluded",
  which would freeze a pet that's plainly on screen.

An earlier version of this file claimed Electron doesn't throttle hidden windows at all.
That was measured against the old `requestAnimationFrame` loop, and it doesn't generalise:
a hidden window running the current `setTimeout` loop is clamped by Chromium to **2 ticks
per second**, the same background-tab treatment. The explicit `offscreen` signal is still
worth having — it takes that to zero and it doesn't depend on Chromium's policy — but the
old blanket claim was wrong.

Separately, `ps -axww` over ~400 processes costs ~96ms, nearly all kernel time, and the
`Bash` prompt check was running it on every 400ms poll for both profiles — about half a
core, burned precisely while you were waiting on the long build that triggered it. It's
now cached for 1.5s, with a fresh re-check before ever declaring a prompt (see
`SHELL_CACHE_MS` in `src/state.js`).

Absolute percentages move with machine load, same caveat as the hook timings — treat the
shape as the finding, not the digits.

## Self-tests

```bash
CLAWD_SELFTEST=drag npm start    # pick-up, drag, clamp, saved position
CLAWD_SELFTEST=fps  npm start    # draws/sec per state
```

`drag` injects mouse events at the renderer — the same place a forwarded mousemove lands —
so the hit test, the click-through handshake and the drop are all genuinely exercised. The
drag arithmetic is driven through `applyDrag` with fabricated cursor points, because the real
thing reads the OS cursor and no synthetic input moves a real mouse.

Two things still need a human: that macOS forwards live cursor movement over a click-through
window at all, and that the crab looks right being carried.

Both modes need the pet **visible**, which is why `fps` writes itself a fake session first: a
hidden page is clamped to 2 ticks/sec, which reads as a wonderfully cheap pet and measures
nothing at all.

## Known limitations

- **The nag can't tell whether you're already looking at that window.** Both accounts are the
  same app bundle, so "is Claude frontmost" can't distinguish account 1 from account 2 without
  Accessibility permission. v1 uses a plain 12s delay instead. If it nags while you're staring
  right at the prompt, raise `nagDelayMs`.
- **Prompt detection is inferred, not reported.** See the section above. It is a heuristic,
  and it is coupled to Claude Code running each `Bash` call as a child shell sourcing a
  snapshot file. If a future version changes that, the `Bash` exemption in `src/state.js`
  stops exempting and long commands will look like prompts.
- **A prompt for a slow tool takes 90s to notice.** That's the deliberate trade in
  `slowToolSuspectMs`: an MCP call that is working and one that is waiting on you look
  identical from outside, and being wrong is the more expensive mistake.
- **Sprite is placeholder art** — a 12×8 pixel grid in `src/renderer/pet.js` (`BODY` / `LEGS`).
  Edit the strings to reshape him.
- **Software rendering.** Hardware acceleration is off: transparent always-on-top windows on
  macOS 12 flood the log with EGL driver errors and can show compositing artifacts. The canvas
  is tiny so it costs nothing.
- **Crashed sessions** leave a stale state file; anything not touched for 30 minutes
  (`behavior.sessionStaleMs`) is ignored, and `SessionEnd` cleans up normally.

## Iterating on the sprite

There's a static preview so you can work on the art without launching Electron:

```bash
npm run preview
```

Then open `http://localhost:4176/?demo=1&color=%23D97757&scale=7` — `demo=1` cycles the
states. `window.__clawdSetState({status:'waiting', message:'…'})` drives it directly from
the console.

## Start at login

Clawd does not survive a reboot on its own. `clawd.command` in this folder is the login
wrapper — add it under System Settings → General → Login Items → `+`.

It refuses to start a second instance, which matters more than it sounds: macOS re-runs
login items on fast user switching, and two Clawds put two pets per account on the same
pixels. The guard matches the *install path*, because Electron's real argv is

```
…/clawd-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
```

so an obvious-looking pattern like `electron .*clawd-desktop` matches nothing and the guard
silently does the thing it exists to prevent. Verified both ways: running → no second copy,
not running → exactly one.

## When the pets appear

Two separate conditions, and only the second is about Claude:

1. **Clawd is running.** Login item above, or `npm start`.
2. **That account has a live Claude Code session.** The pet appears on `SessionStart`, so
   it's opening a project/conversation that summons it — launching the Claude app alone
   doesn't. It leaves on `SessionEnd`, or after `sessionStaleMs` (30 min) of total silence
   from a session that died without cleaning up.

## What it can see

Since this installs hooks into your Claude config, the honest inventory. Each hook writes
one small JSON file, and it holds exactly eight fields:

```json
{"profile":"account1","session_id":"…","state":"working","event":"PreToolUse",
 "tool":"Read","message":"","cwd":"/Users/you/code/my-project","pid":"41207"}
```

Your prompts, Claude's replies, file contents and tool output never leave the payload the
hook reads — it extracts those fields from the first 1200 bytes and drops the rest. `message`
is populated only for `Notification` events, which is Claude's own notification text.

The app makes no network requests of any kind, and there is no telemetry. It's a canvas, a
400ms timer and a folder of small files.

## Building on it

The interesting parts to steal, if you're writing something else that watches Claude Code:

- `hooks/clawd-hook.sh` — how to make a hook that runs on every tool call cost roughly
  what starting a shell costs, and the three things that turned out to dominate.
- `src/state.js` — inferring a permission prompt when the `Notification` hook won't tell you.
- `scripts/show-state.js` — the same module the app uses, on a terminal, so the heuristic
  is inspectable rather than mysterious.

## License

MIT — see [LICENSE](LICENSE). Built with Claude Code, which is also the point of it.
