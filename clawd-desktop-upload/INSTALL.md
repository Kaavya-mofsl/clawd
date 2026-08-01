# Installing Clawd

Written to be followed by Claude Code, and readable if you'd rather do it yourself.
Nine steps, about two minutes, one of which only you can do.

## What this touches

Worth knowing before you start, because one of these is your own Claude config:

| | |
|---|---|
| `~/.claude/settings.json` | **edited** — eight hook entries added. Existing hooks are preserved and a timestamped backup is written first. `npm run uninstall-hooks` reverses it. |
| `~/.clawd/` | **created** — session state files, the account map, dragged positions. Nothing else lives here. |
| the repo folder | node_modules (~250MB, Electron) |

Clawd reads only which account a session belongs to, its state, the current tool name,
the notification text and the project folder. It never reads your prompts, your code or
your transcripts, and it has no network access — there is nowhere for anything to go.

## Requirements

- macOS (12 Monterey or newer; built and tested on 12.7)
- Node 18+ and npm — `node --version`
- Claude Code, either the desktop app or the CLI

## Steps

1. **Check Node.** `node --version`. If it's missing or below 18, stop and tell the user
   to install Node from nodejs.org — don't install it for them.

2. **Clone.** Anywhere you like; `~/clawd` is a fine default.
   ```bash
   git clone https://github.com/Kaavya-mofsl/clawd.git ~/clawd
   cd ~/clawd
   ```

3. **Install dependencies.** `npm install` — this is Electron, so it's a ~250MB download
   and can take a couple of minutes.

4. **Install the hooks.** `npm run install-hooks`. It prints the backup path it wrote.
   If it refuses because `settings.json` isn't valid JSON, stop — fix that first, since
   Claude Code isn't reading it either.

5. **Start it.** `npm start`. It runs in the background with no dock icon; look for 🦀
   in the menu bar.

6. **Expect nothing to happen yet.** Two conditions have to be true before a pet appears:
   Clawd is running, *and* that account has a live Claude Code session. Hooks are read
   when a session starts, so **the session you're using right now can't see them.** Open a
   new Claude Code session — or restart this one — and the crab walks in a second or two later.

7. **Check what it can see.** `npm run state` prints the sessions it's tracking, using the
   same code the pet does. Empty output means step 6 hasn't happened yet, not that
   something is broken.

8. **Let it survive a reboot.** `clawd.command` in the repo is the login wrapper.
   **This step is the user's — it needs System Settings, which an agent can't drive:**
   System Settings → General → Login Items → `+` → pick `clawd.command` in the repo folder.

9. **Say it's done**, and tell them the tray menu has *Test nudge* if they want to see
   what a notification looks like without waiting for a real prompt.

## Two Claude accounts

Only if they run a second Claude account as the same app under `--user-data-dir` — most
people don't, and a fresh install already handles the common case.

```bash
cp config.local.example.json config.local.json
```

Edit the `profiles` list: `match` is any distinctive substring of that account's
`--user-data-dir` path. Then `npm run install-hooks` again (it regenerates the account
map the hook reads) and restart Clawd. `config.local.json` is git-ignored, so this
survives every `git pull`.

## If something's wrong

- **No pet, and `npm run state` prints nothing** — the hooks aren't reaching it. Confirm
  `clawd-hook.sh` appears in `~/.claude/settings.json`, then start a *new* session.
- **No pet, but `npm run state` shows sessions** — Clawd isn't running, or the pet is
  parked off-screen from an earlier drag. Tray → *Forget dragged positions*.
- **Two of every crab** — two copies running. `pkill -f "$PWD/node_modules/electron"` from
  the repo folder, then start once.
- **It nudges when nothing is waiting** — raise `behavior.promptSuspectMs` in
  `config.local.json`. The README's *How a permission prompt is detected* explains why
  the number matters.

## Uninstalling

```bash
npm run uninstall-hooks     # removes only Clawd's entries, backs up first
rm -rf ~/.clawd             # state files
```

Then remove `clawd.command` from Login Items and delete the folder.
