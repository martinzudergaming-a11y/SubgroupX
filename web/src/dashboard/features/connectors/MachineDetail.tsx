import { lazy, Suspense } from "react";
import { Spinner } from "../../../ui/Spinner";
import {
  AlertTriangle,
  ArrowLeft,
  Cable,
  CheckCircle2,
  Folder,
  KeyRound,
  Lock,
  LockOpen,
  Play,
  PlugZap,
  Server,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { ConnectorInfo, SshTargetInfo } from "../../../platform/api.ts";
import { useI18n } from "../../../i18n";
import { StatusDot } from "../../../ui/StatusDot.tsx";
import { primaryButtonClass, quietButtonClass } from "../../ui/controlStyles.ts";
import type { TestState } from "./connector-model.ts";

const ConnectorTelemetryPanel = lazy(() => import("./ConnectorTelemetry.tsx").then((module) => ({
  default: module.ConnectorTelemetryPanel,
})));

function MetaItem({ icon, label, value, mono = false }: { icon: React.ReactNode; label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0 border-b border-[#ECEEE8] py-3 last:border-b-0 dark:border-[#30322D] @lg/detail:border-b-0 @lg/detail:border-r @lg/detail:px-4 @lg/detail:py-0 @lg/detail:last:border-r-0 @lg/detail:first:pl-0">
      <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[.06em] text-[#686C63] dark:text-[#A0A39B]">
        {icon}
        {label}
      </div>
      <div className={`mt-1.5 truncate text-[12px] text-[#4B4E46] dark:text-[#BEC0B8] ${mono ? "font-mono text-[11px]" : ""}`} title={typeof value === "string" ? value : undefined}>{value}</div>
    </div>
  );
}

function TestReadout({ state }: { state?: TestState }) {
  if (!state || state.testing || !state.message) return null;
  return (
    <div className={`mt-3 flex items-start gap-2 border-l-2 px-3 py-2.5 text-[11px] leading-[1.55] ${state.ok
      ? "border-[#70A783] bg-[#F5FAF6] text-[#4A7059] dark:bg-[#223028] dark:text-[#8DB29A]"
      : "border-[#C87668] bg-[#FCF6F4] text-[#95554B] dark:bg-[#2C2421] dark:text-[#D18D82]"
    }`}>
      {state.ok ? <CheckCircle2 className="mt-[1px] size-3.5 shrink-0" strokeWidth={1.8} /> : <AlertTriangle className="mt-[1px] size-3.5 shrink-0" strokeWidth={1.8} />}
      <span className="min-w-0 break-words font-mono">{state.message}</span>
    </div>
  );
}

function PolicyControl({
  unconfined,
  onChange,
  testId,
}: {
  unconfined: boolean;
  onChange: (next: boolean) => void;
  testId: string;
}) {
  const { t } = useI18n();
  return (
    <div className="grid grid-cols-2 border border-[#D9DDD4] dark:border-[#3A3C37]" data-testid={testId} role="group" aria-label={t("plugins.policyTitle")}>
      <button
        type="button"
        aria-pressed={!unconfined}
        onClick={() => unconfined && onChange(false)}
        className={`min-h-[62px] border-r border-[#D9DDD4] px-3 py-2.5 text-left outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.55)] dark:border-[#3A3C37] ${!unconfined
          ? "bg-[#F8F9F5] text-[#353830] shadow-[inset_0_2px_0_#89754D] dark:bg-[#30312D] dark:text-[#E0E1DB]"
          : "text-[#656960] hover:bg-[#F3F4EF] dark:text-[#A0A39B] dark:hover:bg-white/[.04]"
        }`}
      >
        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold"><Lock className="size-3" strokeWidth={1.8} />{t("plugins.chipSandboxed")}</span>
        <span className="mt-1 block text-[10.5px] leading-[1.45]">{t("plugins.sandboxedDescription")}</span>
      </button>
      <button
        type="button"
        aria-pressed={unconfined}
        onClick={() => !unconfined && onChange(true)}
        className={`min-h-[62px] px-3 py-2.5 text-left outline-none transition-[background-color,color,box-shadow] duration-150 focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.55)] ${unconfined
          ? "bg-[#FFF9EC] text-[#805E20] shadow-[inset_0_2px_0_#B58835] dark:bg-[#3A3222] dark:text-[#E0B55F]"
          : "text-[#656960] hover:bg-[#F3F4EF] dark:text-[#A0A39B] dark:hover:bg-white/[.04]"
        }`}
      >
        <span className="flex items-center gap-1.5 text-[11.5px] font-semibold"><LockOpen className="size-3" strokeWidth={1.8} />{t("plugins.chipNoSandbox")}</span>
        <span className="mt-1 block text-[10.5px] leading-[1.45]">{t("plugins.unconfinedDescription")}</span>
      </button>
    </div>
  );
}

function DetailShell({ children, onBack }: { children: React.ReactNode; onBack?: () => void }) {
  const { t } = useI18n();
  return (
    <section className="min-h-full bg-[var(--app-surface)] dark:bg-[#1D1E1B]">
      {onBack && (
        <button type="button" onClick={onBack} className="mb-3 inline-flex min-h-8 items-center gap-1.5 text-[11.5px] font-medium text-[#5F635A] @3xl/connectors:hidden">
          <ArrowLeft className="size-3.5" strokeWidth={1.7} />{t("plugins.backToMachines")}
        </button>
      )}
      {children}
    </section>
  );
}

export function ConnectorDetail({
  connector,
  testState,
  creating,
  onBack,
  onNewSession,
  onTest,
  onRemove,
  onToggleUnconfined,
}: {
  connector: ConnectorInfo;
  testState?: TestState;
  creating: boolean;
  onBack?: () => void;
  onNewSession: () => void;
  onTest: () => void;
  onRemove: () => void;
  onToggleUnconfined: (next: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const lastSeen = connector.online
    ? t("plugins.now")
    : connector.lastSeenAt
      ? new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { dateStyle: "medium", timeStyle: "short" }).format(connector.lastSeenAt)
      : t("plugins.unknown");
  return (
    <DetailShell onBack={onBack}>
      <div className="flex flex-wrap items-start gap-5 border-b border-[#E3E6DE] pb-6 dark:border-[#30322D]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[.08em] text-[#686C63] dark:text-[#A0A39B]"><Cable className="size-3" strokeWidth={1.6} />{t("plugins.connectorMethod")}</div>
          <div className="mt-2 flex min-w-0 items-center gap-3">
            <h2 className="truncate text-[22px] font-semibold tracking-[-.025em] text-[#292C26] dark:text-[#E5E6E0]">{connector.name}</h2>
            <span
              data-testid={`connector-detail-presence-${connector.id}`}
              className="flex size-4 shrink-0 items-center justify-center"
              role="img"
              aria-label={t(connector.online ? "plugins.connectorOnline" : "plugins.connectorOffline")}
              title={t(connector.online ? "plugins.connectorOnline" : "plugins.connectorOffline")}
            >
              <StatusDot tone={connector.online ? "live" : "muted"} />
            </span>
          </div>
          <p className="mt-1.5 max-w-[590px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">{t("plugins.connectorDetailHint")}</p>
        </div>
        <button
          type="button"
          data-testid={`connector-new-session-${connector.id}`}
          onClick={onNewSession}
          disabled={creating || !connector.online}
          title={!connector.online ? t("plugins.connectorOffline") : undefined}
          className={primaryButtonClass}
        >
          {creating ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <Play className="size-3.5" fill="currentColor" strokeWidth={1.5} />}
          {t("plugins.connectorNewSession")}
        </button>
      </div>

      <div className="grid border-b border-[#E3E6DE] py-5 dark:border-[#30322D] @lg/detail:grid-cols-3">
        <MetaItem icon={<Folder className="size-3" />} label={t("plugins.workspaceLabel")} value={connector.workspaceRoot} mono />
        <MetaItem icon={<Cable className="size-3" />} label={t("plugins.capabilitiesLabel")} value={connector.capabilities.length ? connector.capabilities.join(" · ") : t("plugins.standardTools")} />
        <MetaItem icon={<CheckCircle2 className="size-3" />} label={t("plugins.lastSeenLabel")} value={lastSeen} />
      </div>

      <Suspense fallback={<div className="h-[145px] border-b border-[#E3E6DE] dark:border-[#30322D]" aria-hidden="true" />}>
        <ConnectorTelemetryPanel key={connector.id} connector={connector} />
      </Suspense>

      <div className="grid gap-7 py-6 @2xl/detail:grid-cols-[minmax(0,1fr)_minmax(220px,.7fr)]">
        <div>
          <h3 className="text-[13px] font-semibold text-[#383B34] dark:text-[#D5D7CF]">{t("plugins.policyTitle")}</h3>
          <p className="mb-3 mt-1 text-[11px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.policyHint")}</p>
          <PolicyControl unconfined={connector.unconfined} onChange={onToggleUnconfined} testId={`connector-unconfined-${connector.id}`} />
          {connector.unconfined && connector.online && connector.daemonUnconfined === false && (
            <div data-testid={`connector-daemon-outdated-${connector.id}`} className="mt-3 flex items-start gap-1.5 text-[11px] leading-[1.55] text-[#9A6928] dark:text-[#D1A052]">
              <AlertTriangle className="mt-[1px] size-3 shrink-0" strokeWidth={1.8} />
              <span>{t("plugins.connectorDaemonOutdated")}</span>
            </div>
          )}
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-[#383B34] dark:text-[#D5D7CF]">{t("plugins.diagnosticsTitle")}</h3>
          <p className="mb-3 mt-1 text-[11px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.diagnosticsHint")}</p>
          <button type="button" data-testid={`connector-test-${connector.id}`} onClick={onTest} disabled={!connector.online || testState?.testing} className={`${quietButtonClass} w-full`}>
            {testState?.testing ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <PlugZap className="size-3.5" strokeWidth={1.7} />}
            {testState?.testing ? t("plugins.testing") : t("plugins.test")}
          </button>
          <TestReadout state={testState} />
        </div>
      </div>

      <div className="flex justify-end border-t border-[#E3E6DE] pt-4 dark:border-[#30322D]">
        <button type="button" onClick={onRemove} className="inline-flex min-h-8 items-center gap-1.5 rounded-[3px] px-2.5 text-[11px] font-medium text-[#A05A50] transition-colors hover:bg-[#FBF0ED] active:bg-[#F6E5E1] dark:text-[#D68E82] dark:hover:bg-[#332421]"><Trash2 className="size-3" strokeWidth={1.7} />{t("plugins.delete")}</button>
      </div>
    </DetailShell>
  );
}

export function SshDetail({
  target,
  testState,
  unlocking,
  onBack,
  onTest,
  onRemove,
  onUnlock,
  onLock,
  onToggleUnconfined,
}: {
  target: SshTargetInfo;
  testState?: TestState;
  unlocking: boolean;
  onBack?: () => void;
  onTest: () => void;
  onRemove: () => void;
  onUnlock: () => void;
  onLock: () => void;
  onToggleUnconfined: (next: boolean) => void;
}) {
  const { t } = useI18n();
  const locked = target.protected && !target.unlocked;
  const tone = locked ? "working" : target.verified ? "live" : "muted";
  const status = locked ? t("plugins.passkeyLocked") : t(target.verified ? "plugins.verified" : "plugins.notVerified");
  const statusClass = locked
    ? "text-[#956B27] dark:text-[#D0A14F]"
    : target.verified
      ? "text-[#2D7F59] dark:text-[#70C398]"
      : "text-[#656960] dark:text-[#A0A39B]";
  return (
    <DetailShell onBack={onBack}>
      <div className="flex flex-wrap items-start gap-5 border-b border-[#E3E6DE] pb-6 dark:border-[#30322D]">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-[.08em] text-[#686C63] dark:text-[#A0A39B]"><Server className="size-3" strokeWidth={1.55} />{t("plugins.sshMethod")}</div>
          <div className="mt-2 flex min-w-0 items-center gap-3">
            <h2 className="truncate text-[22px] font-semibold tracking-[-.025em] text-[#292C26] dark:text-[#E5E6E0]">{target.label}</h2>
            <span className={`inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium ${statusClass}`}>
              <StatusDot tone={tone} />
              {status}
            </span>
          </div>
          <p className="mt-1.5 max-w-[590px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">{t("plugins.sshDetailHint")}</p>
        </div>
        {target.protected && (locked ? (
          <button type="button" data-testid={`plugin-unlock-${target.id}`} onClick={onUnlock} disabled={unlocking} className={primaryButtonClass}>
            {unlocking ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <KeyRound className="size-3.5" strokeWidth={1.8} />}{t("plugins.unlock")}
          </button>
        ) : (
          <button type="button" data-testid={`plugin-lock-${target.id}`} onClick={onLock} className={quietButtonClass}><Lock className="size-3.5" strokeWidth={1.8} />{t("plugins.lock")}</button>
        ))}
      </div>

      <div className="grid border-b border-[#E3E6DE] py-5 dark:border-[#30322D] @lg/detail:grid-cols-3">
        <MetaItem icon={<Server className="size-3" />} label={t("plugins.endpointLabel")} value={`${target.host}:${target.port}`} mono />
        <MetaItem icon={<KeyRound className="size-3" />} label={t("plugins.userField")} value={target.username} mono />
        <MetaItem icon={<ShieldCheck className="size-3" />} label={t("plugins.keyProtectionLabel")} value={target.protected ? t("plugins.passkeyTitle") : t("plugins.platformEncrypted")} />
      </div>

      <div className="grid gap-7 py-6 @2xl/detail:grid-cols-[minmax(0,1fr)_minmax(220px,.7fr)]">
        <div>
          <h3 className="text-[13px] font-semibold text-[#383B34] dark:text-[#D5D7CF]">{t("plugins.policyTitle")}</h3>
          <p className="mb-3 mt-1 text-[11px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.policyHint")}</p>
          <PolicyControl unconfined={target.unconfined} onChange={onToggleUnconfined} testId={`ssh-unconfined-${target.id}`} />
        </div>
        <div>
          <h3 className="text-[13px] font-semibold text-[#383B34] dark:text-[#D5D7CF]">{t("plugins.diagnosticsTitle")}</h3>
          <p className="mb-3 mt-1 text-[11px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.diagnosticsHint")}</p>
          <button type="button" data-testid={`plugin-test-${target.id}`} onClick={onTest} disabled={testState?.testing || locked} className={`${quietButtonClass} w-full`}>
            {testState?.testing ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <PlugZap className="size-3.5" strokeWidth={1.7} />}{testState?.testing ? t("plugins.testing") : t("plugins.test")}
          </button>
          <TestReadout state={testState} />
        </div>
      </div>

      <div className="flex justify-end border-t border-[#E3E6DE] pt-4 dark:border-[#30322D]">
        <button type="button" onClick={onRemove} className="inline-flex min-h-8 items-center gap-1.5 rounded-[3px] px-2.5 text-[11px] font-medium text-[#A05A50] transition-colors hover:bg-[#FBF0ED] active:bg-[#F6E5E1] dark:text-[#D68E82] dark:hover:bg-[#332421]"><Trash2 className="size-3" strokeWidth={1.7} />{t("plugins.delete")}</button>
      </div>
    </DetailShell>
  );
}
