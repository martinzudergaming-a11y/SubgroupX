import { useEffect, useReducer, useState } from "react";
import { Spinner } from "../../../ui/Spinner";
import {
  Clock,
  Play,
  CheckCircle2,
  Trash2,
  ArrowUpRight,
  ShieldAlert,
} from "lucide-react";
import { api, type AutomationInfo } from "../../../platform/api.ts";
import { useT } from "../../../i18n";
import type { TFunction } from "../../../i18n";
import { fieldClass, labelClass, primaryButtonClass, quietButtonClass } from "../../ui/controlStyles.ts";
import { ViewHeader } from "../../ui/ViewHeader.tsx";

const PRESETS: { key: "everyHour" | "every6Hours" | "everyDay" | "everyWeek" | "custom"; minutes: number | null }[] = [
  { key: "everyHour", minutes: 60 },
  { key: "every6Hours", minutes: 360 },
  { key: "everyDay", minutes: 1440 },
  { key: "everyWeek", minutes: 10080 },
  { key: "custom", minutes: null },
];

type PresetKey = (typeof PRESETS)[number]["key"];

function intervalLabel(t: TFunction, minutes: number): string {
  let unit: string;
  if (minutes % 10080 === 0 && minutes / 10080 === 1) unit = t("auto.unit.week");
  else if (minutes % 1440 === 0) {
    const d = minutes / 1440;
    unit = d === 1 ? t("auto.unit.day") : t("auto.unit.days", { n: d });
  } else if (minutes % 60 === 0) {
    const h = minutes / 60;
    unit = h === 1 ? t("auto.unit.hour") : t("auto.unit.hours", { n: h });
  } else {
    unit = t("auto.unit.minutes", { n: minutes });
  }
  return t("auto.every", { t: unit });
}

function relativeTime(t: TFunction, at: number | null): string {
  if (!at) return t("auto.never");
  const secs = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (secs < 60) return t("auto.rel.justNow");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return t("auto.ago", { t: t("auto.rel.minutes", { n: mins }) });
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("auto.ago", { t: t("auto.rel.hours", { n: hours }) });
  const days = Math.floor(hours / 24);
  return t("auto.ago", { t: t("auto.rel.days", { n: days }) });
}

type RunState = { running: boolean; ok?: boolean; message?: string };

type FormState = {
  name: string;
  prompt: string;
  preset: PresetKey;
  customMinutes: string;
  busy: boolean;
  error: string;
};

type FormAction =
  | { type: "setName"; value: string }
  | { type: "setPrompt"; value: string }
  | { type: "setPreset"; value: PresetKey }
  | { type: "setCustomMinutes"; value: string }
  | { type: "submitStart" }
  | { type: "submitError"; message: string }
  | { type: "submitSuccess" };

const INITIAL_FORM: FormState = {
  name: "",
  prompt: "",
  preset: "everyDay",
  customMinutes: "30",
  busy: false,
  error: "",
};

function formReducer(state: FormState, action: FormAction): FormState {
  switch (action.type) {
    case "setName":
      return { ...state, name: action.value };
    case "setPrompt":
      return { ...state, prompt: action.value };
    case "setPreset":
      return { ...state, preset: action.value };
    case "setCustomMinutes":
      return { ...state, customMinutes: action.value };
    case "submitStart":
      return { ...state, busy: true, error: "" };
    case "submitError":
      return { ...state, busy: false, error: action.message };
    case "submitSuccess":
      return { ...INITIAL_FORM };
  }
}

function selectedMinutes(preset: PresetKey, customMinutes: string): number {
  const found = PRESETS.find((p) => p.key === preset);
  if (found?.minutes != null) return found.minutes;
  return Math.round(Number(customMinutes) || 0);
}

function AutomationCreateForm({ onCreated }: { onCreated: (a: AutomationInfo) => void }) {
  const t = useT();
  const [form, dispatch] = useReducer(formReducer, INITIAL_FORM);
  const { name, prompt, preset, customMinutes, busy, error } = form;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    dispatch({ type: "submitStart" });
    try {
      const { automation } = await api.createAutomation({
        name: name.trim(),
        prompt: prompt.trim(),
        intervalMinutes: selectedMinutes(preset, customMinutes),
      });
      onCreated(automation);
      dispatch({ type: "submitSuccess" });
    } catch (err) {
      dispatch({ type: "submitError", message: err instanceof Error ? err.message : "failed" });
    }
  }

  const canSubmit =
    name.trim().length > 0 && prompt.trim().length > 0 && selectedMinutes(preset, customMinutes) >= 5 && !busy;

  return (
    <form
      data-testid="automation-create"
      onSubmit={submit}
      className="mt-6 border-y border-[#DDE1D8] bg-[var(--app-surface)] px-5 py-5 dark:border-[#383B37] dark:bg-[#1A1A1A] md:px-7"
    >
      <h3 className="mb-4 text-[13px] font-semibold text-[#3A3D36] dark:text-[#DADCD5]">{t("auto.create")}</h3>

      <div className="flex flex-col gap-1.5 mb-4">
        <label htmlFor="automation-name-input" className={labelClass}>{t("auto.nameField")}</label>
        <input
          id="automation-name-input"
          data-testid="automation-name"
          className={fieldClass}
          value={name}
          onChange={(e) => dispatch({ type: "setName", value: e.target.value })}
          placeholder={t("auto.namePlaceholder")}
          autoComplete="off"
        />
      </div>

      <div className="flex flex-col gap-1.5 mb-4">
        <label htmlFor="automation-prompt-input" className={labelClass}>{t("auto.promptField")}</label>
        <textarea
          id="automation-prompt-input"
          data-testid="automation-prompt"
          className={`${fieldClass} min-h-[88px] resize-y`}
          value={prompt}
          onChange={(e) => dispatch({ type: "setPrompt", value: e.target.value })}
          placeholder={t("auto.promptPlaceholder")}
        />
      </div>

      <div className="flex flex-col gap-2 mb-4">
        <label className={labelClass}>{t("auto.intervalField")}</label>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
          {PRESETS.map((p) => {
            const active = preset === p.key;
            return (
              <button
                key={p.key}
                type="button"
                aria-pressed={active}
                data-testid={`automation-preset-${p.key}`}
                onClick={() => dispatch({ type: "setPreset", value: p.key })}
                className={`${active ? primaryButtonClass : quietButtonClass} !px-3 !text-[12px]`}
              >
                {t(`auto.${p.key}`)}
              </button>
            );
          })}
        </div>
        {preset === "custom" && (
          <div className="flex items-center gap-2 mt-1">
            <input
              data-testid="automation-custom-minutes"
              type="number"
              min={5}
              max={10080}
              aria-label={t("auto.customMinutes")}
              className={`${fieldClass} w-28 font-mono tabular-nums`}
              value={customMinutes}
              onChange={(e) => dispatch({ type: "setCustomMinutes", value: e.target.value })}
            />
            <span className="text-[11.5px] text-[#686C63] dark:text-[#A0A39B]">{t("auto.customMinutes")}</span>
          </div>
        )}
      </div>

      {error && <div data-testid="automation-error" className="mb-4 text-[11.5px] leading-4 text-[#B74335] dark:text-[#E28A7D]">{error}</div>}

      <div className="flex justify-end">
        <button
          data-testid="automation-create-submit"
          type="submit"
          disabled={!canSubmit}
          className={primaryButtonClass}
        >
          {busy && <Spinner className="size-[13px]" strokeWidth={2.4} />}
          {busy ? t("auto.adding") : t("auto.add")}
        </button>
      </div>
    </form>
  );
}

function AutomationRow({
  a,
  run,
  onToggle,
  onRunNow,
  onRemove,
  onOpenSession,
}: {
  a: AutomationInfo;
  run: RunState | undefined;
  onToggle: (a: AutomationInfo) => void;
  onRunNow: (a: AutomationInfo) => void;
  onRemove: (a: AutomationInfo) => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const t = useT();
  return (
    <div
      data-testid={`automation-row-${a.id}`}
      className="border-b border-[#E8EBE3] bg-[var(--app-surface)] px-5 py-4 last:border-b-0 dark:border-[#343632] dark:bg-[#1A1A1A] md:px-7"
    >
      <div className="flex items-start gap-3">
        <span className={`flex size-7 shrink-0 items-center justify-center ${a.enabled ? "text-[#5F675C] dark:text-[#A6ACA1]" : "text-[#A0A49D] dark:text-[#656A63]"}`}>
          <Clock strokeWidth={1.75} className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[14px] font-semibold text-[#222] dark:text-[#E8E8E8] truncate">{a.name}</span>
            <span className="inline-flex items-center gap-1 text-[10.5px] font-medium text-[#777B75] dark:text-[#8C9188]">
              <Clock strokeWidth={2} className="size-[11px]" />
              {intervalLabel(t, a.intervalMinutes)}
            </span>
          </div>
          <p className="text-[12.5px] text-[#777] dark:text-[#999] mt-1 line-clamp-2 break-words">{a.prompt}</p>
          <div className="text-[12px] text-[#999] dark:text-[#777] mt-2">
            {t("auto.lastRun")}: {relativeTime(t, a.lastRunAt)}
          </div>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={a.enabled}
          data-testid={`automation-toggle-${a.id}`}
          onClick={() => onToggle(a)}
          title={t("auto.enabled")}
          aria-label={t("auto.enabled")}
          className={`relative h-[18px] w-[30px] shrink-0 rounded-full outline-none transition-colors duration-150 focus-visible:shadow-[0_0_0_2px_rgba(173,145,94,.35)] ${a.enabled ? "bg-[#4A5348] dark:bg-[#8FA089]" : "bg-[#CFD3C9] dark:bg-[#3D3F39]"}`}
        >
          <span className={`absolute top-[3px] size-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,.18)] transition-[left] duration-150 dark:bg-[#1D1E1B] ${a.enabled ? "left-[15px]" : "left-[3px]"}`} />
        </button>
      </div>

      <div className="flex items-center gap-2 mt-4 flex-wrap">
        <button
          type="button"
          data-testid={`automation-run-${a.id}`}
          onClick={() => onRunNow(a)}
          disabled={run?.running}
          className={`${primaryButtonClass} !min-h-8 !px-3 !text-[11.5px]`}
        >
          {run?.running ? <Spinner className="size-[12px]" strokeWidth={2.6} /> : <Play strokeWidth={2} className="size-[12px]" />}
          {run?.running ? t("auto.running") : t("auto.runNow")}
        </button>
        <button
          type="button"
          data-testid={`automation-open-${a.id}`}
          onClick={() => onOpenSession?.(a.sessionId)}
          className={`${quietButtonClass} !min-h-8 !px-3 !text-[11.5px]`}
        >
          {t("auto.openSession")}
          <ArrowUpRight strokeWidth={2} className="size-[12px]" />
        </button>
        <button
          type="button"
          onClick={() => onRemove(a)}
          className="ml-auto inline-flex min-h-8 items-center gap-1.5 rounded-[4px] px-3 text-[11.5px] font-medium text-[#8A6F69] outline-none transition-colors duration-150 hover:bg-[#F4E8E5] hover:text-[#B74335] focus-visible:shadow-[0_0_0_2px_rgba(183,67,53,.2)] dark:text-[#A08A85] dark:hover:bg-[#332421] dark:hover:text-[#E28A7D]"
        >
          <Trash2 strokeWidth={1.75} className="size-[12px]" />
          {t("auto.delete")}
        </button>
      </div>

      {run && !run.running && run.message && (
        <div
          data-testid={`automation-run-result-${a.id}`}
          className={`mt-3 inline-flex items-center gap-1.5 text-[11.5px] leading-4 ${run.ok ? "text-[#3F7A5C] dark:text-[#79BE9B]" : "text-[#B74335] dark:text-[#E28A7D]"}`}
        >
          {run.ok && <CheckCircle2 strokeWidth={2} className="size-[12px]" />}
          {run.message}
        </div>
      )}
    </div>
  );
}

export function AutomationsView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  onOpenSession,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  onOpenSession?: (sessionId: string) => void;
}) {
  const t = useT();
  const [items, setItems] = useState<AutomationInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [runs, setRuns] = useState<Record<string, RunState>>({});

  async function load() {
    const res = await api.automations();
    setItems(res.automations);
    setLoaded(true);
  }

  useEffect(() => {
    void load().catch(() => setLoaded(true));
  }, []);

  async function toggle(a: AutomationInfo) {
    const next = !a.enabled;
    setItems((cur) => cur.map((x) => (x.id === a.id ? { ...x, enabled: next } : x)));
    try {
      await api.setAutomationEnabled(a.id, next);
    } catch {
      setItems((cur) => cur.map((x) => (x.id === a.id ? { ...x, enabled: a.enabled } : x)));
    }
  }

  async function runNow(a: AutomationInfo) {
    setRuns((cur) => ({ ...cur, [a.id]: { running: true } }));
    try {
      await api.runAutomation(a.id);
      setRuns((cur) => ({ ...cur, [a.id]: { running: false, ok: true, message: t("auto.ran") } }));
      await load().catch(() => {});
    } catch (err) {
      const raw = err instanceof Error ? err.message : "";
      const msg = /busy/i.test(raw) ? t("auto.runBusy") : raw || t("auto.runBusy");
      setRuns((cur) => ({ ...cur, [a.id]: { running: false, ok: false, message: msg } }));
    }
  }

  async function remove(a: AutomationInfo) {
    if (!confirm(t("auto.deleteConfirm"))) return;
    await api.deleteAutomation(a.id).catch(() => {});
    setItems((cur) => cur.filter((x) => x.id !== a.id));
  }

  return (
    <div
      data-testid="automations-view"
      className="flex-1 flex flex-col h-full overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]"
    >
      <ViewHeader
        icon={Clock}
        title={t("auto.title")}
        subtitle={t("auto.headerSubtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
      />

      <div className="flex-1 overflow-y-auto hide-scrollbar">
        <div className="mx-auto w-full max-w-[860px] py-5 md:py-7">
          <div className="px-5 md:px-7">
            <h2 className="text-[20px] font-semibold tracking-[-0.025em] text-[#30322D] dark:text-[#E3E4DE]">
              {t("auto.heading")}
            </h2>
            <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">
              {t("auto.subtitle")}
            </p>

            <p className="mt-5 flex items-start gap-2 text-[11px] leading-[1.55] text-[#8A7038] dark:text-[#C2A365]">
              <ShieldAlert strokeWidth={1.8} className="mt-[1px] size-3.5 shrink-0" />
              <span className="max-w-[600px]">{t("auto.securityNotice")}</span>
            </p>
          </div>

          <AutomationCreateForm onCreated={(automation) => setItems((cur) => [automation, ...cur])} />

          {!loaded ? null : items.length === 0 ? (
            <div className="border-b border-[#E8EBE3] px-5 py-6 text-[12px] leading-[1.6] text-[#7E8279] dark:border-[#343632] dark:text-[#8D9088] md:px-7">
              {t("auto.empty")}
            </div>
          ) : (
            <div className="border-t border-[#E8EBE3] dark:border-[#343632]">
              {items.map((a) => (
                <AutomationRow
                  key={a.id}
                  a={a}
                  run={runs[a.id]}
                  onToggle={(x) => void toggle(x)}
                  onRunNow={(x) => void runNow(x)}
                  onRemove={(x) => void remove(x)}
                  onOpenSession={onOpenSession}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
