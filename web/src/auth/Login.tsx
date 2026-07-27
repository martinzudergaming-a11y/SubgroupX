import { useEffect, useReducer } from "react";
import { api, ApiError, isGatewayError, isNetworkError, setToken } from "../platform/api.ts";
import { useI18n } from "../i18n";
import { LangToggle } from "../ui/LangToggle.tsx";
import type { UserInfo } from "@shared/protocol";
import { navigate } from "../platform/router";

type AuthMode = "login" | "signup";

type AuthState = {
  mode: AuthMode;
  email: string;
  password: string;
  error: string;
  busy: boolean;
};

type AuthAction =
  | { type: "setEmail"; value: string }
  | { type: "setPassword"; value: string }
  | { type: "setMode"; value: AuthMode }
  | { type: "setError"; value: string }
  | { type: "submitStart" }
  | { type: "submitDone" };

function authReducer(state: AuthState, action: AuthAction): AuthState {
  switch (action.type) {
    case "setEmail":
      return { ...state, email: action.value };
    case "setPassword":
      return { ...state, password: action.value };
    case "setMode":
      if (state.mode === action.value) return state;
      return { ...state, mode: action.value, error: "" };
    case "setError":
      return { ...state, error: action.value };
    case "submitStart":
      return { ...state, error: "", busy: true };
    case "submitDone":
      return { ...state, busy: false };
    default:
      return state;
  }
}

function GoogleIcon() {
  return (
    <svg viewBox="0.99 0.99 18.01 18.01" className="auth-provider-icon" aria-hidden="true">
      <g clipPath="url(#googleClip)">
        <path fill="#4285F4" d="M18.64 10.205q-.002-.958-.164-1.841H10v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615" />
        <path fill="#34A853" d="M10 19c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H1.957v2.332A9 9 0 0 0 10 19" />
        <path fill="#FBBC04" d="M4.964 11.71A5.4 5.4 0 0 1 4.682 10c0-.593.102-1.17.282-1.71V5.958H1.957A9 9 0 0 0 1 10c0 1.452.348 2.827.957 4.042z" />
        <path fill="#E94235" d="M10 4.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C14.463 1.891 12.426.999 10 .999a9 9 0 0 0-8.043 4.958L4.964 8.29C5.672 6.163 7.656 4.58 10 4.58" />
      </g>
      <defs>
        <clipPath id="googleClip">
          <path fill="#fff" d="M1 1h18v18H1z" />
        </clipPath>
      </defs>
    </svg>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="2.67 0.99 14.65 18.01" className="auth-provider-icon" aria-hidden="true">
      <path d="M13.294 5.348q.192 0 .592.045.41.036.927.2.52.164 1.055.528.537.363.992 1.018-.046.028-.346.246a5 5 0 0 0-.664.637 3.9 3.9 0 0 0-.655 1.046q-.272.627-.273 1.5 0 1.001.346 1.692.355.692.819 1.119.473.427.837.628.373.19.4.2-.01.036-.137.409-.127.364-.4.946a8.4 8.4 0 0 1-.691 1.2q-.39.555-.81 1.065-.409.51-.9.827a1.9 1.9 0 0 1-1.092.328 2.5 2.5 0 0 1-.79-.11 5 5 0 0 1-.628-.254 5 5 0 0 0-.646-.246 3 3 0 0 0-.883-.109q-.69 0-1.155.182-.454.192-.864.373a2.4 2.4 0 0 1-.964.182q-.846 0-1.491-.673a16 16 0 0 1-1.31-1.61q-.519-.745-.946-1.719a12 12 0 0 1-.682-2.065 9.6 9.6 0 0 1-.255-2.183q0-1.746.664-2.937.665-1.192 1.7-1.801 1.037-.61 2.156-.61.592 0 1.11.191.528.192.982.391.456.192.828.191.355 0 .837-.2.482-.21 1.064-.418a3.8 3.8 0 0 1 1.273-.21m-.636-1.474q-.455.555-1.146.919-.683.364-1.292.364-.128 0-.245-.028l-.028-.127a2 2 0 0 1-.009-.2q0-.691.3-1.346t.692-1.092q.482-.573 1.218-.955.747-.38 1.428-.409.028.154.028.355 0 .7-.264 1.364a4.3 4.3 0 0 1-.682 1.155" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg viewBox="0 0 24 24" className="auth-provider-icon" aria-hidden="true">
      <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z" />
    </svg>
  );
}

export function Login({
  onAuthed,
  onBanned,
  onPending,
  initialMode,
  initialError,
  initialEmail,
  onForgot,
}: {
  onAuthed: (user: UserInfo) => void;
  onBanned?: (reason: string | null) => void;
  onPending?: (email: string) => void;
  initialMode?: AuthMode;
  initialError?: string;
  initialEmail?: string;
  onForgot?: (email: string) => void;
}) {
  const { t } = useI18n();
  const [state, dispatch] = useReducer(authReducer, undefined, () => ({
    mode: (initialMode ?? "login") as AuthMode,
    email: initialEmail ?? "",
    password: "",
    error:
      initialError === "github_not_configured"
        ? t("auth.githubNotConfigured")
        : initialError === "google_not_configured"
        ? t("auth.googleNotConfigured")
        : initialError === "google_failed"
        ? t("auth.googleFailed")
        : initialError === "github_failed"
          ? t("auth.githubFailed")
          : "",
    busy: false,
  }));

  useEffect(() => {
    if (initialMode) dispatch({ type: "setMode", value: initialMode });
  }, [initialMode]);
  const { mode, email, password, error, busy } = state;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    dispatch({ type: "submitStart" });
    try {
      const res = mode === "login" ? await api.login(email, password) : await api.signup(email, password);
      if (res.state === "PENDING_VERIFY") {
        if (onPending) onPending(res.pendingEmail);
        return;
      }
      setToken(res.token);
      onAuthed(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.banned && onBanned) {
        onBanned(err.reason);
        return;
      }
      dispatch({
        type: "setError",
        value: isNetworkError(err)
          ? t("auth.network")
          : isGatewayError(err)
            ? t("auth.unavailable")
            : err instanceof Error ? err.message : t("auth.failed"),
      });
    } finally {
      dispatch({ type: "submitDone" });
    }
  }

  return (
    <>
      <a className="auth-skip-link" href="#auth-main">
        {t("auth.skip")}
      </a>
      <main id="auth-main" className="auth-wrap">
        <LangToggle className="lang-toggle-corner" />
        <section className="auth-shell">
          <div className="auth-spacer" />
          <div className="auth-panel">
            <header className="auth-header">
              <h1>oiia</h1>
              <h2>
                {t("auth.taglineLine1")}
                <br />
                {t("auth.taglineLine2")}
              </h2>
            </header>

            <div className="auth-content">
              <div className="auth-provider-list">
                {[
                  { label: "Google", Icon: GoogleIcon, onClick: () => { window.location.href = "/api/auth/google"; } },
                  { label: "Apple", Icon: AppleIcon, onClick: () => dispatch({ type: "setError", value: t("auth.ssoNotConfigured") }) },
                  { label: "GitHub", Icon: GithubIcon, onClick: () => { window.location.href = "/api/auth/github"; } },
                ].map(({ label, Icon, onClick }) => (
                  <button key={label} type="button" className="auth-provider-btn" onClick={onClick}>
                    <Icon />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <div className="auth-divider" aria-hidden="true">
                <span />
              </div>

              <form className="auth-form" onSubmit={submit}>
                <div className="auth-field">
                  <label htmlFor="auth-email">{t("auth.emailLabel")}</label>
                  <div className="auth-input-wrap">
                    <input
                      id="auth-email"
                      type="email"
                      data-testid="email"
                      value={email}
                      onChange={(e) => dispatch({ type: "setEmail", value: e.target.value })}
                      autoComplete="username"
                      placeholder={t("auth.emailPlaceholder")}
                      required
                    />
                  </div>
                </div>

                <div className="auth-field">
                  <div className="auth-field-head">
                    <label htmlFor="auth-password">{t("auth.passwordLabel")}</label>

                    {mode === "login" && onForgot && (
                      <button type="button" className="auth-field-action" data-testid="forgot-link" onClick={() => onForgot(email)}>
                        {t("forgot.link")}
                      </button>
                    )}
                  </div>
                  <div className="auth-input-wrap">
                    <input
                      id="auth-password"
                      type="password"
                      data-testid="password"
                      value={password}
                      onChange={(e) => dispatch({ type: "setPassword", value: e.target.value })}
                      autoComplete={mode === "login" ? "current-password" : "new-password"}
                      placeholder={mode === "login" ? t("auth.passwordPlaceholderLogin") : t("auth.passwordPlaceholderSignup")}
                      required
                    />
                  </div>
                </div>

                {error && (
                  <div className="auth-error" data-testid="auth-error">
                    {error}
                  </div>
                )}

                <button className="auth-continue-btn" type="submit" data-testid="auth-submit" disabled={busy}>
                  {busy ? "..." : t("auth.continue")}
                </button>
              </form>

              <p className="auth-switch">
                {mode === "signup" ? (
                  <>
                    {t("auth.haveAccount")}{" "}
                    <button
                      type="button"
                      data-testid="toggle-mode"
                      onClick={() => { dispatch({ type: "setMode", value: "login" }); navigate("/auth/login"); }}
                    >
                      {t("auth.logIn")}
                    </button>
                  </>
                ) : (
                  <>
                    {t("auth.newUser")}{" "}
                    <button
                      type="button"
                      data-testid="toggle-mode"
                      onClick={() => { dispatch({ type: "setMode", value: "signup" }); navigate("/auth/signup"); }}
                    >
                      {t("auth.signUp")}
                    </button>
                  </>
                )}
              </p>

              <p className="auth-legal">
                by {mode === "signup" ? "signing up" : "continuing"}, you acknowledge that you understand and agree to
                the <span className="auth-legal-doc">terms &amp; conditions</span> and{" "}
                <span className="auth-legal-doc">privacy policy</span>
              </p>
            </div>
          </div>
          <div className="auth-spacer" />
        </section>
      </main>
    </>
  );
}
