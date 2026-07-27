import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Spinner } from "../ui/Spinner";
import { motion, AnimatePresence } from "motion/react";
import { X, Link2, Copy, Check, Trash2, ShieldAlert } from "lucide-react";
import { api } from "../platform/api";
import { writeClipboard } from "../platform/clipboard";
import { useT, type TFunction } from "../i18n";
import { relativeShareTime as relativeTime } from "./relative-time";
import { parseMessageAttachments } from "../files/MessageAttachments-helpers";
import { useOnEscape } from "../dashboard/ui/use-on-escape";
import { useCopyFlag } from "../ui/useCopyFlag";
import type { TimelineItem } from "@shared/protocol";
import { groupConversationTurns } from "@shared/conversation-model";

type Share = { token: string; url: string; createdAt: number };

type Turn = { id: string; itemIds: string[]; preview: string; ts: number };

const PREVIEW_LEN = 60;

function groupTurns(timeline: TimelineItem[]): Turn[] {
  return groupConversationTurns(timeline).map((turn) => {
    const user = turn.items.find((item): item is Extract<TimelineItem, { kind: "user" }> => item.kind === "user");
    const first = turn.items[0];
    const preview = user
      ? parseMessageAttachments(user.text).cleanText.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LEN)
      : first.kind;
    return { id: turn.id, itemIds: turn.items.map((item) => item.id), preview, ts: first.ts };
  });
}

export function ShareDialog({
  sessionId,
  timeline,
  onClose,
}: {
  sessionId: string;
  timeline?: TimelineItem[];
  onClose: () => void;
}) {
  const t = useT();
  const [shares, setShares] = useState<Share[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState(false);
  const [created, setCreated] = useState<{ url: string; itemCount: number; copied: boolean } | null>(null);
  const createdRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (created) createdRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [created]);

  const turns = useMemo(() => groupTurns(timeline ?? []), [timeline]);
  const canSelect = turns.length > 0;
  const [scopeMode, setScopeMode] = useState<"full" | "choose">("full");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const lastIdxRef = useRef<number | null>(null);

  const cardRef = useRef<HTMLDivElement>(null);

  useOnEscape(onClose);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    cardRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  useEffect(() => {
    let live = true;
    setShares(null);
    setLoadError(false);
    setCreated(null);
    setCreateError(false);
    setScopeMode("full");
    setSelected(new Set());
    lastIdxRef.current = null;
    api.listShares(sessionId).then(
      (r) => live && setShares(r.shares),
      () => live && setLoadError(true),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  const selectedItemIds = useMemo(
    () => turns.filter((tn) => selected.has(tn.id)).flatMap((tn) => tn.itemIds),
    [turns, selected],
  );
  const selectedTurnCount = turns.filter((turn) => selected.has(turn.id)).length;
  const useScope = scopeMode === "choose" && selectedTurnCount > 0 && selectedTurnCount < turns.length;
  const createDisabled = creating || (scopeMode === "choose" && selectedTurnCount === 0);

  const create = useCallback(async () => {
    setCreating(true);
    setCreateError(false);
    try {
      const r = useScope
        ? await api.createShare(sessionId, { itemIds: selectedItemIds })
        : await api.createShare(sessionId);
      const copied = await writeClipboard(r.url);
      setCreated({ url: r.url, itemCount: r.itemCount, copied });
      setShares((cur) => [{ token: r.token, url: r.url, createdAt: r.createdAt }, ...(cur ?? [])]);
    } catch {
      setCreateError(true);
    } finally {
      setCreating(false);
    }
  }, [sessionId, useScope, selectedItemIds]);

  const toggleTurn = useCallback(
    (idx: number, shift: boolean) => {
      setSelected((cur) => {
        const next = new Set(cur);
        const id = turns[idx].id;
        const willCheck = !next.has(id);
        const anchor = lastIdxRef.current;
        if (shift && anchor !== null) {
          const [lo, hi] = anchor < idx ? [anchor, idx] : [idx, anchor];
          for (let i = lo; i <= hi; i++) {
            if (willCheck) next.add(turns[i].id);
            else next.delete(turns[i].id);
          }
        } else if (willCheck) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return next;
      });
      lastIdxRef.current = idx;
    },
    [turns],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(turns.map((tn) => tn.id)));
    lastIdxRef.current = turns.length - 1;
  }, [turns]);

  const selectThisTurn = useCallback(() => {
    if (turns.length === 0) return;
    setSelected(new Set([turns[turns.length - 1].id]));
    lastIdxRef.current = turns.length - 1;
  }, [turns]);

  const selectFromHere = useCallback(() => {
    if (turns.length === 0) return;
    const first = turns.findIndex((tn) => selected.has(tn.id));
    const from = first === -1 ? 0 : first;
    setSelected(new Set(turns.slice(from).map((tn) => tn.id)));
    lastIdxRef.current = turns.length - 1;
  }, [turns, selected]);

  const revoke = useCallback(
    async (token: string) => {
      setShares((cur) => (cur ?? []).filter((s) => s.token !== token));
      setCreated((cur) => (cur && shares?.find((s) => s.token === token)?.url === cur.url ? null : cur));
      await api.revokeShare(token).catch(() => {});
    },
    [shares],
  );

  return (
    <AnimatePresence>
      <motion.div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-[1px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="share-dialog"
      >
        <motion.div
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="share-dialog-title"
          tabIndex={-1}
          className="flex flex-col w-full max-w-[460px] max-h-[82vh] rounded-2xl bg-[var(--app-surface)] dark:bg-[#1B1B1B] border border-[#E8EBE3] dark:border-[#333] oiia-shadow-modal overflow-hidden outline-none"
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >

          <div className="flex items-start justify-between px-5 py-3.5 border-b border-[#F0F0F0] dark:border-[#2A2A2A] shrink-0">
            <div className="flex items-center gap-2 min-w-0">
              <Link2 className="w-4 h-4 text-[#666] dark:text-[#A0A0A0] shrink-0" />
              <div id="share-dialog-title" className="text-[14px] font-medium text-[#111] dark:text-[#E8E8E8] truncate">{t("share.dialog.title")}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("share.dialog.close")}
              className="p-1.5 rounded-md text-[#888] dark:text-[#999] hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] transition-colors shrink-0"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="px-5 py-4 overflow-y-auto space-y-4">

            {canSelect && (
              <div>
                <div className="flex rounded-lg bg-[#F4F4F5] dark:bg-[#222] p-0.5 text-[12.5px]">
                  {(["full", "choose"] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      data-testid={`share-scope-${m}`}
                      aria-pressed={scopeMode === m}
                      onClick={() => setScopeMode(m)}
                      className={`flex-1 rounded-md px-3 py-1.5 font-medium transition-colors ${
                        scopeMode === m
                          ? "bg-white dark:bg-[#333] text-[#222] dark:text-[#E8E8E8] shadow-sm"
                          : "text-[#777] dark:text-[#999] hover:text-[#444] dark:hover:text-[#C8C8C8]"
                      }`}
                    >
                      {t(m === "full" ? "share.scope.full" : "share.scope.choose")}
                    </button>
                  ))}
                </div>

                {scopeMode === "choose" && (
                  <div className="mt-2.5" data-testid="share-turn-picker">

                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {(
                        [
                          ["share.scope.selectAll", selectAll, "share-select-all"],
                          ["share.scope.thisTurn", selectThisTurn, "share-this-turn"],
                          ["share.scope.fromHere", selectFromHere, "share-from-here"],
                        ] as const
                      ).map(([key, fn, tid]) => (
                        <button
                          key={key}
                          type="button"
                          data-testid={tid}
                          onClick={fn}
                          className="rounded-md border border-[#E5E5E5] dark:border-[#333] px-2 py-1 text-[11.5px] text-[#555] dark:text-[#BBB] hover:bg-[#F5F5F5] dark:hover:bg-[#262626] transition-colors"
                        >
                          {t(key)}
                        </button>
                      ))}
                    </div>

                    <div className="max-h-[34vh] overflow-y-auto rounded-lg border border-[#ECECEC] dark:border-[#2A2A2A] divide-y divide-[#F0F0F0] dark:divide-[#262626]">
                      {turns.map((tn, idx) => {
                        const checked = selected.has(tn.id);
                        return (
                          <label
                            key={tn.id}
                            data-testid="share-turn-row"
                            className="flex items-center gap-2.5 px-2.5 py-2 cursor-pointer hover:bg-[#F7F7F7] dark:hover:bg-[#222] transition-colors select-none"
                            onClick={(e) => {
                              e.preventDefault();
                              toggleTurn(idx, e.shiftKey);
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              readOnly
                              tabIndex={-1}
                              className="shrink-0 accent-[#222] dark:accent-[#E8E8E8]"
                            />
                            <span className="flex-1 min-w-0 truncate text-[12.5px] text-[#444] dark:text-[#C8C8C8]">
                              {tn.preview || "…"}
                            </span>
                            <span className="shrink-0 text-[11px] tabular-nums text-[#999] dark:text-[#777]">
                              {relativeTime(tn.ts, t)}
                            </span>
                          </label>
                        );
                      })}
                    </div>

                    <div className="mt-1.5 text-[11.5px] text-[#888] dark:text-[#777]" data-testid="share-scope-count">
                      {t("share.scope.countOfTotal", { n: selectedTurnCount, total: turns.length })}
                    </div>
                  </div>
                )}
              </div>
            )}

            <div className="flex items-start gap-2 rounded-lg bg-amber-50 dark:bg-amber-900/15 border border-amber-200/60 dark:border-amber-800/40 px-3 py-2.5 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
              <ShieldAlert className="w-4 h-4 mt-px shrink-0" />
              <span>{t("share.dialog.warning")}</span>
            </div>

            <button
              type="button"
              data-testid="share-create"
              onClick={create}
              disabled={createDisabled}
              className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#222] dark:bg-[#E8E8E8] text-white dark:text-[#1A1A1A] px-3 py-2 text-[13px] font-medium hover:opacity-90 disabled:opacity-60 transition-opacity"
            >
              {creating ? <Spinner className="w-3.5 h-3.5" strokeWidth={2.4} /> : <Link2 className="w-3.5 h-3.5" />}
              {creating ? t("share.dialog.creating") : t("share.dialog.createLink")}
            </button>
            {createError && (
              <div className="text-[12px] text-[#B4453B] dark:text-[#E59A92]">{t("share.dialog.createError")}</div>
            )}

            {created && (
              <div
                ref={createdRef}
                data-testid="share-created"
                style={{ animation: "oiia-slide-down .2s ease-out" }}
                className="rounded-lg ring-1 ring-[#177245]/25 dark:ring-[#9FE0B9]/25 bg-[#F4FBF6] dark:bg-[#13241A]/60 p-2.5"
              >

                <div className="flex items-center gap-1.5 mb-1.5 text-[12px] font-medium text-[#177245] dark:text-[#9FE0B9]">
                  <Check className="w-3.5 h-3.5 shrink-0" />
                  {t("share.dialog.linkCreated")}
                  {created.copied && <span className="opacity-80">· {t("share.dialog.linkCopied")}</span>}
                </div>
                <CopyRow
                  url={created.url}
                  label={`${t("share.dialog.linkLabel")} · ${t("share.dialog.itemCount", { count: created.itemCount })}`}
                  t={t}
                  autoFlash={created.copied}
                />
              </div>
            )}

            <div>
              <div className="text-[11.5px] font-medium text-[#888] dark:text-[#777] mb-1.5">{t("share.dialog.existingShares")}</div>
              {shares === null && !loadError && (
                <div className="text-[12.5px] text-[#999] dark:text-[#777]">{t("share.dialog.loading")}</div>
              )}
              {loadError && (
                <div className="text-[12.5px] text-[#B4453B] dark:text-[#E59A92]">{t("share.dialog.error")}</div>
              )}
              {shares !== null && !loadError && shares.length === 0 && (
                <div className="text-[12.5px] text-[#999] dark:text-[#777]">{t("share.dialog.noShares")}</div>
              )}
              {shares !== null && shares.length > 0 && (
                <div className="space-y-1">
                  {shares.map((s) => (
                    <div
                      key={s.token}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[#F7F7F7] dark:hover:bg-[#222] transition-colors"
                    >
                      <span className="font-mono text-[12px] text-[#555] dark:text-[#BBB] truncate">…{s.token.slice(-8)}</span>
                      <span className="ml-auto text-[11px] tabular-nums text-[#999] dark:text-[#777] shrink-0">
                        {relativeTime(s.createdAt, t)}
                      </span>
                      <button
                        type="button"
                        data-testid="share-revoke"
                        onClick={() => void revoke(s.token)}
                        aria-label={t("share.dialog.revoke")}
                        title={t("share.dialog.revoke")}
                        className="shrink-0 p-1 rounded-md text-[#999] dark:text-[#777] hover:text-[#b42318] dark:hover:text-[#E59A92] hover:bg-[#F0F0F0] dark:hover:bg-[#2A2A2A] transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

function CopyRow({ url, label, t, autoFlash }: { url: string; label: string; t: TFunction; autoFlash?: boolean }) {
  const { copied, flash } = useCopyFlag(1400);
  useEffect(() => { if (autoFlash) flash(); }, [autoFlash, flash]);
  const copy = useCallback(async () => {
    const ok = await writeClipboard(url);
    if (!ok) return;
    flash();
  }, [url, flash]);
  return (
    <div>
      <div className="text-[11.5px] font-medium text-[#888] dark:text-[#777] mb-1.5">{label}</div>
      <div className="flex items-center gap-1.5">
        <input
          readOnly
          value={url}
          data-testid="share-url"
          onFocus={(e) => e.currentTarget.select()}
          className="flex-1 min-w-0 rounded-lg border border-[#E5E5E5] dark:border-[#333] bg-[#FAFAFA] dark:bg-[#161616] px-2.5 py-2 text-[12.5px] font-mono text-[#444] dark:text-[#C8C8C8] outline-none focus:border-[#999] dark:focus:border-[#666]"
        />
        <button
          type="button"
          data-testid="share-copy"
          onClick={copy}
          className="shrink-0 flex items-center gap-1.5 rounded-lg border border-[#E5E5E5] dark:border-[#333] px-2.5 py-2 text-[12.5px] text-[#444] dark:text-[#C8C8C8] hover:bg-[#F5F5F5] dark:hover:bg-[#262626] transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-[#177245] dark:text-[#9FE0B9]" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? t("share.dialog.copied") : t("share.dialog.copy")}
        </button>
      </div>
    </div>
  );
}
