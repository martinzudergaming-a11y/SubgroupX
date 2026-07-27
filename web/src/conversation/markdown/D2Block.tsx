'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { DiagramFallback, DiagramFrame, DiagramPending } from './DiagramFrame';

type D2Engine = InstanceType<typeof import('@terrastruct/d2')['D2']>;
type RenderResult = { src: string; svg: string };

let enginePromise: Promise<D2Engine> | null = null;
let queue: Promise<void> = Promise.resolve();
let counter = 0;
const RENDER_TIMEOUT_MS = 15_000;

async function getEngine(): Promise<D2Engine> {
  if (!enginePromise) enginePromise = import('@terrastruct/d2').then(({ D2 }) => new D2());
  return enginePromise;
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(() => undefined, () => undefined);
  return run;
}

async function renderD2(source: string, salt: string): Promise<string> {
  return enqueue(async () => {
    const engine = await getEngine();
    const result = await engine.compile({
      fs: { index: source },
      inputPath: 'index',
      options: {
        layout: 'dagre',
        themeID: 0,
        darkThemeID: 200,
        center: true,
        pad: 24,
        noXMLTag: true,
        salt,
      },
    });
    return engine.render(result.diagram, result.renderOptions);
  });
}

function renderD2Bounded(source: string, salt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("D2 compiler timed out after 15 seconds.")), RENDER_TIMEOUT_MS);
    renderD2(source, salt).then(
      (svg) => { window.clearTimeout(timer); resolve(svg); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function D2Block({ code }: { code: string }) {
  const [result, setResult] = useState<RenderResult | null>(null);
  const [failure, setFailure] = useState<{ src: string; error: string } | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const id = useRef(`d2-${counter++}`);
  const src = code.trim();
  const svg = result?.src === src ? result.svg : null;

  useEffect(() => {
    if (!src) return;
    let active = true;
    setFailure(null);
    setShowFallback(false);
    if (new TextEncoder().encode(src).length > 48 * 1024) {
      setFailure({ src, error: 'D2 source exceeds 48 KiB.' });
      return;
    }
    renderD2Bounded(src, `${id.current}-${counter++}`)
      .then((rendered) => {
        if (!active) return;
        setResult({ src, svg: rendered });
        setFailure(null);
      })
      .catch((error) => {
        if (active) setFailure({ src, error: error instanceof Error ? error.message : String(error) });
      });
    return () => { active = false; };
  }, [src]);

  useEffect(() => {
    if (!failure || failure.src !== src) return;
    setShowFallback(false);
    const timeout = window.setTimeout(() => setShowFallback(true), 1_200);
    return () => window.clearTimeout(timeout);
  }, [failure, src]);

  if (svg) return <DiagramFrame language="d2" code={src} svg={svg} />;
  if (showFallback) return <DiagramFallback language="d2" code={code} error={failure?.error} />;
  return <DiagramPending language="d2" />;
}

export default memo(D2Block);
