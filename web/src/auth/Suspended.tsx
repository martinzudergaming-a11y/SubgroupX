import { useI18n } from "../i18n";
import { LangToggle } from "../ui/LangToggle.tsx";

export function Suspended({ reason }: { reason?: string | null }) {
  const { t } = useI18n();
  return (
    <main className="auth-wrap">
      <LangToggle className="lang-toggle-corner" />
      <section className="auth-shell">
        <div className="auth-spacer" />
        <div className="auth-panel">
          <header className="auth-header">
            <h1>oiia</h1>
          </header>

          <div className="auth-content">
            <div className="suspended-card" role="alert" data-testid="suspended">
              <div className="suspended-badge" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <line x1="12" y1="8" x2="12" y2="13" />
                  <line x1="12" y1="16.5" x2="12" y2="16.5" />
                </svg>
              </div>
              <h2 className="suspended-title">{t("suspended.title")}</h2>
              <p className="suspended-body">{t("suspended.body")}</p>
              {reason ? (
                <div className="suspended-reason">
                  <span className="suspended-reason-label">{t("suspended.reasonLabel")}</span>
                  <span className="suspended-reason-text">{reason}</span>
                </div>
              ) : null}
              <p className="suspended-contact">
                <a href="/support" target="_blank" rel="noreferrer">{t("suspended.contact")}</a>
              </p>
            </div>
          </div>
        </div>
        <div className="auth-spacer" />
      </section>
    </main>
  );
}
