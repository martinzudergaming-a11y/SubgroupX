import { useState } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import MarkdownRenderer from '../../../conversation/markdown/MarkdownRenderer';
import { useT } from '../../../i18n';
import type { ArchivedMessage, ArchivedContentBlock, CompactionDetailResponse } from '../../../platform/api.ts';

function ArchivedRow({ msg }: { msg: ArchivedMessage }) {
  const roleLabel =
    msg.role === 'user' ? 'User'
    : msg.role === 'assistant' ? 'Assistant'
    : 'Tool';

  let text = '';
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    text = msg.content
      .map((b: ArchivedContentBlock) => {
        if (b.type === 'text' && typeof b.text === 'string') return b.text;
        if (b.type === 'thinking' && typeof b.thinking === 'string') return b.thinking;
        if (b.type === 'toolCall' && typeof b.name === 'string') return `↳ ${b.name}`;
        if (b.type === 'image') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n\n');
  }
  if (msg.role === 'toolResult' && msg.toolName) text = `↳ ${msg.toolName}\n${text}`;
  if (!text.trim()) return null;

  return (
    <div className="border-l-2 border-[#EEE] dark:border-[#333] pl-3">
      <div className="text-[11px] uppercase tracking-wide text-[#A0A0A0] dark:text-[#666] mb-1 select-none">
        {roleLabel}
      </div>
      <div
        className={
          msg.isError
            ? 'text-[13px] leading-[1.6] text-[#A33] dark:text-[#F2B0B0] whitespace-pre-wrap [&_.markdown-body_p]:!text-[13px]'
            : 'text-[13px] leading-[1.6] text-[#555] dark:text-[#A8A8A8] [&_.markdown-body>p]:mb-0 [&_.markdown-body_p]:!text-[13px] [&_.markdown-body_p]:!leading-[1.6]'
        }
      >
        <MarkdownRenderer>{text}</MarkdownRenderer>
      </div>
    </div>
  );
}

export default function CompactionDetail({ detail }: { detail: CompactionDetailResponse }) {
  const t = useT();
  const [archivedOpen, setArchivedOpen] = useState(false);
  return (
    <div data-testid="compaction-detail" className="flex flex-col gap-4 text-left">
      <div className="text-[11px] text-[#A0A0A0] dark:text-[#666] select-none">
        {t('compaction.tokens', { before: detail.tokensBefore, after: detail.tokensAfter })}
      </div>

      <section>
        <div className="text-[11px] uppercase tracking-wide text-[#A0A0A0] dark:text-[#666] mb-1.5 select-none">
          {t('compaction.summary')}
        </div>
        <div className="text-[13.5px] leading-[1.65] text-[#444] dark:text-[#C0C0C0] [&_.markdown-body_p]:!text-[13.5px] [&_.markdown-body_p]:!leading-[1.65]">
          <MarkdownRenderer>{detail.summary}</MarkdownRenderer>
        </div>
      </section>

      <section className="flex flex-col gap-3">

        <button
          type="button"
          data-testid="compaction-archived-toggle"
          onClick={() => setArchivedOpen((v) => !v)}
          aria-expanded={archivedOpen}
          className="flex items-center gap-1.5 w-fit text-[11px] uppercase tracking-wide text-[#A0A0A0] dark:text-[#666] hover:text-[#777] dark:hover:text-[#999] transition-colors select-none"
        >
          {archivedOpen ? <ChevronDown className="size-[13px] opacity-70" /> : <ChevronRight className="size-[13px] opacity-70" />}
          <span>{t('compaction.archived')}</span>
          <span className="text-[#CCC] dark:text-[#444]">·</span>
          <span className="normal-case lowercase">{t('compaction.archivedCount', { n: detail.messages.length })}</span>
        </button>
        {archivedOpen && (
          <div className="flex flex-col gap-3">
            {detail.truncated && (
              <div className="text-[12px] text-[#999] dark:text-[#777]">
                {t('compaction.truncated', { n: detail.messages.length })}
              </div>
            )}
            {detail.messages.map((msg, idx) => (
              <ArchivedRow key={idx} msg={msg} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
