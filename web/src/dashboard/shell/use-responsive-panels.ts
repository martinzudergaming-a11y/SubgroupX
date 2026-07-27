import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from "react";

export const MOBILE_QUERY = "(max-width: 767px)";
export const NARROW_QUERY = "(min-width: 768px) and (max-width: 1149px)";
export const PANEL_LAYOUT_SETTLE_MS = 120;

export type ShellLayout = "mobile" | "narrow" | "wide";

export interface PanelPreferences {
  desktopLeftOpen: boolean;
  mobileLeftOpen: boolean;
  rightOpen: Readonly<Record<ShellLayout, boolean>>;
}

export const INITIAL_PANEL_PREFERENCES: PanelPreferences = {
  desktopLeftOpen: true,
  mobileLeftOpen: false,
  rightOpen: { mobile: false, narrow: false, wide: false },
};

export function shellLayoutFor(mobile: boolean, narrow: boolean): ShellLayout {
  if (mobile) return "mobile";
  return narrow ? "narrow" : "wide";
}

export function panelVisibility(preferences: PanelPreferences, layout: ShellLayout) {
  return {
    leftOpen: layout === "mobile" ? preferences.mobileLeftOpen : preferences.desktopLeftOpen,
    rightOpen: preferences.rightOpen[layout],
  };
}

export function updatePanelPreference(
  preferences: PanelPreferences,
  layout: ShellLayout,
  panel: "left" | "right",
  update: SetStateAction<boolean>,
): PanelPreferences {
  const current = panel === "left"
    ? (layout === "mobile" ? preferences.mobileLeftOpen : preferences.desktopLeftOpen)
    : preferences.rightOpen[layout];
  const next = typeof update === "function" ? update(current) : update;
  if (next === current) return preferences;

  if (panel === "right") {
    return { ...preferences, rightOpen: { ...preferences.rightOpen, [layout]: next } };
  }
  return layout === "mobile"
    ? { ...preferences, mobileLeftOpen: next }
    : { ...preferences, desktopLeftOpen: next };
}

function currentShellLayout(): ShellLayout {
  if (typeof window === "undefined") return "wide";
  return shellLayoutFor(
    window.matchMedia(MOBILE_QUERY).matches,
    window.matchMedia(NARROW_QUERY).matches,
  );
}

export function useResponsivePanels(): {
  isMobile: boolean;
  isNarrow: boolean;
  isLeftSidebarOpen: boolean;
  isRightSidebarOpen: boolean;
  setIsLeftSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setIsRightSidebarOpen: Dispatch<SetStateAction<boolean>>;
} {
  const [layout, setLayout] = useState<ShellLayout>(currentShellLayout);
  const [preferences, setPreferences] = useState<PanelPreferences>(INITIAL_PANEL_PREFERENCES);

  useEffect(() => {
    const mobile = window.matchMedia(MOBILE_QUERY);
    const narrow = window.matchMedia(NARROW_QUERY);
    let settleTimer: number | null = null;
    const sync = () => {
      const next = shellLayoutFor(mobile.matches, narrow.matches);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        setLayout(next);
      }, PANEL_LAYOUT_SETTLE_MS);
    };
    mobile.addEventListener("change", sync);
    narrow.addEventListener("change", sync);
    sync();
    return () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      mobile.removeEventListener("change", sync);
      narrow.removeEventListener("change", sync);
    };
  }, []);

  const setIsLeftSidebarOpen = useCallback<Dispatch<SetStateAction<boolean>>>((update) => {
    setPreferences((current) => updatePanelPreference(current, layout, "left", update));
  }, [layout]);
  const setIsRightSidebarOpen = useCallback<Dispatch<SetStateAction<boolean>>>((update) => {
    setPreferences((current) => updatePanelPreference(current, layout, "right", update));
  }, [layout]);
  const visibility = panelVisibility(preferences, layout);

  return {
    isMobile: layout === "mobile",
    isNarrow: layout === "narrow",
    isLeftSidebarOpen: visibility.leftOpen,
    isRightSidebarOpen: visibility.rightOpen,
    setIsLeftSidebarOpen,
    setIsRightSidebarOpen,
  };
}
