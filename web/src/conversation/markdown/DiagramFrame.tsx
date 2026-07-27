'use client';

import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Expand, Fullscreen, Shrink, X } from 'lucide-react';
import { writeClipboard } from '../../platform/clipboard';
import { useT } from '../../i18n';
import CodeBlock from './CodeBlock';

export type DiagramLanguage = 'mermaid' | 'd2';

function prepareSvg(parsed: SVGSVGElement, language: DiagramLanguage) {
  parsed.setAttribute('role', 'img');
  parsed.setAttribute('aria-label', `${language === 'd2' ? 'D2' : 'Mermaid'} diagram`);

  parsed.querySelectorAll([
    'script', 'iframe', 'object', 'embed', 'image',
    'foreignObject img', 'foreignObject video', 'foreignObject audio', 'foreignObject source',
    'foreignObject track', 'foreignObject link', 'foreignObject meta', 'foreignObject base',
    'foreignObject style', 'foreignObject form', 'foreignObject input', 'foreignObject button',
    'foreignObject textarea', 'foreignObject select',
    'animate', 'animateMotion', 'animateTransform', 'set', 'discard',
  ].join(', ')).forEach((node) => node.remove());
  for (const element of [parsed, ...parsed.querySelectorAll('*')]) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (name.startsWith('on')) element.removeAttribute(attribute.name);
      if ((name === 'href' || name === 'xlink:href') && !value.startsWith('#')) {
        element.removeAttribute(attribute.name);
      }
      if (['src', 'srcset', 'poster', 'action', 'formaction', 'background', 'ping'].includes(name)) {
        element.removeAttribute(attribute.name);
      }
      if (/url\(\s*["']?(?!#)/i.test(value)) element.removeAttribute(attribute.name);
      if (/expression\s*\(|-moz-binding|behavior\s*:/i.test(value)) element.removeAttribute(attribute.name);
    }
  }

  const viewBox = parsed.getAttribute('viewBox')?.trim().split(/\s+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    parsed.setAttribute('width', String(Math.ceil(viewBox[2])));
    parsed.setAttribute('height', String(Math.ceil(viewBox[3])));
  }
  parsed.style.removeProperty('width');
  parsed.style.removeProperty('height');
  parsed.style.removeProperty('max-width');
}

function parseSvg(svg: string, language: DiagramLanguage): SVGSVGElement | null {
  const document = language === 'd2'
    ? new DOMParser().parseFromString(svg, 'image/svg+xml')
    : new DOMParser().parseFromString(svg, 'text/html');
  if (document.querySelector('parsererror')) return null;
  const parsed = (language === 'd2' ? document.documentElement : document.body.querySelector('svg')) as SVGSVGElement | null;
  if (!parsed || parsed.tagName.toLowerCase() !== 'svg') return null;
  prepareSvg(parsed, language);
  return parsed;
}

function useSvgHost(svg: string, language: DiagramLanguage) {
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const parsed = parseSvg(svg, language);
    if (!parsed) return;
    const mounted = document.adoptNode(parsed);
    host.appendChild(mounted);
    return () => {
      if (mounted.parentNode === host) host.removeChild(mounted);
    };
  }, [language, svg]);
  return hostRef;
}

function DiagramFullscreen({ language, svg, onClose }: { language: DiagramLanguage; svg: string; onClose: () => void }) {
  const t = useT();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const hostRef = useSvgHost(svg, language);

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    return () => dialog?.close();
  }, []);

  return (
    <dialog
      ref={dialogRef}
      aria-label={t('diagram.fullscreen')}
      className={`diagram-fullscreen-dialog ${language}-fullscreen-dialog`}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose();
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className="diagram-fullscreen-panel">
        <button
          type="button"
          className="codeblock-icon-btn diagram-fullscreen-close"
          title={t('diagram.closeFullscreen')}
          aria-label={t('diagram.closeFullscreen')}
          onClick={onClose}
        >
          <X size={16} />
        </button>
        <div className="diagram-fullscreen-viewport">
          <div ref={hostRef} className={`diagram-fullscreen-host ${language}-fullscreen-host`} />
        </div>
      </div>
    </dialog>
  );
}

export function DiagramPending({ language }: { language: DiagramLanguage }) {
  const t = useT();
  return (
    <div className={`diagram-shell ${language}-shell diagram-pending`} data-testid={`${language}-pending`}>
      <div className="diagram-pending-mark" />
      <div className="diagram-pending-text">{t('diagram.rendering')}</div>
    </div>
  );
}

export function DiagramFallback({ language, code, error }: { language: DiagramLanguage; code: string; error?: string }) {
  const t = useT();
  return (
    <div className="diagram-fallback" data-testid={`${language}-error`}>
      <div className="diagram-error" title={error}>{t('diagram.invalid')}</div>
      <CodeBlock code={code} language={language} />
    </div>
  );
}

export function DiagramFrame({ language, code, svg }: { language: DiagramLanguage; code: string; svg: string }) {
  const t = useT();
  const [fitToWidth, setFitToWidth] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [copied, setCopied] = useState(false);
  const hostRef = useSvgHost(svg, language);

  async function copySource() {
    const ok = await writeClipboard(code.trim());
    if (!ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_600);
  }

  return (
    <div
      className={`diagram-shell ${language}-shell group`}
      data-language={language}
      data-fit={fitToWidth ? 'width' : 'actual'}
    >
      <div className="diagram-actions">
        <button
          type="button"
          className="codeblock-icon-btn"
          data-testid={`${language}-copy`}
          title={copied ? t('diagram.copiedSource') : t('diagram.copySource')}
          aria-label={copied ? t('diagram.copiedSource') : t('diagram.copySource')}
          onClick={copySource}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          type="button"
          className="codeblock-icon-btn"
          data-testid={`${language}-size-toggle`}
          title={fitToWidth ? t('diagram.showActualSize') : t('diagram.fitToWidth')}
          aria-label={fitToWidth ? t('diagram.showActualSize') : t('diagram.fitToWidth')}
          onClick={() => setFitToWidth((value) => !value)}
        >
          {fitToWidth ? <Expand size={14} /> : <Shrink size={14} />}
        </button>
        <button
          type="button"
          className="codeblock-icon-btn"
          data-testid={`${language}-fullscreen`}
          title={t('diagram.fullscreen')}
          aria-label={t('diagram.fullscreen')}
          onClick={() => setFullscreen(true)}
        >
          <Fullscreen size={14} />
        </button>
      </div>
      <div data-testid={`${language}-diagram`} className="diagram-viewport">
        <div ref={hostRef} className="diagram-svg-host" />
      </div>
      {fullscreen && <DiagramFullscreen language={language} svg={svg} onClose={() => setFullscreen(false)} />}
    </div>
  );
}
