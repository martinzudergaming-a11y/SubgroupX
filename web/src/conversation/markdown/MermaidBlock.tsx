'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { DiagramFallback, DiagramFrame, DiagramPending } from './DiagramFrame';

type Mermaid = typeof import('mermaid')['default'];
let mermaidPromise: Promise<Mermaid> | null = null;
let initialized = false;
let counter = 0;

async function getMermaid(): Promise<Mermaid> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((module) => module.default);
  const mermaid = await mermaidPromise;
  if (!initialized) {
    const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: dark ? 'dark' : 'default',
      fontFamily: 'inherit',
    });
    initialized = true;
  }
  return mermaid;
}

type RenderResult = { src: string; svg: string };

function MermaidBlock({ code }: { code: string }) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const [failure, setFailure] = useState<{ src: string; error: string } | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const baseId = useRef(`mermaid-${counter++}`);
  const src = code.trim();
  const svg = result?.src === src ? result.svg : null;

  useEffect(() => {
    if (!src) return;
    let active = true;
    setFailure(null);
    setShowFallback(false);
    (async () => {
      try {
        const mermaid = await getMermaid();
        await mermaid.parse(src);
        const rendered = await mermaid.render(`${baseId.current}-${counter++}`, src);
        if (!active) return;
        setResult({ src, svg: rendered.svg });
        setFailure(null);
      } catch (error) {
        if (active) setFailure({ src, error: error instanceof Error ? error.message : String(error) });
        if (import.meta.env.DEV) console.debug('[mermaid] compile failed:', error);
      }
    })();
    return () => { active = false; };
  }, [src]);

  useEffect(() => {
    if (!failure || failure.src !== src) return;
    setShowFallback(false);
    const timeout = window.setTimeout(() => setShowFallback(true), 1_200);
    return () => window.clearTimeout(timeout);
  }, [failure, src]);

  if (svg) return <DiagramFrame language="mermaid" code={src} svg={svg} />;
  if (showFallback) return <DiagramFallback language="mermaid" code={code} error={failure?.error} />;
  return <DiagramPending language="mermaid" />;
}

export default memo(MermaidBlock);
