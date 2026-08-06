// Minimal markdown -> HTML renderer. Handles the subset used by
// assessment.md / phase-*.md files: headings, bold/italic, inline code,
// code fences, links, hr, blockquotes, lists (incl. checkboxes, nested), tables.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Code spans are pulled out to placeholders before bold/italic/link rules
// run (matching CommonMark: a code span's content is fully literal, never
// re-parsed for markdown), so identifiers like `insights_feature_flags`
// don't get their underscores eaten by the italic rule below. The
// placeholder is delimited with a private-use-area character (U+E000),
// which can't collide with real prose (unlike, say, a plain space + digit
// + space, which "see line 5 for details" would trip).
function inline(text) {
  let out = escapeHtml(text);
  const codeSpans = [];
  out = out.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(code);
    return '' + (codeSpans.length - 1) + '';
  });
  // Table cells can't contain a literal newline, so `<br>` is the standard
  // markdown escape hatch for a line break inside one. Everything else stays
  // escaped (no raw-HTML passthrough) -- this is a narrow, explicit allowlist.
  out = out.replace(/&lt;br\s*\/?&gt;/gi, '<br>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  // Underscore emphasis requires non-word chars flanking the delimiters
  // (CommonMark's "intraword underscore" rule), so snake_case/SCREAMING_CASE
  // identifiers in plain prose (outside code spans) stay literal too.
  out = out.replace(/(?<!\w)_([^\s_][^_]*?)_(?!\w)/g, '<em>$1</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Bare URLs become links too. This runs after the [label](url) rule and skips
  // anything already inside a tag (the `(?<!...)` guards), so an href or an
  // existing link's text is never re-linked. Trailing sentence punctuation is
  // left outside the link -- "see https://x.com/a." shouldn't capture the dot.
  out = out.replace(
    /(?<!href=")(?<!">)(https?:\/\/[^\s<>"']+?)(?=[.,;:!?)\]]*(?:\s|$))/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>'
  );
  out = out.replace(/(\d+)/g, (_, i) => {
    const code = codeSpans[Number(i)];
    const isPath = /\//.test(code) || /\.[a-z]{2,5}$/i.test(code);
    return `<code${isPath ? ' class="code-path"' : ''}>${code}</code>`;
  });
  return out;
}

function isTableSep(line) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

// Matches a checkbox, ordered ("1. "), or plain bullet list line, capturing
// indent depth so nested sub-items (e.g. under a checkbox task) can be
// rendered as a real nested list instead of flattening into the parent.
function parseListLine(line) {
  const checkbox = line.match(/^(\s*)[-*]\s\[([ xX])\]\s+(.*)$/);
  if (checkbox) {
    return { indent: checkbox[1].length, isCheckbox: true, ordered: false, checked: checkbox[2].toLowerCase() === 'x', text: checkbox[3] };
  }
  const ordered = line.match(/^(\s*)\d+\.\s+(.*)$/);
  if (ordered) {
    return { indent: ordered[1].length, isCheckbox: false, ordered: true, checked: false, text: ordered[2] };
  }
  const plain = line.match(/^(\s*)[-*]\s+(.*)$/);
  if (plain) {
    return { indent: plain[1].length, isCheckbox: false, ordered: false, checked: false, text: plain[2] };
  }
  return null;
}

// Renders a flat, indent-tagged run of list items into a nested list.
// items[0].indent defines this level; any run of subsequent items with a
// greater indent is collected and recursed into as that item's children.
function renderList(items) {
  const levelIndent = items[0].indent;
  const isChecklist = items[0].isCheckbox;
  const tag = items[0].ordered ? 'ol' : 'ul';
  const out = [isChecklist ? '<ul class="md-checklist">' : `<${tag}>`];
  let i = 0;
  while (i < items.length) {
    const item = items[i];
    i++;
    const children = [];
    while (i < items.length && items[i].indent > levelIndent) {
      children.push(items[i]);
      i++;
    }
    const chk = item.isCheckbox ? `<span class="chk">${item.checked ? '☑' : '☐'}</span>` : '';
    const label = `<span class="label">${inline(item.text)}</span>`;
    const childHtml = children.length ? renderList(children) : '';
    const liClass = [item.isCheckbox ? 'task-item' : '', item.checked ? 'checked' : ''].filter(Boolean).join(' ');
    out.push(`<li class="${liClass}"><span class="task-row">${chk}${label}</span>${childHtml}</li>`);
  }
  out.push(isChecklist ? '</ul>' : `</${tag}>`);
  return out.join('');
}

function mdToHtml(md) {
  const lines = md.split('\n');
  const html = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (/^```/.test(line)) {
      // The info string after the fence names the language, which drives both
      // the corner label and the highlighter.
      const lang = (line.match(/^```\s*([\w+#-]*)/) || [])[1] || '';
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      const code = buf.join('\n');
      // highlightCode returns escaped HTML; falling back to escaping here keeps
      // mdToHtml usable on its own if highlight.js hasn't loaded.
      const body = typeof highlightCode === 'function' ? highlightCode(code, lang) : escapeHtml(code);
      const label = typeof highlightLangLabel === 'function' ? highlightLangLabel(lang) : lang;
      const attr = label ? ` data-lang="${escapeHtml(label).replace(/"/g, '&quot;')}"` : '';
      html.push(`<pre class="code-block"${attr}><code>${body}</code></pre>`);
      continue;
    }

    if (/^---\s*$/.test(line)) {
      html.push('<hr>');
      i++;
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      html.push(`<h${level}>${inline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    if (line.trim().startsWith('>')) {
      const buf = [];
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        buf.push(lines[i].trim().replace(/^>\s?/, ''));
        i++;
      }
      html.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    if (line.trim().startsWith('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        rows.push(splitRow(lines[i]));
        i++;
      }
      html.push('<div class="table-wrap"><table><thead><tr>' +
        header.map((h) => `<th>${inline(h)}</th>`).join('') +
        '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
        '</tbody></table></div>');
      continue;
    }

    const firstListLine = parseListLine(line);
    if (firstListLine) {
      const items = [firstListLine];
      i++;
      while (i < lines.length) {
        const next = parseListLine(lines[i]);
        if (!next) break;
        items.push(next);
        i++;
      }
      html.push(renderList(items));
      continue;
    }

    if (line.trim() === '') {
      i++;
      continue;
    }

    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6})\s|^```|^---\s*$|^\s*[-*]\s|^\s*\d+\.\s|^\s*\|/.test(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    html.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return html.join('\n');
}
