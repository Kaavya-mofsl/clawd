#!/bin/bash
# clawd-hook.sh — writes Claude Code session state where the desktop pet can see it.
#
# Runs on EVERY tool call, so it must stay cheap. Everything here is a bash builtin
# except one `mv` (atomic publish) and, once per session, a `ps` walk that is cached.
# No node, no jq, no `cat`, no `date` — freshness comes from the file's mtime.
#
# If you run two Claude accounts as the same app under --user-data-dir, both share
# ~/.claude/settings.json, so this one script fires for both and works out which
# account it belongs to by walking the process tree. One account: it never looks.
#
# Always exits 0. A broken pet must never break a Claude session.

CLAWD_HOME="${CLAWD_HOME:-$HOME/.clawd}"
STATE_DIR="$CLAWD_HOME/state"
CACHE_DIR="$CLAWD_HOME/cache"

# Slurp stdin. `read -r -d ''` is the obvious way and is catastrophically slow on
# big input — bash consumes it a byte at a time, measured at +105ms over a bare
# fork for a 40KB PostToolUse payload, against +10ms for this. Reading to EOF also
# matters: truncating the read would hand Claude an EPIPE on the write side.
payload=$(</dev/stdin)

# Every field we want is a top-level key, and Claude emits them ahead of the
# tool_input / tool_response blobs. Those blobs carry the whole tool output —
# 40KB after a chatty command — and bash 3.2 regex across that is by far the most
# expensive thing this script could do (it doubled the hook's cost when measured).
# So scan a prefix, not the payload.
scan=${payload:0:1200}

# --- extract a top-level string field into a variable ---------------------
# Assigns through `printf -v` instead of returning via $(...): command
# substitution forks a subshell, and four of those cost more than every bit of
# string handling here put together. Values stay JSON-escaped exactly as they
# arrived, so they can be re-emitted verbatim.
field() { # field <json-key> <dest-var>
  local re="\"$1\"[[:space:]]*:[[:space:]]*\"((\\\\.|[^\"\\\\])*)\""
  if [[ $scan =~ $re ]]; then
    printf -v "$2" '%s' "${BASH_REMATCH[1]}"
  else
    printf -v "$2" '%s' ''
  fi
}

field session_id session_id
if [ -z "$session_id" ]; then
  # Unexpected key order — pay for one full scan before giving up.
  scan=$payload
  field session_id session_id
  [ -z "$session_id" ] && exit 0
fi

field hook_event_name event
field cwd cwd
field tool_name tool

# Only Notification carries a top-level "message"; reading it on other events can
# pick up a same-named key nested inside tool_response.
message=""
[ "$event" = "Notification" ] && field message message

# --- debug trace ----------------------------------------------------------
# Off unless ~/.clawd/debug exists. One builtin test when off; when on it forks
# `date` and dumps the whole payload, which is fine for a diagnostic session.
if [ -f "$CLAWD_HOME/debug" ]; then
  printf '%s  %-16s tool=%-12s %s\n' "$(date '+%H:%M:%S')" "$event" "$tool" "$payload" \
    >> "$CLAWD_HOME/events.log" 2>/dev/null
fi

# --- which account fired this, and which process is it? -------------------
# One walk up the PPID chain collects both:
#   claude_pid     the `claude` binary itself — the app checks its children to tell
#                  "Bash is running" apart from "a permission prompt is waiting"
#   user_data_dir  read off the Electron root, which is what separates the accounts
#
# Both are stable for the life of a session, so this is cached and the ps walk
# happens exactly once.
#
#   /bin/bash (this hook)
#     └─ …/claude-code/<ver>/claude.app/Contents/MacOS/claude   <- claude_pid
#         └─ /Applications/Claude.app/Contents/Helpers/disclaimer
#             └─ /Applications/Claude.app/Contents/MacOS/Claude --user-data-dir=…
#
# `disclaimer` carries the claude.app path in its argv too, so only the FIRST
# match counts — walking up would otherwise overwrite it with the wrapper's pid.
detect_ancestry() {
  local cur=$PPID hops=0 line parent cmd
  claude_pid=""
  user_data_dir=""

  while [ "$hops" -lt 10 ]; do
    line=$(ps -o ppid=,command= -p "$cur" 2>/dev/null)
    [ -z "$line" ] && break

    line=${line#"${line%%[![:space:]]*}"}   # ltrim
    parent=${line%% *}                       # first token is ppid
    cmd=${line#* }                           # rest is the command

    if [ -z "$claude_pid" ]; then
      case "$cmd" in
        *claude.app/Contents/MacOS/claude*) claude_pid=$cur ;;
      esac
    fi

    case "$cmd" in
      *--user-data-dir=*)
        cmd=${cmd#*--user-data-dir=}
        user_data_dir=${cmd%% *}
        break
        ;;
    esac

    case "$parent" in ''|*[!0-9]*) break ;; esac
    [ "$parent" -le 1 ] && break
    cur=$parent
    hops=$((hops + 1))
  done
}

cache_file="$CACHE_DIR/profile-$session_id"
if [ -r "$cache_file" ]; then
  # one redirect for both — reopening the file would just re-read line 1
  { IFS= read -r user_data_dir; IFS= read -r claude_pid; } < "$cache_file"
else
  detect_ancestry
  [ -d "$CACHE_DIR" ] || mkdir -p "$CACHE_DIR" 2>/dev/null
  printf '%s\n%s\n' "$user_data_dir" "$claude_pid" > "$cache_file" 2>/dev/null
fi

# Map user-data-dir -> profile id.
#
# `account1` is the built-in default and matches the fallback profile in config.json —
# a single-account setup never has a --user-data-dir at all, so it stops here without
# touching the disk. Extra accounts come from ~/.clawd/profiles.map, one
# "<match><TAB><id>" line per profile, written by `npm run install-hooks`.
profile="account1"
if [ -n "$user_data_dir" ] && [ -r "$CLAWD_HOME/profiles.map" ]; then
  while IFS=$'\t' read -r match id; do
    [ -n "$match" ] && [ -n "$id" ] || continue
    case "$user_data_dir" in
      *"$match"*) profile="$id"; break ;;
    esac
  done < "$CLAWD_HOME/profiles.map"
fi

# --- event -> pet state ---------------------------------------------------
case "$event" in
  Notification)                    state="waiting" ;;
  PreToolUse|PostToolUse|UserPromptSubmit) state="working" ;;
  Stop|SubagentStop|SessionStart)  state="idle" ;;
  SessionEnd)
    rm -f "$STATE_DIR/$profile/$session_id.json" "$cache_file" 2>/dev/null
    exit 0
    ;;
  *)                               state="idle" ;;
esac

# --- publish atomically ---------------------------------------------------
out_dir="$STATE_DIR/$profile"
[ -d "$out_dir" ] || mkdir -p "$out_dir" 2>/dev/null

# Written in place rather than tmp + mv. `mv` is a fork, measured at ~11ms — a
# large slice of this hook's whole budget — and the file is one short write, so
# the window where a reader sees it torn is tiny. The app keeps the last good
# value per session precisely so that a torn read costs nothing.
printf '{"profile":"%s","session_id":"%s","state":"%s","event":"%s","tool":"%s","message":"%s","cwd":"%s","pid":"%s"}\n' \
  "$profile" "$session_id" "$state" "$event" "$tool" "$message" "$cwd" "$claude_pid" \
  > "$out_dir/$session_id.json" 2>/dev/null

exit 0
