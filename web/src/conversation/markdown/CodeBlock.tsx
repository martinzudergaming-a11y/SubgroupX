'use client';

import React, { useEffect, useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { Check, Copy } from 'lucide-react';
import { langIconFor } from '../../files/fileIcons';
import { useT } from '../../i18n';
import { highlightCodeToHtml } from './highlighter';
import { normalizeLanguage } from '../../files/languages';
import { shikiFallback } from './shiki';
import { useCopyFlag } from '../../ui/useCopyFlag';

function formatLanguageLabel(language: string) {
  if (language.includes('json')) return 'json';
  return language.toLowerCase();
}

export function InlineCode({ children }: { children: React.ReactNode }) {
  return <code>{children}</code>;
}

export default function CodeBlock({
  code,
  language = 'plaintext',
  hideHeader = false,
  lineNumbers = false,
}: {
  code: string;
  language?: string;
  hideHeader?: boolean;
  lineNumbers?: boolean;
}) {
  const t = useT();
  const { copied, flash } = useCopyFlag(1600);

  const mappedLanguage = useMemo(() => normalizeLanguage(language), [language]);
  const normalizedCode = useMemo(() => code.replace(/\n$/, ''), [code]);
  const label = useMemo(() => formatLanguageLabel(mappedLanguage), [mappedLanguage]);

  const hasLanguage = mappedLanguage !== 'plaintext';
  const showHeader = !hideHeader && hasLanguage;
  const showFloatingCopy = !hideHeader && !hasLanguage;

  const fallbackHtml = useMemo(
    () => shikiFallback(normalizedCode),
    [normalizedCode],
  );

  const [html, setHtml] = useState(fallbackHtml);

  const safeHtml = useMemo(() => DOMPurify.sanitize(html), [html]);

  useEffect(() => {
    let active = true;
    highlightCodeToHtml(normalizedCode, mappedLanguage)
      .then((out) => { if (active) setHtml(out); })
      .catch(() => {
      });
    return () => { active = false; };
  }, [fallbackHtml, mappedLanguage, normalizedCode]);

  async function copyCode() {
    await navigator.clipboard.writeText(normalizedCode);
    flash();
  }

  return (
    <div
      className={`codeblock-shell group ${hideHeader ? 'h-full flex flex-col bg-transparent m-0' : ''} ${showFloatingCopy ? 'relative' : ''}`}
      style={hideHeader ? { border: 'none', borderRadius: 0, margin: 0 } : undefined}
    >
      {showHeader && (
        <div className="codeblock-header">
          <div className="codeblock-title">
            {langIconFor(mappedLanguage)}
            <span>{label}</span>
          </div>

          <div className="codeblock-actions">
            <button
              type="button"
              className="codeblock-icon-btn"
              title={copied ? t('code.copied') : t('code.copy')}
              aria-label={copied ? t('code.copied') : t('code.copy')}
              onClick={copyCode}
            >
              {copied ? <Check size={14} /> : <Copy size={14} />}
            </button>
          </div>
        </div>
      )}

      {showFloatingCopy && (
        <button
          type="button"
          className="codeblock-icon-btn absolute right-1.5 top-1.5 z-10 rounded-md bg-white/70 dark:bg-[#1b1b1c]/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          title={copied ? t('code.copied') : t('code.copy')}
          aria-label={copied ? t('code.copied') : t('code.copy')}
          onClick={copyCode}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}

      <div className={`codeblock-body flex-1 overflow-y-auto ${lineNumbers ? 'cb-line-numbers' : ''} ${hideHeader ? '!py-2 !px-3 !bg-transparent' : ''}`} dangerouslySetInnerHTML={{ __html: safeHtml }} />
    </div>
  );
}
