import { useState, type FormEvent } from "react";
import { Spinner } from "../../../ui/Spinner";
import {
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  KeyRound,
  Server,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { WebauthnCredentialInfo } from "../../../platform/api.ts";
import { useT } from "../../../i18n";
import CodeBlock from "../../../conversation/markdown/CodeBlock.tsx";
import type {
  ConnectorForm,
  ConnectorFormAction,
  SshForm,
  SshFormAction,
} from "./connector-model.ts";
import { parseSshConfig } from "./connector-model.ts";
import {
  fieldClass,
  iconButtonClass,
  labelClass,
  primaryButtonClass,
  quietButtonClass,
} from "../../ui/controlStyles.ts";

export type SetupMode = null | "connector" | "ssh";

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={htmlFor} className={labelClass}>{label}</label>
      {children}
    </div>
  );
}

function StepLabel({ number, children }: { number: number; children: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center gap-2.5 text-[12px] font-semibold text-[#4D5048] dark:text-[#C8CAC3]">
      <span className="font-mono text-[10.5px] tabular-nums text-[#967D4F] dark:text-[#BDA678]">0{number}</span>
      <span className="h-px w-4 bg-[#D3D7CE] dark:bg-[#41433D]" aria-hidden="true" />
      {children}
    </div>
  );
}

function MethodOption({
  icon,
  title,
  description,
  badge,
  disabled,
  disabledReason,
  testId,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      className="group flex min-h-[88px] w-full items-center border-b border-[#DDE1D8] px-1 py-4 text-left outline-none transition-colors duration-150 last:border-b-0 hover:bg-[#F3F4EF] active:bg-[#ECEEE8] focus-visible:z-10 focus-visible:shadow-[inset_0_0_0_2px_rgba(173,145,94,.5)] disabled:pointer-events-none disabled:opacity-45 dark:border-[#393B35] dark:hover:bg-[#292A26]"
    >
      <span className="flex size-9 shrink-0 items-center justify-center text-[#676B61] dark:text-[#A9ACA2]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 px-2.5">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-[13.5px] font-semibold text-[#353730] dark:text-[#E0E1DB]">{title}</span>
          {badge && <span className="text-[10.5px] font-semibold uppercase tracking-[.06em] text-[#725C34] dark:text-[#CDB77E]">{badge}</span>}
        </span>
        <span className="mt-1 block max-w-[560px] text-[11.5px] leading-[1.55] text-[#686C63] dark:text-[#A0A39B]">{disabledReason ?? description}</span>
      </span>
      <ArrowRight className="mr-2 size-3.5 shrink-0 text-[#70746B] transition-transform duration-150 group-hover:translate-x-0.5 dark:text-[#A0A39B]" strokeWidth={1.7} />
    </button>
  );
}

function SetupHeader({ title, description, onBack }: { title: string; description: string; onBack: () => void }) {
  const t = useT();
  return (
    <div className="mb-7 flex items-start gap-2.5">
      <button type="button" onClick={onBack} aria-label={t("plugins.backToMethods")} className={`${iconButtonClass} -ml-1 mt-[-3px]`}>
        <ArrowLeft className="size-4" strokeWidth={1.7} />
      </button>
      <div className="min-w-0">
        <h3 className="text-[20px] font-semibold tracking-[-0.025em] text-[#30322D] dark:text-[#E3E4DE]">{title}</h3>
        <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">{description}</p>
      </div>
    </div>
  );
}

function ConnectorSetup({
  form,
  dispatch,
  onSubmit,
  onBack,
}: {
  form: ConnectorForm;
  dispatch: React.Dispatch<ConnectorFormAction>;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
}) {
  const t = useT();
  return (
    <form data-testid="connector-register" onSubmit={onSubmit} className="max-w-[660px]">
      <SetupHeader title={t("plugins.connectorRegister")} description={t("plugins.connectorHelp")} onBack={onBack} />
      <StepLabel number={1}>{t("plugins.connectorStepDescribe")}</StepLabel>
      <div className="grid gap-3.5 @lg/detail:grid-cols-[minmax(0,.85fr)_minmax(0,1.25fr)]">
        <Field label={t("plugins.connectorNameField")} htmlFor="connector-name-input">
          <input
            id="connector-name-input"
            data-testid="connector-name"
            required
            autoFocus
            className={fieldClass}
            value={form.name}
            onChange={(event) => dispatch({ type: "set", field: "name", value: event.target.value })}
            placeholder={t("plugins.connectorNamePlaceholder")}
          />
        </Field>
        <Field label={t("plugins.connectorRootField")} htmlFor="connector-root-input">
          <input
            id="connector-root-input"
            data-testid="connector-root"
            className={`${fieldClass} font-mono text-[11.5px]`}
            value={form.root}
            onChange={(event) => dispatch({ type: "set", field: "root", value: event.target.value })}
            placeholder="~/.agent-web/workspaces"
            autoComplete="off"
          />
        </Field>
      </div>
      {form.error && <p data-testid="connector-error" className="mt-3 text-[11px] leading-4 text-[#B74335] dark:text-[#E28A7D]">{form.error}</p>}
      <button data-testid="connector-register-submit" type="submit" disabled={form.busy} className={`${primaryButtonClass} mt-4 sm:w-auto`}>
        {form.busy ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <Cable className="size-3.5" strokeWidth={1.8} />}
        {form.busy ? t("plugins.connectorAdding") : t("plugins.connectorAdd")}
      </button>

      {form.command && (
        <div className="mt-6 border-t border-[#E6E8E1] pt-5 dark:border-[#343630]">
          <StepLabel number={2}>{t("plugins.connectorStepRun")}</StepLabel>
          <div className="mb-2 flex items-center gap-1.5 text-[10.5px] text-[#687067] dark:text-[#979B92]">
            <Check className="size-3 text-[var(--status-live)]" strokeWidth={2.2} />
            {t("plugins.connectorCommandReady")}
          </div>
          {form.insecure && (
            <div data-testid="connector-insecure-warning" className="mb-3 flex items-start gap-1.5 text-[10.5px] leading-[1.5] text-[#9A6928] dark:text-[#D1A052]">
              <ShieldAlert className="mt-[1px] size-3 shrink-0" strokeWidth={1.8} />
              <span>{t("plugins.connectorInsecureWarning")}</span>
            </div>
          )}
          <div data-testid="connector-command" className="[--cb-surface:#F5F6F1] dark:[--cb-surface:#20211E]">
            <CodeBlock code={form.command} language="bash" />
          </div>
          <p className="mt-2 text-[11px] leading-[1.5] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.connectorWaiting")}</p>
        </div>
      )}
    </form>
  );
}

function PasskeyControl({
  passkeys,
  protect,
  canPasskey,
  busy,
  error,
  onProtectChange,
  onEnroll,
  onRemove,
}: {
  passkeys: WebauthnCredentialInfo[];
  protect: boolean;
  canPasskey: boolean;
  busy: boolean;
  error: string;
  onProtectChange: (next: boolean) => void;
  onEnroll: () => void;
  onRemove: (id: string) => void;
}) {
  const t = useT();
  return (
    <div data-testid="passkey-section" className="border border-[#DDE1D8] bg-[#F5F6F1] p-3.5 dark:border-[#393B35] dark:bg-[#292A26]">
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-[#777B70] dark:text-[#A1A49A]" strokeWidth={1.8} />
        <div className="min-w-0 flex-1">
          <div className="text-[11.5px] font-medium text-[#50534B] dark:text-[#C4C6BF]">{t("plugins.passkeyTitle")}</div>
          <p className="mt-0.5 text-[11px] leading-[1.5] text-[#686C63] dark:text-[#A0A39B]">{t("plugins.passkeyCompactHelp")}</p>
        </div>
      </div>
      {passkeys.length === 0 ? (
        <button
          type="button"
          data-testid="passkey-enroll"
          onClick={onEnroll}
          disabled={busy || !canPasskey}
          title={canPasskey ? t("plugins.passkeyHelp") : t("plugins.passkeyUnsupported")}
          className={`${quietButtonClass} mt-2.5 w-full !min-h-8 !text-[11px]`}
        >
          {busy ? <Spinner className="size-3" strokeWidth={2.6} /> : <KeyRound className="size-3" strokeWidth={1.8} />}
          {t("plugins.passkeyEnroll")}
        </button>
      ) : (
        <div className="mt-3 border-t border-[#DDE1D8] dark:border-[#3B3D37]">
          {passkeys.map((passkey) => (
            <div key={passkey.id} className="flex items-center gap-2 border-b border-[#DDE1D8] px-1 py-2.5 dark:border-[#3B3D37]">
              <KeyRound className="size-3 shrink-0 text-[#85877F]" strokeWidth={1.8} />
              <span className="min-w-0 flex-1 truncate text-[11px] text-[#5F635A] dark:text-[#A8AAA3]">{passkey.label}</span>
              <button type="button" onClick={() => onRemove(passkey.id)} className="inline-flex size-6 shrink-0 items-center justify-center rounded-[3px] text-[#74776F] transition-colors hover:bg-[#F4E8E5] hover:text-[#B74335] dark:text-[#9A9C94] dark:hover:bg-[#332421] dark:hover:text-[#E28A7D]" aria-label={t("plugins.delete")}>
                <Trash2 className="size-3" strokeWidth={1.7} />
              </button>
            </div>
          ))}
          <label className="mt-2.5 flex cursor-pointer items-start gap-2 text-[11px] leading-[1.5] text-[#64675E] dark:text-[#A7A9A2]">
            <input
              type="checkbox"
              data-testid="passkey-protect-toggle"
              checked={protect}
              onChange={(event) => onProtectChange(event.target.checked)}
              className="mt-[1px] accent-[#806D47]"
            />
            {t("plugins.passkeyProtectNew")}
          </label>
        </div>
      )}
      {error && <p className="mt-2 text-[10.5px] leading-4 text-[#B74335] dark:text-[#E28A7D]">{error}</p>}
    </div>
  );
}

function SshSetup({
  form,
  dispatch,
  onSubmit,
  onBack,
  passkeys,
  protect,
  canPasskey,
  passkeyBusy,
  passkeyError,
  onProtectChange,
  onEnroll,
  onRemovePasskey,
}: {
  form: SshForm;
  dispatch: React.Dispatch<SshFormAction>;
  onSubmit: (event: FormEvent) => void;
  onBack: () => void;
  passkeys: WebauthnCredentialInfo[];
  protect: boolean;
  canPasskey: boolean;
  passkeyBusy: boolean;
  passkeyError: string;
  onProtectChange: (next: boolean) => void;
  onEnroll: () => void;
  onRemovePasskey: (id: string) => void;
}) {
  const t = useT();
  const [showConfig, setShowConfig] = useState(false);
  const [configApplied, setConfigApplied] = useState(false);
  return (
    <form data-testid="plugin-register" onSubmit={onSubmit} className="max-w-[760px]">
      <SetupHeader title={t("plugins.register")} description={t("plugins.sshRegisterHelp")} onBack={onBack} />
      <button
        type="button"
        onClick={() => setShowConfig((value) => !value)}
        className={`${quietButtonClass} mb-4 w-full !justify-between !px-3 !text-[11px]`}
      >
        <span className="inline-flex items-center gap-1.5">
          {configApplied ? <Check className="size-3 text-[var(--status-live)]" strokeWidth={2.2} /> : <Server className="size-3" strokeWidth={1.7} />}
          {configApplied ? t("plugins.sshConfigApplied") : t("plugins.sshConfigLabel")}
        </span>
        <ArrowRight className={`size-3 transition-transform duration-150 ${showConfig ? "rotate-90" : ""}`} strokeWidth={1.8} />
      </button>
      {showConfig && (
        <textarea
          id="ssh-config-paste"
          data-testid="ssh-config-paste"
          rows={4}
          spellCheck={false}
          autoFocus
          placeholder={t("plugins.sshConfigPlaceholder")}
          className={`${fieldClass} mb-4 min-h-[90px] resize-y whitespace-pre font-mono text-[11px] leading-[1.5]`}
          onChange={(event) => {
            const parsed = parseSshConfig(event.target.value);
            if (parsed.label || parsed.host || parsed.username || parsed.port) {
              if (parsed.label) dispatch({ type: "set", field: "label", value: parsed.label });
              if (parsed.host) dispatch({ type: "set", field: "host", value: parsed.host });
              if (parsed.username) dispatch({ type: "set", field: "username", value: parsed.username });
              if (parsed.port) dispatch({ type: "set", field: "port", value: parsed.port });
              setConfigApplied(true);
            }
          }}
        />
      )}

      <div className="grid gap-3 @md/detail:grid-cols-[minmax(0,1.2fr)_minmax(120px,.8fr)]">
        <Field label={t("plugins.labelField")} htmlFor="plugin-label-input">
          <input id="plugin-label-input" data-testid="plugin-label" required className={fieldClass} value={form.label} onChange={(event) => dispatch({ type: "set", field: "label", value: event.target.value })} placeholder={t("plugins.labelPlaceholder")} />
        </Field>
        <Field label={t("plugins.userField")} htmlFor="plugin-username-input">
          <input id="plugin-username-input" data-testid="plugin-username" required className={fieldClass} value={form.username} onChange={(event) => dispatch({ type: "set", field: "username", value: event.target.value })} placeholder={t("plugins.userPlaceholder")} autoComplete="off" />
        </Field>
        <Field label={t("plugins.hostField")} htmlFor="plugin-host-input">
          <input id="plugin-host-input" data-testid="plugin-host" required className={`${fieldClass} font-mono text-[11.5px]`} value={form.host} onChange={(event) => dispatch({ type: "set", field: "host", value: event.target.value })} placeholder={t("plugins.hostPlaceholder")} autoComplete="off" />
        </Field>
        <Field label={t("plugins.portField")} htmlFor="plugin-port-input">
          <input id="plugin-port-input" data-testid="plugin-port" required className={`${fieldClass} font-mono text-[11.5px]`} type="number" min={1} max={65535} value={form.port} onChange={(event) => dispatch({ type: "set", field: "port", value: event.target.value })} />
        </Field>
      </div>

      <div className="mt-3.5 grid items-start gap-3.5 @xl/detail:grid-cols-[minmax(220px,.78fr)_minmax(0,1.22fr)]">
        <PasskeyControl
          passkeys={passkeys}
          protect={protect}
          canPasskey={canPasskey}
          busy={passkeyBusy}
          error={passkeyError}
          onProtectChange={onProtectChange}
          onEnroll={onEnroll}
          onRemove={onRemovePasskey}
        />
        <Field label={t("plugins.keyField")} htmlFor="plugin-key-input">
          <textarea
            id="plugin-key-input"
            data-testid="plugin-key"
            required
            rows={5}
            className={`${fieldClass} min-h-[106px] resize-y font-mono text-[11px] leading-[1.5]`}
            value={form.privateKey}
            onChange={(event) => dispatch({ type: "set", field: "privateKey", value: event.target.value })}
            placeholder={t("plugins.keyPlaceholder")}
            spellCheck={false}
            autoComplete="off"
          />
        </Field>
      </div>
      {form.error && <p data-testid="plugin-error" className="mt-3 text-[11px] leading-4 text-[#B74335] dark:text-[#E28A7D]">{form.error}</p>}
      <button data-testid="plugin-register-submit" type="submit" disabled={form.busy} className={`${primaryButtonClass} mt-4 sm:w-auto`}>
        {form.busy ? <Spinner className="size-3.5" strokeWidth={2.2} /> : <Server className="size-3.5" strokeWidth={1.8} />}
        {form.busy ? t("plugins.adding") : t("plugins.add")}
      </button>
    </form>
  );
}

export function MachineSetupPanel({
  enabled,
  mode,
  onModeChange,
  connectorForm,
  dispatchConnector,
  onSubmitConnector,
  sshForm,
  dispatchSsh,
  onSubmitSsh,
  passkeys,
  protect,
  canPasskey,
  passkeyBusy,
  passkeyError,
  onProtectChange,
  onEnroll,
  onRemovePasskey,
}: {
  enabled: boolean;
  mode: SetupMode;
  onModeChange: (mode: SetupMode) => void;
  connectorForm: ConnectorForm;
  dispatchConnector: React.Dispatch<ConnectorFormAction>;
  onSubmitConnector: (event: FormEvent) => void;
  sshForm: SshForm;
  dispatchSsh: React.Dispatch<SshFormAction>;
  onSubmitSsh: (event: FormEvent) => void;
  passkeys: WebauthnCredentialInfo[];
  protect: boolean;
  canPasskey: boolean;
  passkeyBusy: boolean;
  passkeyError: string;
  onProtectChange: (next: boolean) => void;
  onEnroll: () => void;
  onRemovePasskey: (id: string) => void;
}) {
  const t = useT();
  return (
    <section
      id="machine-setup"
      className="min-h-full bg-[var(--app-surface)] dark:bg-[#1D1E1B]"
    >
      {mode === "connector" ? (
        <ConnectorSetup form={connectorForm} dispatch={dispatchConnector} onSubmit={onSubmitConnector} onBack={() => onModeChange(null)} />
      ) : mode === "ssh" ? (
        <SshSetup
          form={sshForm}
          dispatch={dispatchSsh}
          onSubmit={onSubmitSsh}
          onBack={() => onModeChange(null)}
          passkeys={passkeys}
          protect={protect}
          canPasskey={canPasskey}
          passkeyBusy={passkeyBusy}
          passkeyError={passkeyError}
          onProtectChange={onProtectChange}
          onEnroll={onEnroll}
          onRemovePasskey={onRemovePasskey}
        />
      ) : (
        <>
          <h2 className="text-[22px] font-semibold tracking-[-0.03em] text-[#30322D] dark:text-[#E3E4DE]">{t("plugins.setupTitle")}</h2>
          <p className="mt-1.5 max-w-[640px] text-[12px] leading-[1.6] text-[#656960] dark:text-[#A0A39B]">{t("plugins.setupHint")}</p>
          <div className="mt-7 max-w-[760px] border-y border-[#DDE1D8] dark:border-[#393B35]">
            <MethodOption
              icon={<Cable className="size-4" strokeWidth={1.7} />}
              title={t("plugins.connectorMethod")}
              description={t("plugins.connectorMethodHint")}
              badge={t("plugins.recommended")}
              testId="add-connector"
              onClick={() => onModeChange("connector")}
            />
            <MethodOption
              icon={<Server className="size-4" strokeWidth={1.7} />}
              title={t("plugins.sshMethod")}
              description={t("plugins.sshMethodHint")}
              disabled={!enabled}
              disabledReason={!enabled ? t("plugins.disabled") : undefined}
              testId="add-ssh"
              onClick={() => onModeChange("ssh")}
            />
          </div>
          <div className="mt-7 flex max-w-[720px] items-start gap-2 border-t border-[#E3E6DE] pt-4 text-[11px] leading-[1.55] text-[#686C63] dark:border-[#343630] dark:text-[#A0A39B]">
            <ShieldAlert className="mt-[1px] size-3 shrink-0" strokeWidth={1.6} />
            <span>{t("plugins.securityNotice")}</span>
          </div>
        </>
      )}
    </section>
  );
}
