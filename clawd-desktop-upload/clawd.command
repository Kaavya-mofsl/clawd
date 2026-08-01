#!/bin/bash
# Login-item wrapper: System Settings -> General -> Login Items -> "+".
#
# Guards against a second copy — macOS re-runs login items on fast user switching,
# and two Clawds means two pets per account stacked on the same spot.
#
# Match on this folder's own path, not "electron": the real argv is
#   <install-dir>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
# so a pattern like "electron .*clawd" matches nothing and the guard silently does the
# exact thing it exists to prevent. Taken from $PWD rather than written out, because
# the folder is whatever you cloned it as, and a hardcoded name guards nobody else.
cd "$(dirname "$0")" || exit 0
pgrep -f -- "$PWD/node_modules/electron" >/dev/null 2>&1 && exit 0
./node_modules/.bin/electron . >/dev/null 2>&1 &
