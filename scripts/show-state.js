#!/usr/bin/env node
// Prints what the pet currently sees — through the same code path the pet uses,
// including the inferred-permission-prompt rule. `--watch` re-prints on a timer.

const fs = require('fs');
const path = require('path');

const config = require('../src/config').load();
const { STATE_DIR, aggregate } = require('../src/state');

const watch = process.argv.includes('--watch');

function render() {
  if (!fs.existsSync(STATE_DIR)) {
    console.log(`no state yet at ${STATE_DIR} — hooks may not be installed`);
    return;
  }

  const stamp = new Date().toTimeString().slice(0, 8);
  const lines = [];

  for (const profile of config.profiles) {
    const agg = aggregate(profile.id, config.behavior);
    lines.push(`${profile.id} — ${agg.status.toUpperCase()} (${agg.sessions} session(s))`);

    for (const s of agg.all) {
      const where = s.cwd ? path.basename(s.cwd) : '?';
      const age = Math.round((Date.now() - s.ts) / 1000);
      const flag = s.inferred ? ' [inferred]' : '';
      lines.push(
        `   ${s.state.padEnd(8)} ${where.padEnd(20)} ${(s.tool || s.event || '').padEnd(13)} ${age}s ago${flag}`
      );
      if (s.message) lines.push(`            ↳ "${s.message}"`);
    }
  }

  console.log(watch ? `[${stamp}] ${lines.join('\n')}` : lines.join('\n'));
}

render();
if (watch) setInterval(render, 2000);
