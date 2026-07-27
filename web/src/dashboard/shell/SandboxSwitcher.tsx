import { useEffect, useState } from "react";
import { Spinner } from "../../ui/Spinner";
import { Server, Boxes, Laptop, Plug, Check } from "lucide-react";
import type { SandboxKind } from "@shared/protocol";
import { api } from "../../platform/api.ts";
import { useT } from "../../i18n";

type Option = {
  kind: SandboxKind;
  targetId: string | null;
  label: string;
  icon: typeof Server;
  online?: boolean;
};

export function SandboxSwitcher({
  currentKind,
  currentTargetId,
  disabled,
  onSwitch,
}: {
  currentKind: SandboxKind;
  currentTargetId?: string | null;
  disabled?: boolean;
  onSwitch: (kind: SandboxKind, targetId: string | null) => void;
}) {
  const t = useT();
  const [opts, setOpts] = useState<Option[] | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      const [models, ssh, conn] = await Promise.all([
        api.models().catch(() => ({ e2b: false }) as { e2b?: boolean }),
        api.sshTargets().catch(() => ({ enabled: false, targets: [] })),
        api.connectors().catch(() => ({ connectors: [] })),
      ]);
      if (!alive) return;
      const list: Option[] = [];
      if (models.e2b) list.push({ kind: "e2b", targetId: null, label: t("sandbox.kind.e2b"), icon: Boxes });
      for (const c of conn.connectors) list.push({ kind: "connector", targetId: c.id, label: c.name, icon: Plug, online: c.online });
      if (ssh.enabled) for (const s of ssh.targets) list.push({ kind: "ssh", targetId: s.id, label: s.label || s.host, icon: Laptop });
      setOpts(list);
    })();
    return () => { alive = false; };
  }, [t]);

  const isCurrent = (o: Option) => o.kind === currentKind && (o.targetId ?? null) === (currentTargetId ?? null);

  const pick = (o: Option) => {
    if (isCurrent(o) || disabled) return;
    // eslint-disable-next-line no-alert -- a deliberate destructive-ish confirm (workspace won't migrate)
    if (!window.confirm(t("sandbox.switch.confirm"))) return;
    onSwitch(o.kind, o.targetId);
  };

  return (
    <div>
      <div className="px-2 py-1.5 text-[11px] font-medium text-[#999] dark:text-[#777]">{t("sandbox.switch.title")}</div>
      {disabled && (
        <div className="px-2 pb-1 text-[11px] text-[#B0742E] dark:text-[#D8A94E]">{t("sandbox.switch.busy")}</div>
      )}
      {opts === null ? (
        <div className="flex items-center gap-1.5 px-2 py-1.5 text-[12px] text-[#999] dark:text-[#777]">
          <Spinner className="size-[13px]" strokeWidth={2.4} /> …
        </div>
      ) : (
        opts.map((o) => {
          const Icon = o.icon;
          const active = isCurrent(o);
          return (
            <button
              key={`${o.kind}:${o.targetId ?? ""}`}
              type="button"
              data-testid={`sandbox-opt-${o.kind}`}
              onClick={() => pick(o)}
              disabled={disabled || active}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left transition-colors text-[12.5px] ${
                active
                  ? "text-[#333] dark:text-[#E0E0E0] bg-[#F1ECE1] dark:bg-[#2C2A22]"
                  : "text-[#333] dark:text-[#E0E0E0] hover:bg-[#F5F5F5] dark:hover:bg-[#2A2A2A] disabled:opacity-50"
              }`}
            >
              <Icon strokeWidth={1.5} className="size-[14px] shrink-0 text-[#777] dark:text-[#A0A0A0]" />
              <span className="flex-1 min-w-0 truncate">{o.label}</span>
              {o.online === false && <span className="shrink-0 text-[10.5px] text-[#B0B0B0] dark:text-[#666]">{t("plugins.connectorOffline")}</span>}
              {active && <Check className="size-[13px] shrink-0 text-[#3F8560] dark:text-[#7FC3A0]" />}
            </button>
          );
        })
      )}
    </div>
  );
}
