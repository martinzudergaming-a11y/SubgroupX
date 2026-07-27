/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState, type ReactNode } from 'react';
import { m } from 'motion/react';
import { safeGet } from '../platform/storage';

export function deriveSessionTitle(text: string, fallback: string): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return fallback;
  const MAX = 48;
  if (clean.length <= MAX) return clean;
  const slice = clean.slice(0, MAX);
  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 24 ? slice.slice(0, lastSpace) : slice).trim() + '…';
}

export function mobileDrawer(opts: {
  keyPrefix: string;
  side: 'left' | 'right';
  widthClass: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const offscreen = opts.side === 'left' ? '-100%' : '100%';
  return [
    <m.div
      key={`${opts.keyPrefix}-backdrop`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={opts.onClose}
      className="fixed inset-0 z-40 bg-black/40"
    />,
    <m.div
      key={`${opts.keyPrefix}-panel`}
      initial={{ x: offscreen }}
      animate={{ x: 0 }}
      exit={{ x: offscreen }}
      transition={{ type: 'spring', stiffness: 450, damping: 42 }}
      className={`fixed inset-y-0 ${opts.side === 'left' ? 'left-0' : 'right-0'} z-50 h-full ${opts.widthClass} shadow-2xl`}
    >
      {opts.children}
    </m.div>,
  ];
}

export function SafeAreaProbe() {
  const [on, setOn] = useState(
    () =>
      typeof location !== 'undefined' &&
      (location.search.includes('safearea') ||
        safeGet('oiia.safearea') === '1' ||
        (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches === true)),
  );
  const [metrics, setMetrics] = useState<Record<string, number | string>>({});
  useEffect(() => {
    if (!on) return;
    const probe = document.createElement('div');
    probe.style.cssText =
      'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);';
    document.body.appendChild(probe);
    const px = (v: string) => Math.round(parseFloat(v) || 0);
    const read = () => {
      const cs = getComputedStyle(probe);
      const vv = window.visualViewport;
      const dvhProbe = document.createElement('div');
      dvhProbe.style.cssText = 'position:fixed;height:100dvh;visibility:hidden;pointer-events:none;';
      document.body.appendChild(dvhProbe);
      const dvh = dvhProbe.getBoundingClientRect().height;
      dvhProbe.remove();
      setMetrics({
        'inset-top': px(cs.paddingTop),
        'inset-right': px(cs.paddingRight),
        'inset-bottom': px(cs.paddingBottom),
        'inset-left': px(cs.paddingLeft),
        innerH: window.innerHeight,
        '100dvh': Math.round(dvh),
        'vv.h': vv ? Math.round(vv.height) : -1,
        'vv.top': vv ? Math.round(vv.offsetTop) : -1,
        standalone: (window.matchMedia('(display-mode: standalone)').matches ? 1 : 0),
        t: new Date().toLocaleTimeString(),
      });
    };
    read();
    const ev = () => read();
    window.addEventListener('resize', ev);
    window.addEventListener('scroll', ev, { capture: true, passive: true });
    window.visualViewport?.addEventListener('resize', ev);
    window.visualViewport?.addEventListener('scroll', ev, { passive: true });
    const iv = setInterval(read, 500);
    return () => {
      window.removeEventListener('resize', ev);
      window.removeEventListener('scroll', ev, true);
      window.visualViewport?.removeEventListener('resize', ev);
      window.visualViewport?.removeEventListener('scroll', ev);
      clearInterval(iv);
      probe.remove();
    };
  }, [on]);
  if (!on) return null;
  return (
    <button
      type="button"
      aria-label="Hide safe-area probe"
      onClick={() => setOn(false)}
      style={{ top: 'env(safe-area-inset-top)' }}
      className="fixed left-1 z-[9999] appearance-none border-0 text-left rounded bg-black/85 text-[#0f0] text-[11px] leading-[1.35] font-mono px-2 py-1 whitespace-pre cursor-pointer"
    >
      {Object.entries(metrics).map(([k, v]) => `${k}: ${v}`).join('\n')}
      {'\n(tap to hide)'}
    </button>
  );
}
