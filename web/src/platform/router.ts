import { createElement, useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

const NAV_EVENT = "app:navigate";

export function navigate(to: string, opts?: { replace?: boolean }): void {
  if (typeof window === "undefined") return;
  if (window.location.pathname === to && !opts?.replace) return;
  window.history[opts?.replace ? "replaceState" : "pushState"]({}, "", to);
  window.dispatchEvent(new Event(NAV_EVENT));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAV_EVENT, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAV_EVENT, onChange);
  };
}

const getPathname = () => window.location.pathname;

export function usePathname(): string {
  return useSyncExternalStore(subscribe, getPathname, () => "/");
}

export function Redirect({ to }: { to: string }): null {
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}

export function Link({
  to,
  replace,
  onNavigate,
  children,
  ...rest
}: {
  to: string;
  replace?: boolean;
  onNavigate?: () => void;
  children?: ReactNode;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const onClick = (e: ReactMouseEvent<HTMLAnchorElement>) => {
    rest.onClick?.(e);
    if (e.defaultPrevented) return;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, { replace });
    onNavigate?.();
  };
  return createElement("a", { ...rest, href: to, onClick }, children);
}
