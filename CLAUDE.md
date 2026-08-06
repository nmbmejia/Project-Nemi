# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Project Nemi: local dashboard that scans sibling git repos for `.docs/<branch>/` ticket folders (produced by dev skills like `start-ticket`) and renders them as a tree/kanban/today/corkboard UI. Single Node process serving a vanilla JS frontend, no build step, no framework, no dependencies (`package.json` has zero `dependencies`).

## Commands

```bash
npm start          # node server.js, runs on :4747 (override with PORT)
node server.js      # same, direct
cp .env.example .env   # then set SCAN_ROOT before first run
```

No test suite, no lint config, no build step. Changes to `server.js` or `public/*` take effect on request/page-reload; only `server.js` needs a process restart.

## Architecture

**Backend (`server.js`, single file):**
- Config comes from `.env` via a tiny inline dotenv loader (`loadDotEnv`, no dependency), loaded before `PORT`/`SCAN_ROOT` are read. Real env vars always win over `.env` values. See `.env.example` for the documented keys.
- `ROOT` = `SCAN_ROOT` if set, else the parent directory of this repo (with a console warning). `findGitRepos` walks down from `ROOT` looking for `.git` dirs (skips `node_modules`, `.git`, build dirs, etc., and does not descend into a repo once found).
- For each repo with a `.docs/` folder, `buildProjects()` walks it: top-level subfolders containing a brief file (`Project Brief.md` / `brief.md` / `assessment.md`, checked in that order) become **tickets**; everything else is a generic folder/file doc node. Tickets are keyed by `${repoLabel}::${branch}`.
- A ticket's phases come from `phase-N*.md` files (sorted numerically), tasks are parsed out of markdown checkboxes (`- [ ]` / `- [x]`) via `CHECKBOX_RE`. Ticket status is auto-derived from checkbox completion (`not-started` / `in-progress` / `done`) unless overridden by `.status.json` in the ticket folder (also stores manual label).
- Board-local state (not part of any repo, lives next to `server.js`): `.labels.json` (label registry), `.pinned.json` (pinned ticket ids), `.notes.json` (corkboard sticky notes).
- All mutation endpoints (`/api/toggle`, `/api/status`, `/api/ticket-label`, `/api/ticket-pin`, `/api/labels/*`, `/api/notes/*`) follow the same pattern: mutate state on disk, then return a fresh `buildProjects()` payload so the client just re-renders from the response rather than doing local reconciliation.
- `/api/checkout` shells out to `git checkout <branch>` in the ticket's repo dir, the one place this app mutates a scanned repo rather than its own board state.
- Sticky note reminders are polled server-side every 20s (`checkNoteReminders`) and fired via `terminal-notifier` if it's resolvable on `PATH` (`resolveTerminalNotifier`, lazy + cached; not `osascript`, see comment in `fireOsNotification` for why), otherwise skipped silently since it's macOS-only and optional. The client polls `/api/notes/reminders/due` to know what fired.
- File edits from the client (checkbox toggles) are validated against a `validFileIds` set rebuilt from `buildProjects()` before writing, and resolved paths are checked to stay under `ROOT`.

**Frontend (`public/app.js`, single file, no modules/bundler):**
- One global `state` object (includes `state.root`, the scan root path echoed back by `/api/tickets` for display in the empty state); `renderAll()` fans out to per-view render functions gated by `updateViewVisibility()`. Views: tree (default, sidebar + doc pane + right rail), board (kanban), today, corkboard (sticky notes canvas).
- Data flow is fetch-then-render: every mutating action calls an `/api/*` endpoint, gets the full tickets/projects/labels payload back, and calls `applyTicketsResponse(data)`. There is no separate client-side store to keep in sync.
- The corkboard (sticky notes) is the most complex subsystem: drag/resize/z-order, a markdown mini-editor with its own format-bar and keyboard shortcut handling (`runFormatAction`, `editorShortcut`), popovers for reminders/folder-pinning, and shake-to-detect gestures, all hand-rolled DOM, no component framework.
- `markdown.js` and `highlight.js` are standalone vendored-style helpers loaded as plain `<script>` tags before `app.js` (check these before assuming a markdown/highlighting library is missing).

## Conventions worth knowing

- No em dashes in any user-facing or committed text (comments, commit messages, UI copy, README). Use commas, colons, or two sentences instead.
- Server responses on mutation endpoints always return the full `{ ok, tickets, projects, labels }` (or `{ ok, notes }` for note endpoints) shape, even on writes that only touch one entity. Keep new endpoints consistent with this.
- `fileId` is a `/`-joined path relative to `ROOT`, used as the identifier for any markdown file the client can reference (ticket brief, phase file, note doc, standalone doc). Convert with `toFileId`/`fromFileId`, never construct manually.
- No personal/machine-specific paths belong in committed code (this repo is public). Config goes through `.env` (gitignored); anything that needs an optional external binary should resolve it via `PATH`, not a hardcoded install location.
