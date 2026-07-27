import { useEffect, useRef, useState } from "react";
import { api, ApiError, isGatewayError, isNetworkError, setToken } from "../platform/api.ts";
import { useI18n } from "../i18n";
import { LangToggle } from "../ui/LangToggle.tsx";
import type { UserInfo } from "@shared/protocol";
import { PRODUCT_NAME } from "../platform/brand";

export function VerifyScreen({ email, onVerified, onUsePassword, onUseGithub, onUseAnotherEmail }: {
  email: string;
  onVerified: (user: UserInfo) => void;
  onUsePassword: () => void;
  onUseGithub: () => void;
  onUseAnotherEmail: () => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resent, setResent] = useState(false);
  const [cooldown, setCooldown] = useState(30);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => window.clearTimeout(id);
  }, [cooldown]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const digits = code.replace(/\D/g, "").slice(0, 6);
    if (digits.length !== 6) { setError(t("verify.invalid")); return; }
    setBusy(true);
    setError("");
    try {
      const res = await api.verifyCode(email, digits);
      setToken(res.token);
      onVerified(res.user);
    } catch (err) {
      if (isNetworkError(err)) setError(t("auth.network"));
      else if (isGatewayError(err)) setError(t("auth.unavailable"));
      else if (err instanceof ApiError && err.status === 423) setError(t("verify.locked"));
      else setError(t("verify.invalid"));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    if (cooldown > 0) return;
    setResent(false);
    setError("");
    try { await api.resendVerification(email); } catch {  }
    setResent(true);
    setCooldown(30);
  }

  return (
    <main className="auth-wrap">
      <LangToggle className="lang-toggle-corner" />
      <section className="auth-shell">
        <div className="auth-spacer" />
        <div className="auth-panel">
          <header className="auth-header"><h1>{PRODUCT_NAME}</h1></header>
          <div className="auth-content">
            <h2 className="verify-title">{t("verify.title")}</h2>
            <p className="verify-sub">{t("verify.sub").replace("{email}", email)}</p>
            <form className="auth-form" onSubmit={submit}>
              <div className="auth-field">
                <label htmlFor="verify-code">{t("verify.codeLabel")}</label>
                <div className="auth-input-wrap">
                  <input
                    id="verify-code"
                    ref={inputRef}
                    data-testid="verify-code"
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
              {error && <div className="auth-error" data-testid="verify-error">{error}</div>}
              <button className="auth-continue-btn" type="submit" data-testid="verify-submit" disabled={busy}>
                {busy ? t("verify.verifying") : t("verify.button")}
              </button>
            </form>
            <p className="verify-actions">
              {resent && <span className="verify-resent">{t("verify.resent")} </span>}
              <button type="button" className="verify-link" onClick={resend} disabled={cooldown > 0}>
                {cooldown > 0 ? t("verify.resendIn").replace("{s}", String(cooldown)) : t("verify.resend")}
              </button>
              <span className="verify-sep">·</span>
              <button type="button" className="verify-link" onClick={onUseAnotherEmail}>{t("verify.wrongEmail")}</button>
            </p>
            <p className="verify-note">{t("verify.slowNote")}</p>
            <div className="verify-existing">
              <span>{t("verify.haveAccount")}</span>
              <div className="verify-existing-actions">
                <button type="button" className="verify-link" data-testid="verify-use-password" onClick={onUsePassword}>
                  {t("verify.usePassword")}
                </button>
                <span className="verify-sep">·</span>
                <button type="button" className="verify-link" data-testid="verify-use-github" onClick={onUseGithub}>
                  {t("verify.useGithub")}
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="auth-spacer" />
      </section>
    </main>
  );
}
