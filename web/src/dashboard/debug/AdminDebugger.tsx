import { useEffect, useReducer, useState, useCallback, useMemo } from "react";
import { LazyMotion, m, AnimatePresence, domAnimation } from "motion/react";
import { X, Copy, Check } from "lucide-react";
import { api, type CaptureMeta, type CaptureDetail, type ReplayResult } from "../../platform/api";
import { useT } from "../../i18n";
import { JsonView, JsonTree, JsonDiff } from "./json-view";
import { prettyOf } from "./json-view-helpers";
import { useOnEscape } from "../ui/use-on-escape";
import { useCopyFlag } from "../../ui/useCopyFlag";
import { OPERATOR_MODEL_PROVIDER } from "@shared/protocol";

type Tab = "request" | "response" | "meta" | "replay";

function statusTone(status: number | null): string {
  if (status === null) return "bg-[#F5E9E9] text-[#B4453B] dark:bg-[#3A2422] dark:text-[#E59A92]";
  if (status >= 200 && status < 300) return "bg-[#EEF8F1] text-[#177245] dark:bg-[#1F3326] dark:text-[#9FE0B9]";
  if (status >= 400) return "bg-[#F5E9E9] text-[#B4453B] dark:bg-[#3A2422] dark:text-[#E59A92]";
  return "bg-[#FBF3E7] text-[#9A6213] dark:bg-[#33291A] dark:text-[#E0B97F]";
}

function JsonBlock({ value }: { value: unknown }) {
  const t = useT();
  const { copied, flash } = useCopyFlag(1200);
  const [mode, setMode] = useState<"tree" | "raw">("tree");
  const text = (() => {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  })();
  const copy = useCallback(() => {
    navigator.clipboard?.writeText(text).then(
      () => {
        flash();
      },
      () => {},
    );
  }, [text, flash]);
  const toggleBtn = (m: "tree" | "raw", label: string) => (
    <button
      type="button"
      data-testid={`json-mode-${m}`}
      onClick={() => setMode(m)}
      className={`px-1.5 py-0.5 rounded text-[10.5px] transition-colors ${
        mode === m
          ? "bg-[#ECECEC] dark:bg-[#333] text-[#333] dark:text-[#E0E0E0]"
          : "text-[#999] dark:text-[#777] hover:text-[#555] dark:hover:text-[#AAA]"
      }`}
    >
      {label}
    </button>
  );
  return (
    <div className="relative h-full min-h-0">
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-white/80 dark:bg-[#1E1E1E]/80 backdrop-blur border border-[#ECECEC] dark:border-[#333] p-0.5">
          {toggleBtn("tree", t("admin.inspector.viewTree"))}
          {toggleBtn("raw", t("admin.inspector.viewRaw"))}
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 px-2 py-1 rounded-md text-[11px] bg-white/80 dark:bg-[#1E1E1E]/80 backdrop-blur border border-[#ECECEC] dark:border-[#333] text-[#777] dark:text-[#A0A0A0] hover:bg-white dark:hover:bg-[#262626] transition-colors"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? t("admin.inspector.copied") : t("admin.inspector.copy")}
        </button>
      </div>
      {mode === "tree" ? <JsonTree value={value} /> : <JsonView value={value} />}
    </div>
  );
}

function CaptureList({
  captures,
  selectedId,
  onSelect,
}: {
  captures: CaptureMeta[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="w-[230px] shrink-0 overflow-auto border-r border-[#F0F0F0] dark:border-[#2A2A2A] py-1.5">
      {captures.map((c) => {
        const active = c.messageId === selectedId;
        return (
          <button
            key={c.messageId}
            type="button"
            onClick={() => onSelect(c.messageId)}
            className={`w-full text-left px-3 py-2 transition-colors ${
              active ? "bg-[#F0F4FF] dark:bg-[#1B2742]" : "hover:bg-[#F7F7F7] dark:hover:bg-[#222]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-mono text-[11px] text-[#555] dark:text-[#BBB] truncate">{c.model}</span>
              <span className={`shrink-0 px-1.5 py-px rounded text-[9.5px] tabular-nums ${statusTone(c.status)}`}>
                {c.status === null ? "ERR" : c.status}
              </span>
            </div>
            <div className="mt-0.5 flex items-center justify-between gap-2 text-[10.5px] text-[#999] dark:text-[#777]">
              <span className="truncate">{c.provider}</span>
              <span className="tabular-nums">{new Date(c.createdAt).toLocaleTimeString()}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

type ReplayView = "edit" | "result" | "reqDiff" | "respDiff";

function ReplayPanel({
  sessionId,
  messageId,
  originalRequest,
  originalResponseMsg,
}: {
  sessionId: string;
  messageId: string;
  originalRequest: unknown;
  originalResponseMsg: unknown;
}) {
  const t = useT();
  const [editText, setEditText] = useState(() => prettyOf(originalRequest));
  const [replaying, setReplaying] = useState(false);
  const [result, setResult] = useState<ReplayResult | null>(null);
  const [view, setView] = useState<ReplayView>("edit");

  const parsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(editText) as unknown };
    } catch (e) {
      return { ok: false as const, err: e instanceof Error ? e.message : String(e) };
    }
  }, [editText]);

  async function runReplay() {
    if (!parsed.ok) return;
    setReplaying(true);
    try {
      const r = await api.adminReplay(sessionId, messageId, parsed.value);
      setResult(r);
      setView("result");
    } catch (e) {
      setResult({ ok: false, status: 0, response: null, outputText: null, errorMessage: e instanceof Error ? e.message : String(e) });
      setView("result");
    } finally {
      setReplaying(false);
    }
  }

  const viewBtn = (v: ReplayView, label: string, disabled?: boolean) => (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setView(v)}
      className={`px-2 py-0.5 rounded text-[11px] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        view === v ? "bg-[#EEF1F6] dark:bg-[#2A2F3A] text-[#333] dark:text-[#E0E0E0]" : "text-[#888] dark:text-[#999] hover:bg-[#F5F5F5] dark:hover:bg-[#222]"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-full min-h-0 flex-col gap-2" data-testid="replay-panel">

      <div className="flex items-center gap-1 shrink-0">
        {viewBtn("edit", t("admin.replay.edit"))}
        {viewBtn("result", t("admin.replay.result"), !result)}
        {viewBtn("reqDiff", t("admin.replay.reqDiff"))}
        {viewBtn("respDiff", t("admin.replay.respDiff"), !result)}
        <button
          type="button"
          data-testid="replay-run"
          disabled={!parsed.ok || replaying}
          onClick={runReplay}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-[#2B6CB0] px-2.5 py-1 text-[11.5px] font-medium text-white transition-colors hover:bg-[#24568F] disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {replaying ? t("admin.replay.running") : t("admin.replay.run")}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {view === "edit" && (
          <div className="flex h-full min-h-0 flex-col gap-1">
            <textarea
              data-testid="replay-editor"
              aria-label={t("admin.replay.edit")}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              spellCheck={false}
              className="h-full min-h-0 w-full resize-none rounded-lg border border-[#F0F0F0] dark:border-[#2A2A2A] bg-[#FAFAFA] dark:bg-[#171717] p-3 font-mono text-[11.5px] leading-relaxed text-[#333] dark:text-[#CFCFCF] outline-none focus:border-[#C9D6EA] dark:focus:border-[#3A4A66]"
            />
            <div className="shrink-0 text-[10.5px]">
              {parsed.ok ? (
                <span className="text-[#AAA] dark:text-[#666]">⚡ {t("admin.replay.costHint")}</span>
              ) : (
                <span className="text-[#B4453B] dark:text-[#E59A92]">{t("admin.replay.invalidJson")}: {parsed.err}</span>
              )}
            </div>
          </div>
        )}
        {view === "result" &&
          (result ? (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <div className="flex shrink-0 items-center gap-2 text-[11.5px]">
                <span className={`px-1.5 py-px rounded text-[10px] tabular-nums ${statusTone(result.status || null)}`}>
                  {result.status ? `HTTP ${result.status}` : "ERR"}
                </span>
                {result.errorMessage && (
                  <span className="min-w-0 truncate rounded bg-[#F5E9E9] px-1.5 py-px text-[#B4453B] dark:bg-[#3A2422] dark:text-[#E59A92]" title={result.errorMessage}>
                    {result.errorMessage}
                  </span>
                )}
              </div>
              {result.outputText && (
                <div className="shrink-0 max-h-[30%] overflow-auto rounded-lg border border-[#F0F0F0] dark:border-[#2A2A2A] bg-white dark:bg-[#1A1A1A] p-2.5 text-[12px] whitespace-pre-wrap break-words text-[#333] dark:text-[#CFCFCF]">
                  {result.outputText}
                </div>
              )}
              <div className="flex-1 min-h-0">
                <JsonTree value={result.response} />
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-[#999] dark:text-[#777]">{t("admin.replay.needRun")}</div>
          ))}
        {view === "reqDiff" && <JsonDiff before={originalRequest} after={parsed.ok ? parsed.value : editText} />}
        {view === "respDiff" &&
          (result ? (
            <JsonDiff before={originalResponseMsg} after={result.response} />
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-[#999] dark:text-[#777]">{t("admin.replay.needRun")}</div>
          ))}
      </div>
    </div>
  );
}

type DebuggerState = {
  captures: CaptureMeta[] | null;
  error: boolean;
  selectedId: string | null;
  detail: CaptureDetail | null;
  detailLoading: boolean;
};

const INITIAL_STATE: DebuggerState = {
  captures: null,
  error: false,
  selectedId: null,
  detail: null,
  detailLoading: false,
};

type DebuggerAction =
  | { type: "loadList" }
  | { type: "listLoaded"; captures: CaptureMeta[] }
  | { type: "listFailed" }
  | { type: "select"; id: string }
  | { type: "loadDetail" }
  | { type: "detailLoaded"; detail: CaptureDetail }
  | { type: "detailFailed" };

function debuggerReducer(state: DebuggerState, action: DebuggerAction): DebuggerState {
  switch (action.type) {
    case "loadList":
      return INITIAL_STATE;
    case "listLoaded":
      return {
        ...state,
        captures: action.captures,
        selectedId: action.captures.length > 0 ? action.captures[0].messageId : null,
      };
    case "listFailed":
      return { ...state, error: true };
    case "select":
      return { ...state, selectedId: action.id };
    case "loadDetail":
      return { ...state, detail: null, detailLoading: true };
    case "detailLoaded":
      return { ...state, detail: action.detail, detailLoading: false };
    case "detailFailed":
      return { ...state, detail: null, detailLoading: false };
    default:
      return state;
  }
}

export function AdminDebugger({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const t = useT();
  const [state, dispatch] = useReducer(debuggerReducer, INITIAL_STATE);
  const { captures, error, selectedId, detail, detailLoading } = state;
  const [tab, setTab] = useState<Tab>("request");

  useOnEscape(onClose);

  useEffect(() => {
    let live = true;
    dispatch({ type: "loadList" });
    api.adminCaptures(sessionId).then(
      (r) => {
        if (!live) return;
        dispatch({ type: "listLoaded", captures: r.captures });
      },
      () => live && dispatch({ type: "listFailed" }),
    );
    return () => {
      live = false;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!selectedId) return;
    let live = true;
    dispatch({ type: "loadDetail" });
    api.adminCapture(sessionId, selectedId).then(
      (d) => {
        if (!live) return;
        dispatch({ type: "detailLoaded", detail: d });
      },
      () => {
        if (!live) return;
        dispatch({ type: "detailFailed" });
      },
    );
    return () => {
      live = false;
    };
  }, [sessionId, selectedId]);

  const canReplay = detail?.provider === OPERATOR_MODEL_PROVIDER;
  const activeTab: Tab = tab === "replay" && !canReplay ? "request" : tab;
  const tabs: { key: Tab; label: string }[] = [
    { key: "request", label: t("admin.inspector.tab.request") },
    { key: "response", label: t("admin.inspector.tab.response") },
    { key: "meta", label: t("admin.inspector.tab.meta") },
    ...(canReplay ? [{ key: "replay" as const, label: t("admin.inspector.tab.replay") }] : []),
  ];

  return (
    <LazyMotion features={domAnimation}>
    <AnimatePresence>
      <m.div
        className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/30 backdrop-blur-[1px]"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.12 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
        data-testid="admin-inspector"
      >
        <m.div
          className="flex flex-col w-full max-w-[940px] h-[82vh] rounded-2xl bg-white dark:bg-[#1B1B1B] border border-[#ECECEC] dark:border-[#333] oiia-shadow-modal overflow-hidden"
          initial={{ opacity: 0, scale: 0.97, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: 8 }}
          transition={{ duration: 0.16, ease: "easeOut" }}
        >

          <div className="flex items-start justify-between px-5 py-3.5 border-b border-[#F0F0F0] dark:border-[#2A2A2A] shrink-0">
            <div className="min-w-0">
              <div className="text-[14px] font-medium text-[#111] dark:text-[#E8E8E8]">{t("admin.inspector.title")}</div>
              <div className="text-[11.5px] text-[#999] dark:text-[#777] mt-0.5 truncate">{t("admin.inspector.subtitle")}</div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("admin.inspector.close")}
              className="p-1.5 rounded-md text-[#888] dark:text-[#999] hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] transition-colors shrink-0"
            >
              <X className="size-4" />
            </button>
          </div>

          <div className="flex flex-1 min-h-0">
            {captures === null && !error && (
              <div className="flex-1 flex items-center justify-center text-[12.5px] text-[#999] dark:text-[#777]">
                {t("admin.inspector.loading")}
              </div>
            )}
            {error && (
              <div className="flex-1 flex items-center justify-center text-[12.5px] text-[#B4453B] dark:text-[#E59A92]">
                {t("admin.inspector.error")}
              </div>
            )}
            {captures !== null && !error && captures.length === 0 && (
              <div className="flex-1 flex items-center justify-center text-[12.5px] text-[#999] dark:text-[#777] px-6 text-center">
                {t("admin.inspector.empty")}
              </div>
            )}
            {captures !== null && !error && captures.length > 0 && (
              <>
                <CaptureList captures={captures} selectedId={selectedId} onSelect={(id) => dispatch({ type: "select", id })} />
                <div className="flex-1 flex flex-col min-w-0">

                  <div className="flex items-center gap-1 px-3 pt-2.5 pb-2 border-b border-[#F0F0F0] dark:border-[#2A2A2A] shrink-0">
                    {tabs.map((tb) => (
                      <button
                        key={tb.key}
                        type="button"
                        onClick={() => setTab(tb.key)}
                        className={`px-2.5 py-1 rounded-md text-[11.5px] transition-colors ${
                          activeTab === tb.key
                            ? "bg-[#EEF1F6] dark:bg-[#2A2F3A] text-[#333] dark:text-[#E0E0E0]"
                            : "text-[#888] dark:text-[#999] hover:bg-[#F5F5F5] dark:hover:bg-[#222]"
                        }`}
                      >
                        {tb.label}
                      </button>
                    ))}
                    {detail?.responseMeta && (
                      <span className={`ml-auto px-1.5 py-px rounded text-[10px] tabular-nums ${statusTone(detail.responseMeta.status)}`}>
                        HTTP {detail.responseMeta.status}
                      </span>
                    )}
                  </div>

                  <div className="flex-1 min-h-0 p-3">
                    {detailLoading || !detail ? (
                      <div className="h-full flex items-center justify-center text-[12.5px] text-[#999] dark:text-[#777]">
                        {t("admin.inspector.loading")}
                      </div>
                    ) : activeTab === "request" ? (
                      <JsonBlock value={detail.request} />
                    ) : activeTab === "replay" ? (
                      <ReplayPanel
                        key={detail.messageId}
                        sessionId={sessionId}
                        messageId={detail.messageId}
                        originalRequest={detail.request}
                        originalResponseMsg={detail.responseMsg}
                      />
                    ) : activeTab === "response" ? (
                      detail.responseMsg === null ? (
                        <div className="h-full flex items-center justify-center text-[12.5px] text-[#999] dark:text-[#777]">
                          {t("admin.inspector.noResponse")}
                        </div>
                      ) : (
                        <JsonBlock value={detail.responseMsg} />
                      )
                    ) : (
                      detail.responseMeta === null ? (
                        <div className="h-full flex items-center justify-center text-[12.5px] text-[#999] dark:text-[#777]">
                          {t("admin.inspector.noResponse")}
                        </div>
                      ) : (
                        <JsonBlock value={detail.responseMeta} />
                      )
                    )}
                  </div>
                </div>
              </>
            )}
          </div>

          <div className="px-5 py-2 border-t border-[#F0F0F0] dark:border-[#2A2A2A] shrink-0">
            <span className="text-[10.5px] text-[#AAA] dark:text-[#666]">🔒 {t("admin.inspector.scrubbed")}</span>
          </div>
        </m.div>
      </m.div>
    </AnimatePresence>
    </LazyMotion>
  );
}
