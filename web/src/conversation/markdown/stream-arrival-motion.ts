type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

type ArrivalBatch = {
  start: number;
  end: number;
  expiresAt: number;
  delayByStart: Map<number, number>;
};

const ARRIVAL_DURATION_MS = 140;
const ARRIVAL_STAGGER_MS = 8;
const ARRIVAL_MAX_DELAY_MS = 32;

const SKIP_TAGS = new Set([
  'code',
  'pre',
  'svg',
  'math',
  'annotation',
  'table',
  'style',
]);

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl
  ? new Intl.Segmenter(undefined, { granularity: 'word' })
  : null;

export type StreamTextSegment = { text: string; animate: boolean };

export function segmentStreamText(text: string): StreamTextSegment[] {
  if (!text) return [];
  if (segmenter) {
    return Array.from(segmenter.segment(text), (part) => ({
      text: part.segment,
      animate: part.isWordLike ?? /\S/u.test(part.segment),
    }));
  }

  const out: StreamTextSegment[] = [];
  let whitespace = '';
  for (const char of text) {
    if (/\s/u.test(char)) {
      whitespace += char;
      continue;
    }
    if (whitespace) {
      out.push({ text: whitespace, animate: false });
      whitespace = '';
    }
    out.push({ text: char, animate: true });
  }
  if (whitespace) out.push({ text: whitespace, animate: false });
  return out;
}

function classNames(node: HastNode): string[] {
  const raw = node.properties?.className;
  if (Array.isArray(raw)) return raw.map(String);
  return typeof raw === 'string' ? raw.split(/\s+/) : [];
}

function skipsMotion(node: HastNode): boolean {
  return Boolean(
    (node.tagName && SKIP_TAGS.has(node.tagName))
      || classNames(node).some((name) => name === 'katex' || name.startsWith('stream-math-placeholder')),
  );
}

function animatedWord(text: string, delay: number): HastNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: {
      'data-stream-word': true,
      'data-stream-arrival': true,
      style: `--stream-arrival-delay:${delay}ms`,
    },
    children: [{ type: 'text', value: text }],
  };
}

function settledWord(text: string): HastNode {
  return {
    type: 'element',
    tagName: 'span',
    properties: { 'data-stream-word': true },
    children: [{ type: 'text', value: text }],
  };
}

export type StreamArrivalController = {
  prepare: (live: boolean, sourceKey?: string) => void;
  rehypePlugin: () => (tree: HastNode) => void;
};

export function createStreamArrivalController(
  now: () => number = () => performance.now(),
): StreamArrivalController {
  let previousCharCount = 0;
  let lastRenderCharCount = 0;
  let preparedSourceKey: string | null = null;
  let live = false;
  let batches: ArrivalBatch[] = [];

  const prepare = (nextLive: boolean, sourceKey = '') => {
    live = nextLive;
    const time = now();
    batches = nextLive ? batches.filter((batch) => batch.expiresAt > time) : [];
    if (!nextLive) {
      previousCharCount = 0;
      lastRenderCharCount = 0;
      preparedSourceKey = null;
    } else if (sourceKey !== preparedSourceKey) {
      previousCharCount = lastRenderCharCount;
      preparedSourceKey = sourceKey;
    }
  };

  const rehypePlugin = () => (tree: HastNode) => {
    if (!live) return;
    const time = now();
    let charCount = 0;
    let newWordIndex = 0;
    const newDelays = new Map<number, number>();

    const activeBatchAt = (start: number): ArrivalBatch | undefined =>
      batches.find((batch) => start >= batch.start && start < batch.end && batch.expiresAt > time);

    const walk = (node: HastNode, skipped: boolean) => {
      const skipChildren = skipped || skipsMotion(node);
      if (!node.children || skipChildren) return;

      const nextChildren: HastNode[] = [];
      for (const child of node.children) {
        if (child.type !== 'text' || typeof child.value !== 'string') {
          walk(child, skipChildren);
          nextChildren.push(child);
          continue;
        }

        for (const segment of segmentStreamText(child.value)) {
          const start = charCount;
          charCount += segment.text.length;
          if (!segment.animate) {
            nextChildren.push({ type: 'text', value: segment.text });
            continue;
          }

          const activeBatch = activeBatchAt(start);
          const isNew = start >= previousCharCount;
          if (isNew) {
            const delay = Math.min(newWordIndex++ * ARRIVAL_STAGGER_MS, ARRIVAL_MAX_DELAY_MS);
            newDelays.set(start, delay);
            nextChildren.push(animatedWord(segment.text, delay));
          } else if (activeBatch) {
            nextChildren.push(animatedWord(segment.text, activeBatch.delayByStart.get(start) ?? 0));
          } else {
            nextChildren.push(settledWord(segment.text));
          }
        }
      }
      node.children = nextChildren;
    };

    walk(tree, false);

    if (charCount < previousCharCount) {
      batches = [];
    } else if (charCount > previousCharCount) {
      if (!batches.some((batch) => batch.start === previousCharCount && batch.end === charCount)) {
        batches.push({
          start: previousCharCount,
          end: charCount,
          expiresAt: time + ARRIVAL_DURATION_MS + ARRIVAL_MAX_DELAY_MS,
          delayByStart: newDelays,
        });
      }
    }
    lastRenderCharCount = charCount;
  };

  return { prepare, rehypePlugin };
}
