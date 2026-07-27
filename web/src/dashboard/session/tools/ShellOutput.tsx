import { useState } from 'react';
import type { ShellResult } from '@shared/protocol';
import { useT } from '../../../i18n';

const VISIBLE_LINES = 40;
const STREAM_CHAR_CAP = 32_000;

function parseShellResult(raw: string): {
  stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; truncated: boolean;
} {
  let body = raw;
  let exitCode: number | null = null;
  let timedOut = false;
  let truncated = false;
  body = body.replace(/\n…\[truncated \d+ chars\]\s*$/, () => { truncated = true; return ''; });
  body = body.replace(/\n\[exit code: (-?\d+)\]\s*$/, (_m, n) => { exitCode = Number(n); return ''; });
  body = body.replace(/\n\[command timed out\]\s*$/, () => { timedOut = true; return ''; });
  let stdout = body;
  let stderr = '';
  if (body.startsWith('[stderr]\n')) { stdout = ''; stderr = body.slice('[stderr]\n'.length); }
  else {
    const i = body.indexOf('\n[stderr]\n');
    if (i !== -1) { stdout = body.slice(0, i); stderr = body.slice(i + '\n[stderr]\n'.length); }
  }
  return { stdout, stderr, exitCode, timedOut, truncated };
}

export function ShellOutput({ shell, text, collapse = true }: { shell?: ShellResult; text: string; collapse?: boolean }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const parsed = shell ?? parseShellResult(text);
  const stdout = parsed.stdout.slice(0, STREAM_CHAR_CAP);
  const stderr = parsed.stderr.slice(0, STREAM_CHAR_CAP);
  const { exitCode, timedOut } = parsed;
  const truncated = parsed.truncated
    || parsed.stdout.length > STREAM_CHAR_CAP
    || parsed.stderr.length > STREAM_CHAR_CAP;

  const outLines = stdout ? stdout.split('\n') : [];
  const errLines = stderr ? stderr.split('\n') : [];
  const outHidden = collapse && !expanded && outLines.length > VISIBLE_LINES ? outLines.length - VISIBLE_LINES : 0;
  const errHidden = collapse && !expanded && errLines.length > VISIBLE_LINES ? errLines.length - VISIBLE_LINES : 0;
  const shownOut = outHidden ? outLines.slice(0, VISIBLE_LINES).join('\n') : stdout;
  const shownErr = errHidden ? errLines.slice(0, VISIBLE_LINES).join('\n') : stderr;
  const hidden = outHidden + errHidden;

  return (
    <div className="font-mono text-[12.5px] leading-[1.55] whitespace-pre-wrap break-words">
      {exitCode != null && exitCode !== 0 && (
        <div className="text-[#D2433B] dark:text-[#E89B9B] mb-0.5">
          {t('tool.exitCode', { code: exitCode })}{timedOut ? ` · ${t('tool.timedOut')}` : ''}
        </div>
      )}
      {shownOut && <span className="text-[#5f6368] dark:text-[#9a9a9a]">{shownOut}</span>}
      {shownErr && <span className={`block text-[#A77A06] dark:text-[#E0B84A] ${shownOut ? 'mt-1' : ''}`}>{shownErr}</span>}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="block mt-1 text-[11.5px] text-[#888] dark:text-[#777] hover:text-[#555] dark:hover:text-[#bbb] transition-colors"
        >
          {t(hidden === 1 ? 'tool.showMoreLine' : 'tool.showMoreLines', { count: hidden })}
        </button>
      )}
      {truncated && (
        <div className="mt-1 text-[11.5px] italic text-[#999] dark:text-[#777]">{t('tool.outputTruncated')}</div>
      )}
    </div>
  );
}
