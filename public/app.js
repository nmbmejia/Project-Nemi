const STATUS_RANK = { 'in-progress': 0, 'not-started': 1, 'done': 2 };
const STATUS_LABEL = { 'not-started': 'Not started', 'in-progress': 'In progress', 'done': 'Done' };
const STALE_DAYS = 3;

let state = {
  tickets: [],
  projects: [],
  labels: [],
  notes: [],
  hideDoneNotes: localStorage.getItem('hideDoneNotes') === '1',
  search: '',
  view: localStorage.getItem('view') || 'tree',
  hideDone: localStorage.getItem('hideDone') === '1',
  labelFilter: localStorage.getItem('labelFilter') || null,
  expandedProjects: new Set(),
  expandedTickets: new Set(),
  expandedNoteGroups: new Set(),
  expandedFolders: new Set(),
  expandedTaskGroups: new Set(),
  selectedTicketId: null,
  selectedDoc: null,
  selectedKey: null,
};

function isStale(t) {
  if (t.status === 'done') return false;
  const ageMs = Date.now() - new Date(t.lastUpdated).getTime();
  return ageMs > STALE_DAYS * 86400000;
}

// Deterministic per-label color: same label name always lands on the same
// hue, so labels stay visually distinguishable as the label list grows
// (same approach GitHub/Linear use for tag colors), without storing a color.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function labelColorStyle(name) {
  const hue = hashString(name) % 360;
  const dark = effectiveTheme() === 'dark';
  const text = `hsl(${hue} 70% ${dark ? 75 : 32}%)`;
  const bg = `hsl(${hue} 70% ${dark ? 50 : 45}% / ${dark ? 0.22 : 0.12})`;
  return `color:${text};background:${bg}`;
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function stripLeadingH1(md) {
  const lines = md.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && /^#\s+.+$/.test(lines[i])) {
    lines.splice(i, 1);
    return lines.join('\n');
  }
  return md;
}

function prettyName(s) {
  return s
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => (/^[A-Z0-9]+$/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join(' ');
}

function ticketKeyLabel(branch) {
  const m = branch.match(/^([A-Za-z]+-\d+)-?(.*)$/);
  if (!m) return prettyName(branch);
  const key = m[1].toUpperCase();
  const rest = m[2] ? prettyName(m[2]) : '';
  return rest ? `${key}: ${rest}` : key;
}

function repoFolderName(repo) {
  return repo.split('/').pop();
}

function escapeText(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// escapeText() escapes < > &, but NOT quotes, so it is not safe inside an
// attribute value -- a string containing a double quote would break out of it.
// Anything interpolated into an attribute goes through this instead.
function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------- Data shaping ----------

function ticketDocs(t) {
  const docs = [{
    key: t.assessmentFileId,
    name: 'Project Brief',
    kind: 'assessment',
    markdown: t.assessmentMarkdown,
    tasks: null,
  }];
  for (const p of t.phases) {
    docs.push({
      key: p.fileId,
      name: p.name,
      kind: 'phase',
      markdown: p.markdown,
      tasks: p.tasks,
      progress: p.progress,
      doneTasks: p.tasks.filter((x) => x.done).length,
      totalTasks: p.tasks.length,
    });
  }
  for (const n of t.notes || []) {
    docs.push({
      key: n.fileId,
      name: n.name,
      kind: 'note',
      filename: n.filename,
      markdown: n.markdown,
      tasks: null,
    });
  }
  return docs;
}

function matchesSearch(t, q) {
  if (t.title.toLowerCase().includes(q)) return true;
  if (t.branch.toLowerCase().includes(q)) return true;
  return ticketDocs(t).some((d) => d.name.toLowerCase().includes(q) || d.markdown.toLowerCase().includes(q));
}

function docNodeMatchesSearch(node, q) {
  if (node.type === 'ticket') {
    const t = state.tickets.find((x) => x.id === node.id);
    return t ? matchesSearch(t, q) : false;
  }
  if (node.type === 'file') {
    return (
      node.name.toLowerCase().includes(q) ||
      node.filename.toLowerCase().includes(q) ||
      node.markdown.toLowerCase().includes(q)
    );
  }
  if (node.type === 'folder') {
    return node.name.toLowerCase().includes(q) || node.children.some((c) => docNodeMatchesSearch(c, q));
  }
  return false;
}

function projectSortValue(project) {
  const tickets = state.tickets.filter((t) => t.repo === project.repo);
  if (!tickets.length) return { rank: 3, lastUpdated: 0 };
  const best = tickets.reduce((a, b) => (STATUS_RANK[b.status] < STATUS_RANK[a.status] ? b : a));
  const latest = Math.max(...tickets.map((t) => new Date(t.lastUpdated).getTime()));
  return { rank: STATUS_RANK[best.status], lastUpdated: latest };
}

function applyHideDone(nodes) {
  if (!state.hideDone) return nodes;
  const out = [];
  for (const n of nodes) {
    if (n.type === 'ticket') {
      const t = state.tickets.find((x) => x.id === n.id);
      if (t && t.status === 'done') continue;
      out.push(n);
    } else if (n.type === 'folder') {
      out.push({ ...n, children: applyHideDone(n.children) });
    } else {
      out.push(n);
    }
  }
  return out;
}

// A label filter is a focused view: only tickets carrying that label
// survive. Unlike hideDone, loose docs/folders (which aren't label-scoped)
// are dropped too, and folders left with nothing matching disappear.
function applyLabelFilter(nodes) {
  if (!state.labelFilter) return nodes;
  const out = [];
  for (const n of nodes) {
    if (n.type === 'ticket') {
      const t = state.tickets.find((x) => x.id === n.id);
      if (t && t.label === state.labelFilter) out.push(n);
    } else if (n.type === 'folder') {
      const children = applyLabelFilter(n.children);
      if (children.length) out.push({ ...n, children });
    }
  }
  return out;
}

function matchesActiveLabel(t) {
  return !state.labelFilter || t.label === state.labelFilter;
}

// ---------- Sidebar ----------

// Small inline SVG icon set for the sidebar tree (16x16, stroke-based,
// currentColor so they pick up row text color and theme automatically).
const TREE_ICONS = {
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>',
  folder: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7z"></path></svg>',
  doc: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1z"></path><polyline points="15 2 15 7 20 7"></polyline></svg>',
  pin: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="17" x2="12" y2="22"></line><path d="M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3z"></path></svg>',
  branch: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"></line><circle cx="18" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><path d="M18 9a9 9 0 0 1-9 9"></path></svg>',
};

function treeIcon(name, extraClass) {
  return `<span class="tree-icon${extraClass ? ' ' + extraClass : ''}">${TREE_ICONS[name]}</span>`;
}

function renderSidebar() {
  const container = document.getElementById('sidebar');
  const q = state.search.trim().toLowerCase();

  const projectOrder = [...state.projects].sort((a, b) => {
    const sa = projectSortValue(a);
    const sb = projectSortValue(b);
    if (sa.rank !== sb.rank) return sa.rank - sb.rank;
    return sb.lastUpdated - sa.lastUpdated;
  });

  container.innerHTML = '';
  let any = false;

  for (const project of projectOrder) {
    const repoMatches = project.repo.toLowerCase().includes(q);
    let nodes = project.docsTree;
    if (q && !repoMatches) {
      nodes = project.docsTree.filter((n) => docNodeMatchesSearch(n, q));
      if (!nodes.length) continue;
    }
    nodes = applyHideDone(nodes);
    nodes = applyLabelFilter(nodes);
    if (!nodes.length) continue;
    any = true;
    container.appendChild(buildProjectEl(project, nodes, q));
  }

  if (!any) {
    container.innerHTML = '<div class="tree-empty">No matches</div>';
  }
}

function buildProjectEl(project, nodes, q) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-project';

  const expanded = !!q || state.expandedProjects.has(project.repo);

  const header = document.createElement('button');
  header.className = 'tree-row';
  const projectLabel = prettyName(repoFolderName(project.repo));
  const openCount = state.tickets.filter(
    (t) => t.repo === project.repo && t.status !== 'done' && matchesActiveLabel(t)
  ).length;
  const countBadge = openCount ? `<span class="project-count-badge">${openCount} open</span>` : '';
  header.innerHTML = `<span class="chevron ${expanded ? 'open' : ''}">${treeIcon('chevron')}</span><span class="tree-title" title="${escapeText(projectLabel)}">${escapeText(projectLabel)}</span>${countBadge}`;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tree-project-body' + (expanded ? ' expanded' : '');
  const inner = document.createElement('div');
  inner.className = 'tree-project-body-inner';
  for (const n of nodes) {
    inner.appendChild(buildDocsNodeEl(n, project, q, ''));
  }
  body.appendChild(inner);
  wrap.appendChild(body);

  header.addEventListener('click', () => {
    const willExpand = !state.expandedProjects.has(project.repo);
    if (willExpand) state.expandedProjects.add(project.repo);
    else state.expandedProjects.delete(project.repo);
    header.querySelector('.chevron').classList.toggle('open', willExpand);
    body.classList.toggle('expanded', willExpand);
  });

  return wrap;
}

function buildDocsNodeEl(node, project, q, parentPath) {
  if (node.type === 'ticket') {
    const t = state.tickets.find((x) => x.id === node.id);
    if (!t) return document.createElement('div');
    return buildTicketEl(t, q);
  }
  if (node.type === 'file') {
    return buildFileDocEl(node, project);
  }
  return buildFolderDocEl(node, project, q, parentPath);
}

function buildFileDocEl(node, project) {
  const btn = document.createElement('button');
  btn.className = 'tree-row tree-doc' + (state.selectedKey === node.fileId ? ' active' : '');
  btn.innerHTML = `${treeIcon('doc', 'tree-doc-icon')}<span class="tree-title" title="${escapeText(node.name)}">${escapeText(node.name)}</span>`;
  btn.addEventListener('click', () => selectStandaloneDoc(project.repo, node));
  return btn;
}

function buildFolderDocEl(node, project, q, parentPath) {
  const folderPath = parentPath ? `${parentPath}/${node.name}` : node.name;
  const folderKey = `${project.repo}::${folderPath}`;
  const wrap = document.createElement('div');
  wrap.className = 'tree-ticket';

  const expanded = !!q || state.expandedFolders.has(folderKey);

  const header = document.createElement('button');
  header.className = 'tree-row tree-ticket-header';
  header.innerHTML = `<span class="chevron ${expanded ? 'open' : ''}">${treeIcon('chevron')}</span>${treeIcon('folder', 'tree-folder-icon')}<span class="tree-title" title="${escapeText(node.name)}">${escapeText(node.name)}</span>`;
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tree-ticket-body' + (expanded ? ' expanded' : '');
  const inner = document.createElement('div');
  inner.className = 'tree-ticket-body-inner';
  const children = q ? node.children.filter((c) => docNodeMatchesSearch(c, q)) : node.children;
  for (const c of children) {
    inner.appendChild(buildDocsNodeEl(c, project, q, folderPath));
  }
  body.appendChild(inner);
  wrap.appendChild(body);

  header.addEventListener('click', () => {
    const willExpand = !state.expandedFolders.has(folderKey);
    if (willExpand) state.expandedFolders.add(folderKey);
    else state.expandedFolders.delete(folderKey);
    header.querySelector('.chevron').classList.toggle('open', willExpand);
    body.classList.toggle('expanded', willExpand);
  });

  return wrap;
}

function buildTicketEl(t, q) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-ticket';

  const expanded = !!q || state.expandedTickets.has(t.id);

  const isCurrentBranch = t.branch === t.repoBranch;
  // A plain div (not <button>) since it needs to host the pin toggle as its
  // own nested button — a <button> can't legally contain another <button>.
  const header = document.createElement('div');
  header.className = 'tree-row tree-ticket-header';
  const ticketLabel = ticketKeyLabel(t.branch);
  // Label/stale/branch metadata is folded into the row's title tooltip
  // instead of always-on badges, keeping the row a single compact line;
  // full metadata is still visible once the ticket's brief is open.
  const metaParts = [t.branch];
  if (t.label) metaParts.push(`Label: ${t.label}`);
  if (isStale(t)) metaParts.push(`Stale (no updates in ${STALE_DAYS}+ days)`);
  if (isCurrentBranch) metaParts.push('Repo is currently on this branch');
  header.innerHTML = `
    <span class="chevron ${expanded ? 'open' : ''}">${treeIcon('chevron')}</span>
    ${treeIcon('doc', 'tree-doc-icon')}
    <span class="tree-title" title="${escapeText(metaParts.join(' • '))}">${escapeText(ticketLabel)}</span>
    <span class="tree-status-dot ${t.status}" title="${STATUS_LABEL[t.status]}"></span>
    <button type="button" class="tree-pin-btn${t.pinned ? ' pinned' : ''}" title="${t.pinned ? 'Unpin' : 'Pin to top'}">${treeIcon('pin')}</button>
  `;
  header.querySelector('.tree-pin-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleTicketPin(t.id, !t.pinned);
  });
  wrap.appendChild(header);

  const body = document.createElement('div');
  body.className = 'tree-ticket-body' + (expanded ? ' expanded' : '');
  const inner = document.createElement('div');
  inner.className = 'tree-ticket-body-inner';

  // "Test Cases" stays a core doc alongside the brief/phases; other loose
  // notes (scratch investigation writeups etc) fold under a group toggle so
  // an expanded ticket doesn't dump 8-9 flat rows at once.
  const allDocs = ticketDocs(t);
  const coreDocs = allDocs.filter((d) => d.kind !== 'note' || d.name === 'Test Cases');
  const extraNotes = allDocs.filter((d) => d.kind === 'note' && d.name !== 'Test Cases');

  const buildDocBtn = (d) => {
    const btn = document.createElement('button');
    btn.className = 'tree-row tree-doc' + (state.selectedKey === d.key ? ' active' : '');
    btn.innerHTML = `${treeIcon('doc', 'tree-doc-icon')}<span class="tree-title" title="${escapeText(d.name)}">${escapeText(d.name)}</span>`;
    btn.addEventListener('click', () => selectDoc(t.id, d.key));
    return btn;
  };

  for (const d of coreDocs) inner.appendChild(buildDocBtn(d));

  if (extraNotes.length) {
    const noteSelected = extraNotes.some((d) => d.key === state.selectedKey);
    const notesExpanded = !!q || noteSelected || state.expandedNoteGroups.has(t.id);
    const notesToggle = document.createElement('button');
    notesToggle.className = 'tree-row tree-doc tree-notes-toggle';
    notesToggle.innerHTML = `<span class="chevron ${notesExpanded ? 'open' : ''}">${treeIcon('chevron')}</span><span class="tree-title">Notes (${extraNotes.length})</span>`;
    notesToggle.addEventListener('click', () => {
      if (state.expandedNoteGroups.has(t.id)) state.expandedNoteGroups.delete(t.id);
      else state.expandedNoteGroups.add(t.id);
      renderSidebar();
    });
    inner.appendChild(notesToggle);
    if (notesExpanded) {
      for (const d of extraNotes) inner.appendChild(buildDocBtn(d));
    }
  }

  body.appendChild(inner);
  wrap.appendChild(body);

  header.addEventListener('click', () => {
    const willExpand = !state.expandedTickets.has(t.id);
    if (willExpand) {
      // Accordion: only one ticket per project stays open, so the sidebar
      // doesn't just keep growing as you click through several tickets.
      for (const sibling of state.tickets) {
        if (sibling.repo === t.repo && sibling.id !== t.id) state.expandedTickets.delete(sibling.id);
      }
      state.expandedTickets.add(t.id);
    } else {
      state.expandedTickets.delete(t.id);
    }
    renderSidebar();
  });

  return wrap;
}

function saveSelection() {
  if (state.selectedDoc) {
    localStorage.setItem('nemejiSelection', JSON.stringify({ kind: 'file', fileId: state.selectedDoc.key }));
  } else if (state.selectedTicketId) {
    localStorage.setItem(
      'nemejiSelection',
      JSON.stringify({ kind: 'ticket', ticketId: state.selectedTicketId, key: state.selectedKey })
    );
  }
}

function findFileNodeIn(nodes, fileId) {
  for (const n of nodes) {
    if (n.type === 'file' && n.fileId === fileId) return n;
    if (n.type === 'folder') {
      const found = findFileNodeIn(n.children, fileId);
      if (found) return found;
    }
  }
  return null;
}

function findFileNode(fileId) {
  for (const project of state.projects) {
    const found = findFileNodeIn(project.docsTree, fileId);
    if (found) return { project, node: found };
  }
  return null;
}

function restoreSelection() {
  let sel;
  try {
    sel = JSON.parse(localStorage.getItem('nemejiSelection'));
  } catch (e) {
    return false;
  }
  if (!sel) return false;

  if (sel.kind === 'ticket') {
    const t = state.tickets.find((x) => x.id === sel.ticketId);
    if (!t) return false;
    const docs = ticketDocs(t);
    const key = docs.some((d) => d.key === sel.key) ? sel.key : t.assessmentFileId;
    state.selectedDoc = null;
    state.selectedTicketId = t.id;
    state.selectedKey = key;
    state.expandedProjects.add(t.repo);
    state.expandedTickets.add(t.id);
    return true;
  }

  if (sel.kind === 'file') {
    const found = findFileNode(sel.fileId);
    if (!found) return false;
    state.selectedTicketId = null;
    state.selectedDoc = { key: found.node.fileId, name: found.node.name, markdown: found.node.markdown };
    state.selectedKey = found.node.fileId;
    state.expandedProjects.add(found.project.repo);
    return true;
  }

  return false;
}

function selectDoc(ticketId, key) {
  const t = state.tickets.find((x) => x.id === ticketId);
  if (!t) return;
  state.selectedDoc = null;
  state.selectedTicketId = ticketId;
  state.selectedKey = key;
  state.expandedProjects.add(t.repo);
  state.expandedTickets.add(t.id);
  saveSelection();
  renderSidebar();
  renderDoc();
  renderRail();
}

function selectStandaloneDoc(repo, node) {
  state.selectedTicketId = null;
  state.selectedDoc = { key: node.fileId, name: node.name, markdown: node.markdown };
  state.selectedKey = node.fileId;
  state.expandedProjects.add(repo);
  saveSelection();
  renderSidebar();
  renderDoc();
  renderRail();
}

// ---------- Doc pane ----------

function renderDoc() {
  const pane = document.getElementById('docPane');

  if (state.selectedDoc) {
    const doc = state.selectedDoc;
    pane.innerHTML = `
      <h1 class="doc-title">${escapeText(doc.name)}</h1>
      <div class="md-body" id="docBody">${mdToHtml(stripLeadingH1(doc.markdown))}</div>
    `;
    pane.querySelectorAll('.md-checklist').forEach((ul, i) => groupCompletedTasks(ul, `${doc.key}::${i}`));
    return;
  }

  const t = state.tickets.find((x) => x.id === state.selectedTicketId);

  if (!t) {
    pane.innerHTML = '<div class="doc-empty">Select a doc from the sidebar.</div>';
    return;
  }
  const docs = ticketDocs(t);
  const doc = docs.find((d) => d.key === state.selectedKey) || docs[0];
  if (!doc) {
    pane.innerHTML = '<div class="doc-empty">No docs in this ticket.</div>';
    return;
  }
  state.selectedKey = doc.key;

  pane.innerHTML = `
    <h1 class="doc-title">${escapeText(doc.name)}</h1>
    <div class="md-body" id="docBody">${mdToHtml(stripLeadingH1(doc.markdown))}</div>
  `;

  if (doc.kind === 'phase' && doc.tasks && doc.tasks.length) {
    const items = pane.querySelectorAll('.md-checklist li.task-item');
    if (items.length === doc.tasks.length) {
      items.forEach((li, i) => {
        const task = doc.tasks[i];
        li.dataset.fileId = task.fileId;
        li.dataset.lineIndex = task.lineIndex;
        li.addEventListener('click', () => toggleTask(task.fileId, task.lineIndex));
      });
    }
  }

  pane.querySelectorAll('.md-checklist').forEach((ul, i) => groupCompletedTasks(ul, `${doc.key}::${i}`));
}

function groupCompletedTasks(ul, groupKey) {
  const items = Array.from(ul.children);
  const open = items.filter((li) => !li.classList.contains('checked'));
  const done = items.filter((li) => li.classList.contains('checked'));
  if (!done.length) return;

  open.forEach((li) => ul.appendChild(li));

  const isExpanded = state.expandedTaskGroups.has(groupKey);
  const wrap = document.createElement('li');
  wrap.className = 'task-done-group';
  wrap.innerHTML = `
    <button type="button" class="task-done-toggle${isExpanded ? ' open' : ''}">
      <span class="chevron">&#9656;</span> Completed (${done.length})
    </button>
    <div class="task-done-list-wrap${isExpanded ? ' expanded' : ''}">
      <ul class="task-done-list"></ul>
    </div>
  `;
  ul.appendChild(wrap);

  const doneListWrap = wrap.querySelector('.task-done-list-wrap');
  const doneList = wrap.querySelector('.task-done-list');
  done.forEach((li) => doneList.appendChild(li));

  const toggle = wrap.querySelector('.task-done-toggle');
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const willExpand = !doneListWrap.classList.contains('expanded');
    doneListWrap.classList.toggle('expanded', willExpand);
    toggle.classList.toggle('open', willExpand);
    if (willExpand) state.expandedTaskGroups.add(groupKey);
    else state.expandedTaskGroups.delete(groupKey);
  });
}

// ---------- Right rail ----------

const COPY_ICON_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

// Fills el with fullText, wrapped up to maxLines. If that overflows, cuts
// from the front (prefixed with an ellipsis) instead of the CSS-native
// line-clamp-from-the-end, since the end of a file path (the filename) is
// the part worth keeping visible. Binary search over how many trailing
// characters fit, since text height only shrinks monotonically as more of
// the front is dropped.
function truncateFront(el, fullText, maxLines) {
  el.textContent = fullText;
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 16;
  const maxHeight = lineHeight * maxLines + 1;
  if (el.scrollHeight <= maxHeight) return;

  let lo = 0;
  let hi = fullText.length;
  let best = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    el.textContent = '…' + fullText.slice(fullText.length - mid);
    if (el.scrollHeight <= maxHeight) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  el.textContent = '…' + fullText.slice(fullText.length - best);
}

function renderRail() {
  const rail = document.getElementById('rail');
  const t = state.tickets.find((x) => x.id === state.selectedTicketId);
  if (!t) {
    rail.innerHTML = '';
    return;
  }
  const docs = ticketDocs(t);
  const doc = docs.find((d) => d.key === state.selectedKey) || docs[0];

  const progress = doc.kind === 'phase' ? doc.progress : t.overallProgress;
  const doneTasks = doc.kind === 'phase' ? doc.doneTasks : t.doneTasks;
  const totalTasks = doc.kind === 'phase' ? doc.totalTasks : t.totalTasks;
  // doc.key is the fileId (path relative to SCAN_ROOT); its last segment is
  // the real on-disk filename -- doc.name is a prettified display label
  // (title-cased, extension stripped) and isn't what's actually on disk.
  const pathParts = doc.key.split('/');
  const fileName = pathParts[pathParts.length - 1];
  const hasDir = pathParts.length > 1;
  const fullPath = state.root ? `${state.root}/${doc.key}` : doc.key;

  rail.innerHTML = `
    <div class="rail-box-dark">
      <div class="rail-box-label">Branch</div>
      <div class="rail-box-value">${escapeText(t.branch)}</div>
      ${t.repoBranch === t.branch
        ? '<div class="rail-branch-current">Current branch</div>'
        : '<button type="button" class="rail-switch-btn" id="switchBranchBtn">Switch to this branch</button>'}
    </div>

    <div class="rail-box-light">
      <div class="rail-box-title">File</div>
      <div class="rail-copy-row">
        <span class="rail-copy-value" title="${escapeAttr(fileName)}">${escapeText(fileName)}</span>
        <button type="button" class="rail-copy-btn" data-copy-value="${escapeAttr(fileName)}" aria-label="Copy file name">${COPY_ICON_SVG}</button>
      </div>
      ${hasDir ? `
      <div class="rail-copy-row">
        <span class="rail-copy-value rail-copy-path" id="railFilePath" title="${escapeAttr(fullPath)}"></span>
        <button type="button" class="rail-copy-btn" data-copy-value="${escapeAttr(fullPath)}" aria-label="Copy file path">${COPY_ICON_SVG}</button>
      </div>` : ''}
    </div>

    <div class="rail-box-light">
      <div class="rail-box-title">Progress</div>
      <div class="rail-progress-row">
        <div class="progress-bar"><div class="progress-fill ${t.status}" style="width:${progress}%"></div></div>
        <span class="rail-progress-label">${doneTasks}/${totalTasks}</span>
      </div>
      <select id="statusSelect" class="rail-status-select ${t.status}">
        <option value="not-started" ${t.status === 'not-started' ? 'selected' : ''}>Not started</option>
        <option value="in-progress" ${t.status === 'in-progress' ? 'selected' : ''}>In progress</option>
        <option value="done" ${t.status === 'done' ? 'selected' : ''}>Done</option>
      </select>
      <div class="rail-meta-line">Updated ${timeAgo(t.lastUpdated)}</div>
    </div>

    <div class="rail-box-light">
      <div class="rail-box-title">Label</div>
      <div id="labelSelectWrap"></div>
    </div>
  `;

  const filePathEl = document.getElementById('railFilePath');
  if (filePathEl) truncateFront(filePathEl, fullPath, 3);

  document.getElementById('statusSelect').addEventListener('change', (e) => {
    setTicketStatus(t.id, e.target.value);
  });

  document.getElementById('labelSelectWrap').appendChild(buildLabelSelect(t));

  const switchBtn = document.getElementById('switchBranchBtn');
  if (switchBtn) {
    switchBtn.addEventListener('click', () => {
      switchBtn.disabled = true;
      switchBtn.textContent = 'Switching...';
      checkoutBranch(t.id, switchBtn);
    });
  }
}

function buildLabelSelect(t) {
  const select = document.createElement('select');
  select.className = 'rail-status-select';
  if (t.label) select.setAttribute('style', labelColorStyle(t.label));

  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'No label';
  if (!t.label) noneOpt.selected = true;
  select.appendChild(noneOpt);

  for (const l of state.labels) {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = l;
    if (t.label === l) opt.selected = true;
    select.appendChild(opt);
  }

  const newOpt = document.createElement('option');
  newOpt.value = '__new__';
  newOpt.textContent = '+ New label…';
  select.appendChild(newOpt);

  select.addEventListener('change', () => {
    if (select.value === '__new__') {
      const name = prompt('New label name:');
      select.value = t.label || '';
      if (name && name.trim()) {
        createLabel(name.trim(), t.id);
      }
      return;
    }
    assignTicketLabel(t.id, select.value || null);
  });

  return select;
}

function applyTicketsResponse(data) {
  state.tickets = data.tickets;
  state.projects = data.projects;
  state.labels = data.labels;
  if (data.root) state.root = data.root;
  lastTicketsSnapshot = snapshotOf(data);
  renderAll();
}

async function toggleTask(fileId, lineIndex) {
  const res = await fetch('/api/toggle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileId, lineIndex }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not update: ' + data.error);
    return;
  }
  applyTicketsResponse(data);
}

async function setTicketStatus(ticketId, status) {
  const res = await fetch('/api/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId, status }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not update status: ' + data.error);
    return;
  }
  applyTicketsResponse(data);
}

async function toggleTicketPin(ticketId, pinned) {
  const res = await fetch('/api/ticket-pin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId, pinned }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not update pin: ' + data.error);
    return;
  }
  applyTicketsResponse(data);
}

async function assignTicketLabel(ticketId, label) {
  const res = await fetch('/api/ticket-label', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId, label }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not assign label: ' + data.error);
    return;
  }
  applyTicketsResponse(data);
}

async function createLabel(name, assignToTicketId) {
  const res = await fetch('/api/labels/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not create label: ' + data.error);
    return;
  }
  applyTicketsResponse(data);
  if (assignToTicketId) {
    await assignTicketLabel(assignToTicketId, name.trim());
  }
}

async function deleteLabel(name) {
  const count = state.tickets.filter((t) => t.label === name).length;
  const msg = count
    ? `Delete "${name}"? This will remove it from ${count} ticket${count === 1 ? '' : 's'}.`
    : `Delete "${name}"?`;
  if (!confirm(msg)) return;
  const res = await fetch('/api/labels/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not delete label: ' + data.error);
    return;
  }
  if (state.labelFilter === name) {
    state.labelFilter = null;
    localStorage.setItem('labelFilter', '');
  }
  applyTicketsResponse(data);
}

async function checkoutBranch(ticketId, switchBtn) {
  const res = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticketId }),
  });
  const data = await res.json();
  if (!data.ok) {
    alert('Could not switch branch: ' + data.error);
    if (switchBtn) {
      switchBtn.disabled = false;
      switchBtn.textContent = 'Switch to this branch';
    }
    return;
  }
  applyTicketsResponse(data);
}

// ---------- Board (kanban) view ----------

const BOARD_COLUMNS = [
  { status: 'not-started', label: 'Not started' },
  { status: 'in-progress', label: 'In progress' },
  { status: 'done', label: 'Done' },
];

function renderBoardView() {
  const el = document.getElementById('boardView');
  if (!el) return;
  el.innerHTML = '';
  for (const col of BOARD_COLUMNS) {
    const tickets = state.tickets.filter((t) => t.status === col.status && matchesActiveLabel(t));
    const colEl = document.createElement('div');
    colEl.className = 'board-col';
    colEl.innerHTML = `<div class="board-col-header">${col.label} <span class="board-col-count">${tickets.length}</span></div>`;
    const body = document.createElement('div');
    body.className = 'board-col-body';
    if (!tickets.length) {
      body.innerHTML = '<div class="board-col-empty">Nothing here</div>';
    }
    for (const t of tickets) {
      body.appendChild(buildBoardCard(t));
    }
    colEl.appendChild(body);

    colEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      colEl.classList.add('drag-over');
    });
    colEl.addEventListener('dragleave', () => colEl.classList.remove('drag-over'));
    colEl.addEventListener('drop', (e) => {
      e.preventDefault();
      colEl.classList.remove('drag-over');
      const ticketId = e.dataTransfer.getData('text/plain');
      const t = state.tickets.find((x) => x.id === ticketId);
      if (t && t.status !== col.status) setTicketStatus(ticketId, col.status);
    });

    el.appendChild(colEl);
  }
}

function buildBoardCard(t) {
  const card = document.createElement('div');
  card.className = 'board-card';
  card.draggable = true;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.setData('text/plain', t.id);
    card.classList.add('dragging');
  });
  card.addEventListener('dragend', () => card.classList.remove('dragging'));
  card.addEventListener('click', () => {
    setView('tree');
    selectDoc(t.id, t.assessmentFileId);
  });

  card.innerHTML = `
    <div class="board-card-repo">${escapeText(prettyName(repoFolderName(t.repo)))}</div>
    <div class="board-card-title">${escapeText(ticketKeyLabel(t.branch))}</div>
    <div class="board-card-progress">
      <div class="progress-bar"><div class="progress-fill ${t.status}" style="width:${t.overallProgress}%"></div></div>
      <span class="board-card-count">${t.doneTasks}/${t.totalTasks}</span>
    </div>
    <div class="board-card-meta">
      ${t.label ? `<span class="label-badge" style="${labelColorStyle(t.label)}">${escapeText(t.label)}</span>` : ''}
      ${isStale(t) ? '<span class="stale-badge" title="No updates in ' + STALE_DAYS + '+ days">Stale</span>' : ''}
      <span class="board-card-time">${timeAgo(t.lastUpdated)}</span>
    </div>
  `;
  return card;
}

// ---------- Today view ----------

function renderTodayView() {
  const el = document.getElementById('todayView');
  if (!el) return;
  el.innerHTML = '';

  const active = [...state.tickets]
    .filter((t) => t.status !== 'done' && matchesActiveLabel(t))
    .sort((a, b) => new Date(b.lastUpdated) - new Date(a.lastUpdated));

  let anyTasks = false;

  for (const t of active) {
    const openTasks = [];
    for (const p of t.phases) {
      for (const task of p.tasks) {
        if (!task.done) openTasks.push({ task, phaseName: p.name });
      }
    }
    if (!openTasks.length) continue;
    anyTasks = true;

    const group = document.createElement('div');
    group.className = 'today-group';
    group.innerHTML = `
      <div class="today-group-header">
        <span class="status-badge ${t.status}">${STATUS_LABEL[t.status]}</span>
        <span class="today-group-title">${escapeText(prettyName(repoFolderName(t.repo)))} &middot; ${escapeText(ticketKeyLabel(t.branch))}</span>
        ${t.label ? `<span class="label-badge" style="${labelColorStyle(t.label)}">${escapeText(t.label)}</span>` : ''}
        ${isStale(t) ? '<span class="stale-badge" title="No updates in ' + STALE_DAYS + '+ days">Stale</span>' : ''}
      </div>
      <ul class="today-task-list"></ul>
    `;
    const list = group.querySelector('.today-task-list');
    for (const { task, phaseName } of openTasks) {
      const li = document.createElement('li');
      li.className = 'today-task';
      li.innerHTML = `<span class="chk">&#9744;</span><span class="today-task-text">${escapeText(task.text)}</span><span class="today-task-phase">${escapeText(phaseName)}</span>`;
      li.addEventListener('click', () => toggleTask(task.fileId, task.lineIndex));
      list.appendChild(li);
    }
    el.appendChild(group);
  }

  if (!anyTasks) {
    el.innerHTML = '<div class="doc-empty">No open tasks. Nice.</div>';
  }
}

// ---------- Corkboard (sticky notes) ----------

const NOTE_COLORS = ['yellow', 'pink', 'blue', 'green', 'orange'];
const REMIND_PRESETS = [
  { value: '', label: 'No reminder' },
  { value: '1', label: 'In 1m' },
  { value: '30', label: 'In 30m' },
  { value: '60', label: 'In 1h' },
  { value: '120', label: 'In 2h' },
  { value: '240', label: 'In 4h' },
  { value: '1440', label: 'Tomorrow' },
  { value: 'custom', label: 'Pick date/time…' },
];

// Kept in sync with `.sticky-note` in style.css. Tidy up has to know a note's
// footprint before it has an explicit w/h, and a note only gets those once
// it's been resized by hand.
const NOTE_DEF_W = 220;
const NOTE_DEF_H = 180;
const NOTE_MIN_W = 190;
const NOTE_MIN_H = 140;
const NOTE_COLLAPSED_H = 46;
const NOTE_MAX_H = 900;
const SNAP_GRID = 8;

function timeUntilLabel(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'due now';
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `in ${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function findPinnedTicket(pinTicketId) {
  if (!pinTicketId) return null;
  return state.tickets.find((t) => t.id === pinTicketId) || null;
}

// Set while a note's title/body field has focus. The 5s poll below must not
// rebuild the corkboard DOM while that's true — wiping and recreating the
// focused textarea mid-keystroke is what caused the cursor-jumping/lost-text
// bug (a full re-render every 5s, regardless of what the user was doing).
let editingNoteField = false;

// Count of in-flight drags/resizes. A full re-render swaps out every note
// element, so a poll landing mid-gesture would cancel the drag: the pointer
// keeps moving an element that is no longer in the document, and the note snaps
// back to where it started.
let activeNoteGesture = 0;

// Everything a canvas rebuild would destroy: a gesture, a focused text field,
// or an open popover (whose position is anchored to an element that is about to
// be replaced). If any of these are live the poll skips its render; state.notes
// is still updated, so the next quiet tick paints the fresh data.
function boardBusy() {
  return (
    editingNoteField ||
    activeNoteGesture > 0 ||
    !!document.querySelector('.remind-popover, .add-note-popover, .folder-popover, .sticky-menu')
  );
}

// Notes written before z existed have no depth at all, so they all render at 0.
// Tied notes stack by DOM order, which means "in front" is not something the
// board can tell you or you can change. Assign each one a distinct depth once,
// in the order they already appear, so nothing moves but depth becomes real.
let zBackfillDone = false;

async function backfillNoteZ() {
  if (zBackfillDone) return false;
  zBackfillDone = true;
  if (!state.notes.length || state.notes.every((n) => typeof n.z === 'number')) return false;
  const order = new Map(state.notes.map((n, i) => [n.id, i]));
  const ordered = [...state.notes].sort((a, b) => {
    const dz = (a.z || 0) - (b.z || 0);
    if (dz) return dz;
    if (a.done !== b.done) return a.done ? -1 : 1;
    return order.get(a.id) - order.get(b.id);
  });
  await mutateNotes(
    '/api/notes/bulkUpdate',
    { updates: ordered.map((n, i) => ({ id: n.id, patch: { z: i + 1 } })) },
    { mode: 'all' }
  );
  // If every note still lacks a depth after writing them all, the server threw
  // the field away rather than storing it.
  checkServerKeepsZ(state.notes);
  return true;
}

// Shown once per page load. Repeating it on every poll would be unusable.
let staleServerReported = false;

function reportStaleServer(url, status) {
  if (staleServerReported) return;
  staleServerReported = true;
  const msg =
    `The board's server does not recognise ${url} (HTTP ${status}).\n\n` +
    "It's running an older version of server.js than the page expects, so some " +
    'changes (note depth, Tidy up) are being dropped instead of saved.\n\n' +
    'Restart it: stop the process and run `npm start` again.';
  console.error(msg);
  alert(msg);
}

// The z field is only honoured by a server new enough to whitelist it. An older
// process accepts the request, drops the field, and returns 200 -- so notes
// silently refuse to come forward and nothing anywhere reports an error.
function checkServerKeepsZ(notes) {
  if (staleServerReported || !Array.isArray(notes)) return;
  if (!notes.length || notes.some((n) => typeof n.z === 'number')) return;
  staleServerReported = true;
  const msg =
    'The board saved note depths but the server returned none, so it is ' +
    'discarding them.\n\nIt is running an older server.js than the page ' +
    'expects. Restart it: stop the process and run `npm start` again.';
  console.error(msg);
  alert(msg);
}

async function fetchNotes() {
  const res = await fetch('/api/notes');
  const data = await res.json();
  state.notes = data.notes || [];
  if (boardBusy()) return;
  // The backfill re-renders through mutateNotes, so don't paint twice.
  if (await backfillNoteZ()) return;
  if (state.view === 'corkboard') renderCorkboard();
}

// `render` decides how much of the board gets rebuilt:
//   { mode: 'all' }            full rebuild (create, delete, filter change)
//   { mode: 'one', id }        swap a single note's element
//   { mode: 'none' }           the DOM is already correct, just take the data
// Anything that used to rebuild the whole canvas dropped hover state, killed
// the reveal transitions, and would now also throw away an edit in progress on
// another note.
async function mutateNotes(url, body, render) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  // A server process started before these endpoints existed answers with a 404
  // and an HTML body, so res.json() throws and the failure vanishes into an
  // unhandled rejection. Say so plainly instead -- a running-but-stale server
  // silently ignoring fields is very hard to tell apart from a UI bug.
  if (!res.ok) {
    reportStaleServer(url, res.status);
    return;
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    reportStaleServer(url, res.status);
    return;
  }
  if (!data.ok) {
    alert('Could not update note: ' + data.error);
    return;
  }
  state.notes = data.notes;
  const mode = (render && render.mode) || 'all';
  if (mode === 'one') renderOneNote(render.id);
  else if (mode !== 'none') renderCorkboard();
}

function createNoteAt(x, y) {
  // Empty text is allowed: a note can be a title and nothing else.
  mutateNotes('/api/notes/create', { title: '', text: '', color: 'yellow', x, y, remind: null }, { mode: 'all' })
    .then(() => {
      // Focus the newest note's title so a fresh note is immediately typeable.
      const newest = state.notes[state.notes.length - 1];
      if (!newest) return;
      const el = noteElById(newest.id);
      if (el) el.querySelector('.sticky-note-title').focus();
    });
}

function updateNote(id, patch, render) {
  return mutateNotes('/api/notes/update', { id, patch }, render || { mode: 'one', id });
}

function deleteNoteById(id) {
  if (!confirm('Remove this note?')) return;
  mutateNotes('/api/notes/delete', { id }, { mode: 'all' });
}

function noteElById(id) {
  const canvas = document.getElementById('corkboardCanvas');
  if (!canvas) return null;
  return [...canvas.querySelectorAll('.sticky-note')].find((el) => el.dataset.id === id) || null;
}

// ----- Popovers -----

function closeStickyPopovers() {
  document
    .querySelectorAll('.remind-popover, .add-note-popover, .folder-popover, .sticky-menu')
    .forEach((p) => p.remove());
  document.querySelectorAll('.sticky-note.menu-open').forEach((n) => n.classList.remove('menu-open'));
}

// Flips above / pulls inward when the anchor is near the viewport edge. Notes
// live anywhere on the board, so a popover anchored to one in the bottom-right
// corner would otherwise open off-screen.
function positionPopover(pop, anchorEl) {
  document.body.appendChild(pop);
  const rect = anchorEl.getBoundingClientRect();
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  let left = rect.left + window.scrollX;
  let top = rect.bottom + window.scrollY + 4;
  if (left + w > window.scrollX + window.innerWidth - 8) {
    left = window.scrollX + window.innerWidth - w - 8;
  }
  if (rect.bottom + h + 8 > window.innerHeight) {
    top = rect.top + window.scrollY - h - 4;
  }
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${Math.max(8, top)}px`;
}

function closeOnOutsideClick(pop, anchorEl, onClose) {
  setTimeout(() => {
    document.addEventListener('click', function close(e) {
      if (pop.contains(e.target) || e.target === anchorEl) return;
      document.removeEventListener('click', close);
      if (onClose) onClose();
    });
  });
}

function ticketOptionsHtml(selectedId) {
  return state.tickets
    .map(
      (t) =>
        `<option value="${escapeAttr(t.id)}"${t.id === selectedId ? ' selected' : ''}>${escapeText(
          ticketKeyLabel(t.branch)
        )}</option>`
    )
    .join('');
}

// Reminder mini-popover, shared between new-note creation and editing an
// existing note's reminder — same controls, different submit target.
function openRemindPopover(anchorEl, currentIso, onPick) {
  closeStickyPopovers();
  const pop = document.createElement('div');
  pop.className = 'remind-popover';
  pop.innerHTML = `
    <select class="remind-preset-select">
      ${REMIND_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('')}
    </select>
    <input type="datetime-local" class="remind-custom-input" hidden />
    <div class="remind-popover-actions">
      ${currentIso ? '<button type="button" class="remind-clear-btn">Clear</button>' : ''}
      <button type="button" class="remind-set-btn">Set</button>
    </div>
  `;
  positionPopover(pop, anchorEl);

  const presetSelect = pop.querySelector('.remind-preset-select');
  const customInput = pop.querySelector('.remind-custom-input');
  presetSelect.addEventListener('change', () => {
    customInput.hidden = presetSelect.value !== 'custom';
  });
  const clearBtn = pop.querySelector('.remind-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', () => { onPick(null); pop.remove(); });
  pop.querySelector('.remind-set-btn').addEventListener('click', () => {
    let at = null;
    if (presetSelect.value === 'custom') {
      if (customInput.value) at = new Date(customInput.value).toISOString();
    } else if (presetSelect.value) {
      at = new Date(Date.now() + parseInt(presetSelect.value, 10) * 60000).toISOString();
    }
    if (at) onPick(at);
    pop.remove();
  });

  closeOnOutsideClick(pop, anchorEl, () => pop.remove());
}

// Folder = the pinned ticket. Assignable after creation, not only at it.
function openFolderPopover(anchorEl, note) {
  closeStickyPopovers();
  const pop = document.createElement('div');
  pop.className = 'folder-popover';
  pop.innerHTML = `
    <select class="folder-select">
      <option value="">No folder</option>
      ${ticketOptionsHtml(note.pinTicketId)}
    </select>
    <div class="folder-popover-actions">
      ${note.pinTicketId ? '<button type="button" class="folder-clear-btn">Remove</button>' : ''}
      <button type="button" class="folder-set-btn">Save</button>
    </div>
  `;
  positionPopover(pop, anchorEl);

  const clearBtn = pop.querySelector('.folder-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      updateNote(note.id, { pinTicketId: null });
      pop.remove();
    });
  }
  pop.querySelector('.folder-set-btn').addEventListener('click', () => {
    updateNote(note.id, { pinTicketId: pop.querySelector('.folder-select').value || null });
    pop.remove();
  });

  closeOnOutsideClick(pop, anchorEl, () => pop.remove());
}

function openStickyMenu(anchorEl, el, note) {
  closeStickyPopovers();
  const ticket = findPinnedTicket(note.pinTicketId);
  const menu = document.createElement('div');
  menu.className = 'sticky-menu';
  menu.innerHTML = `
    <button type="button" data-act="collapse">${note.collapsed ? 'Expand note' : 'Collapse note'}</button>
    <button type="button" data-act="folder">${ticket ? 'Change folder…' : 'Assign folder…'}</button>
    ${ticket ? '<button type="button" data-act="unfolder">Remove from folder</button>' : ''}
    <button type="button" data-act="front" title="Or just drag the note anywhere">Bring to front</button>
    <button type="button" class="danger" data-act="delete">Delete note</button>
  `;
  positionPopover(menu, anchorEl);
  el.classList.add('menu-open');

  const close = () => {
    menu.remove();
    el.classList.remove('menu-open');
  };

  menu.addEventListener('click', (e) => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    close();
    if (act === 'collapse') updateNote(note.id, { collapsed: !note.collapsed });
    else if (act === 'folder') openFolderPopover(anchorEl, note);
    else if (act === 'unfolder') updateNote(note.id, { pinTicketId: null });
    else if (act === 'front') bringNoteToFront(el, note, { force: true, flash: true });
    else if (act === 'delete') deleteNoteById(note.id);
  });

  closeOnOutsideClick(menu, anchorEl, close);
}

// ----- Note body: rendered markdown for reading, textarea for editing -----

// A raw pipeline URL runs ~70 characters and swamps a 220px note, so the
// visible label gets shortened to host + last path segments. The href and the
// tooltip keep the full URL.
const LINK_LABEL_MAX = 34;

function shortenUrl(url) {
  let host;
  let path;
  try {
    const u = new URL(url);
    host = u.host.replace(/^www\./, '');
    path = u.pathname.replace(/\/$/, '') + u.search + u.hash;
  } catch (e) {
    return url.length > LINK_LABEL_MAX ? `${url.slice(0, LINK_LABEL_MAX - 1)}…` : url;
  }
  if (host.length + path.length <= LINK_LABEL_MAX) return host + path;
  const segs = path.split('/').filter(Boolean);
  // Try progressively fewer trailing segments, then hard-truncate. Returning
  // `host/…/last-two` unconditionally could still exceed the budget and wrap
  // mid-token, which is exactly what the shortening exists to prevent.
  for (const take of [2, 1]) {
    const cand = `${host}/…/${segs.slice(-take).join('/')}`;
    if (cand.length <= LINK_LABEL_MAX) return cand;
  }
  const last = segs[segs.length - 1] || '';
  const room = Math.max(6, LINK_LABEL_MAX - host.length - 4);
  return `${host}/…/${last.length > room ? `…${last.slice(-(room - 1))}` : last}`;
}

function shortenNoteLinks(root) {
  root.querySelectorAll('a[href]').forEach((a) => {
    const href = a.getAttribute('href');
    // Only autolinked bare URLs get shortened. A [label](url) link already has
    // a human-written label, which is better than anything computed here.
    if (a.textContent.trim() !== href) return;
    a.title = href;
    a.textContent = shortenUrl(href);
  });
}

// mdToHtml escapes every input character and only lets a literal <br> through
// (markdown.js), so note text is safe to inject as HTML here.
function renderNoteBody(md, note) {
  const text = (note.text || '').trim();
  if (!text) {
    md.classList.add('empty');
    md.textContent = 'No details yet';
    return;
  }
  md.classList.remove('empty');
  md.innerHTML = mdToHtml(text);
  shortenNoteLinks(md);
}

// Whether the body has more content below the fold. Drives both the fade and
// the "more" chip; `at-end` drops the fade once you've scrolled to the bottom
// so it never implies content that isn't there.
function updateBodyFade(el) {
  const md = el.querySelector('.sticky-note-md');
  const expandBtn = el.querySelector('.sticky-expand-btn');
  if (!md) {
    el.classList.remove('overflowing');
    if (expandBtn) expandBtn.hidden = true;
    return;
  }
  const overflowing = md.scrollHeight - md.clientHeight > 2;
  el.classList.toggle('overflowing', overflowing);
  md.classList.toggle('at-end', md.scrollTop + md.clientHeight >= md.scrollHeight - 2);
  // An expanded note isn't overflowing any more -- that's the point -- so the
  // chip has to stay up on its own account, otherwise "more" would be one-way
  // with no route back to the original height.
  if (expandBtn) expandBtn.hidden = !overflowing && el.dataset.expanded !== '1';
}

function makeBodyReadEl(el, note) {
  const md = document.createElement('div');
  md.className = 'sticky-note-md';
  md.tabIndex = 0;
  renderNoteBody(md, note);
  md.addEventListener('click', (e) => {
    if (e.target.closest('a')) return; // follow the link instead of editing
    // Don't hijack an in-progress text selection -- but only one made inside
    // THIS body. Testing the document-wide selection meant any stray highlight
    // left over from a drag silently blocked editing entirely.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && md.contains(sel.anchorNode)) return;
    enterBodyEdit(el, note, false);
  });
  md.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === md) {
      e.preventDefault();
      enterBodyEdit(el, note, true);
    }
  });
  md.addEventListener('scroll', () => updateBodyFade(el));
  return md;
}

function exitBodyEdit(ta, el, note) {
  const bar = el.querySelector('.sticky-format-bar');
  if (bar) bar.remove();
  const md = makeBodyReadEl(el, note);
  ta.replaceWith(md);
  updateBodyFade(el);
}

// ----- Editing: markdown-aware typing -----

// Bullet, ordered or checkbox item. Captures the indent, the marker and the
// content so Enter can continue the list, and an empty item can end it.
const MD_LIST_RE = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?(.*)$/;

function lineBoundsAt(text, pos) {
  const start = text.lastIndexOf('\n', pos - 1) + 1;
  let end = text.indexOf('\n', pos);
  if (end === -1) end = text.length;
  return { start, end, line: text.slice(start, end) };
}

// Goes through execCommand so the browser's native undo stack keeps working --
// assigning to .value would make Cmd+Z blow away the whole edit instead of the
// last change. setRangeText is the fallback if execCommand is unavailable.
function replaceRange(ta, start, end, text, selStart, selEnd) {
  ta.focus();
  ta.setSelectionRange(start, end);
  let ok = false;
  try {
    ok = document.execCommand && document.execCommand('insertText', false, text);
  } catch (err) {
    ok = false;
  }
  if (!ok) ta.setRangeText(text, start, end, 'end');
  if (selStart != null) ta.setSelectionRange(selStart, selEnd == null ? selStart : selEnd);
}

// Wraps the selection in a marker, or unwraps it if it is already wrapped, so
// the same shortcut toggles. With no selection it inserts the pair and puts the
// caret between them.
function toggleWrap(ta, marker) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  const len = marker.length;
  const wrappedInside = sel.startsWith(marker) && sel.endsWith(marker) && sel.length >= len * 2;
  if (wrappedInside) {
    const inner = sel.slice(len, -len);
    replaceRange(ta, s, e, inner, s, s + inner.length);
    return;
  }
  const outerWrapped = v.slice(s - len, s) === marker && v.slice(e, e + len) === marker;
  if (outerWrapped) {
    replaceRange(ta, s - len, e + len, sel, s - len, e - len);
    return;
  }
  replaceRange(ta, s, e, marker + sel + marker, s + len, s + len + sel.length);
}

// Adds or removes a line prefix (heading, quote). Passing the same prefix that
// is already there removes it, so Cmd+1 twice returns to a plain paragraph.
function toggleLinePrefix(ta, prefix) {
  const { start, end, line } = lineBoundsAt(ta.value, ta.selectionStart);
  const existing = line.match(/^(\s*)((?:#{1,6}|>)\s+)?/);
  const indent = existing[1] || '';
  const current = existing[2] || '';
  const rest = line.slice(indent.length + current.length);
  const next = current.trim() === prefix.trim() ? '' : prefix;
  const replacement = indent + next + rest;
  const caret = start + replacement.length - rest.length + Math.max(0, ta.selectionStart - (start + indent.length + current.length));
  replaceRange(ta, start, end, replacement, Math.min(caret, start + replacement.length));
}

// Toggles a list marker on every line the selection touches.
function toggleListLines(ta, ordered) {
  const v = ta.value;
  const first = lineBoundsAt(v, ta.selectionStart);
  const last = lineBoundsAt(v, ta.selectionEnd);
  const block = v.slice(first.start, last.end);
  const lines = block.split('\n');
  const allMarked = lines.every((l) => !l.trim() || MD_LIST_RE.test(l));
  let n = 0;
  const next = lines
    .map((l) => {
      if (!l.trim()) return l;
      const m = l.match(MD_LIST_RE);
      const indent = m ? m[1] : (l.match(/^\s*/) || [''])[0];
      const body = m ? (m[6] || '') + m[7] : l.trim();
      if (allMarked) return indent + body;
      n++;
      return `${indent}${ordered ? `${n}.` : '-'} ${body}`;
    })
    .join('\n');
  replaceRange(ta, first.start, last.end, next, first.start, first.start + next.length);
}

function insertDivider(ta) {
  const { start, end, line } = lineBoundsAt(ta.value, ta.selectionStart);
  const block = (line.trim() ? '\n' : '') + '---\n';
  replaceRange(ta, line.trim() ? end : start, line.trim() ? end : end, block, (line.trim() ? end : start) + block.length);
}

function insertLink(ta) {
  const { selectionStart: s, selectionEnd: e, value: v } = ta;
  const sel = v.slice(s, e);
  const text = sel || 'label';
  const out = `[${text}](url)`;
  // Select the `url` placeholder so it can be typed over immediately.
  const urlAt = s + out.length - 4;
  replaceRange(ta, s, e, out, urlAt, urlAt + 3);
}

// Enter inside a list continues it; Enter on an empty item ends it. A line of
// three or more dashes becomes a divider. Returns true if it handled the key.
function handleEditorEnter(ta) {
  const { start, end, line } = lineBoundsAt(ta.value, ta.selectionStart);
  if (ta.selectionStart !== ta.selectionEnd) return false;

  if (/^\s*-{3,}\s*$/.test(line)) {
    replaceRange(ta, start, end, '---\n', start + 4);
    return true;
  }

  const m = line.match(MD_LIST_RE);
  if (!m) return false;
  const [, indent, bullet, num, delim, gap, checkbox, content] = m;
  // Caret must be at or past the marker, otherwise Enter is splitting text
  // above the item and should behave normally.
  if (ta.selectionStart < start + indent.length + (bullet || num + delim).length) return false;

  if (!content.trim()) {
    // Empty item: drop the marker and leave the list.
    replaceRange(ta, start, end, indent.replace(/ {2}$/, ''), start + Math.max(0, indent.length - 2));
    return true;
  }
  const marker = bullet ? bullet : `${parseInt(num, 10) + 1}${delim}`;
  const next = `\n${indent}${marker}${gap}${checkbox ? '[ ] ' : ''}`;
  replaceRange(ta, ta.selectionStart, ta.selectionStart, next);
  return true;
}

// Tab indents a list item rather than moving focus -- but only on a list line,
// so Tab still escapes the textarea everywhere else.
function handleEditorTab(ta, shift) {
  const { start, end, line } = lineBoundsAt(ta.value, ta.selectionStart);
  if (!MD_LIST_RE.test(line)) return false;
  const caret = ta.selectionStart;
  if (shift) {
    if (!/^\s{1,}/.test(line)) return true;
    const removed = line.startsWith('  ') ? 2 : 1;
    replaceRange(ta, start, end, line.slice(removed), Math.max(start, caret - removed));
  } else {
    replaceRange(ta, start, end, '  ' + line, caret + 2);
  }
  return true;
}

const FORMAT_ACTIONS = {
  bold: (ta) => toggleWrap(ta, '**'),
  italic: (ta) => toggleWrap(ta, '*'),
  code: (ta) => toggleWrap(ta, '`'),
  h1: (ta) => toggleLinePrefix(ta, '# '),
  h2: (ta) => toggleLinePrefix(ta, '## '),
  h3: (ta) => toggleLinePrefix(ta, '### '),
  quote: (ta) => toggleLinePrefix(ta, '> '),
  bullet: (ta) => toggleListLines(ta, false),
  ordered: (ta) => toggleListLines(ta, true),
  divider: (ta) => insertDivider(ta),
  link: (ta) => insertLink(ta),
  fence: (ta) => {
    const { selectionStart: s, selectionEnd: e, value: v } = ta;
    const sel = v.slice(s, e);
    const out = '```\n' + (sel || '') + '\n```\n';
    // Caret lands on the info string so a language can be typed straight away.
    replaceRange(ta, s, e, out, s + 3);
  },
};

function runFormatAction(ta, act) {
  const fn = FORMAT_ACTIONS[act];
  if (fn) fn(ta);
}

// Cmd on macOS, Ctrl elsewhere.
function editorShortcut(e) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey) return null;
  const k = e.key.toLowerCase();
  if (e.shiftKey) {
    if (k === '8') return 'bullet';
    if (k === '7') return 'ordered';
    if (k === 'c') return 'fence';
    if (k === '.') return 'quote';
    if (k === '-') return 'divider';
    return null;
  }
  if (k === 'b') return 'bold';
  if (k === 'i') return 'italic';
  if (k === 'e') return 'code';
  if (k === 'k') return 'link';
  if (k === '1') return 'h1';
  if (k === '2') return 'h2';
  if (k === '3') return 'h3';
  return null;
}

const FORMAT_BAR_BUTTONS = [
  { act: 'bold', label: 'B', title: 'Bold  (Cmd+B)', cls: 'is-bold' },
  { act: 'italic', label: 'I', title: 'Italic  (Cmd+I)', cls: 'is-italic' },
  { act: 'h2', label: 'H', title: 'Heading  (Cmd+2)', cls: 'is-head' },
  { act: 'bullet', label: '•', title: 'Bulleted list  (Cmd+Shift+8)' },
  { act: 'ordered', label: '1.', title: 'Numbered list  (Cmd+Shift+7)' },
  { act: 'code', label: '‹›', title: 'Inline code  (Cmd+E)' },
  { act: 'fence', label: '{ }', title: 'Code block  (Cmd+Shift+C)' },
  { act: 'link', label: '↗', title: 'Link  (Cmd+K)' },
  { act: 'divider', label: '—', title: 'Divider  (Cmd+Shift+-)' },
];

function makeFormatBar(ta) {
  const bar = document.createElement('div');
  bar.className = 'sticky-format-bar';
  bar.innerHTML = FORMAT_BAR_BUTTONS.map(
    (b) => `<button type="button" class="sticky-format-btn ${b.cls || ''}" data-act="${b.act}" title="${escapeAttr(b.title)}" tabindex="-1">${escapeText(b.label)}</button>`
  ).join('');
  // preventDefault on mousedown keeps focus (and the selection) in the
  // textarea. Without it the button steals focus, the textarea blurs, and the
  // blur handler commits and closes the editor before the click ever lands.
  bar.addEventListener('mousedown', (e) => e.preventDefault());
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('.sticky-format-btn');
    if (!btn) return;
    runFormatAction(ta, btn.dataset.act);
  });
  return bar;
}

function enterBodyEdit(el, note, caretAtEnd) {
  const md = el.querySelector('.sticky-note-md');
  if (!md) return;
  const ta = document.createElement('textarea');
  ta.className = 'sticky-note-body';
  ta.spellcheck = false;
  ta.value = note.text || '';
  md.replaceWith(ta);
  el.classList.remove('overflowing');
  editingNoteField = true;
  ta.before(makeFormatBar(ta));

  let cancelled = false;
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      cancelled = true;
      ta.blur();
      return;
    }
    const act = editorShortcut(e);
    if (act) {
      e.preventDefault();
      runFormatAction(ta, act);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
      if (handleEditorEnter(ta)) e.preventDefault();
      return;
    }
    if (e.key === 'Tab') {
      if (handleEditorTab(ta, e.shiftKey)) e.preventDefault();
    }
  });
  ta.addEventListener('blur', () => {
    editingNoteField = false;
    const text = ta.value.trim();
    if (!cancelled && text !== (note.text || '')) {
      updateNote(note.id, { text });
      return; // the re-render replaces this element wholesale
    }
    exitBodyEdit(ta, el, note);
  });

  ta.focus();
  if (caretAtEnd) ta.setSelectionRange(ta.value.length, ta.value.length);
}

// ----- Note element -----

function buildNoteEl(note) {
  const el = document.createElement('div');
  el.className =
    `sticky-note note-${note.color}` +
    (note.done ? ' done' : '') +
    (note.collapsed ? ' collapsed' : '');
  el.style.left = `${note.x}px`;
  el.style.top = `${note.y}px`;
  if (note.w) el.style.width = `${note.w}px`;
  // Height is left to CSS while collapsed so the strip sizes to its title.
  if (note.h && !note.collapsed) el.style.height = `${note.h}px`;
  // Rotation goes through a custom property, not `transform`, so the
  // straighten-on-hover rule in the stylesheet can win over the per-note value
  // (an inline `transform` would beat any stylesheet rule).
  el.style.setProperty('--rot', `${note.rotation || 0}deg`);
  // Unset z must render as 0, not 1: a note being raised for the first time
  // gets max(z)+1 == 1, which would merely tie with every other note.
  el.style.setProperty('--z', note.z || 0);
  el.dataset.id = note.id;

  const ticket = findPinnedTicket(note.pinTicketId);
  const remindLabel = note.remind
    ? (note.remind.fired ? 'reminded' : timeUntilLabel(note.remind.at))
    : 'remind';
  const remindClass = note.remind ? (note.remind.fired ? 'fired' : 'pending') : 'idle';
  // hPrev holds the height the note had before "more" grew it, which is both
  // the flag that it is expanded and the height "less" restores.
  const expanded = Number.isFinite(note.hPrev);
  if (expanded) el.dataset.expanded = '1';

  el.innerHTML = `
    <div class="sticky-note-head">
      <button type="button" class="sticky-done-toggle" title="${note.done ? 'Mark not done' : 'Mark done'}">${note.done ? '✓' : ''}</button>
      <button type="button" class="sticky-folder-chip${ticket ? '' : ' empty'}" title="${ticket ? 'Open in Tree' : 'Assign a folder'}">${ticket ? escapeText(ticketKeyLabel(ticket.branch)) : '+ folder'}</button>
      <div class="sticky-head-actions">
        <button type="button" class="sticky-icon-btn sticky-menu-btn" title="More">&#8943;</button>
        <button type="button" class="sticky-icon-btn sticky-delete-btn" title="Delete">&times;</button>
      </div>
    </div>
    <input class="sticky-note-title" type="text" placeholder="Title" />
    <div class="sticky-note-foot">
      <button type="button" class="sticky-remind-btn ${remindClass}">${escapeText(remindLabel)}</button>
      <button type="button" class="sticky-expand-btn" hidden>${expanded ? '&#8963; less' : '&#8964; more'}</button>
      <div class="sticky-color-dots">
        ${NOTE_COLORS.map(
          (c) => `<button type="button" class="sticky-color-dot dot-${c}${c === note.color ? ' selected' : ''}" data-color="${c}" title="${c}"></button>`
        ).join('')}
      </div>
    </div>
    <div class="sticky-resize-handle" title="Drag to resize"></div>
  `;

  // Body is inserted rather than templated: escapeText() does not escape
  // quotes, so nothing user-authored belongs in an attribute or an innerHTML
  // string here.
  const head = el.querySelector('.sticky-note-head');
  const titleInput = el.querySelector('.sticky-note-title');
  titleInput.value = note.title || '';
  titleInput.classList.toggle('untitled', !titleInput.value);
  titleInput.addEventListener('input', () => {
    titleInput.classList.toggle('untitled', !titleInput.value);
  });
  el.querySelector('.sticky-note-foot').before(makeBodyReadEl(el, note));

  el.querySelector('.sticky-done-toggle').addEventListener('click', () =>
    updateNote(note.id, { done: !note.done })
  );
  el.querySelector('.sticky-delete-btn').addEventListener('click', () => deleteNoteById(note.id));

  const menuBtn = el.querySelector('.sticky-menu-btn');
  menuBtn.addEventListener('click', () => openStickyMenu(menuBtn, el, note));

  // Double-clicking the head collapses to a title-only strip. Safe to bind:
  // the canvas dblclick handler only fires when the canvas itself is the
  // target, so this never also creates a note.
  head.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    updateNote(note.id, { collapsed: !note.collapsed });
  });

  titleInput.addEventListener('focus', () => { editingNoteField = true; });
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') titleInput.blur(); });
  titleInput.addEventListener('blur', () => {
    editingNoteField = false;
    const title = titleInput.value.trim();
    if (title === (note.title || '')) return;
    updateNote(note.id, { title });
  });

  const folderChip = el.querySelector('.sticky-folder-chip');
  folderChip.addEventListener('click', () => {
    if (ticket) {
      setView('tree');
      selectDoc(ticket.id, ticket.assessmentFileId);
    } else {
      openFolderPopover(folderChip, note);
    }
  });

  el.querySelectorAll('.sticky-color-dot').forEach((dot) => {
    dot.addEventListener('click', () => updateNote(note.id, { color: dot.dataset.color }));
  });

  const remindBtn = el.querySelector('.sticky-remind-btn');
  remindBtn.addEventListener('click', () => {
    openRemindPopover(remindBtn, note.remind && !note.remind.fired ? note.remind.at : null, (at) => {
      updateNote(note.id, { remind: at ? { at } : null });
    });
  });

  const expandBtn = el.querySelector('.sticky-expand-btn');
  expandBtn.addEventListener('click', () => {
    if (expanded) {
      // Back to whatever height it was before "more", and forget it.
      updateNote(note.id, { h: note.hPrev, hPrev: null });
      return;
    }
    const md = el.querySelector('.sticky-note-md');
    if (!md) return;
    const grow = md.scrollHeight - md.clientHeight;
    const h = Math.min(NOTE_MAX_H, el.offsetHeight + grow + 4);
    // Remember the current height so the same chip can undo this.
    updateNote(note.id, { h: Math.round(h), hPrev: el.offsetHeight });
  });

  wireNoteDrag(el, note);
  wireNoteResize(el, note);
  return el;
}

// ----- Stacking -----

function maxNoteZ() {
  return state.notes.reduce((m, n) => Math.max(m, n.z || 0), 0);
}

// Touching a note brings it forward, the way picking up a sheet of paper does.
// Cheap to call on every pointerdown: a note already on top returns immediately
// without a write, so only a genuinely buried note costs a request.
//
// `flash` plays the confirmation pulse. That is for gestures whose effect might
// otherwise go unnoticed (the shake, the menu item); an ordinary click already
// shows its own result, so pulsing on every click would just be noise.
function bringNoteToFront(el, note, opts) {
  const { force = false, flash = false } = opts || {};
  const top = maxNoteZ();
  if (!force && top > 0 && (note.z || 0) >= top) return;
  const z = top + 1;
  note.z = z;
  el.style.setProperty('--z', z);
  // mode 'none': the element is already at the right depth, no rebuild needed.
  updateNote(note.id, { z }, { mode: 'none' });
  if (!flash) return;
  el.classList.remove('shaken');
  // Reflow between remove and add so a repeat gesture replays the animation.
  void el.offsetWidth;
  el.classList.add('shaken');
  setTimeout(() => el.classList.remove('shaken'), 400);
}

// Shake-to-raise. Wiggling a note back and forth mid-drag pulls it out of the
// pile, the way you'd shuffle a physical sheet loose. Each axis is tracked
// separately so a horizontal or a vertical shake both work.
//
// A "swing" is continuous travel in one direction; it only counts as a reversal
// once it clears SHAKE_MIN_TRAVEL, which is what keeps ordinary hand jitter and
// a slightly curved drag from registering.
const SHAKE_MIN_TRAVEL = 16;
const SHAKE_REVERSALS = 3;
const SHAKE_WINDOW_MS = 900;

function makeShakeDetector(onShake) {
  const axes = {
    x: { dir: 0, swing: 0, last: null, flips: [] },
    y: { dir: 0, swing: 0, last: null, flips: [] },
  };
  return function track(cx, cy) {
    for (const [key, val] of [['x', cx], ['y', cy]]) {
      const a = axes[key];
      if (a.last === null) { a.last = val; continue; }
      const d = val - a.last;
      if (Math.abs(d) < 2) continue; // sub-pixel noise
      const dir = d > 0 ? 1 : -1;
      a.last = val;
      if (a.dir === 0) { a.dir = dir; a.swing = Math.abs(d); continue; }
      if (dir === a.dir) { a.swing += Math.abs(d); continue; }
      if (a.swing >= SHAKE_MIN_TRAVEL) {
        const now = performance.now();
        a.flips = a.flips.filter((t) => now - t < SHAKE_WINDOW_MS);
        a.flips.push(now);
        if (a.flips.length >= SHAKE_REVERSALS) {
          a.flips = [];
          onShake();
        }
      }
      a.dir = dir;
      a.swing = Math.abs(d);
    }
  };
}

// ----- Resize / drag -----

function wireNoteResize(el, note) {
  const handle = el.querySelector('.sticky-resize-handle');
  handle.addEventListener('pointerdown', (e) => {
    // Deliberately does NOT stopPropagation: the note's own pointerdown needs
    // to see this so the note still comes to the front when you resize it. It
    // early-returns for this target, so no drag starts.
    const canvas = document.getElementById('corkboardCanvas');
    const startW = el.offsetWidth;
    const startH = el.offsetHeight;
    const startX = e.clientX;
    const startY = e.clientY;
    const maxW = Math.max(NOTE_MIN_W, canvas.clientWidth - el.offsetLeft - 4);
    const maxH = Math.max(NOTE_MIN_H, canvas.clientHeight - el.offsetTop - 4);
    try {
      handle.setPointerCapture(e.pointerId);
    } catch (err) {
      return;
    }
    activeNoteGesture++;

    function onMove(ev) {
      const w = Math.min(maxW, Math.max(NOTE_MIN_W, startW + (ev.clientX - startX)));
      const h = Math.min(maxH, Math.max(NOTE_MIN_H, startH + (ev.clientY - startY)));
      el.style.width = `${w}px`;
      el.style.height = `${h}px`;
      updateBodyFade(el);
    }
    function onUp() {
      activeNoteGesture = Math.max(0, activeNoteGesture - 1);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      // Resizing by hand supersedes an earlier "more", so drop the remembered
      // height rather than letting "less" snap back to a stale one.
      const patch = { w: el.offsetWidth, h: el.offsetHeight };
      if (Number.isFinite(note.hPrev)) patch.hPrev = null;
      updateNote(note.id, patch, { mode: Number.isFinite(note.hPrev) ? 'one' : 'none', id: note.id });
    }
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  });
}

function wireNoteDrag(el, note) {
  el.addEventListener('pointerdown', (e) => {
    // Any touch on the note surfaces it -- including on the title, body or a
    // button, which is why this sits above the early return below.
    bringNoteToFront(el, note);
    if (
      e.target.closest('button') ||
      e.target.closest('.sticky-note-body') ||
      e.target.closest('.sticky-note-title') ||
      e.target.closest('.sticky-note-md') ||
      e.target.closest('.sticky-resize-handle')
    ) return;
    const canvas = document.getElementById('corkboardCanvas');
    const startX = e.clientX - el.offsetLeft;
    const startY = e.clientY - el.offsetTop;
    // Captured once: the board's scroll size grows as a note approaches the
    // edge, so re-reading it mid-drag would let the clamp recede forever.
    const maxX = Math.max(0, canvas.scrollWidth - el.offsetWidth);
    const maxY = Math.max(0, canvas.scrollHeight - el.offsetHeight);
    // Capture first, mutate after. setPointerCapture can throw (a pointer that
    // is already gone, some touch cases); doing it first means a throw aborts
    // cleanly instead of leaving the note stuck in .dragging, pinned at the
    // drag z-index with no pointerup coming to clear it.
    try {
      el.setPointerCapture(e.pointerId);
    } catch (err) {
      return;
    }
    el.classList.add('dragging');
    activeNoteGesture++;
    const trackShake = makeShakeDetector(() => bringNoteToFront(el, note, { force: true, flash: true }));

    function onMove(ev) {
      el.style.left = `${Math.min(maxX, Math.max(0, ev.clientX - startX))}px`;
      el.style.top = `${Math.min(maxY, Math.max(0, ev.clientY - startY))}px`;
      trackShake(ev.clientX, ev.clientY);
    }
    function onUp() {
      activeNoteGesture = Math.max(0, activeNoteGesture - 1);
      el.classList.remove('dragging');
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      const x = Math.round(el.offsetLeft / SNAP_GRID) * SNAP_GRID;
      const y = Math.round(el.offsetTop / SNAP_GRID) * SNAP_GRID;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      // No z here: pointerdown already raised the note, so a drop only has to
      // persist where it landed.
      updateNote(note.id, { x, y }, { mode: 'none' });
    }
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

// ----- Filtering and rendering -----

function visibleNotes() {
  return state.hideDoneNotes ? state.notes.filter((n) => !n.done) : state.notes;
}

// Search and the label filter dim rather than remove: the board's layout is
// spatial memory, so a filter must not move anything.
function noteMatchesFilter(note) {
  const ticket = findPinnedTicket(note.pinTicketId);
  if (state.labelFilter) {
    if (!ticket || ticket.label !== state.labelFilter) return false;
  }
  const q = (state.search || '').trim().toLowerCase();
  if (!q) return true;
  const hay = [
    note.title || '',
    note.text || '',
    ticket ? ticketKeyLabel(ticket.branch) : '',
  ].join(' ').toLowerCase();
  return hay.includes(q);
}

function applyNoteFilter(el, note) {
  el.classList.toggle('dimmed', !noteMatchesFilter(note));
}

// Re-applies the filter without rebuilding the board, so it can run on every
// keystroke of the topbar search without thrashing the DOM.
function refreshCorkboardFilter() {
  const canvas = document.getElementById('corkboardCanvas');
  if (!canvas) return;
  for (const el of canvas.querySelectorAll('.sticky-note')) {
    const note = state.notes.find((n) => n.id === el.dataset.id);
    if (note) applyNoteFilter(el, note);
  }
  renderCorkboardStatus(visibleNotes());
}

function renderCorkboardStatus(notes) {
  const status = document.getElementById('corkboardStatus');
  if (!status) return;
  const filtering = !!((state.search || '').trim() || state.labelFilter);
  if (!filtering) {
    status.textContent = notes.length ? `${notes.length} note${notes.length === 1 ? '' : 's'}` : '';
    return;
  }
  const hits = notes.filter(noteMatchesFilter).length;
  status.textContent = `${hits} of ${notes.length} match`;
}

// Post-insertion work: overflow can only be measured once the element is in
// the document and has been laid out.
function finishNoteEl(el, note) {
  applyNoteFilter(el, note);
  updateBodyFade(el);
}

function renderOneNote(id) {
  const canvas = document.getElementById('corkboardCanvas');
  if (!canvas) return;
  const note = state.notes.find((n) => n.id === id);
  const existing = noteElById(id);
  // Anything that changes which notes belong on the board (a delete, or a note
  // hidden by "Hide done") needs the full pass.
  if (!note || !existing || (state.hideDoneNotes && note.done)) {
    renderCorkboard();
    return;
  }
  const el = buildNoteEl(note);
  existing.replaceWith(el);
  finishNoteEl(el, note);
  renderCorkboardStatus(visibleNotes());
}

function renderCorkboard() {
  const canvas = document.getElementById('corkboardCanvas');
  if (!canvas) return;
  closeStickyPopovers();
  canvas.innerHTML = '';
  const notes = visibleNotes();
  renderCorkboardStatus(notes);
  if (!notes.length) {
    const empty = document.createElement('div');
    empty.className = 'corkboard-empty';
    empty.innerHTML = `
      <div class="corkboard-empty-mark">&#9633;</div>
      <div class="corkboard-empty-text">${
        state.notes.length ? 'Everything here is done.' : 'Nothing pinned yet.'
      }</div>
      <button type="button" class="corkboard-empty-btn">New note</button>
    `;
    empty.querySelector('.corkboard-empty-btn').addEventListener('click', () =>
      createNoteAt(40, 40)
    );
    canvas.appendChild(empty);
    return;
  }
  // Paint in depth order so DOM order agrees with z. When two notes share a z
  // the browser falls back to DOM order, so if the two disagreed, stacking would
  // look arbitrary and shuffle whenever the board re-rendered.
  // Done notes sit behind at equal depth; the index tie-break keeps the order
  // stable across renders.
  const order = new Map(notes.map((n, i) => [n.id, i]));
  const sorted = [...notes].sort((a, b) => {
    const dz = (a.z || 0) - (b.z || 0);
    if (dz) return dz;
    if (a.done !== b.done) return a.done ? -1 : 1;
    return order.get(a.id) - order.get(b.id);
  });
  const els = sorted.map((note) => {
    const el = buildNoteEl(note);
    canvas.appendChild(el);
    return { el, note };
  });
  for (const { el, note } of els) finishNoteEl(el, note);
}

// ----- Tidy up -----

function noteFootprint(note) {
  return {
    w: note.w || NOTE_DEF_W,
    h: note.collapsed ? NOTE_COLLAPSED_H : note.h || NOTE_DEF_H,
  };
}

// Shelf pack over each note's real footprint. The previous version assumed
// every note was 190x150, so any resized or collapsed note overlapped its
// neighbours after a tidy.
//
// Notes are packed tallest-first. Real boards have wildly different note
// heights (a code note can be 4x a one-liner), and packing in list order leaves
// a row as tall as its tallest member with everything after it stranded below a
// band of dead space. Tidy up is an explicit reflow, so reordering is expected.
async function tidyUpNotes() {
  const notes = visibleNotes();
  if (!notes.length) return;
  const canvas = document.getElementById('corkboardCanvas');
  const gap = 24;
  const boardW = Math.max(NOTE_DEF_W + gap * 2, canvas.clientWidth);
  const ordered = [...notes].sort((a, b) => noteFootprint(b).h - noteFootprint(a).h);
  let x = gap;
  let y = gap;
  let rowH = 0;
  const patches = [];
  for (const note of ordered) {
    const { w, h } = noteFootprint(note);
    if (x > gap && x + w + gap > boardW) {
      x = gap;
      y += rowH + gap;
      rowH = 0;
    }
    patches.push({ id: note.id, patch: { x, y, rotation: 0 } });
    x += w + gap;
    rowH = Math.max(rowH, h);
  }
  // Optimistic local move so the board settles immediately.
  for (const p of patches) {
    const n = state.notes.find((x2) => x2.id === p.id);
    if (n) Object.assign(n, p.patch);
  }
  renderCorkboard();
  // One request, one file write. N parallel single-note updates each rewrote
  // the whole .notes.json, which is both wasteful and last-write-wins.
  await mutateNotes('/api/notes/bulkUpdate', { updates: patches }, { mode: 'all' });
}

// ----- Toolbar and canvas wiring -----

function wireCorkboardToolbarExtras() {
  const tidyBtn = document.getElementById('corkboardTidyBtn');
  if (tidyBtn) tidyBtn.addEventListener('click', () => tidyUpNotes());

  const hideDoneBtn = document.getElementById('corkboardHideDoneBtn');
  if (hideDoneBtn) {
    hideDoneBtn.classList.toggle('active', state.hideDoneNotes);
    hideDoneBtn.addEventListener('click', () => {
      state.hideDoneNotes = !state.hideDoneNotes;
      localStorage.setItem('hideDoneNotes', state.hideDoneNotes ? '1' : '');
      hideDoneBtn.classList.toggle('active', state.hideDoneNotes);
      renderCorkboard();
    });
  }
}

function wireCorkboardCanvasDblClick() {
  const canvas = document.getElementById('corkboardCanvas');
  if (!canvas) return;
  canvas.addEventListener('dblclick', (e) => {
    if (e.target !== canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = Math.max(0, e.clientX - rect.left + canvas.scrollLeft - NOTE_DEF_W / 2);
    const y = Math.max(0, e.clientY - rect.top + canvas.scrollTop - 40);
    createNoteAt(Math.round(x), Math.round(y));
  });
}

function wireCorkboardAddButton() {
  const btn = document.getElementById('corkboardAddBtn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    closeStickyPopovers();
    const pop = document.createElement('div');
    pop.className = 'add-note-popover';
    pop.innerHTML = `
      <input class="add-note-title" type="text" placeholder="Title" />
      <textarea class="add-note-text" placeholder="Details, links, code (markdown)" rows="3"></textarea>
      <div class="add-note-row">
        <div class="sticky-color-dots">
          ${NOTE_COLORS.map((c, i) => `<button type="button" class="sticky-color-dot dot-${c}${i === 0 ? ' selected' : ''}" data-color="${c}" title="${c}"></button>`).join('')}
        </div>
        <select class="add-note-pin"><option value="">No folder</option>${ticketOptionsHtml(null)}</select>
      </div>
      <div class="add-note-row">
        <select class="add-note-remind-preset">
          ${REMIND_PRESETS.map((p) => `<option value="${p.value}">${p.label}</option>`).join('')}
        </select>
        <input type="datetime-local" class="add-note-remind-custom" hidden />
      </div>
      <div class="add-note-hint">A title on its own is enough.</div>
      <button type="button" class="add-note-submit">Pin it</button>
    `;
    positionPopover(pop, btn);

    let selectedColor = NOTE_COLORS[0];
    pop.querySelectorAll('.sticky-color-dot').forEach((dot) => {
      dot.addEventListener('click', () => {
        pop.querySelectorAll('.sticky-color-dot').forEach((d) => d.classList.remove('selected'));
        dot.classList.add('selected');
        selectedColor = dot.dataset.color;
      });
    });
    const presetSelect = pop.querySelector('.add-note-remind-preset');
    const customInput = pop.querySelector('.add-note-remind-custom');
    presetSelect.addEventListener('change', () => {
      customInput.hidden = presetSelect.value !== 'custom';
    });

    pop.querySelector('.add-note-submit').addEventListener('click', () => {
      const text = pop.querySelector('.add-note-text').value.trim();
      const title = pop.querySelector('.add-note-title').value.trim();
      // Either field alone is a valid note.
      if (!text && !title) return;
      let remind = null;
      if (presetSelect.value === 'custom') {
        if (customInput.value) remind = { at: new Date(customInput.value).toISOString() };
      } else if (presetSelect.value) {
        remind = { at: new Date(Date.now() + parseInt(presetSelect.value, 10) * 60000).toISOString() };
      }
      const x = 40 + Math.round(Math.random() * 200);
      const y = 40 + Math.round(Math.random() * 120);
      mutateNotes('/api/notes/create', {
        title,
        text,
        color: selectedColor,
        x,
        y,
        pinTicketId: pop.querySelector('.add-note-pin').value || null,
        remind,
      }, { mode: 'all' });
      pop.remove();
    });

    closeOnOutsideClick(pop, btn, () => pop.remove());
  });
}

async function pollNoteReminders() {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const after = parseInt(localStorage.getItem('lastSeenNoteReminderId'), 10) || 0;
  const res = await fetch(`/api/notes/reminders/due?after=${after}`);
  const data = await res.json();
  if (!data.reminders || !data.reminders.length) return;
  let maxId = after;
  for (const r of data.reminders) {
    new Notification('sprint-board sticky note', { body: r.text || r.title || 'Reminder' });
    if (r.id > maxId) maxId = r.id;
  }
  localStorage.setItem('lastSeenNoteReminderId', maxId);
}

if ('Notification' in window && Notification.permission === 'default') {
  Notification.requestPermission();
}

wireCorkboardAddButton();
wireCorkboardCanvasDblClick();
wireCorkboardToolbarExtras();
fetchNotes();
setInterval(fetchNotes, 5000);
pollNoteReminders();
setInterval(pollNoteReminders, 5000);

// ---------- View switching ----------

function updateViewVisibility() {
  const hasTickets = state.tickets.length > 0;
  // A repo can have a .docs folder full of loose docs and no tickets at all.
  // Tree view can still show those, so it gates on docs, not tickets. Board
  // and today render tickets only, so they stay ticket-gated.
  const hasDocs = state.projects.some((p) => p.docsTree && p.docsTree.length > 0);
  const treeVisible = hasDocs && state.view === 'tree';
  const anyViewVisible = hasTickets || treeVisible;
  document.getElementById('emptyState').hidden = anyViewVisible || state.view === 'corkboard';
  const scanRootEl = document.getElementById('emptyStateScanRoot');
  if (scanRootEl) scanRootEl.textContent = state.root || '';
  document.querySelector('.layout').hidden = !treeVisible;
  document.getElementById('boardView').hidden = !hasTickets || state.view !== 'board';
  document.getElementById('todayView').hidden = !hasTickets || state.view !== 'today';
  document.getElementById('corkboardView').hidden = state.view !== 'corkboard';
  // The corkboard carries its own "Hide done" in its toolbar, so the global one
  // would be a second control for the same setting.
  document.getElementById('hideDoneBtn').hidden = state.view === 'corkboard';
}

function setView(view) {
  state.view = view;
  localStorage.setItem('view', view);
  document.querySelectorAll('.view-switch-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  updateViewVisibility();
  if (view === 'board') renderBoardView();
  if (view === 'today') renderTodayView();
  if (view === 'corkboard') renderCorkboard();
}

function renderAll() {
  updateViewVisibility();
  renderSidebar();
  renderDoc();
  renderRail();
  renderBoardView();
  renderTodayView();
  renderLabelFilterSelect();
  renderLabelManagePanel();
  if (state.view === 'corkboard') renderCorkboard();
}

// ---------- Labels (topbar filter + manage panel) ----------

function renderLabelFilterSelect() {
  const select = document.getElementById('labelFilterSelect');
  select.innerHTML = '';

  const allOpt = document.createElement('option');
  allOpt.value = '';
  allOpt.textContent = 'All labels';
  select.appendChild(allOpt);

  for (const l of state.labels) {
    const opt = document.createElement('option');
    opt.value = l;
    opt.textContent = l;
    select.appendChild(opt);
  }

  select.value = state.labelFilter || '';
}

function renderLabelManagePanel() {
  const panel = document.getElementById('labelManagePanel');
  panel.innerHTML = '';

  if (!state.labels.length) {
    const empty = document.createElement('div');
    empty.className = 'label-manage-empty';
    empty.textContent = 'No labels yet.';
    panel.appendChild(empty);
  } else {
    for (const l of state.labels) {
      const row = document.createElement('div');
      row.className = 'label-manage-row';

      const name = document.createElement('span');
      name.className = 'label-manage-name';
      name.textContent = l;

      const count = document.createElement('span');
      count.className = 'label-manage-count';
      count.textContent = String(state.tickets.filter((t) => t.label === l).length);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'label-manage-delete';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', () => deleteLabel(l));

      row.appendChild(name);
      row.appendChild(count);
      row.appendChild(delBtn);
      panel.appendChild(row);
    }
  }

  const addRow = document.createElement('div');
  addRow.className = 'label-manage-add';

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'New label name';
  input.className = 'label-manage-input';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'label-manage-add-btn';
  addBtn.textContent = 'Add';

  const submit = () => {
    const name = input.value.trim();
    if (!name) return;
    createLabel(name);
    input.value = '';
  };
  addBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });

  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  panel.appendChild(addRow);
}

document.querySelectorAll('.view-switch-btn').forEach((btn) => {
  btn.addEventListener('click', () => setView(btn.dataset.view));
});
setView(state.view);

function effectiveTheme() {
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'light' || attr === 'dark') return attr;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function applyThemeIcon() {
  themeToggleBtn.textContent = effectiveTheme() === 'dark' ? '☀️' : '\u{1F319}';
}

const themeToggleBtn = document.getElementById('themeToggleBtn');
applyThemeIcon();
themeToggleBtn.addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('theme', next);
  applyThemeIcon();
  renderAll();
});

const hideDoneBtn = document.getElementById('hideDoneBtn');
hideDoneBtn.classList.toggle('active', state.hideDone);
hideDoneBtn.addEventListener('click', () => {
  state.hideDone = !state.hideDone;
  localStorage.setItem('hideDone', state.hideDone ? '1' : '');
  hideDoneBtn.classList.toggle('active', state.hideDone);
  renderSidebar();
});

document.getElementById('labelFilterSelect').addEventListener('change', (e) => {
  state.labelFilter = e.target.value || null;
  localStorage.setItem('labelFilter', state.labelFilter || '');
  renderSidebar();
  renderBoardView();
  renderTodayView();
  refreshCorkboardFilter();
});

const manageLabelsBtn = document.getElementById('manageLabelsBtn');
const labelManagePanel = document.getElementById('labelManagePanel');
manageLabelsBtn.addEventListener('click', () => {
  labelManagePanel.hidden = !labelManagePanel.hidden;
  manageLabelsBtn.classList.toggle('active', !labelManagePanel.hidden);
});
document.addEventListener('click', (e) => {
  if (!labelManagePanel.hidden && !labelManagePanel.contains(e.target) && e.target !== manageLabelsBtn) {
    labelManagePanel.hidden = true;
    manageLabelsBtn.classList.remove('active');
  }
});

// ---------- Fetch / boot ----------

let lastTicketsSnapshot = null;

function snapshotOf(data) {
  return JSON.stringify({ tickets: data.tickets, projects: data.projects, labels: data.labels });
}

async function fetchTickets() {
  const res = await fetch('/api/tickets');
  const data = await res.json();

  const snapshot = snapshotOf(data);
  const changed = snapshot !== lastTicketsSnapshot;
  lastTicketsSnapshot = snapshot;

  if (!changed) return;

  state.tickets = data.tickets;
  state.projects = data.projects;
  state.labels = data.labels;
  if (data.root) state.root = data.root;

  if (!state.selectedKey) {
    const restored = restoreSelection();
    if (!restored && state.tickets.length) {
      const first = state.tickets[0];
      state.selectedTicketId = first.id;
      state.selectedKey = first.assessmentFileId;
      state.expandedProjects.add(first.repo);
      state.expandedTickets.add(first.id);
    }
  }

  renderAll();
}

document.getElementById('searchInput').addEventListener('input', (e) => {
  state.search = e.target.value;
  renderSidebar();
  refreshCorkboardFilter();
});
document.getElementById('refreshBtn').addEventListener('click', (e) => {
  e.preventDefault();
  fetchTickets();
});
document.getElementById('emptyStateRefreshLink').addEventListener('click', (e) => {
  e.preventDefault();
  fetchTickets();
});

fetchTickets();
setInterval(fetchTickets, 5000);

// ---------- Sidebar resize ----------

const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 480;
const sidebarEl = document.getElementById('sidebar');
const sidebarResizerEl = document.getElementById('sidebarResizer');

function setSidebarWidth(px) {
  const clamped = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px));
  sidebarEl.style.width = clamped + 'px';
  localStorage.setItem('sidebarWidth', clamped);
}

const savedSidebarWidth = parseInt(localStorage.getItem('sidebarWidth'), 10);
if (savedSidebarWidth && window.innerWidth > 860) setSidebarWidth(savedSidebarWidth);

sidebarResizerEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  const startX = e.clientX;
  const startWidth = sidebarEl.getBoundingClientRect().width;
  sidebarResizerEl.classList.add('dragging');
  document.body.style.userSelect = 'none';
  document.body.style.cursor = 'col-resize';

  function onMouseMove(ev) {
    setSidebarWidth(startWidth + (ev.clientX - startX));
  }
  function onMouseUp() {
    sidebarResizerEl.classList.remove('dragging');
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  }
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

// ---------- Copy buttons (code blocks, rail file name/path) ----------
// Delegated on document (not the doc pane or rail) since their innerHTML
// gets replaced wholesale on every render; a listener bound to a child
// would be thrown away each time.
function flashCopied(btn) {
  const label = btn.querySelector('.code-copy-label');
  const prevLabel = label ? label.textContent : '';
  btn.classList.add('copied');
  if (label) label.textContent = 'Copied';
  clearTimeout(btn._copyResetTimer);
  btn._copyResetTimer = setTimeout(() => {
    btn.classList.remove('copied');
    if (label) label.textContent = prevLabel;
  }, 1400);
}

document.addEventListener('click', (e) => {
  const codeBtn = e.target.closest('.code-copy-btn');
  if (codeBtn) {
    const code = codeBtn.closest('.code-block-wrap')?.querySelector('code');
    if (code) navigator.clipboard.writeText(code.innerText).then(() => flashCopied(codeBtn));
    return;
  }
  const railBtn = e.target.closest('.rail-copy-btn');
  if (railBtn) {
    navigator.clipboard.writeText(railBtn.dataset.copyValue || '').then(() => flashCopied(railBtn));
  }
});
