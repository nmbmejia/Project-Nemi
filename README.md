# Project Nemi

A local dashboard for tickets that live as markdown in your repos. Point it at the folder containing your projects, and it scans every git repo for a `.docs/<branch>/` folder, turning briefs, phase files, and checkboxes into a tree view, a kanban board, a "today" view, and a sticky-note corkboard, all backed by the markdown files themselves (no database).

No build step, no framework, no dependencies. One Node process, one static frontend.

![Project Nemi empty state](docs/screenshot-empty-state.png)

## Requirements

- Node.js 18+
- Git repos with a `.docs/<branch-name>/` folder containing a `Project Brief.md` (or `brief.md` / `assessment.md`). These are typically produced by ticket-authoring dev skills/scripts, but any folder matching that shape works.

## Setup

```bash
git clone <this-repo>
cd project-nemi
cp .env.example .env
```

Edit `.env` and set `SCAN_ROOT` to the absolute path of the folder containing the repos you want scanned (e.g. `/Users/you/Projects`):

```
SCAN_ROOT=/Users/you/Projects
```

Then start it:

```bash
npm start
```

Open **http://localhost:4747**. Nemi walks every git repo under `SCAN_ROOT` (up to 6 levels deep), looks for a `.docs/` folder in each, and renders whatever ticket folders it finds.

If nothing shows up, the app's empty state repeats these steps and tells you which folder it's currently scanning.

### Configuration

All config lives in `.env` (copy from `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `SCAN_ROOT` | parent of this repo | Absolute path to the folder Nemi scans for repos |
| `PORT` | `4747` | Port the local server listens on |

## How a ticket is structured

Nemi doesn't invent its own format, it reads folders you already have:

```
your-repo/
  .docs/
    your-branch-name/
      Project Brief.md      # title (# heading) + Problem Statement section
      phase-1-setup.md      # optional: **Goal:** line + checkbox tasks
      phase-2-build.md
      any-other-notes.md    # anything else in the folder is shown as a note
```

- A folder becomes a **ticket** if it contains `Project Brief.md`, `brief.md`, or `assessment.md`.
- `phase-N-*.md` files are parsed for `- [ ]` / `- [x]` checkboxes; ticket progress and status (`not-started` / `in-progress` / `done`) are derived from how many are checked.
- Any other markdown in `.docs/` (outside a ticket folder) is shown as a browsable doc tree.
- Checking a box, changing status, pinning, or labeling in the UI writes straight back to the markdown/JSON files, there's no separate database to get out of sync.

## Features

- **Tree view**: sidebar of every scanned repo and its tickets, with a doc pane and a right rail for ticket metadata.
- **Board view**: kanban by status, drag-free, click to update.
- **Today view**: a focused slice of what's active right now.
- **Stickies (corkboard)**: freeform sticky notes with drag/resize, a small markdown editor, optional reminders (desktop notifications on macOS via `terminal-notifier` if installed, otherwise in-app only), and the ability to pin a note to a ticket.
- **Labels**: a small global label registry you can create, assign, and filter by.
- **Checkout from the UI**: jump a repo to a ticket's branch with one click.
- **Search**: filters across tickets and docs as you type.
- **Light/dark theme**, remembered per browser.

## Showcase

<!-- Drop screenshots into docs/ and reference them below. -->

| Tree view | Board view |
|---|---|
| ![Tree view](docs/screenshot-tree.png) | ![Board view](docs/screenshot-board.png) |

| Today view | Stickies |
|---|---|
| ![Today view](docs/screenshot-today.png) | ![Stickies view](docs/screenshot-stickies.png) |

## Notes

- This is a local tool: it reads/writes files on disk and shells out to `git checkout` in your repos. Don't expose it beyond `localhost`.
- macOS desktop notifications for sticky note reminders use [terminal-notifier](https://github.com/julienXX/terminal-notifier) (`brew install terminal-notifier`) if it's found on your `PATH`; otherwise reminders still fire in-app.
