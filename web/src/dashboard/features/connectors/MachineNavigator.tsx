import { useMemo, useState } from "react";
import { Cable, CheckCircle2, CircleDashed, Lock, Monitor, Search, Server } from "lucide-react";
import type { ConnectorInfo, SshTargetInfo } from "../../../platform/api.ts";
import { useT } from "../../../i18n";
import { StatusDot } from "../../../ui/StatusDot.tsx";

export type MachineSelection = { kind: "connector" | "ssh"; id: string };

function selectionMatches(a: MachineSelection | null, b: MachineSelection): boolean {
  return a?.kind === b.kind && a.id === b.id;
}

const rowClass = (selected: boolean) =>
  `group relative flex min-h-[54px] w-full items-center border-b border-l-2 border-b-[#E5E8E0] px-3.5 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-[#B8A57E] dark:border-b-[#30322D] ${
    selected
      ? "border-l-[#89754D] bg-[var(--app-surface)] dark:bg-[#292A26]"
      : "border-l-transparent hover:bg-black/[.035] active:bg-black/[.055] dark:hover:bg-white/[.035] dark:active:bg-white/[.055]"
  }`;

function ConnectorRow({ connector, selected, onSelect }: { connector: ConnectorInfo; selected: boolean; onSelect: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      data-testid={`connector-row-${connector.id}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={rowClass(selected)}
    >
      <Monitor
        data-testid={`connector-glyph-${connector.id}`}
        className={`mr-2.5 size-4 shrink-0 ${selected ? "text-[#4F534A] dark:text-[#CED0C8]" : "text-[#74786F] dark:text-[#A0A39B]"}`}
        strokeWidth={1.55}
      />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-medium ${selected ? "text-[#2F322C] dark:text-[#E4E5DF]" : "text-[#4F524A] dark:text-[#BABCB4]"}`}>{connector.name}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-[#686C63] dark:text-[#A0A39B]">{connector.workspaceRoot}</span>
      </span>

      <span
        data-testid={`connector-presence-${connector.id}`}
        className="ml-2 flex size-4 shrink-0 items-center justify-center"
        role="img"
        aria-label={t(connector.online ? "plugins.connectorOnline" : "plugins.connectorOffline")}
        title={t(connector.online ? "plugins.connectorOnline" : "plugins.connectorOffline")}
      >
        <StatusDot tone={connector.online ? "live" : "muted"} />
      </span>
    </button>
  );
}

function SshRow({ target, selected, onSelect }: { target: SshTargetInfo; selected: boolean; onSelect: () => void }) {
  const t = useT();
  const locked = target.protected && !target.unlocked;
  const status = locked ? t("plugins.passkeyLocked") : t(target.verified ? "plugins.verified" : "plugins.notVerified");
  const StatusIcon = locked ? Lock : target.verified ? CheckCircle2 : CircleDashed;
  const statusClass = locked
    ? "text-[#9B6B24] dark:text-[#D0A14F]"
    : target.verified
      ? "text-[#27855B] dark:text-[#6CC494]"
      : "text-[#70746B] dark:text-[#A0A39B]";
  return (
    <button
      type="button"
      data-testid={`plugin-row-${target.id}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
      className={rowClass(selected)}
    >
      <Server className={`mr-2.5 size-4 shrink-0 ${selected ? "text-[#4F534A] dark:text-[#CED0C8]" : "text-[#74786F] dark:text-[#A0A39B]"}`} strokeWidth={1.55} />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[13px] font-medium ${selected ? "text-[#2F322C] dark:text-[#E4E5DF]" : "text-[#4F524A] dark:text-[#BABCB4]"}`}>{target.label}</span>
        <span className="mt-0.5 block truncate font-mono text-[11px] leading-4 text-[#686C63] dark:text-[#A0A39B]">{target.username}@{target.host}:{target.port}</span>
      </span>
      <span className={`ml-2 flex size-4 shrink-0 items-center justify-center ${statusClass}`} role="img" aria-label={status} title={status}>
        <StatusIcon className="size-3.5" strokeWidth={1.7} />
      </span>
    </button>
  );
}

function GroupLabel({ icon, label, count }: { icon: React.ReactNode; label: string; count: number }) {
  return (
    <div className="flex h-8 items-center gap-1.5 border-b border-[#E1E4DC] bg-[#ECEFE8] px-3.5 text-[10.5px] font-semibold uppercase tracking-[.08em] text-[#656960] dark:border-[#30322D] dark:bg-[#242521] dark:text-[#A4A79F]">
      {icon}
      <span className="flex-1">{label}</span>
      <span className="font-normal tabular-nums tracking-normal">{count}</span>
    </div>
  );
}

export function MachineNavigator({
  connectors,
  targets,
  selected,
  onSelect,
}: {
  connectors: ConnectorInfo[];
  targets: SshTargetInfo[];
  selected: MachineSelection | null;
  onSelect: (selection: MachineSelection) => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLocaleLowerCase();
  const visibleConnectors = useMemo(
    () => connectors.filter((connector) => !normalized || `${connector.name} ${connector.workspaceRoot}`.toLocaleLowerCase().includes(normalized)),
    [connectors, normalized],
  );
  const visibleTargets = useMemo(
    () => targets.filter((target) => !normalized || `${target.label} ${target.username}@${target.host}:${target.port}`.toLocaleLowerCase().includes(normalized)),
    [targets, normalized],
  );
  const showSearch = connectors.length + targets.length > 5;

  return (
    <nav aria-label={t("plugins.registryTitle")} className="flex min-h-0 flex-col bg-[#F3F4EF] dark:bg-[#20211E]">
      <div className="shrink-0 border-b border-[#DDE1D8] px-3.5 py-3 dark:border-[#30322D]">
        <div className="flex h-7 items-center gap-2">
          <h2 className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-[#3B3E37] dark:text-[#D7D9D1]">{t("plugins.registryTitle")}</h2>
          <span className="text-[11px] tabular-nums text-[#686C63] dark:text-[#A0A39B]">{connectors.length + targets.length}</span>
        </div>
        {showSearch && (
          <label className="relative mt-2 block">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-[#70746B] dark:text-[#A0A39B]" strokeWidth={1.6} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("plugins.searchMachines")}
              placeholder={t("plugins.searchMachines")}
              className="h-9 w-full rounded-[4px] border border-[#D9DDD4] bg-[#FAFBF7] pl-8 pr-2.5 text-[11.5px] text-[#44473F] outline-none placeholder:text-[#7C8077] focus:border-[#A99773] focus:shadow-[0_0_0_2px_rgba(173,145,94,.11)] dark:border-[#383A35] dark:bg-[#252622] dark:text-[#C9CBC3] dark:placeholder:text-[#92958D] dark:focus:border-[#71664F]"
            />
          </label>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
        {visibleConnectors.length > 0 && (
          <section>
            <GroupLabel icon={<Cable className="size-3" strokeWidth={1.6} />} label={t("plugins.connectorShort")} count={visibleConnectors.length} />
            {visibleConnectors.map((connector) => {
              const selection: MachineSelection = { kind: "connector", id: connector.id };
              return <ConnectorRow key={connector.id} connector={connector} selected={selectionMatches(selected, selection)} onSelect={() => onSelect(selection)} />;
            })}
          </section>
        )}
        {visibleTargets.length > 0 && (
          <section>
            <GroupLabel icon={<Server className="size-3" strokeWidth={1.55} />} label={t("plugins.sshShort")} count={visibleTargets.length} />
            {visibleTargets.map((target) => {
              const selection: MachineSelection = { kind: "ssh", id: target.id };
              return <SshRow key={target.id} target={target} selected={selectionMatches(selected, selection)} onSelect={() => onSelect(selection)} />;
            })}
          </section>
        )}
        {visibleConnectors.length + visibleTargets.length === 0 && (
          <p className="px-5 py-10 text-center text-[11.5px] leading-5 text-[#656960] dark:text-[#A0A39B]">
            {connectors.length + targets.length === 0 ? t("plugins.navigatorEmpty") : t("plugins.noSearchResults")}
          </p>
        )}
      </div>
    </nav>
  );
}
