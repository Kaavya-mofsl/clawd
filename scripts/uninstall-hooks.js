#!/usr/bin/env node
// Removes every Clawd hook from ~/.claude/settings.json, leaving everything else alone.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const MARKER = 'clawd-hook.sh';

if (!fs.existsSync(SETTINGS)) {
  console.log('nothing to do — no settings.json');
  process.exit(0);
}

const raw = fs.readFileSync(SETTINGS, 'utf8');
const settings = JSON.parse(raw);

fs.writeFileSync(`${SETTINGS}.clawd-backup-${Date.now()}`, raw);

let removed = 0;
for (const [event, list] of Object.entries(settings.hooks || {})) {
  if (!Array.isArray(list)) continue;
  for (const group of list) {
    if (!Array.isArray(group.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter((h) => !String(h.command || '').includes(MARKER));
    removed += before - group.hooks.length;
  }
  settings.hooks[event] = list.filter((g) => !Array.isArray(g.hooks) || g.hooks.length > 0);
  if (settings.hooks[event].length === 0) delete settings.hooks[event];
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + '\n');
console.log(`✓ removed ${removed} Clawd hook entries`);
console.log(`  ~/.clawd is left alone — delete it by hand to remove the state files too.`);
