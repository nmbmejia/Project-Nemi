// Minimal syntax highlighter. No dependencies and no build step, matching the
// rest of this project -- a CDN highlighter isn't an option here.
//
// The approach is a flat, ordered scan rather than a real parser: at each
// position, try each rule in priority order and take the first that matches
// exactly there. That handles the cases that actually matter in a sticky note
// (comments, strings, numbers, keywords) and degrades to plain text elsewhere,
// which is the right trade for a 200-line file.
//
// Rule order is load-bearing. Comments and strings come first so a keyword
// inside them isn't coloured; `ident` sits immediately after `keyword` so that
// a word like `interfaces` can't match the `interface` keyword and leave a
// stray `s` behind.

function hlEscape(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const HL_KEYWORDS = {
  dart: 'abstract as assert async await break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for get hide if implements import in interface is late library mixin new null on operator part required rethrow return set show static super switch sync this throw true try typedef var void while with yield',
  js: 'as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function get if implements import in instanceof interface let new null of package private protected public return set static super switch this throw true try typeof var void while with yield undefined',
  swift: 'any as associatedtype async await break case catch class continue convenience default defer deinit didSet do else enum extension fallthrough false fileprivate final for func get guard if import in indirect init inout internal is lazy let mutating nil none open operator override postfix precedencegroup prefix private protocol public repeat required rethrows return self Self set some static struct subscript super switch throw throws true try typealias unowned var weak where while willSet',
  json: 'true false null',
  shell: 'if then else elif fi for while do done case esac function return in break continue local export source alias set unset echo printf cd exit trap read eval exec',
};

const HL_TYPES = {
  dart: 'String int double num bool List Map Set Future Stream Object Widget BuildContext void',
  js: 'String Number Boolean Object Array Promise Map Set Date RegExp Error JSON Math console window document',
  swift: 'String Int Double Float Bool Array Dictionary Set Optional Result Data Date URL View Text',
  json: '',
  shell: '',
};

const HL_ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
  dart: 'dart', flutter: 'dart',
  swift: 'swift', kotlin: 'swift', kt: 'swift', java: 'swift',
  json: 'json',
  sh: 'shell', bash: 'shell', zsh: 'shell', shell: 'shell', console: 'shell', terminal: 'shell',
};

function hlWordRe(words) {
  if (!words) return null;
  return new RegExp(`(?:${words.trim().split(/\s+/).join('|')})\\b`, 'y');
}

function hlRules(lang) {
  const isShell = lang === 'shell';
  const rules = [];
  // Comments first: everything inside one is literal.
  if (isShell) {
    rules.push({ type: 'comment', re: /#[^\n]*/y });
  } else {
    rules.push({ type: 'comment', re: /\/\/[^\n]*/y });
    rules.push({ type: 'comment', re: /\/\*[\s\S]*?\*\//y });
  }
  // Strings, with escapes, and not crossing a newline for the quoted forms.
  rules.push({ type: 'string', re: /'(?:\\.|[^'\\\n])*'/y });
  rules.push({ type: 'string', re: /"(?:\\.|[^"\\\n])*"/y });
  rules.push({ type: 'string', re: /`(?:\\.|[^`\\])*`/y });
  rules.push({ type: 'number', re: /0[xX][0-9a-fA-F]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?/y });
  if (isShell) {
    rules.push({ type: 'number', re: /\$\{?\w+\}?/y }); // variables read as values
    rules.push({ type: 'type', re: /(?<=\s)--?[A-Za-z][\w-]*/y }); // flags
  } else {
    rules.push({ type: 'annotation', re: /@\w+/y });
  }
  const kw = hlWordRe(HL_KEYWORDS[lang]);
  if (kw) rules.push({ type: 'keyword', re: kw });
  const ty = hlWordRe(HL_TYPES[lang]);
  if (ty) rules.push({ type: 'type', re: ty });
  // Must follow keyword/type: consumes a whole identifier so a longer word
  // starting with a keyword can never be split.
  rules.push({ type: null, re: /[A-Za-z_$][\w$]*/y });
  rules.push({ type: null, re: /\s+/y });
  rules.push({ type: 'punct', re: /[^\w\s]/y });
  return rules;
}

function hlTokenize(code, rules) {
  const out = [];
  let i = 0;
  scan: while (i < code.length) {
    for (const rule of rules) {
      rule.re.lastIndex = i;
      const m = rule.re.exec(code);
      if (m && m.index === i && m[0].length) {
        out.push({ type: rule.type, text: m[0] });
        i += m[0].length;
        continue scan;
      }
    }
    // No rule matched: emit one character so the scan can never stall.
    out.push({ type: null, text: code[i] });
    i++;
  }
  return out;
}

// A JSON string is a key when the next non-space token is a colon. Colouring
// keys differently is most of what makes JSON readable at a glance.
function hlMarkJsonKeys(tokens) {
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== 'string') continue;
    let j = i + 1;
    while (j < tokens.length && tokens[j].type === null && !tokens[j].text.trim()) j++;
    if (j < tokens.length && tokens[j].type === 'punct' && tokens[j].text === ':') {
      tokens[i].type = 'key';
    }
  }
}

// Returns escaped HTML. Callers must not escape again.
function highlightCode(code, lang) {
  const key = HL_ALIASES[String(lang || '').toLowerCase()];
  if (!key) return hlEscape(code);
  const tokens = hlTokenize(code, hlRules(key));
  if (key === 'json') hlMarkJsonKeys(tokens);
  let out = '';
  let plain = '';
  for (const t of tokens) {
    if (!t.type) {
      plain += t.text; // batch untyped runs into one text node
      continue;
    }
    if (plain) { out += hlEscape(plain); plain = ''; }
    out += `<span class="hl-${t.type}">${hlEscape(t.text)}</span>`;
  }
  if (plain) out += hlEscape(plain);
  return out;
}

// Display name for the corner label. Unknown languages still get labelled.
function highlightLangLabel(lang) {
  const raw = String(lang || '').trim();
  if (!raw) return '';
  const pretty = { js: 'JS', ts: 'TS', tsx: 'TSX', jsx: 'JSX', json: 'JSON', sh: 'sh', dart: 'Dart', swift: 'Swift', bash: 'bash', zsh: 'zsh', kt: 'Kotlin' };
  return pretty[raw.toLowerCase()] || raw;
}
