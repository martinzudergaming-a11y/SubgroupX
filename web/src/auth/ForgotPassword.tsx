import { useEffect, useRef, useState } from "react";
import { api, ApiError, isGatewayError, isNetworkError, setToken } from "../platform/api.ts";
import { useI18n } from "../i18n";
import { LangToggle } from "../ui/LangToggle.tsx";
import type { UserInfo } from "@shared/protocol";
import { PRODUCT_NAME } from "../platform/brand";

export function ForgotPassword({ initialEmail, onDone, onBack }: {
  initialEmail?: string;
  onDone: (user: UserInfo) => void;
  onBack: (email: string) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState(initialEmail ?? "");
  const [stage, setStage] = useState<"request" | "redeem">("request");
  const [justSent, setJustSent] = useState(false);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cooldown, setCooldown] = useState(0);
  const codeRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (stage === "redeem") codeRef.current?.focus(); }, [stage]);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  function describe(err: unknown): string {
    if (isNetworkError(err)) return t("auth.network");
    if (!(err instanceof ApiError)) return t("forgot.invalid");
    if (err.status === 501) return t("forgot.unavailable");
    if (isGatewayError(err)) return t("auth.unavailable");
    if (err.status === 423 || err.status === 429) return t("forgot.locked");
    return t("forgot.invalid");
  }

  async function request(e?: { preventDefault(): void }) {
    e?.preventDefault();
    if (busy || cooldown > 0) return;
    setBusy(true);
    setError("");
    try {
      await api.forgotPassword(email.trim());
      setCode("");
      setJustSent(true);
      setStage("redeem");
      setCooldown(60);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  async function redeem(e: React.FormEvent) {
    e.preventDefault();
    const digits = code.replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6) { setError(t("forgot.invalid")); return; }
    if (password.length < 8) { setError(t("forgot.weak")); return; }
    setBusy(true);
    setError("");
    try {
      const res = await api.resetPassword(email.trim(), digits, password);
      setToken(res.token);
      onDone(res.user);
    } catch (err) {
      setError(describe(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-wrap">
      <LangToggle className="lang-toggle-corner" />
      <section className="auth-shell">
        <div className="auth-spacer" />
        <div className="auth-panel">
          <header className="auth-header"><h1>{PRODUCT_NAME}</h1></header>
          <div className="auth-content">
            <h2 className="verify-title">
              {stage === "request" ? t("forgot.title") : justSent ? t("forgot.sentTitle") : t("forgot.enterCodeTitle")}
            </h2>
            <p className="verify-sub">
              {stage === "request"
                ? t("forgot.sub")
                : justSent
                  ? t("forgot.sentSub").replace("{email}", email.trim())
                  : t("forgot.enterCodeSub").replace("{email}", email.trim())}
            </p>

            {stage === "request" ? (
              <form className="auth-form" onSubmit={request}>
                <div className="auth-field">
                  <label htmlFor="forgot-email">{t("forgot.emailLabel")}</label>
                  <div className="auth-input-wrap">
                    <input
                      id="forgot-email"
                      type="email"
                      data-testid="forgot-email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      autoComplete="username"
                      autoFocus
                      required
                    />
                  </div>
                </div>
                {error && <div className="auth-error" data-testid="forgot-error">{error}</div>}
                <button className="auth-continue-btn" type="submit" data-testid="forgot-send" disabled={busy}>
                  {busy ? t("forgot.sending") : t("forgot.send")}
                </button>

                <p className="verify-actions">
                  <button
                    type="button"
                    className="verify-link"
                    data-testid="forgot-have-code"
                    disabled={!email.trim()}
                    onClick={() => { setError(""); setStage("redeem"); }}
                  >
                    {t("forgot.haveCode")}
                  </button>
                </p>
              </form>
            ) : (
              <form className="auth-form" onSubmit={redeem}>
                <div className="auth-field">
                  <label htmlFor="forgot-code">{t("forgot.codeLabel")}</label>
                  <div className="auth-input-wrap">
                    <input
                      id="forgot-code"
                      ref={codeRef}
                      data-testid="forgot-code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={7}
                      className="verify-code-input"
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="••• •••"
                    />
                  </div>
                </div>
                <div className="auth-field">
                  <label htmlFor="forgot-password">{t("forgot.newPasswordLabel")}</label>
                  <div className="auth-input-wrap">
                    <input
                      id="forgot-password"
                      type="password"
                      data-testid="forgot-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      placeholder={t("forgot.newPasswordPlaceholder")}
                      maxLength={200}
                      required
                    />
                  </div>
                </div>
                {error && <div className="auth-error" data-testid="forgot-error">{error}</div>}
                <button className="auth-continue-btn" type="submit" data-testid="forgot-submit" disabled={busy}>
                  {busy ? t("forgot.submitting") : t("forgot.submit")}
                </button>
                <p className="verify-note">{t("forgot.signsOut")}</p>
              </form>
            )}

            <p className="verify-actions">
              {stage === "redeem" && (
                <>
                  <button type="button" className="verify-link" data-testid="forgot-resend" onClick={() => void request()} disabled={cooldown > 0 || busy}>
                    {cooldown > 0 ? t("forgot.resendIn").replace("{s}", String(cooldown)) : t("forgot.resend")}
                  </button>
                  <span className="verify-sep">·</span>
                </>
              )}
              <button type="button" className="verify-link" data-testid="forgot-back" onClick={() => onBack(email.trim())}>
                {t("forgot.backToLogin")}
              </button>
            </p>
            <p className="verify-note">{t("forgot.oauthNote")}</p>
          </div>
        </div>
        <div className="auth-spacer" />
      </section>
    </main>
  );
}
