// Reading session state and working out what the pet should be doing.
//
// This lives apart from main.js so `npm run state` evaluates the *same* logic the
// pet does — including the inferred-prompt rule, which is subtle enough that it
// needs to be inspectable from a terminal rather than only from inside Electron.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const CLAWD_HOME = process.env.CLAWD_HOME || path.join(os.homedir(), '.clawd');
const STATE_DIR = path.join(CLAWD_HOME, 'state');

// sessionId -> last successfully parsed payload.
// The hook writes state files in place (no atomic rename — see clawd-hook.sh), so a
// poll can land mid-write and see a truncated file. Reusing the last good value keeps
// that from reading as "session vanished", which would flicker the pet off and back on.
// A file that is genuinely gone never reaches here: readdir won't list it.
const lastGood = new Map();

function readProfileSessions(profileId, behavior) {
  const dir = path.join(STATE_DIR, profileId);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const now = Date.now();
  const sessions = [];

  for (const file of files) {
    if (!file.endsWith('.json') || file.startsWith('.')) continue;
    const full = path.join(dir, file);
    const id = file.slice(0, -'.json'.length);

    let ts;
    try {
      // The hook doesn't fork `date`, so freshness comes from the file's mtime.
      ts = fs.statSync(full).mtimeMs;
    } catch {
      lastGood.delete(id);
      continue;
    }
    if (now - ts > behavior.sessionStaleMs) {
      lastGood.delete(id);
      continue;
    }

    let data;
    try {
      data = JSON.parse(fs.readFileSync(full, 'utf8'));
      lastGood.set(id, data);
    } catch {
      // Caught it mid-write. Fall back to what it last said — but with the fresh
      // mtime, so the session doesn't look stale while it's actively being updated.
      data = lastGood.get(id);
      if (!data) continue;
    }

    sessions.push({ ...data, ts });
  }

  return sessions;
}

// `ps -axww` over ~400 processes costs ~96ms, almost all of it kernel time. The poll
// runs every 400ms for each of two profiles, so an uncached check during one long Bash
// command burns roughly half a core — precisely while the machine is already busy with
// the build you're waiting on. Cached, that becomes one scan per 1.5s.
//
// Staleness is only dangerous in one direction. "A shell is running" aging out costs
// nothing (we stay quiet a moment longer). "No shell is running" is the verdict that
// puts a bubble on screen, so that one is re-verified fresh — it happens rarely, and a
// stale negative would mean nagging about a command that is actually running.
const SHELL_CACHE_MS = 1500;
const NEGATIVE_MAX_AGE_MS = 250;
let shellCache = { at: 0, parents: null };

/**
 * Parents of a live Claude tool shell, as a Set of pid strings.
 * Returns null if `ps` couldn't be read — callers must treat that as "don't know"
 * rather than "nothing running", or a slow build looks like a permission prompt.
 */
function toolShellParents({ trustNegative = false } = {}) {
  const age = Date.now() - shellCache.at;
  const fresh = trustNegative ? age < NEGATIVE_MAX_AGE_MS : age < SHELL_CACHE_MS;
  if (fresh && shellCache.parents !== null) return shellCache.parents;

  const parents = scanToolShellParents();
  shellCache = { at: Date.now(), parents };
  return parents;
}

function scanToolShellParents() {
  // -ww is essential: without it `ps` truncates the command to terminal width and
  // the snapshot path we match on gets cut off.
  const res = spawnSync('ps', ['-axww', '-o', 'ppid=,command='], {
    encoding: 'utf8',
    timeout: 2000,
  });
  if (res.error || res.status !== 0 || !res.stdout) return null;

  const parents = new Set();
  for (const line of res.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, ppid, cmd] = m;
    // Claude runs each Bash call as its own shell sourcing a snapshot file. MCP
    // servers are children of `claude` too, so match the shell specifically.
    if (cmd.includes('shell-snapshot') || /^\/bin\/(ba|z)?sh -c/.test(cmd)) {
      parents.add(ppid);
    }
  }
  return parents;
}

// Tools that always finish in milliseconds. For these — and only these — a gap
// after PreToolUse can only mean nobody has answered the prompt.
//
// The original rule was "everything except Bash is fast", which is wrong and was the
// main source of phantom nudges. `Task` runs a subagent for minutes. `WebFetch` and
// `WebSearch` are network calls. Every `mcp__*` tool is a round trip to a server —
// Apollo, Gmail, Supabase, a browser — and those routinely take longer than 4s while
// working perfectly. All of them were being reported as unanswered prompts.
//
// So this is an allowlist, not a denylist: a tool nobody has classified is assumed
// slow. A new tool showing up in a Claude release then costs a late notification,
// never a false one.
const FAST_TOOLS = new Set([
  'Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit',
  'Glob', 'Grep', 'LS', 'TodoWrite',
  'ExitPlanMode', 'EnterPlanMode', 'BashOutput', 'KillShell',
]);

/** 'fast' → prompt after promptSuspectMs · 'shell' → also check the shell · 'slow' → slowToolSuspectMs */
function toolClass(tool) {
  if (tool === 'Bash') return 'shell';
  return FAST_TOOLS.has(tool) ? 'fast' : 'slow';
}

// Claude Code's Notification hook does not fire for permission prompts in the desktop
// app (see README) — but it *does* fire for "Claude is waiting for your input" after a
// session sits idle. The hook can't tell those apart without parsing, so it marks every
// Notification as waiting, and the idle one produced a nudge with nothing to approve:
// you walk over, and there is no prompt on screen.
function isPermissionNotification(s) {
  return /permission/i.test(s.message || '');
}

/**
 * The desktop app never fires the Notification hook for permission prompts, so a
 * prompt has to be inferred: PreToolUse arrived, PostToolUse never did — for longer
 * than that tool could plausibly take. Bash gets a second check: if its shell is
 * still alive it's just a slow command.
 *
 * Mutates the sessions in place.
 */
function markInferredPrompts(sessions, behavior, now = Date.now()) {
  const slowMs = behavior.slowToolSuspectMs ?? 90000;
  // A tool call that has been dangling this long is far more likely to be wreckage —
  // an interrupted turn, a killed session, a denied tool — than a prompt someone is
  // still going to answer. Without this, one Esc keypress leaves a pet standing there
  // insisting on a prompt that no longer exists until the session goes stale.
  const maxMs = behavior.inferredMaxMs ?? 300000;

  const candidates = sessions.filter((s) => {
    if (s.state !== 'working' || s.event !== 'PreToolUse') return false;
    const age = now - s.ts;
    if (age > maxMs) return false;
    return age > (toolClass(s.tool) === 'slow' ? slowMs : behavior.promptSuspectMs);
  });
  if (!candidates.length) return sessions;

  const needsShellCheck = candidates.some((s) => toolClass(s.tool) === 'shell');
  let running = needsShellCheck ? toolShellParents() : null;

  for (const s of candidates) {
    if (toolClass(s.tool) === 'shell') {
      // Only claim "waiting" when we positively know no shell is running.
      if (!s.pid || running === null) continue;
      if (running.has(String(s.pid))) continue;
      // About to put a bubble on screen off the back of an absence. Re-check with a
      // fresh scan before believing it — see SHELL_CACHE_MS.
      running = toolShellParents({ trustNegative: true });
      if (running === null || running.has(String(s.pid))) continue;
    }
    s.state = 'waiting';
    s.inferred = true;
    if (!s.message) {
      s.message = s.tool ? `Needs permission for ${s.tool}` : 'Needs your permission';
    }
  }

  return sessions;
}

function aggregate(profileId, behavior) {
  const sessions = readProfileSessions(profileId, behavior);

  for (const s of sessions) {
    if (s.state === 'waiting' && s.event === 'Notification' && !isPermissionNotification(s)) {
      s.state = 'idle';
    }
  }

  markInferredPrompts(sessions, behavior);

  const waiting = sessions.filter((s) => s.state === 'waiting');
  const working = sessions.filter((s) => s.state === 'working');

  let status = 'absent';
  if (waiting.length) status = 'waiting';
  else if (working.length) status = 'working';
  else if (sessions.length) status = 'idle';

  return {
    status,
    sessions: sessions.length,
    waiting: waiting.length,
    working: working.length,
    message: waiting[0]?.message || '',
    cwd: waiting[0]?.cwd || working[0]?.cwd || '',
    tool: working[0]?.tool || waiting[0]?.tool || '',
    inferred: Boolean(waiting[0]?.inferred),
    waitingIds: waiting.map((s) => s.session_id),
    all: sessions,
  };
}

module.exports = {
  STATE_DIR,
  readProfileSessions,
  toolShellParents,
  markInferredPrompts,
  toolClass,
  isPermissionNotification,
  aggregate,
};
