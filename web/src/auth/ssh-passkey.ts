import { api, type SshTargetInfo } from "../platform/api";
import { unwrapPrivateKey, passkeyErrorMessage } from "./webauthn";

export async function resolveSessionSshTarget(sandboxTargetId?: string | null): Promise<SshTargetInfo | null> {
  try {
    const { targets } = await api.sshTargets();
    if (targets.length === 0) return null;
    return (sandboxTargetId ? targets.find((x) => x.id === sandboxTargetId) : targets[0]) ?? null;
  } catch {
    return null;
  }
}

export async function ensureSshUnlocked(targetId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const [{ wrappedKey }, { credentials }] = await Promise.all([
      api.sshTargetWrapped(targetId),
      api.webauthnCredentials(),
    ]);
    const transports = credentials.find((c) => c.credentialId === wrappedKey.credentialId)?.transports ?? [];
    const privateKey = await unwrapPrivateKey(wrappedKey, transports);
    await api.unlockSshTarget(targetId, privateKey);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: passkeyErrorMessage(e) };
  }
}
