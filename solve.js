// Fast drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written fresh in this session from the README spec and the reference's observable
// behaviour. Same answers, byte for byte; much less work per byte.
//
// Design: one fused build. Sources are read, front-mattered and permalinked in a
// single pass; Markdown is lexed and rendered in one pass with a segment-scanning
// inline renderer (no per-character escape calls, no token arrays); templates are
// compiled once per case to plain JS functions; cards are built once per source
// and reused; slugify is memoised per build with an ASCII fast path.

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped; unchanged when it holds none of them. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

/**
 * The slug of `text`, memoised per build in `cache`. Pure ASCII input skips the
 * NFKD normalisation (ASCII is stable under NFKD); anything else goes through
 * the full rule: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifySlow(text);
  cache.set(text, out);
  return out;
}

function slugifySlow(text) {
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) {
        gap = out.length > 0;
        continue;
      }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: its runs of characters other than whitespace (no array built). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c > 32 && c < 0xa0) {
      if (!inWord) {
        inWord = true;
        n++;
      }
    } else if (c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function fmString(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * `text` has "\n" line ends. The body is sliced, never split and rejoined.
 */
function parseFrontMatter(text) {
  if (text === '---') return { error: 'the front matter is not closed' };
  if (!text.startsWith('---\n')) return { error: 'no front matter' };
  let closeIdx = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeIdx !== -1) bodyStart = closeIdx + 5;
  else if (text.endsWith('\n---')) { closeIdx = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  const data = {};
  const fm = text.slice(4, closeIdx);
  let pos = 0;
  let lineNo = 1; // FM line j (0-based) is original line j+2
  while (pos <= fm.length) {
    let e = fm.indexOf('\n', pos);
    if (e === -1) e = fm.length;
    const line = fm.slice(pos, e);
    pos = e + 1;
    lineNo++;
    if (isBlank(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${lineNo} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValue(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    if (pos > fm.length) break;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;
const MD_WS = /\s/;

/** A heading line's level and text, or null. */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  return isBlank(line) || MD_FENCE_OPEN.test(line) || headingOf(line) !== null || MD_HR.test(line);
}

/** A line as it is rendered: spaces and tabs at either end dropped (the line itself when it has none). */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** The characters an inline scan stops at: a construct opener, or one the escape table covers. */
const INLINE_SPECIAL = /[\\`*\[&<>"']/g;
const INLINE_ENTITY = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

/**
 * `s` rendered inline; `L.link(target)` is a link's href.
 * One scan finds the next special among \ ` * [ & < > " ': a plain run holds none of
 * them, so it is appended verbatim with no escaping call; a construct recurses the
 * same way; an & < > " ' appends its entity. INLINE_SPECIAL's lastIndex is saved
 * and restored around each recursive call.
 */
function inline(s, L) {
  let out = '';
  let i = 0;
  const n = s.length;
  INLINE_SPECIAL.lastIndex = 0;
  let m;
  while ((m = INLINE_SPECIAL.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += s.slice(i, j);
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) {
        out += s[j + 1];
        i = j + 2;
      } else {
        out += '\\';
        i = j + 1;
      }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          const saved = INLINE_SPECIAL.lastIndex;
          out += `<strong>${inline(s.slice(j + 2, k), L)}</strong>`;
          INLINE_SPECIAL.lastIndex = saved;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          const saved = INLINE_SPECIAL.lastIndex;
          out += `<em>${inline(s.slice(j + 1, k), L)}</em>`;
          INLINE_SPECIAL.lastIndex = saved;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
    } else if (c === '[') {
      const k = findUnescaped(s, ']', j + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !MD_WS.test(target)) {
        const saved = INLINE_SPECIAL.lastIndex;
        out += `<a href="${esc(L.link(target))}">${inline(s.slice(j + 1, k), L)}</a>`;
        INLINE_SPECIAL.lastIndex = saved;
        i = mm + 1;
      } else {
        out += '[';
        i = j + 1;
      }
    } else {
      out += INLINE_ENTITY[c];
      i = j + 1;
    }
    INLINE_SPECIAL.lastIndex = i;
  }
  if (i < n) out += s.slice(i);
  return out;
}

/**
 * `src` rendered in one pass: its HTML, its table of contents (every level 2
 * and 3 heading), its excerpt (the first paragraph's inline HTML, or "") and
 * its word count. `L` carries the link context (dir, bySource, staticPaths,
 * base, broken, srcPath) and the per-build slug cache.
 */
function renderMarkdown(src, L) {
  const words = wordsOf(src);
  let html = '';
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let pos = 0;
  const n = src.length;
  const readLine = () => {
    if (pos >= n) return null;
    let e = src.indexOf('\n', pos);
    if (e === -1) e = n;
    const line = src.slice(pos, e);
    pos = e + 1;
    return line;
  };
  let line;
  while ((line = readLine()) !== null) {
    if (isBlank(line)) continue;
    const c0 = line.charCodeAt(0);
    if (c0 === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const bodyStart = pos;
        let bodyEnd = n;
        let l;
        while ((l = readLine()) !== null) {
          if (MD_FENCE_CLOSE.test(l)) {
            bodyEnd = pos - l.length - 1;
            break;
          }
        }
        let region = src.slice(bodyStart, bodyEnd);
        if (region !== '' && !region.endsWith('\n')) region += '\n';
        const cls = fence[1] === '' ? '' : ` class="language-${esc(fence[1])}"`;
        html += `<pre><code${cls}>${esc(region)}</code></pre>\n`;
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, L.slugCache), ids);
        const h = inline(heading.text, L);
        html += `<h${heading.depth} id="${id}">${h}</h${heading.depth}>\n`;
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: h });
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (MD_HR.test(line)) {
        html += '<hr>\n';
        continue;
      }
      const bullet = MD_BULLET.exec(line);
      if (bullet !== null) {
        const items = [trimLine(bullet[1])];
        while (true) {
          const save = pos;
          const nl = readLine();
          if (nl === null) break;
          const mm = MD_BULLET.exec(nl);
          if (mm !== null) {
            items.push(trimLine(mm[1]));
            continue;
          }
          if (MD_CONTINUED.test(nl)) {
            items[items.length - 1] += `\n${trimLine(nl)}`;
            continue;
          }
          pos = save;
          break;
        }
        html += `<ul>\n${items.map((text) => `<li>${inline(text, L)}</li>\n`).join('')}</ul>\n`;
        continue;
      }
    } else if (c0 === 62) {
      let body = '';
      const addQ = (raw) => {
        const t = trimLine(raw);
        if (t !== '') body += (body === '' ? '' : '\n') + t;
      };
      addQ(line.slice(line.charCodeAt(1) === 32 ? 2 : 1));
      while (true) {
        const save = pos;
        const nl = readLine();
        if (nl === null || !nl.startsWith('>')) {
          pos = save;
          break;
        }
        addQ(nl.slice(nl.charCodeAt(1) === 32 ? 2 : 1));
      }
      html += body === '' ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(body, L)}</p>\n</blockquote>\n`;
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      const ordered = MD_ORDERED.exec(line);
      if (ordered !== null) {
        const start = Number(ordered[1]);
        const items = [trimLine(ordered[2])];
        while (true) {
          const save = pos;
          const nl = readLine();
          if (nl === null) break;
          const mm = MD_ORDERED.exec(nl);
          if (mm !== null) {
            items.push(trimLine(mm[2]));
            continue;
          }
          if (MD_CONTINUED.test(nl)) {
            items[items.length - 1] += `\n${trimLine(nl)}`;
            continue;
          }
          pos = save;
          break;
        }
        const open = start !== 1 ? `<ol start="${start}">` : '<ol>';
        html += `${open}\n${items.map((text) => `<li>${inline(text, L)}</li>\n`).join('')}</ol>\n`;
        continue;
      }
    }
    let text = trimLine(line);
    while (true) {
      const save = pos;
      const nl = readLine();
      if (nl === null) break;
      if (endsParagraph(nl)) {
        pos = save;
        break;
      }
      text += `\n${trimLine(nl)}`;
    }
    const h = inline(text, L);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// --- template runtime (shared by every compiled template) ---

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, ...names) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, names[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[names[0]];
  for (let k = 1; k < names.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, names[k])) return undefined;
    v = v[names[k]];
  }
  return v;
}

/** tplLookup for a one-name path (no rest array built). */
function tplLookup1(scope, a) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  return s === null ? undefined : s.vars[a];
}

/** tplLookup for a two-name path. */
function tplLookup2(scope, a, b) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, b) ? undefined : v[b];
}

/** tplLookup for a three-name path. */
function tplLookup3(scope, a, b, c) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  return v === null || typeof v !== 'object' || !Object.hasOwn(v, c) ? undefined : v[c];
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplText(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplText).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's nodes compiled to a function (S, depth, L, T, Y, E, INC) -> string.
 * The tree is walked once at compile time; rendering is plain JS: string
 * concatenation, a lookup per path, a fresh scope object per for item.
 */
function compileTemplate(nodes) {
  const lines = [];
  let counter = 0;
  const lookupExpr = (path, scopeVar) => {
    const parts = path.map((p) => JSON.stringify(p)).join(',');
    if (path.length === 1) return `A(${scopeVar},${parts})`;
    if (path.length === 2) return `B(${scopeVar},${parts})`;
    if (path.length === 3) return `C(${scopeVar},${parts})`;
    return `L(${scopeVar},${parts})`;
  };
  const gen = (ns, scopeVar) => {
    for (const n of ns) {
      switch (n.kind) {
        case 'text':
          if (n.text !== '') lines.push(`o+=${JSON.stringify(n.text)};`);
          break;
        case 'var':
          lines.push(`o+=E(T(${lookupExpr(n.path, scopeVar)}));`);
          break;
        case 'raw':
          lines.push(`o+=T(${lookupExpr(n.path, scopeVar)});`);
          break;
        case 'if':
          lines.push(`if(${n.not ? '!' : ''}Y(${lookupExpr(n.path, scopeVar)})){`);
          gen(n.then, scopeVar);
          if (n.else !== null) {
            lines.push('}else{');
            gen(n.else, scopeVar);
          }
          lines.push('}');
          break;
        case 'for': {
          counter++;
          const sv = `S${counter}`;
          const xv = `X${counter}`;
          const iv = `I${counter}`;
          lines.push(`{const ${xv}=${lookupExpr(n.path, scopeVar)};if(Array.isArray(${xv})){for(let ${iv}=0;${iv}<${xv}.length;${iv}++){const ${sv}={vars:{${JSON.stringify(n.name)}:${xv}[${iv}],loop:{index:${iv}+1,first:${iv}===0,last:${iv}===${xv}.length-1,length:${xv}.length}},parent:${scopeVar}};`);
          gen(n.body, sv);
          lines.push('}}}');
          break;
        }
        case 'include':
          lines.push(`o+=INC(${JSON.stringify(n.name)},${scopeVar},depth);`);
          break;
      }
    }
  };
  gen(nodes, 'S');
  return new Function('S', 'depth', 'A', 'B', 'C', 'L', 'T', 'Y', 'E', 'INC', `"use strict";let o="";${lines.join('')}return o;`);
}

// ---------------------------------------------------------------- build

/** A scheme, an absolute path or a fragment: a link kept as written. */
const LINK_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function run(input) {
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');
  const slugCache = new Map();
  const output = {};
  const broken = new Set();
  const bySource = new Map();
  const inc = (name, scope, depth) => {
    const f = templates.get(name);
    if (f === undefined || depth >= INCLUDE_DEPTH) return '';
    return f(scope, depth + 1, tplLookup1, tplLookup2, tplLookup3, tplLookup, tplText, tplTruthy, esc, inc);
  };

  // 1-3 fused: sources in code-unit order of path, line ends made "\n"; a refused
  // source is reported and dropped, and so is a draft; each kept page's slug is
  // made unique in its directory, in source order, and its url set.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const f of files) {
    if (!f.path.endsWith('.md')) {
      statics.push({ path: f.path, content: f.content });
      continue;
    }
    const raw = f.content;
    const fm = parseFrontMatter(raw.includes('\r') ? raw.replace(/\r\n?/g, '\n') : raw);
    if ('error' in fm) {
      report.push(`refused ${f.path}: ${fm.error}`);
      continue;
    }
    const data = fm.data;
    const post = f.path.startsWith('posts/');
    const own = f.path.startsWith('tags/') ? 'tags' : f.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${f.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (post && !Object.hasOwn(data, 'date')) {
      report.push(`refused ${f.path}: a post needs a date`);
      continue;
    }
    const layout = data.layout ?? (post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${f.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    if (data.draft === true) {
      report.push(`draft ${f.path}`);
      continue;
    }
    const dir = post ? 'posts' : dirOf(f.path);
    const slug = uniqueSlug(data.slug ?? slugify(data.title, slugCache), takenIn(dir));
    const s = { path: f.path, data, body: fm.body, post, layout, slug, outDir: dir === '' ? slug : `${dir}/${slug}`, url: `${base}/${dir === '' ? slug : `${dir}/${slug}`}/` };
    sources.push(s);
    bySource.set(f.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of sources) {
    const dir = dirOf(s.path);
    const L = {
      slugCache,
      link: (target) => {
        if (LINK_SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, L);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Each source's card, built once and reused by every page that shows it.
  // The card also carries the page's own fields (slug, content, toc, newer,
  // older, is_post): a layout reads the fields it names, so the same object
  // serves as the page, and no spread copies it per render.
  for (const s of sources) {
    s.card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const render = (name, vars) => {
    const f = templates.get(name);
    if (f === undefined) return null;
    return f({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0, tplLookup1, tplLookup2, tplLookup3, tplLookup, tplText, tplTruthy, esc, inc);
  };
  for (const s of sources) {
    output[`${s.outDir}/index.html`] = render(s.layout, { page: s.card });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
