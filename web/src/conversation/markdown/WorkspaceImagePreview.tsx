'use client';

import { useEffect, useRef, useState } from 'react';
import { ImageIcon, ImageOff, Maximize2 } from 'lucide-react';
import { useT } from '../../i18n';
import { fetchBlobWithProgress } from '../../platform/progressive-media';
import { ByteProgressRing, type ByteProgress } from '../../ui/ByteProgressRing';

export interface WorkspaceImageLease {
  url: string;
  generation: number;
  release(): void;
}

type PreviewPhase = 'idle' | 'loading' | 'ready' | 'error';

export function WorkspaceImagePreview({
  path,
  label,
  acquire,
  onOpen,
}: {
  path: string;
  label: string;
  acquire: (path: string, replaceGeneration?: number) => Promise<WorkspaceImageLease>;
  onOpen: (path: string) => void;
}) {
  const t = useT();
  const rootRef = useRef<HTMLSpanElement>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const generationRef = useRef<number | undefined>(undefined);
  const [nearViewport, setNearViewport] = useState(false);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [phase, setPhase] = useState<PreviewPhase>('idle');
  const [attempt, setAttempt] = useState(0);
  const [replaceGeneration, setReplaceGeneration] = useState<number | undefined>(undefined);
  const [progress, setProgress] = useState<ByteProgress | null>(null);
  const objectUrlRef = useRef<string | null>(null);
  const releaseObjectUrl = () => {
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  };

  useEffect(() => {
    setAttempt(0);
    setReplaceGeneration(undefined);
    generationRef.current = undefined;
  }, [path]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    if (!("IntersectionObserver" in window)) {
      setNearViewport(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => setNearViewport(entry.isIntersecting),
      { rootMargin: '360px 0px' },
    );
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    if (!nearViewport) {
      releaseRef.current?.();
      releaseRef.current = null;
      generationRef.current = undefined;
      releaseObjectUrl();
      setSourceUrl(null);
      setProgress(null);
      setPhase('idle');
      if (attempt !== 0) setAttempt(0);
      return;
    }

    setSourceUrl(null);
    setProgress(null);
    setPhase('loading');
    acquire(path, attempt > 0 ? replaceGeneration : undefined).then(
      (lease) => {
        if (!live) {
          lease.release();
          return;
        }
        releaseRef.current?.();
        releaseRef.current = lease.release;
        generationRef.current = lease.generation;
        fetchBlobWithProgress(lease.url, {
          signal: controller.signal,
          onProgress: (p) => { if (live) setProgress(p); },
        }).then(
          ({ url }) => {
            if (!live) {
              URL.revokeObjectURL(url);
              return;
            }
            releaseObjectUrl();
            objectUrlRef.current = url;
            setSourceUrl(url);
          },
          () => {
            if (!live) return;
            fail();
          },
        );
      },
      () => {
        if (!live) return;
        if (attempt === 0) {
          setReplaceGeneration(undefined);
          setAttempt(1);
        }
        else setPhase('error');
      },
    );

    return () => {
      live = false;
      controller.abort();
      releaseRef.current?.();
      releaseRef.current = null;
      generationRef.current = undefined;
      releaseObjectUrl();
    };
  }, [acquire, attempt, nearViewport, path, replaceGeneration]);

  const fail = () => {
    const failedGeneration = generationRef.current;
    releaseRef.current?.();
    releaseRef.current = null;
    generationRef.current = undefined;
    releaseObjectUrl();
    setProgress(null);
    setSourceUrl(null);
    if (attempt === 0) {
      setPhase('loading');
      setReplaceGeneration(failedGeneration);
      setAttempt(1);
    } else {
      setPhase('error');
    }
  };

  return (
    <span ref={rootRef} data-workspace-image-root className="group/workspace-image my-2 inline-flex w-[min(100%,34rem)] max-w-full align-top">
      <button
        type="button"
        onClick={() => onOpen(path)}
        title={`${t('rs.openInPanel')}: ${label}`}
        aria-label={`${t('rs.openInPanel')}: ${label}`}
        aria-busy={phase === 'loading'}
        data-testid="workspace-image-preview"
        data-file={path}
        data-state={phase}
        className="relative w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-[#C77D2E]/30"
      >
        <span data-testid="workspace-image-viewport" className={`relative block aspect-[16/10] w-full overflow-hidden ${phase === 'ready' ? 'bg-transparent' : 'bg-[color-mix(in_srgb,var(--app-frame)_55%,transparent)] dark:bg-[#20211F]/55'}`}>
          {sourceUrl && (
            <img
              src={sourceUrl}
              alt={label}
              data-testid="workspace-image"
              loading="lazy"
              decoding="async"
              draggable={false}
              onLoad={() => setPhase('ready')}
              onError={fail}
              className={`absolute inset-0 !m-0 size-full !rounded-none !border-0 object-contain transition-opacity duration-200 ease-[cubic-bezier(.16,1,.3,1)] motion-reduce:transition-none ${phase === 'ready' ? 'opacity-100' : 'opacity-0'}`}
            />
          )}
          {phase !== 'ready' && (
            <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-[#989A92] dark:text-[#74776F]">
              {phase === 'loading' ? (
                <ByteProgressRing progress={progress} />
              ) : phase === 'error' ? (
                <>
                  <ImageOff aria-hidden className="size-5" strokeWidth={1.7} />
                  <span className="px-4 text-center text-[11px] leading-4">{t('file.previewFailed')}</span>
                </>
              ) : (
                <ImageIcon aria-hidden className="size-5" strokeWidth={1.7} />
              )}
              {phase === 'loading' && <span className="sr-only">{t('file.previewLoading')}</span>}
            </span>
          )}
        </span>
        <span className="mt-1.5 flex h-6 items-center gap-2 px-0.5 text-[11.5px] text-[#7B7E76] dark:text-[#94978F]">
          <span className="min-w-0 flex-1 truncate" dir="auto">{label}</span>
          <Maximize2 aria-hidden className="size-3.5 shrink-0 opacity-0 transition-opacity group-hover/workspace-image:opacity-60 group-focus-within/workspace-image:opacity-60 [@media(hover:none)]:opacity-45" strokeWidth={1.8} />
        </span>
      </button>
    </span>
  );
}
