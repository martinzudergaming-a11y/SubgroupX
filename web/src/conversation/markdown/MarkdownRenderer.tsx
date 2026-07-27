'use client';

import { memo, useEffect, useMemo, useRef, useState, createContext, useContext, type HTMLAttributes, type ReactNode } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkCjkFriendlyGfmStrikethrough from 'remark-cjk-friendly-gfm-strikethrough';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import CodeBlock, { InlineCode } from './CodeBlock';
import MermaidBlock from './MermaidBlock';
import D2Block from './D2Block';
import { WorkspaceImagePreview, type WorkspaceImageLease } from './WorkspaceImagePreview';
import {
  GFM_MATH_PIPE_SENTINEL,
  LITERAL_DOLLAR_SENTINEL,
  normalizeMathDelimiters,
  protectGfmTableMath,
  protectLiteralDollars,
  scanStreamingMath,
  stabilizeStreamingMath,
  stripMathLabels,
  type StreamingMathKind,
} from './streaming-math';
import { createStreamArrivalController } from './stream-arrival-motion';
import { ErrorBoundary } from '../../ui/ErrorBoundary';
import './code-theme.css';
import 'katex/dist/katex.min.css';

type FileLinkContextValue = {
  openFile?: (path: string, frag?: string) => void;
  canPreviewImage?: (path: string) => boolean;
  acquireImage?: (path: string, replaceGeneration?: number) => Promise<WorkspaceImageLease>;
};
export const MarkdownFileLinkContext = createContext<FileLinkContextValue>({});

export function workspaceHref(href: string | undefined): string | null {
  if (!href) return null;
  const raw = href.trim();
  if (!raw || raw.startsWith("#") || raw.startsWith("?") || raw.startsWith("//")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) return null;
  const pathOnly = raw.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathOnly);
  } catch {
    decoded = pathOnly;
  }
  const stripped = decoded.replace(/^\.?\//, "").trim();
  if (!stripped) return null;
  if (stripped.includes("\\")) return null;
  if (stripped.split("/").some((seg) => seg === "..")) return null;
  return stripped;
}

const PDF_FRAG_PARAM = /^(page=\d{1,5}|zoom=\d{1,4}|nameddest=[\w][\w.-]{0,80}|view=Fit[HV]?)$/;
export function workspacePdfFragment(href: string | undefined): string | null {
  if (!href) return null;
  const hashAt = href.indexOf("#");
  if (hashAt === -1) return null;
  const frag = href.slice(hashAt + 1).trim();
  if (!frag) return null;
  const parts = frag.split("&");
  if (parts.length > 4 || !parts.every((p) => PDF_FRAG_PARAM.test(p))) return null;
  return parts.join("&");
}

function detectLanguage(text: string) {
  const source = text.trim();

  if (!source) return 'plaintext';
  if (/^\s*#include\b|^\s*int\s+main\b/m.test(source)) return 'cpp';
  if (/^\s*package\s+\w+|^\s*func\s+\w+/m.test(source)) return 'go';
  if (/^\s*def\s+\w+\(|^\s*import\s+\w+/m.test(source)) return 'python';
  if (/^\s*interface\s+\w+|:\s*React\./m.test(source)) return 'typescript';
  if (/^\s*const\s+\w+\s*=|^\s*function\s+\w+\(/m.test(source)) return 'javascript';
  if (/^\s*<\w+[\s>]/m.test(source)) return 'html';
  if (/^\s*[{[]/.test(source)) return 'json';
  if (/^\s*#\s|\n##\s|\n```/.test(source)) return 'markdown';
  return 'plaintext';
}

type MutableMarkdownNode = {
  type?: string;
  value?: string;
  children?: MutableMarkdownNode[];
  data?: { hChildren?: MutableMarkdownNode[] };
};

function remarkRestoreMathSentinels() {
  return (tree: MutableMarkdownNode) => {
    const walk = (node: MutableMarkdownNode) => {
      if ((node.type === 'inlineMath' || node.type === 'math') && typeof node.value === 'string') {
        const fixMathText = (value: string) => stripMathLabels(value.replaceAll(GFM_MATH_PIPE_SENTINEL, '|'));
        node.value = fixMathText(node.value);
        const fixHast = (child: MutableMarkdownNode) => {
          if (typeof child.value === 'string') child.value = fixMathText(child.value);
          child.children?.forEach(fixHast);
        };
        node.data?.hChildren?.forEach(fixHast);
      }
      if (node.type === 'text' && typeof node.value === 'string') {
        node.value = node.value.replaceAll(LITERAL_DOLLAR_SENTINEL, '$');
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
}

const REMARK_PLUGINS: Options['remarkPlugins'] = [
  remarkGfm,
  remarkCjkFriendly,
  remarkCjkFriendlyGfmStrikethrough,
  remarkMath,
  remarkRestoreMathSentinels,
];
const REHYPE_PLUGINS: Options['rehypePlugins'] = [[rehypeKatex, { strict: "ignore", trust: false, errorColor: "#777777", maxExpand: 1000 }]];

const INLINE_MATH_PENDING = '\uE000';
const DISPLAY_MATH_PENDING = '\uE001';

function withMathPlaceholder(source: string, pending: StreamingMathKind | null): string {
  if (pending === 'inline') return `${source}\`${INLINE_MATH_PENDING}\``;
  if (pending === 'display') {
    const gap = !source || source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n';
    return `${source}${gap}\`\`\`oiia-stream-math\n${DISPLAY_MATH_PENDING}\n\`\`\``;
  }
  return source;
}

function splitMarkdownBlocks(md: string): string[] {
  const lines = md.split('\n');
  const segments: string[] = [];
  let cur: string[] = [];
  let inFence = false;
  let fence = '';
  let inMath = false;
  const flush = () => { if (cur.length) { segments.push(cur.join('\n')); cur = []; } };
  for (const line of lines) {
    const fenceOpen = /^\s{0,3}(```+|~~~+)/.exec(line);
    if (!inMath && fenceOpen) {
      const marker = fenceOpen[1][0].repeat(3);
      if (!inFence) { inFence = true; fence = marker; }
      else if (line.trimStart().startsWith(fence)) { inFence = false; }
      cur.push(line);
      continue;
    }
    if (inFence) { cur.push(line); continue; }
    if (((line.match(/\$\$/g) || []).length) % 2 === 1) inMath = !inMath;
    if (inMath) { cur.push(line); continue; }
    if (line.trim() === '') { flush(); continue; }
    cur.push(line);
  }
  flush();
  if (segments.length <= 1) return segments;
  const listRe = /^\s{0,3}([-*+]|\d{1,9}[.)])\s/;
  const quoteRe = /^\s{0,3}>/;
  const merged: string[] = [];
  for (const seg of segments) {
    const first = seg.split('\n', 1)[0];
    const prev = merged.length ? merged[merged.length - 1] : null;
    const prevFirst = prev ? prev.split('\n', 1)[0] : '';
    const continuation = prev != null && (
      /^\s+\S/.test(first) ||
      (listRe.test(first) && listRe.test(prevFirst)) ||
      (quoteRe.test(first) && quoteRe.test(prevFirst)) ||
      (first.trimStart().startsWith('|') && prevFirst.trimStart().startsWith('|'))
    );
    if (continuation) merged[merged.length - 1] = prev + '\n\n' + seg;
    else merged.push(seg);
  }
  return merged;
}

const MarkdownBlock = memo(function MarkdownBlock({ source, streaming }: { source: string; streaming: boolean }) {
  const arrival = useMemo(() => createStreamArrivalController(), []);
  arrival.prepare(streaming, source);
  const rehypePlugins = useMemo<Options['rehypePlugins']>(
    () => streaming ? [...REHYPE_PLUGINS, arrival.rehypePlugin] : REHYPE_PLUGINS,
    [arrival, streaming],
  );
  return (
    <ErrorBoundary
      resetKey={source}
      fallback={
        <pre className="whitespace-pre-wrap break-words text-[13px] leading-[1.6]" style={{ fontFamily: 'var(--font-code)' }}>
          {source}
        </pre>
      }
    >
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} rehypePlugins={rehypePlugins} components={MARKDOWN_COMPONENTS}>
        {source}
      </ReactMarkdown>
    </ErrorBoundary>
  );
});

function MarkdownLink({ href, children }: { href?: string; children?: ReactNode }) {
  const { openFile } = useContext(MarkdownFileLinkContext);
  const filePath = workspaceHref(href);
  if (filePath) {
    if (openFile) {
      return (
        <a
          href={href}
          onClick={(e) => {
            e.preventDefault();
            openFile(filePath, workspacePdfFragment(href) ?? undefined);
          }}
          data-file={filePath}
          className="cursor-pointer underline decoration-[#C8C8C8] dark:decoration-[#555] underline-offset-2 hover:decoration-current"
        >
          {children}
        </a>
      );
    }
    return <span className="underline decoration-dotted decoration-[#C8C8C8] dark:decoration-[#555] underline-offset-2 opacity-90">{children}</span>;
  }
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">
      {children}
    </a>
  );
}

type HastLike = {
  type?: unknown;
  tagName?: unknown;
  value?: unknown;
  properties?: Record<string, unknown>;
  children?: HastLike[];
};

function hastText(node: HastLike | undefined): string {
  if (!node) return '';
  if (typeof node.value === 'string') return node.value;
  return node.children?.map(hastText).join('') ?? '';
}

function standaloneImageCandidate(node: unknown): { href: string; label: string } | null {
  const paragraph = node as HastLike | undefined;
  if (!paragraph?.children || paragraph.children.length !== 1) return null;
  const child = paragraph.children[0];
  if (child.type !== 'element' || (child.tagName !== 'a' && child.tagName !== 'img')) return null;
  const key = child.tagName === 'img' ? 'src' : 'href';
  const href = child.properties?.[key];
  if (typeof href !== 'string') return null;
  const alt = child.tagName === 'img' ? child.properties?.alt : undefined;
  return { href, label: typeof alt === 'string' ? alt : hastText(child).trim() };
}

const fileLabel = (path: string): string => path.split('/').filter(Boolean).pop() ?? path;

function MarkdownParagraph({ node, children, ...props }: HTMLAttributes<HTMLParagraphElement> & { node?: unknown; children?: ReactNode }) {
  const { openFile, canPreviewImage, acquireImage } = useContext(MarkdownFileLinkContext);
  const candidate = standaloneImageCandidate(node);
  const path = workspaceHref(candidate?.href);
  if (path && openFile && acquireImage && canPreviewImage?.(path)) {
    return (
      <div className="my-2">
        <WorkspaceImagePreview
          path={path}
          label={candidate?.label || fileLabel(path)}
          acquire={acquireImage}
          onOpen={openFile}
        />
      </div>
    );
  }
  return <p {...props}>{children}</p>;
}

function MarkdownImage({ src, alt }: { src?: string; alt?: string }) {
  const { openFile, canPreviewImage, acquireImage } = useContext(MarkdownFileLinkContext);
  const path = workspaceHref(src);
  if (path && openFile && acquireImage && canPreviewImage?.(path)) {
    return <WorkspaceImagePreview path={path} label={alt || fileLabel(path)} acquire={acquireImage} onOpen={openFile} />;
  }
  if (path) {
    return <span className="underline decoration-dotted decoration-[#C8C8C8] underline-offset-2 opacity-90">{alt || fileLabel(path)}</span>;
  }
  return (
    <span className="markdown-remote-image-frame">
      <img
        src={src}
        alt={alt ?? ''}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="markdown-remote-image"
      />
    </span>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  a: ({ href, children }) => <MarkdownLink href={href}>{children}</MarkdownLink>,
  p: MarkdownParagraph,
  img: ({ src, alt }) => <MarkdownImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  table: ({ children }) => (
    <div className="markdown-table-scroll">
      <table>{children}</table>
    </div>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className="border-l-2 border-[#E5E5E5] dark:border-[#333] my-2 pl-3 text-left not-italic text-inherit max-w-full"
      style={{ textAlign: 'left', fontStyle: 'normal', margin: '8px 0', maxWidth: '100%', color: 'inherit' }}
    >
      {children}
    </blockquote>
  ),
  code: ({ className, children }) => {
    const text = String(children ?? '');
    if (!className && text === INLINE_MATH_PENDING) {
      return <span aria-hidden="true" className="stream-math-placeholder stream-math-placeholder--inline" />;
    }
    if (className?.includes('language-oiia-stream-math') && text.trim() === DISPLAY_MATH_PENDING) {
      return <span aria-hidden="true" className="stream-math-placeholder stream-math-placeholder--display" />;
    }
    const isInline = !className?.includes('language-') && !text.includes('\n');
    if (isInline) return <InlineCode>{text}</InlineCode>;
    const langFromClass = (className || '').replace('language-', '').trim();
    const language = (langFromClass || detectLanguage(text)).toLowerCase();
    if (language === 'mermaid') return <MermaidBlock code={text} />;
    if (language === 'd2') return <D2Block code={text} />;
    return <CodeBlock code={text} language={language} />;
  },
};

function FormulaZoom({ node, onClose }: { node: HTMLElement; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);
  useEffect(() => {
    const host = contentRef.current;
    if (!host) return;
    const clone = node.cloneNode(true);
    host.appendChild(clone);
    return () => {
      host.removeChild(clone);
    };
  }, [node]);
  return (
    <dialog
      ref={dialogRef}
      onClick={(e) => {
        if (e.target === dialogRef.current) onClose();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-label="Formula"
      className="fixed inset-0 z-[100] m-0 max-w-none max-h-none w-full h-full border-none bg-black/60 backdrop-blur-sm p-4 flex items-center justify-center backdrop:bg-transparent"
    >
      <div className="relative max-w-[96vw] max-h-[88vh] overflow-auto rounded-xl bg-white dark:bg-[#1A1A1A] px-10 py-12 shadow-2xl">
        <button type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute top-2 right-2 size-8 flex items-center justify-center rounded-md text-[#888] hover:text-[#222] dark:hover:text-white hover:bg-[#F0F0F0] dark:hover:bg-[#333] transition-colors text-xl leading-none"
        >
          ×
        </button>
        <div ref={contentRef} className="formula-zoom-content" />
      </div>
    </dialog>
  );
}

function MarkdownRenderer({
  children,
  streaming = false,
}: {
  children: string;
  streaming?: boolean;
}) {
  const mathSpans = useMemo(
    () => streaming ? scanStreamingMath(children) : [],
    [children, streaming],
  );
  const presentation = useMemo(
    () => streaming
      ? stabilizeStreamingMath(children, children.length, true, mathSpans)
      : { source: children, pendingMath: null },
    [children, mathSpans, streaming],
  );
  const normalized = protectGfmTableMath(protectLiteralDollars(
    withMathPlaceholder(normalizeMathDelimiters(presentation.source), presentation.pendingMath),
  ));
  const blocks = useMemo(() => splitMarkdownBlocks(normalized), [normalized]);
  const [zoomNode, setZoomNode] = useState<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onClick = (e: MouseEvent) => {
      const math = (e.target as HTMLElement).closest?.('.katex-display, .katex') as HTMLElement | null;
      if (math) {
        e.stopPropagation();
        setZoomNode(math);
      }
    };
    body.addEventListener('click', onClick);
    return () => body.removeEventListener('click', onClick);
  }, []);

  return (
    <div ref={bodyRef} className="markdown-theme markdown-body max-w-none">

      {blocks.map((source, i) => (
        <MarkdownBlock key={i} source={source} streaming={streaming && i === blocks.length - 1} />
      ))}
      {zoomNode && <FormulaZoom node={zoomNode} onClose={() => setZoomNode(null)} />}
    </div>
  );
}

export default memo(MarkdownRenderer);
