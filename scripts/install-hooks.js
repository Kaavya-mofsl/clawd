#!/usr/bin/env node
// Merges the Clawd hooks into ~/.claude/settings.json.
//
// Existing hooks are preserved; a timestamped backup is written first; running it
// twice is a no-op rather than a duplicate. If you run two Claude accounts as the
// same app under --user-data-dir, they share this one settings file, so installing
// once covers both.

const fs = require('fs');
const path = require('path');
const os = require('os');

const config = require('../src/config').load();

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const HOOK = path.join(__dirname, '..', 'hooks', 'clawd-hook.sh');
const MARKER = 'clawd-hook.sh';

const CLAWD_HOME = process.env.CLAWD_HOME || path.join(os.homedir(), '.clawd');
const PROFILE_MAP = path.join(CLAWD_HOME, 'profiles.map');

// The hook can't parse JSON without forking node, and it runs on every tool call, so
// the account matching is flattened to "<match><TAB><id>" lines it can read with a
// builtin. Only profiles that declare a `match` appear; the fallback is `account1`,
// hardcoded in the hook, which is why config.json says not to rename it.
function writeProfileMap() {
  const lines = (config.profiles || [])
    .filter((p) => p.match)
    .map((p) => `${p.match}\t${p.id}`);

  fs.mkdirSync(CLAWD_HOME, { recursive: true });
  fs.writeFileSync(PROFILE_MAP, lines.length ? lines.join('\n') + '\n' : '');

  const fallback = (config.profiles || []).filter((p) => !p.match);
  if (!fallback.some((p) => p.id === 'account1')) {
    console.warn('! no profile with id "account1" and match:null — the hook\'s default');
    console.warn('  profile will have nowhere to go. See the //profiles note in config.json.');
  }
  if (lines.length) console.log(`• account map written: ${PROFILE_MAP} (${lines.length} extra)`);
}

const EVENTS = [
  ['SessionStart', null],
  ['UserPromptSubmit', null],
  ['PreToolUse', '*'],
  ['PostToolUse', '*'],
  ['Notification', null],
  ['Stop', null],
  ['SubagentStop', null],
  ['SessionEnd', null],
];

function main() {
  if (!fs.existsSync(HOOK)) {
    console.error(`✗ hook script missing: ${HOOK}`);
    process.exit(1);
  }
  fs.chmodSync(HOOK, 0o755);
  writeProfileMap();

  let settings = {};
  if (fs.existsSync(SETTINGS)) {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${SETTINGS} is not valid JSON — refusing to touch it.`);
      process.exit(1);
    }
    const backup = `${SETTINGS}.clawd-backup-${Date.now()}`;
    fs.writeFileSync(backup, raw);
    console.log(`• backup written: ${backup}`);
  }

  settings.hooks = settings.hooks || {};
  const command = `"${HOOK}"`;

  let added = 0;
  for (const [event, matcher] of EVENTS) {
    const list = (settings.hooks[event] = settings.hooks[event] || []);

    // drop any previous Clawd entries so this stays idempotent
    for (const group of list) {
      if (Array.isArray(group.hooks)) {
        group.hooks = group.hooks.filter((h) => !String(h.command || '').includes(MARKER));
      }
    }
    // remove groups we just emptied, but never groups that were already empty of ours
    const pruned = list.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
    settings.hooks[event] = pruned;

    const entry = { hooks: [{ type: 'command', command }] };
    if (matcher) entry.matcher = matcher;
    settings.hooks[event].push(entry);
    added++;
  }

  const tmp = `${SETTINGS}.clawd-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS);

  console.log(`✓ installed Clawd hooks on ${added} events in ${SETTINGS}`);
  console.log('  Existing hooks were preserved. Restart any open Claude sessions to pick them up —');
  console.log('  hooks are read when a session starts, so the ones already open stay invisible.');
}

main();
