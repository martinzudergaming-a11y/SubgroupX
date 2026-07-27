import { useEffect, useRef, useState } from 'react';
import { highlightSegmentsToHtml } from './highlighter';
import { splitHeredoc } from './heredoc';
import { shikiFallback } from './shiki';
import { useFormattedBash } from './bash-format';

export function ShellCommand({ command, format = false }: { command: string; format?: boolean }) {
  const pretty = useFormattedBash(command, format);
  const code = (pretty ?? command).replace(/\n+$/, '');
  const [html, setHtml] = useState(() => shikiFallback(code));
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    highlightSegmentsToHtml(splitHeredoc(code))
      .then((out) => { if (active) setHtml(out); })
      .catch(() => {});
    return () => { active = false; };
  }, [code]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.replaceChildren(
      ...new DOMParser().parseFromString(html, 'text/html').body.childNodes,
    );
  }, [html]);

  return (
    <div
      data-testid="shell-command"
      data-formatted={format ? "true" : "false"}
      className="markdown-theme flex items-start gap-2 text-[13px] leading-[1.6]"
      style={{ fontFamily: 'var(--font-code)' }}
    >
      <span className="shrink-0 select-none opacity-70 text-[#888] dark:text-[#777]">$</span>
      <div
        ref={bodyRef}
        className="min-w-0 flex-1 select-text break-normal [overflow-wrap:anywhere] [&_pre.shiki]:!m-0 [&_pre.shiki]:!p-0 [&_pre.shiki]:!bg-transparent [&_.shiki]:!bg-transparent [&_.shiki]:whitespace-pre-wrap [&_.shiki]:break-normal [&_.shiki]:[overflow-wrap:anywhere] [&_pre.shiki_code]:whitespace-pre-wrap [&_pre.shiki_code]:break-normal [&_pre.shiki_code]:[overflow-wrap:anywhere] [&_pre.shiki_span]:break-normal [&_pre.shiki_span]:[overflow-wrap:anywhere]"
      />
    </div>
  );
}
