export type InstallState = "installed" | "prompt" | "ios" | "desktop-safari" | "manual";

export interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export interface InstallEnvironment {
  standalone: boolean;
  hasPrompt: boolean;
  userAgent: string;
  maxTouchPoints: number;
}

export function isAppleTouchDevice(env: InstallEnvironment): boolean {
  if (/iPhone|iPod/i.test(env.userAgent)) return true;
  if (/iPad/i.test(env.userAgent)) return true;
  return /Macintosh/i.test(env.userAgent) && env.maxTouchPoints > 1;
}

function isSafari(userAgent: string): boolean {
  return /Safari/i.test(userAgent) && !/Chrome|Chromium|Edg\/|OPR\/|SamsungBrowser/i.test(userAgent);
}

export function installState(env: InstallEnvironment): InstallState {
  if (env.standalone) return "installed";
  if (env.hasPrompt) return "prompt";
  if (isAppleTouchDevice(env)) return "ios";
  if (isSafari(env.userAgent)) return "desktop-safari";
  return "manual";
}

let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

export function watchInstallPrompt(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    for (const notify of listeners) notify();
  });
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null;
    for (const notify of listeners) notify();
  });
}

export function hasInstallPrompt(): boolean {
  return deferredPrompt !== null;
}

export function subscribeInstallPrompt(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => listeners.delete(onChange);
}

export async function runInstallPrompt(): Promise<boolean> {
  const event = deferredPrompt;
  if (!event) return false;
  deferredPrompt = null;
  for (const notify of listeners) notify();
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    return outcome === "accepted";
  } catch {
    return false;
  }
}

export function currentInstallEnvironment(): InstallEnvironment {
  if (typeof window === "undefined") {
    return { standalone: false, hasPrompt: false, userAgent: "", maxTouchPoints: 0 };
  }
  return {
    standalone:
      window.matchMedia?.("(display-mode: standalone)").matches === true
      || (window.navigator as { standalone?: boolean }).standalone === true,
    hasPrompt: hasInstallPrompt(),
    userAgent: window.navigator.userAgent,
    maxTouchPoints: window.navigator.maxTouchPoints ?? 0,
  };
}
