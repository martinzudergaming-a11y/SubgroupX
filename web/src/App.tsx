import { lazy, Suspense, useEffect, useState } from "react";
import { api, ApiError, getToken, setToken } from "./platform/api.ts";
import { Login } from "./auth/Login.tsx";
import { Landing } from "./auth/Landing.tsx";
import { parseBlogRoute } from "./platform/blog-route";
import { VerifyScreen } from "./auth/VerifyScreen.tsx";
import { ForgotPassword } from "./auth/ForgotPassword.tsx";
import { Suspended } from "./auth/Suspended.tsx";
import DashboardApp from "./dashboard/App.tsx";
import type { UserInfo } from "@shared/protocol";
import { safeSet } from "./platform/storage";
import { PRODUCT_NAME } from "./platform/brand";
import { navigate, usePathname, Redirect } from "./platform/router";

type AuthMode = "login" | "signup";

function readRedirect() {
  const params = new URLSearchParams(window.location.search);
  return {
    token: params.get("gh_token") || params.get("auth_token"),
    authError: params.get("auth_error") ?? "",
    pwSetup: params.get("pw_setup"),
    pwError: params.get("pw_error") ?? "",
    banned: params.get("banned") === "1",
  };
}

const PW_SETUP_KEY = "oiia.pwsetup";
const PW_ERROR_KEY = "oiia.pwerror";

const StandaloneBlog = lazy(() => import("@internal-blog-view").then(({ BlogView }) => ({ default: BlogView })));

export function App() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [banned, setBanned] = useState<{ reason: string | null } | null>(null);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [authEmailHint, setAuthEmailHint] = useState("");
  const pathname = usePathname();
  const [redirect] = useState(readRedirect);
  const [authError] = useState<string>(redirect.authError);
  const [loading, setLoading] = useState(() => Boolean(redirect.token) || Boolean(getToken()));

  useEffect(() => {
    if (redirect.token) setToken(redirect.token);
    if (redirect.pwSetup) safeSet(PW_SETUP_KEY, redirect.pwSetup, "session");
    if (redirect.pwError) safeSet(PW_ERROR_KEY, redirect.pwError, "session");
    if (redirect.banned) setBanned({ reason: null });
    if (redirect.token || redirect.authError || redirect.pwSetup || redirect.pwError || redirect.banned) {
      const params = new URLSearchParams(window.location.search);
      for (const k of ["gh_token", "auth_token", "verified", "verify_error", "auth_error", "pw_setup", "pw_error", "banned"]) params.delete(k);
      const qs = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (qs ? `?${qs}` : ""));
    }

    if (redirect.banned || !getToken()) {
      setLoading(false);
      return;
    }
    api
      .me()
      .then((r) => {
        if (r.user.emailVerificationPending) setPendingEmail(r.user.email);
        else setUser(r.user);
      })
      .catch((err) => {
        if (err instanceof ApiError && err.banned) setBanned({ reason: err.reason });
        else setToken(null);
      })
      .finally(() => setLoading(false));
  }, [redirect]);

  function enterApp(u: UserInfo) {
    setPendingEmail(null);
    setAuthEmailHint("");
    setUser(u);
    if (window.location.pathname.startsWith("/auth")) navigate("/", { replace: true });
  }

  if (loading) return <div className="app-boot"><span className="oiia-loader">{PRODUCT_NAME}</span></div>;
  if (banned) return <Suspended reason={banned.reason} />;

  const blogRoute = user ? parseBlogRoute(pathname) : null;
  if (blogRoute) {
    return (
      <Suspense fallback={<div className="app-boot"><span className="oiia-loader">{PRODUCT_NAME}</span></div>}>
        <StandaloneBlog slug={blogRoute.slug} backHref="/" />
      </Suspense>
    );
  }
  if (pathname === "/about") {
    return <Landing signedIn={Boolean(user)} onAuth={(mode) => navigate(`/auth/${mode}`)} onEnterApp={() => navigate("/")} />;
  }

  if (pendingEmail) {
    if (pathname !== "/auth/verify") return <Redirect to="/auth/verify" />;
    return (
      <VerifyScreen
        email={pendingEmail}
        onVerified={enterApp}
        onUsePassword={() => {
          setAuthEmailHint(pendingEmail);
          setPendingEmail(null);
          navigate("/auth/login", { replace: true });
        }}
        onUseGithub={() => { window.location.href = "/api/auth/github"; }}
        onUseAnotherEmail={() => {
          setAuthEmailHint("");
          setPendingEmail(null);
          navigate("/auth/signup", { replace: true });
        }}
      />
    );
  }
  if (user) {
    if (pathname.startsWith("/auth")) return <Redirect to="/" />;
    return <DashboardApp user={user} onSuspended={() => setBanned({ reason: null })} />;
  }
  if (authError && !pathname.startsWith("/auth/")) return <Redirect to="/auth/login" />;
  if (pathname === "/auth/login" || pathname === "/auth/signup") {
    const mode: AuthMode = pathname === "/auth/signup" ? "signup" : "login";
    return (
      <Login
        initialMode={mode}
        initialEmail={authEmailHint}
        onAuthed={enterApp}
        onPending={(email) => { setAuthEmailHint(email); setPendingEmail(email); }}
        onBanned={(reason) => setBanned({ reason })}
        onForgot={(email) => { setAuthEmailHint(email); navigate("/auth/forgot"); }}
        initialError={authError}
      />
    );
  }
  if (pathname === "/auth/forgot") {
    return (
      <ForgotPassword
        initialEmail={authEmailHint}
        onDone={enterApp}
        onBack={(email) => { setAuthEmailHint(email); navigate("/auth/login", { replace: true }); }}
      />
    );
  }
  if (pathname === "/auth/verify") return <Redirect to="/auth/login" />;
  return <Landing onAuth={(mode) => navigate(`/auth/${mode}`)} />;
}
