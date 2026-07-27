const RESEND_KEY = process.env.AGENT_WEB_RESEND_KEY || "";
const EMAIL_FROM = process.env.AGENT_WEB_EMAIL_FROM || "";
const RESEND_REQUEST_TIMEOUT_MS = 10_000;

export function mailerEnabled(): boolean {
  return Boolean(RESEND_KEY && EMAIL_FROM);
}

export type EmailDispatchResult =
  | { outcome: "accepted"; httpStatus: number; providerId: string | null; durationMs: number }
  | { outcome: "rejected"; httpStatus: number; providerCode: string | null; durationMs: number }
  | { outcome: "failed"; errorKind: string; durationMs: number }
  | { outcome: "disabled"; durationMs: 0 };

export function boundedProviderCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 64);
  return normalized || null;
}

function errorKind(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  if (error.name === "AbortError" || error.name === "TimeoutError") return "timeout";
  return boundedProviderCode(error.name) ?? "error";
}

export async function sendEmail(message: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<EmailDispatchResult> {
  if (!mailerEnabled()) return { outcome: "disabled", durationMs: 0 };
  const startedAt = Date.now();
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      signal: AbortSignal.timeout(RESEND_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    const raw = (await r.text()).slice(0, 4096);
    const durationMs = Date.now() - startedAt;
    let payload: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && !Array.isArray(parsed) && typeof parsed === "object") {
        payload = parsed as Record<string, unknown>;
      }
    } catch {  }
    if (!r.ok) {
      return {
        outcome: "rejected",
        httpStatus: r.status,
        providerCode: boundedProviderCode(payload.name ?? payload.code),
        durationMs,
      };
    }
    const providerId = typeof payload.id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(payload.id)
      ? payload.id
      : null;
    return { outcome: "accepted", httpStatus: r.status, providerId, durationMs };
  } catch (e) {
    return { outcome: "failed", errorKind: errorKind(e), durationMs: Date.now() - startedAt };
  }
}
