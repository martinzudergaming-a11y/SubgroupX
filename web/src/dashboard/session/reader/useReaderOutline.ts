import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { TimelineItem } from '@shared/protocol';
import { groupConversationTurns } from '@shared/conversation-model';

export interface OutlineEntry {
  turnId: string;
  id: string;
  idx: number;
  text: string;
  inferred: boolean;
}

export function useReaderOutline(opts: {
  items: TimelineItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  maxVisible: number;
  setMaxVisible: Dispatch<SetStateAction<number>>;
  pinnedRef: RefObject<boolean>;
  resetKey: string;
}) {
  const { items, scrollRef, maxVisible, setMaxVisible, pinnedRef, resetKey } = opts;

  const [tocOpen, setTocOpen] = useState(false);
  const [tocActiveId, setTocActiveId] = useState<string | null>(null);
  const pendingTocScrollRef = useRef<string | null>(null);

  useEffect(() => {
    setTocOpen(false);
    setTocActiveId(null);
    pendingTocScrollRef.current = null;
  }, [resetKey]);

  const turnEntries = useMemo<OutlineEntry[]>(() => {
    const indexById = new Map(items.map((item, index) => [item.id, index]));
    return groupConversationTurns(items).flatMap((turn) => {
      const prompt = turn.items.find((item): item is Extract<TimelineItem, { kind: 'user' }> => item.kind === 'user');
      if (!prompt) return [];
      return [{
        turnId: turn.id,
        id: prompt.id,
        idx: indexById.get(prompt.id) ?? 0,
        text: prompt.text,
        inferred: turn.inferred,
      }];
    });
  }, [items]);
  const turnEntriesRef = useRef(turnEntries);
  turnEntriesRef.current = turnEntries;
  const promptAnchorSig = turnEntries.map((entry) => entry.id).join(' ') + `|${maxVisible}`;

  const scrollToPrompt = useCallback(
    (id: string) => {
      const root = scrollRef.current;
      const node = root?.querySelector(`#toc-${CSS.escape(id)}`);
      if (!root || !node) return;
      const top = root.scrollTop + node.getBoundingClientRect().top - root.getBoundingClientRect().top - 8;
      const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
      root.scrollTo({ top, behavior: reduced ? 'auto' : 'smooth' });
    },
    [scrollRef],
  );

  const jumpToPrompt = useCallback(
    (id: string, idx: number) => {
      setTocOpen(false);
      pinnedRef.current = false;
      const firstVisible = Math.max(0, items.length - maxVisible);
      if (idx < firstVisible) {
        pendingTocScrollRef.current = id;
        setMaxVisible(items.length);
      } else {
        scrollToPrompt(id);
      }
    },
    [items.length, maxVisible, setMaxVisible, scrollToPrompt, pinnedRef],
  );

  const onPendingTocScroll = useEffectEvent((id: string) => scrollToPrompt(id));

  useLayoutEffect(() => {
    const id = pendingTocScrollRef.current;
    if (id == null) return;
    pendingTocScrollRef.current = null;
    requestAnimationFrame(() => onPendingTocScroll(id));
  }, [maxVisible]);

  useEffect(() => {
    const root = scrollRef.current;
    const prompts = turnEntriesRef.current;
    if (!root || prompts.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const visible = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = e.target.id.replace(/^toc-/, '');
          if (e.isIntersecting) visible.set(id, e.boundingClientRect.top);
          else visible.delete(id);
        }
        if (visible.size === 0) return;
        let topId: string | null = null;
        let topOffset = Infinity;
        for (const [id, offset] of visible) {
          if (offset < topOffset) { topOffset = offset; topId = id; }
        }
        setTocActiveId(topId);
      },
      { root, rootMargin: '0px 0px -70% 0px', threshold: 0 },
    );
    for (const p of prompts) {
      const node = root.querySelector(`#toc-${CSS.escape(p.id)}`);
      if (node) io.observe(node);
    }
    return () => io.disconnect();
  }, [promptAnchorSig]);

  return { turnEntries, tocOpen, setTocOpen, tocActiveId, jumpToPrompt, pendingTocScrollRef };
}
