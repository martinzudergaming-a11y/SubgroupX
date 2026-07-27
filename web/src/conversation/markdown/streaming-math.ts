export type StreamingMathKind = 'inline' | 'display';

export type StreamingMarkdownPresentation = {
  source: string;
  pendingMath: StreamingMathKind | null;
};

export type StreamingMathSpan = {
  start: number;
  end: number | null;
  kind: StreamingMathKind;
};

export const GFM_MATH_PIPE_SENTINEL = '\uE002';
export const LITERAL_DOLLAR_SENTINEL = '\uE003';

type MathClose = { start: number; end: number };

function isEscaped(source: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && source[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

function markerRun(source: string, index: number, marker: string): number {
  let end = index;
  while (source[end] === marker) end++;
  return end - index;
}

function fenceAtLineStart(source: string, index: number): { marker: string; size: number } | null {
  if (index > 0 && source[index - 1] !== '\n') return null;
  let cursor = index;
  while (cursor < source.length && cursor - index < 4 && source[cursor] === ' ') cursor++;
  const marker = source[cursor];
  if (marker !== '`' && marker !== '~') return null;
  const size = markerRun(source, cursor, marker);
  return size >= 3 ? { marker, size } : null;
}

function inlineDollarClose(source: string, start: number): number | null {
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\n') return null;
    if (source[i] !== '$' || isEscaped(source, i)) continue;
    if (source[i - 1] === '$' || source[i + 1] === '$' || /\s/.test(source[i - 1] ?? '')) return null;
    if (/\d/.test(source[i + 1] ?? '')) return null;
    return i;
  }
  return null;
}

function looksLikeIncompleteInlineMath(source: string, start: number): boolean {
  const suffix = source.slice(start + 1);
  if (!suffix || suffix.includes('\n') || /^\s|^\d|^\$/.test(suffix)) return false;
  for (let i = start + 1; i < source.length && source[i] !== '\n'; i++) {
    if (source[i] === '$' && !isEscaped(source, i)) return false;
  }
  return /[\\_^{}|=<>+*/]|(?:^|[^\\])-/.test(suffix);
}

function isDisplayDollar(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1;
  return source.slice(lineStart, index).trim() === '';
}

function findLatexClose(source: string, start: number, kind: StreamingMathKind): MathClose | null {
  const opener = kind === 'display' ? '\\[' : '\\(';
  const closer = kind === 'display' ? '\\]' : '\\)';
  for (let i = start; i < source.length; i++) {
    if (source.startsWith(opener, i) && !isEscaped(source, i)) return null;
    if (source.startsWith(closer, i) && !isEscaped(source, i)) return { start: i, end: i + 2 };
    if (kind === 'display' && source.startsWith('$$', i) && !isEscaped(source, i)) {
      return { start: i, end: i + 2 };
    }
  }
  return null;
}

function normalizeTextMath(source: string): string {
  let output = '';
  let committed = 0;
  for (let i = 0; i < source.length;) {
    const kind: StreamingMathKind | null =
      source.startsWith('\\[', i) && !isEscaped(source, i) ? 'display'
        : source.startsWith('\\(', i) && !isEscaped(source, i) ? 'inline'
          : null;
    if (!kind) {
      i++;
      continue;
    }
    const close = findLatexClose(source, i + 2, kind);
    if (!close) {
      i += 2;
      continue;
    }
    const body = source.slice(i + 2, close.start);
    output += source.slice(committed, i);
    output += kind === 'display' ? `\n$$\n${body}\n$$\n` : `$${body}$`;
    committed = close.end;
    i = close.end;
  }
  return output + source.slice(committed);
}

const BARE_DISPLAY_ENVIRONMENTS = new Set([
  'equation', 'equation*',
  'align', 'align*',
  'alignat', 'alignat*',
  'flalign', 'flalign*',
  'gather', 'gather*',
  'multline', 'multline*',
  'aligned', 'alignedat', 'gathered', 'split',
  'cases', 'dcases', 'rcases', 'array',
  'matrix', 'matrix*', 'pmatrix', 'pmatrix*', 'bmatrix', 'bmatrix*',
  'Bmatrix', 'Bmatrix*', 'vmatrix', 'vmatrix*', 'Vmatrix', 'Vmatrix*', 'smallmatrix',
]);
const BARE_DISPLAY_OPENERS = [...BARE_DISPLAY_ENVIRONMENTS].map((name) => `\\begin{${name}}`);

function bareEnvironmentAt(source: string, index: number): { opener: string; closer: string } | null {
  const match = /^\\begin\{([A-Za-z]+\*?)\}/.exec(source.slice(index));
  if (!match || !BARE_DISPLAY_ENVIRONMENTS.has(match[1])) return null;
  return { opener: match[0], closer: `\\end{${match[1]}}` };
}

function transformOutsideCode(source: string, transform: (text: string) => string): string {
  let output = '';
  let textStart = 0;
  let i = 0;
  while (i < source.length) {
    const fence = fenceAtLineStart(source, i);
    if (fence) {
      output += transform(source.slice(textStart, i));
      const codeStart = i;
      const firstLineEnd = source.indexOf('\n', i);
      i = firstLineEnd === -1 ? source.length : firstLineEnd + 1;
      let closed = false;
      while (i < source.length) {
        const close = fenceAtLineStart(source, i);
        const lineEnd = source.indexOf('\n', i);
        const next = lineEnd === -1 ? source.length : lineEnd + 1;
        if (close?.marker === fence.marker && close.size >= fence.size) {
          i = next;
          closed = true;
          break;
        }
        i = next;
      }
      output += source.slice(codeStart, i);
      textStart = i;
      if (!closed) return output;
      continue;
    }

    if (source[i] === '`') {
      const size = markerRun(source, i, '`');
      const marker = '`'.repeat(size);
      let close = source.indexOf(marker, i + size);
      while (close !== -1 && (source[close - 1] === '`' || source[close + size] === '`')) {
        close = source.indexOf(marker, close + size);
      }
      output += transform(source.slice(textStart, i));
      if (close === -1) return output + source.slice(i);
      output += source.slice(i, close + size);
      i = close + size;
      textStart = i;
      continue;
    }
    i++;
  }
  return output + transform(source.slice(textStart));
}

const BARE_ENVIRONMENT_RE = /\\begin\{(equation\*?|align\*?|alignat\*?|flalign\*?|gather\*?|multline\*?|aligned|alignedat|gathered|split|cases|dcases|rcases|array|matrix\*?|pmatrix\*?|bmatrix\*?|Bmatrix\*?|vmatrix\*?|Vmatrix\*?|smallmatrix)\}([\s\S]*?)\\end\{\1\}/g;

function normalizeBareDisplayEnvironments(source: string): string {
  if (!source.includes('\\begin{')) return source;
  const delimited = scanStreamingMath(source, { bareEnvironments: false });
  return source.replace(BARE_ENVIRONMENT_RE, (match, rawName: string, rawBody: string, offset: number) => {
    if (isEscaped(source, offset)) return match;
    if (delimited.some((span) => offset >= span.start && (span.end == null || offset < span.end))) return match;
    const name = rawName.replace(/\*$/, '');
    const body = rawBody.trim();
    let math = body;
    if (name === 'align' || name === 'flalign') math = `\\begin{aligned}${body}\\end{aligned}`;
    else if (name === 'alignat') math = `\\begin{alignedat}${body}\\end{alignedat}`;
    else if (name === 'gather' || name === 'multline') math = `\\begin{gathered}${body}\\end{gathered}`;
    else if (name !== 'equation') math = `\\begin{${rawName}}${body}\\end{${rawName}}`;
    return `\n$$\n${math}\n$$\n`;
  });
}

function normalizeStandaloneDoubleDollarLines(source: string): string {
  if (!source.includes('$$')) return source;
  return source.replace(/^([ \t]{0,3})\$\$([^\r\n]+?)\$\$[ \t]*$/gm, (_match, indent: string, body: string) =>
    `${indent}$$\n${indent}${body.trim()}\n${indent}$$`);
}

export function normalizeMathDelimiters(source: string): string {
  if (!source.includes('\\') && !source.includes('$$')) return source;
  return transformOutsideCode(source, (text) => normalizeStandaloneDoubleDollarLines(
    normalizeTextMath(normalizeBareDisplayEnvironments(text)),
  ));
}

export function scanStreamingMath(
  source: string,
  options: { bareEnvironments?: boolean } = {},
): StreamingMathSpan[] {
  const spans: StreamingMathSpan[] = [];
  let fence: { marker: string; size: number } | null = null;
  let inlineTicks = 0;
  let open: {
    start: number;
    opener: string | null;
    closes: readonly string[];
    kind: StreamingMathKind;
  } | null = null;

  for (let i = 0; i < source.length;) {
    if (open) {
      const close = open.closes.find((candidate) => source.startsWith(candidate, i) && !isEscaped(source, i));
      if (close) {
        spans.push({ start: open.start, end: i + close.length, kind: open.kind });
        i += close.length;
        open = null;
      } else if (open.opener && source.startsWith(open.opener, i) && !isEscaped(source, i)) {
        const opener: string = open.opener;
        const closes: readonly string[] = open.closes;
        const kind: StreamingMathKind = open.kind;
        open = { start: i, opener, closes, kind };
        i += opener.length;
      } else {
        i++;
      }
      continue;
    }

    if (fence) {
      const candidate = fenceAtLineStart(source, i);
      if (candidate?.marker === fence.marker && candidate.size >= fence.size) fence = null;
      const nextLine = source.indexOf('\n', i);
      i = nextLine === -1 ? source.length : nextLine + 1;
      continue;
    }

    if (inlineTicks > 0) {
      if (source[i] === '`') {
        const size = markerRun(source, i, '`');
        if (size === inlineTicks) inlineTicks = 0;
        i += size;
      } else {
        i++;
      }
      continue;
    }

    const lineFence = fenceAtLineStart(source, i);
    if (lineFence) {
      fence = lineFence;
      const nextLine = source.indexOf('\n', i);
      i = nextLine === -1 ? source.length : nextLine + 1;
      continue;
    }

    if (source[i] === '`') {
      inlineTicks = markerRun(source, i, '`');
      i += inlineTicks;
      continue;
    }

    if (source.startsWith('\\[', i) && !isEscaped(source, i)) {
      open = { start: i, opener: '\\[', closes: ['\\]', '$$'], kind: 'display' };
      i += 2;
      continue;
    }
    if (source.startsWith('\\(', i) && !isEscaped(source, i)) {
      open = { start: i, opener: '\\(', closes: ['\\)'], kind: 'inline' };
      i += 2;
      continue;
    }
    if (options.bareEnvironments !== false && source.startsWith('\\begin{', i) && !isEscaped(source, i)) {
      const environment = bareEnvironmentAt(source, i);
      if (environment) {
        open = {
          start: i,
          opener: environment.opener,
          closes: [environment.closer],
          kind: 'display',
        };
        i += environment.opener.length;
        continue;
      }
    }
    if (options.bareEnvironments !== false && source.startsWith('\\begin', i) && !isEscaped(source, i)) {
      const suffix = source.slice(i);
      if (BARE_DISPLAY_OPENERS.some((opener) => opener.startsWith(suffix))) {
        spans.push({ start: i, end: null, kind: 'display' });
        break;
      }
    }
    if (source.startsWith('$$', i) && !isEscaped(source, i)) {
      const kind = isDisplayDollar(source, i) ? 'display' : 'inline';
      open = { start: i, opener: null, closes: ['$$'], kind };
      i += 2;
      continue;
    }
    if (source[i] === '$' && !isEscaped(source, i)) {
      const close = inlineDollarClose(source, i);
      if (close != null) {
        spans.push({ start: i, end: close + 1, kind: 'inline' });
        i = close + 1;
        continue;
      }
      if (looksLikeIncompleteInlineMath(source, i)) {
        spans.push({ start: i, end: null, kind: 'inline' });
        break;
      }
    }
    i++;
  }

  if (open) spans.push({ start: open.start, end: null, kind: open.kind });
  return spans;
}

export function stripMathLabels(value: string): string {
  return value.includes('\\label') ? value.replace(/\\label\{[^{}]*\}/g, '') : value;
}

export function protectGfmTableMath(source: string): string {
  if (!source.includes('|')) return source;
  const spans = scanStreamingMath(source);
  let cursor = 0;
  let output = '';
  for (const span of spans) {
    if (span.end == null) continue;
    output += source.slice(cursor, span.start);
    output += source.slice(span.start, span.end).replaceAll('|', GFM_MATH_PIPE_SENTINEL);
    cursor = span.end;
  }
  return cursor === 0 ? source : output + source.slice(cursor);
}

export function protectLiteralDollars(source: string): string {
  if (!source.includes('$')) return source;
  return transformOutsideCode(source, (text) => {
    const spans = scanStreamingMath(text).filter((span) => span.end != null);
    let spanIndex = 0;
    let output = '';
    for (let i = 0; i < text.length; i++) {
      while (spanIndex < spans.length && spans[spanIndex].end! <= i) spanIndex++;
      const span = spans[spanIndex];
      const inMath = Boolean(span && i >= span.start && i < span.end!);
      output += text[i] === '$' && !inMath && !isEscaped(text, i)
        ? LITERAL_DOLLAR_SENTINEL
        : text[i];
    }
    return output;
  });
}

export function stabilizeStreamingMath(
  source: string,
  revealLength: number,
  streamLive: boolean,
  spans: readonly StreamingMathSpan[] = scanStreamingMath(source),
): StreamingMarkdownPresentation {
  const boundary = Math.max(0, Math.min(source.length, Math.floor(revealLength)));
  for (const span of spans) {
    if (boundary <= span.start) break;
    if (span.end == null) {
      if (streamLive) return { source: source.slice(0, span.start), pendingMath: span.kind };
      continue;
    }
    if (boundary < span.end) {
      return { source: source.slice(0, span.start), pendingMath: span.kind };
    }
  }
  return { source: source.slice(0, boundary), pendingMath: null };
}
