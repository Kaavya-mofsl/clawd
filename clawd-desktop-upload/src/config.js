// One place that decides what the config actually is.
//
// `config.json` is checked in and is the shared default. `config.local.json` sits
// beside it, is git-ignored, and wins — so you can keep a second account, a different
// strip position or a slower frame rate without ever conflicting with `git pull`.
//
// Merge is one level deep: `strip` and `behavior` merge key by key, `profiles` is a
// list and is replaced wholesale (a half-merged list of pets is nobody's intent).

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_PATH = path.join(ROOT, 'config.json');
const LOCAL_PATH = path.join(ROOT, 'config.local.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${file} is not valid JSON: ${err.message}`);
  }
}

function load() {
  const base = readJson(BASE_PATH);
  if (!base) throw new Error(`missing ${BASE_PATH}`);

  const local = readJson(LOCAL_PATH);
  if (!local) return base;

  return {
    ...base,
    ...local,
    strip: { ...base.strip, ...local.strip },
    behavior: { ...base.behavior, ...local.behavior },
    profiles: local.profiles || base.profiles,
  };
}

module.exports = { load, BASE_PATH, LOCAL_PATH };
