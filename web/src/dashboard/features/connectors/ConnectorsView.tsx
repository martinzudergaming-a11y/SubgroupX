import { useEffect, useReducer, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Plug, Plus } from "lucide-react";
import type { SessionInfo } from "@shared/protocol";
import { api, type ConnectorInfo, type SshTargetInfo, type WebauthnCredentialInfo } from "../../../platform/api.ts";
import { passkeysSupported, enrollPasskey, wrapPrivateKey, passkeyErrorMessage } from "../../../auth/webauthn.ts";
import { ensureSshUnlocked } from "../../../auth/ssh-passkey.ts";
import { useT } from "../../../i18n";
import {
  connectorFormInit,
  connectorFormReducer,
  connectorsDataInit,
  connectorsDataReducer,
  shellQuote,
  sshFormInit,
  sshFormReducer,
  type TestState,
} from "./connector-model.ts";
import { MachineSetupPanel, type SetupMode } from "./MachineSetupPanel.tsx";
import { MachineNavigator, type MachineSelection } from "./MachineNavigator.tsx";
import { ConnectorDetail, SshDetail } from "./MachineDetail.tsx";
import { primaryButtonClass } from "../../ui/controlStyles.ts";
import { ViewHeader } from "../../ui/ViewHeader.tsx";

export function ConnectorsView({
  isLeftSidebarOpen,
  onOpenLeftSidebar,
  onOpenSession,
}: {
  isLeftSidebarOpen?: boolean;
  onOpenLeftSidebar?: () => void;
  onOpenSession?: (session: SessionInfo) => void;
}) {
  const t = useT();
  const [data, dispatchData] = useReducer(connectorsDataReducer, connectorsDataInit);
  const { enabled, loaded, targets, connectors } = data;
  const [connectorForm, dispatchConnector] = useReducer(connectorFormReducer, connectorFormInit);
  const [sshForm, dispatchSsh] = useReducer(sshFormReducer, sshFormInit);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [setupMode, setSetupMode] = useState<SetupMode>(null);
  const [selected, setSelected] = useState<MachineSelection | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const focusDetailAfterOpenRef = useRef(false);
  const focusMachineAfterBackRef = useRef<MachineSelection | null>(null);

  const [passkeys, setPasskeys] = useState<WebauthnCredentialInfo[]>([]);
  const [protect, setProtect] = useState(false);
  const [pkBusy, setPkBusy] = useState(false);
  const [pkError, setPkError] = useState("");
  const [unlockingId, setUnlockingId] = useState<string | null>(null);
  const canPasskey = passkeysSupported();

  const [creatingSession, setCreatingSession] = useState<string | null>(null);
  const [createError, setCreateError] = useState("");
  const machineCount = connectors.length + targets.length;
  const selectedConnector = selected?.kind === "connector" ? connectors.find((connector) => connector.id === selected.id) : undefined;
  const selectedTarget = selected?.kind === "ssh" ? targets.find((target) => target.id === selected.id) : undefined;

  const isNarrowWorkspace = () => (workspaceRef.current?.clientWidth ?? 768) < 768;

  useEffect(() => {
    if (!mobileDetailOpen || !focusDetailAfterOpenRef.current) return;
    focusDetailAfterOpenRef.current = false;
    const frame = requestAnimationFrame(() => detailRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [mobileDetailOpen, selected, showSetup]);

  useEffect(() => {
    const selection = focusMachineAfterBackRef.current;
    if (mobileDetailOpen || !selection) return;
    focusMachineAfterBackRef.current = null;
    const testId = selection.kind === "connector" ? `connector-row-${selection.id}` : `plugin-row-${selection.id}`;
    const frame = requestAnimationFrame(() => {
      const rows = workspaceRef.current?.querySelectorAll<HTMLElement>("[data-testid]");
      Array.from(rows ?? []).find((row) => row.dataset.testid === testId)?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [mobileDetailOpen]);

  async function load() {
    const [ssh, connectorResponse, credentials] = await Promise.all([
      api.sshTargets().catch(() => ({ enabled: false, targets: [] as SshTargetInfo[] })),
      api.connectors().catch(() => ({ connectors: [] as ConnectorInfo[] })),
      api.webauthnCredentials().catch(() => ({ credentials: [] as WebauthnCredentialInfo[] })),
    ]);
    setPasskeys(credentials.credentials);
    dispatchData({
      type: "loaded",
      enabled: ssh.enabled,
      targets: ssh.targets,
      connectors: connectorResponse.connectors,
    });
  }

  useEffect(() => {
    void load().catch(() => dispatchData({ type: "loadFailed" }));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    let stopped = false;
    const tick = async () => {
      if (stopped || document.hidden) return;
      const response = await api.connectors().catch(() => null);
      if (!stopped && response) dispatchData({ type: "connectors", connectors: response.connectors });
    };
    const interval = window.setInterval(tick, 3000);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loaded]);

  useEffect(() => {
    if (!loaded) return;
    if (machineCount === 0) {
      setSelected(null);
      setShowSetup(true);
      setMobileDetailOpen(true);
      return;
    }
    const selectionStillExists = selected?.kind === "connector"
      ? connectors.some((connector) => connector.id === selected.id)
      : selected?.kind === "ssh"
        ? targets.some((target) => target.id === selected.id)
        : false;
    if (!showSetup && !selectionStillExists) {
      const connector = connectors[0];
      const target = targets[0];
      setSelected(connector ? { kind: "connector", id: connector.id } : { kind: "ssh", id: target.id });
    }
  }, [connectors, loaded, machineCount, selected, showSetup, targets]);

  function openSetup() {
    if (isNarrowWorkspace()) focusDetailAfterOpenRef.current = true;
    setSetupMode(null);
    setShowSetup(true);
    setMobileDetailOpen(true);
  }

  function returnToNavigator() {
    focusMachineAfterBackRef.current = selected;
    setMobileDetailOpen(false);
  }

  async function enroll() {
    setPkBusy(true);
    setPkError("");
    try {
      const { credentialId, transports } = await enrollPasskey("oiia SSH key");
      await api.addWebauthnCredential({ credentialId, label: "Passkey", transports });
      const credentials = await api.webauthnCredentials().catch(() => ({ credentials: passkeys }));
      setPasskeys(credentials.credentials);
      setProtect(true);
    } catch (error) {
      setPkError(passkeyErrorMessage(error));
    } finally {
      setPkBusy(false);
    }
  }

  async function removePasskey(id: string) {
    if (!confirm(t("plugins.passkeyDeleteConfirm"))) return;
    await api.deleteWebauthnCredential(id).catch(() => {});
    setPasskeys((current) => current.filter((credential) => credential.id !== id));
  }

  async function unlock(target: SshTargetInfo) {
    setUnlockingId(target.id);
    setPkError("");
    const result = await ensureSshUnlocked(target.id);
    if (!result.ok) setPkError(result.error || t("plugins.passkeyUnsupported"));
    await load().catch(() => {});
    setUnlockingId(null);
  }

  async function lock(target: SshTargetInfo) {
    await api.lockSshTarget(target.id).catch(() => {});
    await load().catch(() => {});
  }

  async function submitConnector(event: React.FormEvent) {
    event.preventDefault();
    dispatchConnector({ type: "submitStart" });
    try {
      const response = await api.createConnectorPairing({
        name: connectorForm.name.trim(),
        workspaceRoot: connectorForm.root.trim() || "~/.agent-web/workspaces",
      });
      await load();
      const origin = window.location.origin;
      const installerUrl = `${origin}/api/connectors/install.sh`;
      const insecure =
        window.location.protocol !== "https:" &&
        !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);
      dispatchConnector({
        type: "submitOk",
        insecure,
        command: `curl -fsSL ${shellQuote(installerUrl)} | sh -s -- --url ${shellQuote(origin)} --pair-code ${shellQuote(response.code)} --root ${shellQuote(response.pairing.workspaceRoot)}`,
      });
    } catch (error) {
      dispatchConnector({ type: "submitError", error: error instanceof Error ? error.message : "failed" });
    } finally {
      dispatchConnector({ type: "submitEnd" });
    }
  }

  async function submitSsh(event: React.FormEvent) {
    event.preventDefault();
    dispatchSsh({ type: "submitStart" });
    const base = {
      label: sshForm.label.trim(),
      host: sshForm.host.trim(),
      port: Number(sshForm.port) || 22,
      username: sshForm.username.trim(),
    };
    try {
      let created: SshTargetInfo;
      if (protect && passkeys[0]) {
        const passkey = passkeys[0];
        const wrappedKey = await wrapPrivateKey(passkey.credentialId, passkey.transports, sshForm.privateKey);
        created = (await api.createSshTarget({ ...base, wrappedKey })).target;
      } else {
        created = (await api.createSshTarget({ ...base, privateKey: sshForm.privateKey })).target;
      }
      await load();
      dispatchSsh({ type: "submitOk" });
      setSetupMode(null);
      setSelected({ kind: "ssh", id: created.id });
      setShowSetup(false);
      setMobileDetailOpen(true);
    } catch (error) {
      dispatchSsh({ type: "submitError", error: error instanceof Error ? passkeyErrorMessage(error) : "failed" });
    } finally {
      dispatchSsh({ type: "submitEnd" });
    }
  }

  async function testSsh(target: SshTargetInfo) {
    setTests((current) => ({ ...current, [target.id]: { testing: true } }));
    try {
      const response = await api.testSshTarget(target.id);
      setTests((current) => ({
        ...current,
        [target.id]: {
          testing: false,
          ok: response.ok,
          message: response.ok ? response.output || t("plugins.ok") : response.error || t("plugins.failed"),
        },
      }));
      if (response.ok) await load().catch(() => {});
    } catch (error) {
      setTests((current) => ({
        ...current,
        [target.id]: { testing: false, ok: false, message: error instanceof Error ? error.message : t("plugins.failed") },
      }));
    }
  }

  async function testConnector(connector: ConnectorInfo) {
    setTests((current) => ({ ...current, [connector.id]: { testing: true } }));
    try {
      const response = await api.testConnector(connector.id);
      setTests((current) => ({
        ...current,
        [connector.id]: {
          testing: false,
          ok: response.ok,
          message: response.ok ? response.output || t("plugins.ok") : response.error || t("plugins.failed"),
        },
      }));
      await load().catch(() => {});
    } catch (error) {
      setTests((current) => ({
        ...current,
        [connector.id]: { testing: false, ok: false, message: error instanceof Error ? error.message : t("plugins.failed") },
      }));
    }
  }

  async function removeSsh(target: SshTargetInfo) {
    if (!confirm(t("plugins.deleteConfirm"))) return;
    await api.deleteSshTarget(target.id).catch(() => {});
    dispatchData({ type: "removeTarget", id: target.id });
  }

  async function removeConnector(connector: ConnectorInfo) {
    if (!confirm(t("plugins.connectorDeleteConfirm"))) return;
    await api.deleteConnector(connector.id).catch(() => {});
    dispatchData({ type: "removeConnector", id: connector.id });
  }

  async function toggleConnectorUnconfined(connector: ConnectorInfo, next: boolean) {
    if (next && !connector.unconfined && !confirm(t("plugins.connectorUnconfinedConfirm"))) return;
    dispatchData({
      type: "connectors",
      connectors: connectors.map((candidate) => candidate.id === connector.id ? { ...candidate, unconfined: next } : candidate),
    });
    try {
      await api.setConnectorUnconfined(connector.id, next);
    } catch {
      const response = await api.connectors().catch(() => null);
      if (response) dispatchData({ type: "connectors", connectors: response.connectors });
    }
  }

  async function toggleSshUnconfined(target: SshTargetInfo, next: boolean) {
    if (next && !target.unconfined && !confirm(t("plugins.sshUnconfinedConfirm"))) return;
    dispatchData({
      type: "targets",
      targets: targets.map((candidate) => candidate.id === target.id ? { ...candidate, unconfined: next } : candidate),
    });
    try {
      await api.setSshUnconfined(target.id, next);
    } catch {
      const response = await api.sshTargets().catch(() => null);
      if (response) dispatchData({ type: "targets", targets: response.targets });
    }
  }

  async function newConnectorSession(connector: ConnectorInfo) {
    if (creatingSession) return;
    setCreatingSession(connector.id);
    setCreateError("");
    try {
      const { models } = await api.models();
      const model = models[0];
      if (!model) throw new Error(t("plugins.noModels"));
      const { session } = await api.createSession({
        title: connector.name,
        provider: model.provider,
        model: model.id,
        sandboxKind: "connector",
        sandboxTargetId: connector.id,
        sandboxMode: "danger-full-access",
        approvalPolicy: "never",
      });
      onOpenSession?.(session);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : t("plugins.sessionCreateFailed"));
    } finally {
      setCreatingSession(null);
    }
  }

  return (
    <div data-testid="plugins-view" className="flex h-full flex-1 flex-col overflow-hidden bg-[var(--app-surface)] dark:bg-[#1A1A1A]">
      <ViewHeader
        icon={Plug}
        title={t("plugins.title")}
        subtitle={t("plugins.subtitle")}
        isLeftSidebarOpen={isLeftSidebarOpen}
        onOpenLeftSidebar={onOpenLeftSidebar}
        action={
          <button type="button" onClick={openSetup} className={`${primaryButtonClass} !min-h-8 !px-3 !text-[11.5px]`}>
            <Plus className="size-3.5" strokeWidth={2} />
            {t("plugins.connectMachine")}
          </button>
        }
      />

      <div ref={workspaceRef} className="@container/connectors min-h-0 flex-1">
        <div className="grid h-full w-full overflow-hidden bg-[var(--app-surface)] dark:bg-[#1D1E1B] @3xl/connectors:grid-cols-[288px_minmax(0,1fr)]">
          <div className={`${mobileDetailOpen ? "hidden" : "flex"} min-h-0 flex-col border-r border-[#DDE1D8] dark:border-[#30322D] @3xl/connectors:flex`}>
            {loaded ? (
              <MachineNavigator
                connectors={connectors}
                targets={targets}
                selected={showSetup ? null : selected}
                onSelect={(selection) => {
                  if (isNarrowWorkspace()) focusDetailAfterOpenRef.current = true;
                  setSelected(selection);
                  setShowSetup(false);
                  setSetupMode(null);
                  setCreateError("");
                  setMobileDetailOpen(true);
                }}
              />
            ) : (
              <div className="h-full animate-pulse bg-[#F3F4EF] dark:bg-[#20211E]" />
            )}
          </div>

          <main ref={detailRef} tabIndex={-1} className={`@container/detail ${mobileDetailOpen ? "block" : "hidden"} min-h-0 overflow-y-auto bg-[var(--app-surface)] px-5 py-6 outline-none hide-scrollbar dark:bg-[#1D1E1B] @3xl/connectors:block @2xl/detail:px-8 @2xl/detail:py-8 @5xl/detail:px-10`}>
            {(createError || (pkError && setupMode !== "ssh")) && (
              <div className="mb-6 flex items-start gap-2 border-l-2 border-[#C87668] bg-[#FCF5F2] px-3 py-2.5 text-[11.5px] leading-5 text-[#91483E] dark:bg-[#2D2321] dark:text-[#D98D82]">
                <AlertCircle className="mt-[1px] size-3.5 shrink-0" strokeWidth={1.8} />
                <span>{createError || pkError}</span>
              </div>
            )}
            {!loaded ? (
              <div className="h-72 animate-pulse bg-[#F3F4EF] dark:bg-[#242521]" />
            ) : showSetup || (!selectedConnector && !selectedTarget) ? (
              <>
                {machineCount > 0 && (
                  <button type="button" onClick={returnToNavigator} className="mb-4 inline-flex min-h-8 items-center gap-1.5 text-[11.5px] font-medium text-[#5F635A] @3xl/connectors:hidden">
                    <ArrowLeft className="size-3.5" strokeWidth={1.7} />{t("plugins.backToMachines")}
                  </button>
                )}
                <MachineSetupPanel
                  enabled={enabled}
                  mode={setupMode}
                  onModeChange={setSetupMode}
                  connectorForm={connectorForm}
                  dispatchConnector={dispatchConnector}
                  onSubmitConnector={(event) => void submitConnector(event)}
                  sshForm={sshForm}
                  dispatchSsh={dispatchSsh}
                  onSubmitSsh={(event) => void submitSsh(event)}
                  passkeys={passkeys}
                  protect={protect}
                  canPasskey={canPasskey}
                  passkeyBusy={pkBusy}
                  passkeyError={pkError}
                  onProtectChange={setProtect}
                  onEnroll={() => void enroll()}
                  onRemovePasskey={(id) => void removePasskey(id)}
                />
              </>
            ) : selectedConnector ? (
              <ConnectorDetail
                connector={selectedConnector}
                testState={tests[selectedConnector.id]}
                creating={creatingSession === selectedConnector.id}
                onBack={returnToNavigator}
                onNewSession={() => void newConnectorSession(selectedConnector)}
                onTest={() => void testConnector(selectedConnector)}
                onRemove={() => void removeConnector(selectedConnector)}
                onToggleUnconfined={(next) => void toggleConnectorUnconfined(selectedConnector, next)}
              />
            ) : selectedTarget ? (
              <SshDetail
                target={selectedTarget}
                testState={tests[selectedTarget.id]}
                unlocking={unlockingId === selectedTarget.id}
                onBack={returnToNavigator}
                onTest={() => void testSsh(selectedTarget)}
                onRemove={() => void removeSsh(selectedTarget)}
                onUnlock={() => void unlock(selectedTarget)}
                onLock={() => void lock(selectedTarget)}
                onToggleUnconfined={(next) => void toggleSshUnconfined(selectedTarget, next)}
              />
            ) : null}
          </main>
        </div>
      </div>
    </div>
  );
}
