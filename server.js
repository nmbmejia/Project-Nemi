'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { execFileSync } = require('child_process');

const SELF = __dirname;

// Minimal .env loader (no deps): KEY=value per line, `#` comments, blank
// lines skipped. Only fills vars not already set, so real env vars (e.g.
// `PORT=5000 node server.js`) always win over the file.
function loadDotEnv(file) {
  let content;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv(path.join(SELF, '.env'));

const PORT = process.env.PORT || 4747;
if (!process.env.SCAN_ROOT) {
  console.warn('No SCAN_ROOT set. Copy .env.example to .env and set SCAN_ROOT to the folder containing the repos you want scanned.');
  console.warn(`Falling back to the parent directory: ${path.resolve(path.join(SELF, '..'))}`);
}
const ROOT = path.resolve(process.env.SCAN_ROOT || path.join(SELF, '..'));

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'Pods', 'DerivedData', 'build', 'dist', '.next',
  'target', 'vendor', '.fvm', '.dart_tool', '.gradle', '.idea', '.vscode',
  'Carthage', '.build', '_backups', 'sprint-board'
]);

// ---------- Discovery ----------

function findGitRepos(root, depth = 6) {
  const repos = [];
  function walk(dir, remaining) {
    if (remaining < 0) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    if (entries.some((e) => e.isDirectory() && e.name === '.git')) {
      repos.push(dir);
      return; // don't descend into a repo looking for nested repos
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.') && entry.name !== '.git') continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), remaining - 1);
    }
  }
  walk(root, depth);
  return repos;
}

function currentBranch(repoDir) {
  try {
    const head = fs.readFileSync(path.join(repoDir, '.git', 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    if (m) return m[1];
    return head.slice(0, 7); // detached HEAD, short sha
  } catch (e) {
    return null;
  }
}

// ---------- Parsing ----------

const CHECKBOX_RE = /^(\s*[-*]\s\[)([ xX])(\]\s+)(.*)$/;
const STATUSES = new Set(['not-started', 'in-progress', 'done']);

function readStatusFile(ticketDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ticketDir, '.status.json'), 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeStatusFile(ticketDir, patch) {
  const next = { ...readStatusFile(ticketDir), ...patch };
  fs.writeFileSync(path.join(ticketDir, '.status.json'), JSON.stringify(next, null, 2));
}

function readManualStatus(ticketDir) {
  const data = readStatusFile(ticketDir);
  return STATUSES.has(data.status) ? data.status : null;
}

function writeManualStatus(ticketDir, status) {
  if (!STATUSES.has(status)) throw new Error('invalid status');
  writeStatusFile(ticketDir, { status });
}

function readTicketLabel(ticketDir) {
  const data = readStatusFile(ticketDir);
  return typeof data.label === 'string' && data.label ? data.label : null;
}

function writeTicketLabel(ticketDir, label) {
  writeStatusFile(ticketDir, { label: label || null });
}

// ---------- Labels (global registry, board-local, not per-repo) ----------

const LABELS_FILE = path.join(SELF, '.labels.json');

function readLabels() {
  try {
    const data = JSON.parse(fs.readFileSync(LABELS_FILE, 'utf8'));
    return Array.isArray(data.labels) ? data.labels : [];
  } catch (e) {
    return [];
  }
}

function writeLabels(labels) {
  fs.writeFileSync(LABELS_FILE, JSON.stringify({ labels }, null, 2));
}

function createLabel(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw new Error('label name required');
  const labels = readLabels();
  if (labels.includes(trimmed)) throw new Error('label already exists');
  labels.push(trimmed);
  writeLabels(labels);
}

function deleteLabel(name) {
  const labels = readLabels();
  if (!labels.includes(name)) throw new Error('unknown label');
  writeLabels(labels.filter((l) => l !== name));
  for (const t of buildTickets()) {
    if (t.label === name) {
      writeTicketLabel(path.dirname(fromFileId(t.assessmentFileId)), null);
    }
  }
}

function assignTicketLabel(ticketId, label) {
  const ticket = buildTickets().find((t) => t.id === ticketId);
  if (!ticket) throw new Error('unknown ticket');
  if (label) {
    if (!readLabels().includes(label)) throw new Error('unknown label');
  }
  writeTicketLabel(path.dirname(fromFileId(ticket.assessmentFileId)), label || null);
}

// ---------- Pinned tickets (board-local, overrides default sort) ----------

const PINNED_FILE = path.join(SELF, '.pinned.json');

function readPinned() {
  try {
    const data = JSON.parse(fs.readFileSync(PINNED_FILE, 'utf8'));
    return Array.isArray(data.pinned) ? data.pinned : [];
  } catch (e) {
    return [];
  }
}

function writePinned(ids) {
  fs.writeFileSync(PINNED_FILE, JSON.stringify({ pinned: ids }, null, 2));
}

function setTicketPinned(ticketId, pinned) {
  const pinnedIds = readPinned();
  const has = pinnedIds.includes(ticketId);
  if (pinned && !has) writePinned([...pinnedIds, ticketId]);
  else if (!pinned && has) writePinned(pinnedIds.filter((id) => id !== ticketId));
}

function parseTitle(md) {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : null;
}

function parseProblemStatement(md) {
  const lines = md.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Problem Statement/i.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return '';
  const out = [];
  for (let i = start; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i]) || /^##\s+/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

function parsePhaseGoal(md) {
  const m = md.match(/^\*\*Goal:\*\*\s*(.+)$/m);
  return m ? m[1].trim() : '';
}

function parseCheckboxes(md, fileId) {
  const lines = md.split('\n');
  const tasks = [];
  lines.forEach((line, idx) => {
    const m = line.match(CHECKBOX_RE);
    if (m) {
      tasks.push({
        fileId,
        lineIndex: idx,
        done: m[2].toLowerCase() === 'x',
        text: m[4].trim(),
      });
    }
  });
  return tasks;
}

function phaseSortKey(filename) {
  const m = filename.match(/phase-(\d+)/i);
  return m ? parseInt(m[1], 10) : 999;
}

function toFileId(absPath) {
  return path.relative(ROOT, absPath).split(path.sep).join('/');
}

function fromFileId(fileId) {
  return path.join(ROOT, fileId.split('/').join(path.sep));
}

// ---------- Build docs tree ----------

// A ticket is a top-level folder directly under .docs/ whose name starts with
// an issue key (letters, hyphen, digits: "MBM-3000", "A-300", "B-3"),
// optionally followed by a slug ("MBM-3000-fix-login"), and which holds at
// least one .md file. Every other folder under .docs/ is a generic doc
// folder, still listed with its contents but without ticket status, phases,
// or progress. Loose .md files directly under .docs/ and anything nested
// deeper are generic doc nodes too.
//
// A brief is optional: if one of BRIEF_FILENAMES is present it is used as the
// ticket's overview (checked in that order, newest naming first, older names
// kept for tickets created before a rename), otherwise the first non-phase
// .md alphabetically stands in, and failing that the first phase file.

const BRIEF_FILENAMES = ['Project Brief.md', 'brief.md', 'assessment.md'];

const PHASE_RE = /^phase-\d+.*\.md$/i;

// Anchored at the start so a key-prefixed slug still matches, but a folder
// that merely contains a key-like substring ("notes-for-MBM-3000") does not.
const TICKET_KEY_RE = /^[A-Za-z]+-\d+(?:-|$)/;

function isTicketFolderName(name) {
  return TICKET_KEY_RE.test(name);
}

// Returns the path to use as the ticket's overview doc, or null if the folder
// holds no markdown at all (in which case it is not a ticket).
function resolveBriefPath(ticketDir) {
  for (const name of BRIEF_FILENAMES) {
    const p = path.join(ticketDir, name);
    if (fs.existsSync(p)) return p;
  }
  let entries;
  try {
    entries = fs.readdirSync(ticketDir, { withFileTypes: true });
  } catch (e) {
    return null;
  }
  const mds = entries
    .filter((e) => e.isFile() && !e.name.startsWith('.') && /\.md$/i.test(e.name))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  if (!mds.length) return null;
  // Prefer a non-phase doc so the overview isn't "Phase 1" when the folder
  // has both; a phase-only folder falls back to its first phase.
  const preferred = mds.find((f) => !PHASE_RE.test(f)) || mds[0];
  return path.join(ticketDir, preferred);
}

function buildFileDocNode(absPath) {
  const md = fs.readFileSync(absPath, 'utf8');
  const nameMatch = md.match(/^#\s+(.+)$/m);
  return {
    type: 'file',
    fileId: toFileId(absPath),
    filename: path.basename(absPath),
    name: nameMatch ? nameMatch[1].trim() : path.basename(absPath).replace(/\.md$/i, ''),
    markdown: md,
  };
}

function buildTicketNode(ticketDir, branch, repoLabel) {
  const assessmentPath = resolveBriefPath(ticketDir);
  const assessmentMd = fs.readFileSync(assessmentPath, 'utf8');
  const assessmentFileId = toFileId(assessmentPath);
  let lastUpdated = fs.statSync(assessmentPath).mtime;
  const createdAt = fs.statSync(ticketDir).birthtime;
  const id = `${repoLabel}::${branch}`;
  const pinned = readPinned().includes(id);

  const entries = fs.readdirSync(ticketDir);

  const briefFilename = path.basename(assessmentPath);

  const phaseFiles = entries
    .filter((f) => PHASE_RE.test(f) && f !== briefFilename)
    .sort((a, b) => phaseSortKey(a) - phaseSortKey(b));

  const phases = [];
  let totalTasks = 0;
  let doneTasks = 0;

  for (const pf of phaseFiles) {
    const pPath = path.join(ticketDir, pf);
    const pMd = fs.readFileSync(pPath, 'utf8');
    const pStat = fs.statSync(pPath);
    if (pStat.mtime > lastUpdated) lastUpdated = pStat.mtime;
    const fileId = toFileId(pPath);
    const tasks = parseCheckboxes(pMd, fileId);
    totalTasks += tasks.length;
    doneTasks += tasks.filter((t) => t.done).length;

    const nameMatch = pMd.match(/^#\s+(.+)$/m);
    phases.push({
      fileId,
      filename: pf,
      name: nameMatch ? nameMatch[1].trim() : pf,
      goal: parsePhaseGoal(pMd),
      tasks,
      progress: tasks.length ? Math.round((tasks.filter((t) => t.done).length / tasks.length) * 100) : 0,
      markdown: pMd,
    });
  }

  const notesFiles = entries
    .filter((f) => /\.md$/i.test(f) && f !== briefFilename && !PHASE_RE.test(f))
    .sort();

  const notes = [];
  for (const nf of notesFiles) {
    const nPath = path.join(ticketDir, nf);
    const nMd = fs.readFileSync(nPath, 'utf8');
    const nStat = fs.statSync(nPath);
    if (nStat.mtime > lastUpdated) lastUpdated = nStat.mtime;
    const nameMatch = nMd.match(/^#\s+(.+)$/m);
    notes.push({
      fileId: toFileId(nPath),
      filename: nf,
      name: nameMatch ? nameMatch[1].trim() : nf.replace(/\.md$/i, ''),
      markdown: nMd,
    });
  }

  const overallProgress = totalTasks ? Math.round((doneTasks / totalTasks) * 100) : 0;
  let status = 'not-started';
  if (totalTasks > 0 && overallProgress === 100) status = 'done';
  else if (doneTasks > 0) status = 'in-progress';
  const manualStatus = readManualStatus(ticketDir);
  if (manualStatus) status = manualStatus;
  const label = readTicketLabel(ticketDir);

  return {
    type: 'ticket',
    id,
    branch,
    title: parseTitle(assessmentMd) || branch,
    problemExcerpt: parseProblemStatement(assessmentMd),
    assessmentMarkdown: assessmentMd,
    assessmentFileId,
    phases,
    notes,
    totalTasks,
    doneTasks,
    overallProgress,
    status,
    label,
    lastUpdated,
    createdAt,
    pinned,
  };
}

// topLevel: only direct children of .docs/ are eligible to be tickets, and
// only those named with an issue key (see isTicketFolderName). Deeper folders
// (e.g. .docs/review/) and unkeyed ones are always generic doc folders.
function scanDocsChildren(dir, depth, topLevel, repoLabel) {
  if (depth < 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return [];
  }
  entries = entries
    .filter((e) => !e.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const nodes = [];
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (topLevel && isTicketFolderName(e.name) && resolveBriefPath(full)) {
        nodes.push(buildTicketNode(full, e.name, repoLabel));
      } else {
        const children = scanDocsChildren(full, depth - 1, false, repoLabel);
        if (children.length) nodes.push({ type: 'folder', name: e.name, children });
      }
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      nodes.push(buildFileDocNode(full));
    }
  }
  return sortDocsNodes(nodes);
}

// Folders first, then tickets (pinned first, then most recently created
// folder first), then loose files.
function sortDocsNodes(nodes) {
  const GROUP_RANK = { folder: 0, ticket: 1, file: 2 };
  return nodes.slice().sort((a, b) => {
    const rankDiff = GROUP_RANK[a.type] - GROUP_RANK[b.type];
    if (rankDiff !== 0) return rankDiff;
    if (a.type === 'ticket') {
      const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
      if (pinDiff !== 0) return pinDiff;
      return b.createdAt - a.createdAt;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

// Returns { tickets, projects }. `tickets` is the flat list of every ticket
// across every project (used for kanban/today/rail/search). `projects` is
// one entry per repo that has a .docs folder, holding a lightweight doc
// tree for the sidebar (ticket nodes are just {type:'ticket', id} pointers
// back into `tickets`, so the full ticket payload isn't duplicated).
function buildProjects() {
  const repos = findGitRepos(ROOT);
  const projects = [];
  const tickets = [];

  for (const repoDir of repos) {
    const docsDir = path.join(repoDir, '.docs');
    if (!fs.existsSync(docsDir)) continue;

    const repoLabel = path.relative(ROOT, repoDir).split(path.sep).join('/') || path.basename(repoDir);
    const repoBranch = currentBranch(repoDir);
    const rawTree = scanDocsChildren(docsDir, 6, true, repoLabel);

    const toLightweight = (nodes) =>
      nodes.map((n) => {
        if (n.type === 'ticket') {
          tickets.push({
            id: n.id,
            repo: repoLabel,
            repoBranch,
            branch: n.branch,
            title: n.title,
            problemExcerpt: n.problemExcerpt,
            assessmentMarkdown: n.assessmentMarkdown,
            assessmentFileId: n.assessmentFileId,
            phases: n.phases,
            notes: n.notes,
            totalTasks: n.totalTasks,
            doneTasks: n.doneTasks,
            overallProgress: n.overallProgress,
            status: n.status,
            label: n.label,
            lastUpdated: n.lastUpdated.toISOString(),
            createdAt: n.createdAt.toISOString(),
            pinned: n.pinned,
          });
          return { type: 'ticket', id: n.id };
        }
        if (n.type === 'folder') {
          return { type: 'folder', name: n.name, children: toLightweight(n.children) };
        }
        return n;
      });

    projects.push({ repo: repoLabel, repoBranch, docsTree: toLightweight(rawTree) });
  }

  tickets.sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
  return { tickets, projects, labels: readLabels() };
}

function buildTickets() {
  return buildProjects().tickets;
}

// ---------- Sticky notes (corkboard) ----------
// Notes live in their own JSON store, board-local like labels — they're not
// part of any repo's markdown, so they persist even if pinned tickets are
// deleted (pin just goes stale, note stays put on the board).

const NOTES_FILE = path.join(SELF, '.notes.json');
const NOTE_COLORS = new Set(['yellow', 'pink', 'blue', 'green', 'orange']);

function readNotes() {
  try {
    const data = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(data.notes) ? data.notes : [];
  } catch (e) {
    return [];
  }
}

function writeNotes(notes) {
  fs.writeFileSync(NOTES_FILE, JSON.stringify({ notes }, null, 2));
}

function makeNoteId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function validateRemind(remind) {
  if (remind == null) return null;
  const at = new Date(remind.at).getTime();
  if (isNaN(at)) throw new Error('invalid reminder time');
  return { at: new Date(at).toISOString(), fired: false };
}

function createNote({ title, text, color, x, y, pinTicketId, remind }) {
  const trimmed = (text || '').trim();
  const trimmedTitle = (title || '').trim();
  // Neither field is required. A title with no body is a normal way to jot
  // something down, and a blank note is a blank sheet waiting to be typed into
  // (double-clicking the board creates one) -- a note is always visible paper
  // with its own controls, so there is nothing to lose track of.
  if (pinTicketId && !buildTickets().some((t) => t.id === pinTicketId)) {
    throw new Error('unknown ticket');
  }
  const notes = readNotes();
  notes.push({
    id: makeNoteId(),
    title: trimmedTitle,
    text: trimmed,
    color: NOTE_COLORS.has(color) ? color : 'yellow',
    x: Number.isFinite(x) ? x : 40,
    y: Number.isFinite(y) ? y : 40,
    // Kept under +/-1.5deg: enough to read as paper rather than a UI card,
    // little enough that a long line of text stays comfortable to read.
    rotation: Math.round((Math.random() - 0.5) * 3 * 10) / 10,
    done: false,
    z: notes.reduce((m, n) => Math.max(m, n.z || 0), 0) + 1,
    collapsed: false,
    pinTicketId: pinTicketId || null,
    remind: validateRemind(remind),
    createdAt: new Date().toISOString(),
  });
  writeNotes(notes);
  return notes;
}

const NOTE_MIN_W = 190;
const NOTE_MIN_H = 140;
const NOTE_PATCH_KEYS = ['title', 'text', 'color', 'x', 'y', 'w', 'h', 'hPrev', 'z', 'rotation', 'done', 'collapsed', 'pinTicketId', 'remind'];

// Applies a patch in place. Split out from updateNote so the bulk endpoint can
// reuse the exact same validation without re-reading the file per note.
function applyNotePatch(note, patch, ticketsRef) {
  for (const key of NOTE_PATCH_KEYS) {
    if (!(key in patch)) continue;
    if (key === 'remind') {
      note.remind = validateRemind(patch.remind);
    } else if (key === 'color') {
      note.color = NOTE_COLORS.has(patch.color) ? patch.color : note.color;
    } else if (key === 'pinTicketId') {
      if (patch.pinTicketId) {
        if (ticketsRef.tickets == null) ticketsRef.tickets = buildTickets();
        if (!ticketsRef.tickets.some((t) => t.id === patch.pinTicketId)) {
          throw new Error('unknown ticket');
        }
      }
      note.pinTicketId = patch.pinTicketId || null;
    } else if (key === 'w' || key === 'h') {
      const min = key === 'w' ? NOTE_MIN_W : NOTE_MIN_H;
      note[key] = Number.isFinite(patch[key]) ? Math.max(min, patch[key]) : note[key];
    } else if (key === 'hPrev') {
      // The height to restore when "less" is pressed. Explicitly nullable:
      // null is how the note records that it is no longer expanded.
      note.hPrev = Number.isFinite(patch.hPrev) ? Math.max(NOTE_MIN_H, patch.hPrev) : null;
    } else if (key === 'z') {
      note.z = Number.isFinite(patch.z) ? Math.max(0, Math.round(patch.z)) : note.z;
    } else if (key === 'done' || key === 'collapsed') {
      note[key] = !!patch[key];
    } else if (key === 'title' || key === 'text') {
      note[key] = String(patch[key] == null ? '' : patch[key]);
    } else {
      note[key] = patch[key];
    }
  }
}

function updateNote(id, patch) {
  const notes = readNotes();
  const note = notes.find((n) => n.id === id);
  if (!note) throw new Error('unknown note');
  applyNotePatch(note, patch, { tickets: null });
  writeNotes(notes);
  return notes;
}

// One read, one write, for the whole batch. Tidy up used to fire N parallel
// single-note updates, each of which rewrote the entire file -- wasteful, and
// last-write-wins meant some positions could be lost.
function bulkUpdateNotes(updates) {
  if (!Array.isArray(updates)) throw new Error('updates array required');
  const notes = readNotes();
  const ticketsRef = { tickets: null };
  for (const u of updates) {
    const note = notes.find((n) => n.id === (u && u.id));
    if (!note) throw new Error('unknown note');
    applyNotePatch(note, (u && u.patch) || {}, ticketsRef);
  }
  writeNotes(notes);
  return notes;
}

function deleteNote(id) {
  const notes = readNotes();
  const next = notes.filter((n) => n.id !== id);
  if (next.length === notes.length) throw new Error('unknown note');
  writeNotes(next);
  return next;
}

// osascript's `display notification` routes through Script Editor's bundle
// identity (com.apple.ScriptEditor2), which can end up in a broken
// registration state where macOS silently drops every notification. See
// https://github.com/julienXX/terminal-notifier — it has an independent,
// properly-registered bundle, so it doesn't hit that failure mode.
// Resolved lazily via PATH rather than hardcoded, since it's an optional,
// macOS-only, brew-installed tool: on any other setup we just skip OS
// notifications and rely on the in-app reminder poll instead.
const NOTIF_SOUND = 'Glass';
let terminalNotifierPath;
function resolveTerminalNotifier() {
  if (terminalNotifierPath !== undefined) return terminalNotifierPath;
  try {
    terminalNotifierPath = execFileSync('which', ['terminal-notifier']).toString().trim() || null;
  } catch (e) {
    terminalNotifierPath = null;
  }
  return terminalNotifierPath;
}

// Modern macOS won't let a CLI tool spoof its notification icon (-appIcon
// and -sender both no-op in the compact banner — it always shows
// terminal-notifier's own icon), so we don't try. Sound/subtitle/click-to-
// open/grouping still work and are the actual customization surface left.
function fireOsNotification({ title, text, subtitle, group }) {
  const bin = resolveTerminalNotifier();
  if (!bin) return;
  const args = ['-title', title, '-message', text.slice(0, 200), '-sound', NOTIF_SOUND, '-open', `http://localhost:${PORT}`];
  if (subtitle) args.push('-subtitle', subtitle);
  if (group) args.push('-group', group);
  try {
    execFileSync(bin, args);
  } catch (e) {
    // best-effort; a missing terminal-notifier shouldn't crash the loop
  }
}

let noteRemindersFired = [];
let noteRemindersFiredCounter = 0;

function checkNoteReminders() {
  const now = Date.now();
  const notes = readNotes();
  let changed = false;
  let tickets = null;
  for (const note of notes) {
    if (!note.remind || note.remind.fired) continue;
    if (new Date(note.remind.at).getTime() > now) continue;
    if (note.pinTicketId && tickets == null) tickets = buildTickets();
    const ticket = note.pinTicketId ? tickets.find((t) => t.id === note.pinTicketId) : null;
    const keyMatch = ticket && ticket.branch.match(/^([A-Za-z]+-\d+)/);
    // A title-only note has no text, so fall back to the title rather than
    // firing a notification with an empty body.
    const body = (note.text || '').trim() || (note.title || '').trim();
    fireOsNotification({
      title: 'Project Nemi',
      text: body,
      subtitle: keyMatch ? keyMatch[1].toUpperCase() : null,
      group: note.id,
    });
    note.remind.fired = true;
    noteRemindersFiredCounter++;
    noteRemindersFired.push({
      id: noteRemindersFiredCounter,
      noteId: note.id,
      title: (note.title || '').trim(),
      text: body,
      firedAt: now,
    });
    if (noteRemindersFired.length > 200) noteRemindersFired = noteRemindersFired.slice(-200);
    changed = true;
  }
  if (changed) writeNotes(notes);
}

setInterval(checkNoteReminders, 20000);

// ---------- Toggle ----------

function toggleCheckbox(fileId, lineIndex) {
  const validFileIds = new Set();
  const { tickets, projects } = buildProjects();
  for (const t of tickets) {
    validFileIds.add(t.assessmentFileId);
    for (const p of t.phases) validFileIds.add(p.fileId);
    for (const n of t.notes) validFileIds.add(n.fileId);
  }
  const collectFileNodes = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'file') validFileIds.add(n.fileId);
      else if (n.type === 'folder') collectFileNodes(n.children);
    }
  };
  for (const p of projects) collectFileNodes(p.docsTree);
  if (!validFileIds.has(fileId)) {
    throw new Error('unknown file');
  }
  const absPath = fromFileId(fileId);
  if (!absPath.startsWith(ROOT)) throw new Error('invalid path');

  const content = fs.readFileSync(absPath, 'utf8');
  const lines = content.split('\n');
  if (lineIndex < 0 || lineIndex >= lines.length) throw new Error('bad line');
  const m = lines[lineIndex].match(CHECKBOX_RE);
  if (!m) throw new Error('not a checkbox line');
  const newChar = m[2].toLowerCase() === 'x' ? ' ' : 'x';
  lines[lineIndex] = m[1] + newChar + m[3] + m[4];
  fs.writeFileSync(absPath, lines.join('\n'));
}

function setTicketStatus(ticketId, status) {
  if (!STATUSES.has(status)) throw new Error('invalid status');
  const ticket = buildTickets().find((t) => t.id === ticketId);
  if (!ticket) throw new Error('unknown ticket');
  const ticketDir = path.dirname(fromFileId(ticket.assessmentFileId));
  writeManualStatus(ticketDir, status);
}

function repoDirForTicket(ticket) {
  return path.dirname(path.dirname(path.dirname(fromFileId(ticket.assessmentFileId))));
}

function checkoutBranch(ticketId) {
  const ticket = buildTickets().find((t) => t.id === ticketId);
  if (!ticket) throw new Error('unknown ticket');
  const repoDir = repoDirForTicket(ticket);
  try {
    execFileSync('git', ['checkout', ticket.branch], { cwd: repoDir, stdio: 'pipe' });
  } catch (e) {
    throw new Error(e.stderr ? e.stderr.toString().trim() : e.message);
  }
}

// ---------- HTTP server ----------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(SELF, 'public', rel);
  if (!filePath.startsWith(path.join(SELF, 'public'))) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = '';
    req.on('data', (c) => (chunks += c));
    req.on('end', () => resolve(chunks));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);

  if (parsed.pathname === '/api/tickets' && req.method === 'GET') {
    let data;
    try {
      data = buildProjects();
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: e.message }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ root: ROOT, tickets: data.tickets, projects: data.projects, labels: data.labels }));
  }

  if (parsed.pathname === '/api/toggle' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      toggleCheckbox(body.fileId, body.lineIndex);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/status' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      setTicketStatus(body.ticketId, body.status);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/checkout' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      checkoutBranch(body.ticketId);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/ticket-label' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      assignTicketLabel(body.ticketId, body.label);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/ticket-pin' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      setTicketPinned(body.ticketId, !!body.pinned);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/labels/create' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      createLabel(body.name);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/labels/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      deleteLabel(body.name);
      const data = buildProjects();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, tickets: data.tickets, projects: data.projects, labels: data.labels }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/notes' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ notes: readNotes() }));
  }

  if (parsed.pathname === '/api/notes/create' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const notes = createNote(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, notes }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/notes/update' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const notes = updateNote(body.id, body.patch || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, notes }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/notes/bulkUpdate' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const notes = bulkUpdateNotes(body.updates);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, notes }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/notes/delete' && req.method === 'POST') {
    try {
      const body = JSON.parse(await readBody(req));
      const notes = deleteNote(body.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, notes }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  if (parsed.pathname === '/api/notes/reminders/due' && req.method === 'GET') {
    const after = parseInt(parsed.query.after, 10) || 0;
    const due = noteRemindersFired.filter((r) => r.id > after);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ reminders: due }));
  }

  return serveStatic(req, res, parsed.pathname);
});

server.listen(PORT, () => {
  console.log(`Project Nemi running at http://localhost:${PORT}`);
  console.log(`Scanning: ${ROOT}`);
});
