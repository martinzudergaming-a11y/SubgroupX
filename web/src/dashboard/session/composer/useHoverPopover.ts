import { useCallback, useEffect, useId, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";

export type ComposerPopoverGroup = "composer-footer" | "composer-overflow";
type OpenReason = "hover" | "press";

const OPEN_EVENT = "oiia:composer-popover-open";
const CLOSE_GROUP_EVENT = "oiia:composer-popover-close-group";

type GroupDetail = { group: ComposerPopoverGroup; id?: string };

type Point = { x: number; y: number };
type RectLike = Pick<DOMRect, "top" | "right" | "bottom" | "left" | "width" | "height">;
type SafeTriangle = readonly [Point, Point, Point];

const SAFE_TRIANGLE_TIMEOUT_MS = 650;
const SAFE_TRIANGLE_PADDING_PX = 6;
const SAFE_TRIANGLE_DIRECTION_SLOP_PX = 6;

const HOVER_OPEN_DELAY_MS = 130;
const GROUP_WARM_WINDOW_MS = 250;
const HOVER_CLOSE_GRACE_MS = 150;
const AIM_DEFER_MS = 220;
const WARM_OBSERVE_MS = 80;
const TRAIL_WINDOW_MS = 160;

const openByGroup = new Map<ComposerPopoverGroup, Set<string>>();
const pinnedByGroup = new Map<ComposerPopoverGroup, Set<string>>();
const lastOpenAt = new Map<ComposerPopoverGroup, number>();
const openRootByGroup = new Map<ComposerPopoverGroup, { id: string; root: HTMLElement | null }>();

let trail: Point[] = [];
let trailAt: number[] = [];
let trailListener: ((event: PointerEvent) => void) | null = null;
function syncTrailListener() {
  let anyOpen = false;
  for (const set of openByGroup.values()) if (set.size > 0) { anyOpen = true; break; }
  if (anyOpen && !trailListener) {
    trailListener = (event) => {
      const now = performance.now();
      trail.push({ x: event.clientX, y: event.clientY });
      trailAt.push(now);
      while (trailAt.length && now - trailAt[0] > TRAIL_WINDOW_MS) { trail.shift(); trailAt.shift(); }
    };
    document.addEventListener("pointermove", trailListener, { capture: true, passive: true });
  } else if (!anyOpen && trailListener) {
    document.removeEventListener("pointermove", trailListener, true);
    trailListener = null;
    trail = [];
    trailAt = [];
  }
}

function markOpen(group: ComposerPopoverGroup, id: string, open: boolean, pinned: boolean, root: HTMLElement | null) {
  let set = openByGroup.get(group);
  if (!set) { set = new Set(); openByGroup.set(group, set); }
  let pinnedSet = pinnedByGroup.get(group);
  if (!pinnedSet) { pinnedSet = new Set(); pinnedByGroup.set(group, pinnedSet); }
  if (open) set.add(id);
  else set.delete(id);
  if (open && pinned) pinnedSet.add(id);
  else pinnedSet.delete(id);
  if (open) openRootByGroup.set(group, { id, root });
  else if (openRootByGroup.get(group)?.id === id) openRootByGroup.delete(group);
  lastOpenAt.set(group, performance.now());
  syncTrailListener();
}

function aimingAtOpenPeer(group: ComposerPopoverGroup, selfId: string, point: Point | null) {
  if (!point) return false;
  const peer = openRootByGroup.get(group);
  if (!peer || peer.id === selfId) return false;
  const surface = directPopoverSurface(peer.root);
  if (!surface || trail.length === 0) return false;
  const origin = trail[0];
  if (Math.hypot(point.x - origin.x, point.y - origin.y) < 2) return false;
  return pointInTriangle(point, safeTriangleForExit(origin, surface.getBoundingClientRect()));
}
function groupIsWarm(group: ComposerPopoverGroup) {
  if ((openByGroup.get(group)?.size ?? 0) > 0) return true;
  const at = lastOpenAt.get(group);
  return at != null && performance.now() - at < GROUP_WARM_WINDOW_MS;
}
function groupHasPinnedPeer(group: ComposerPopoverGroup, selfId: string) {
  const pinnedSet = pinnedByGroup.get(group);
  if (!pinnedSet) return false;
  for (const pinnedId of pinnedSet) if (pinnedId !== selfId) return true;
  return false;
}

function directPopoverSurface(root: HTMLElement | null) {
  if (!root) return null;
  return Array.from(root.children).find((child): child is HTMLElement => {
    if (!(child instanceof HTMLElement)) return false;
    const role = child.getAttribute("role");
    return role === "menu" || role === "dialog";
  }) ?? null;
}

export function safeTriangleForExit(exit: Point, rect: RectLike, padding = SAFE_TRIANGLE_PADDING_PX): SafeTriangle {
  if (exit.y >= rect.bottom) {
    return [
      { x: exit.x, y: exit.y + padding },
      { x: rect.left - padding, y: rect.bottom - padding },
      { x: rect.right + padding, y: rect.bottom - padding },
    ];
  }
  if (exit.y <= rect.top) {
    return [
      { x: exit.x, y: exit.y - padding },
      { x: rect.left - padding, y: rect.top + padding },
      { x: rect.right + padding, y: rect.top + padding },
    ];
  }
  if (exit.x >= rect.right) {
    return [
      { x: exit.x + padding, y: exit.y },
      { x: rect.right - padding, y: rect.top - padding },
      { x: rect.right - padding, y: rect.bottom + padding },
    ];
  }
  return [
    { x: exit.x - padding, y: exit.y },
    { x: rect.left + padding, y: rect.top - padding },
    { x: rect.left + padding, y: rect.bottom + padding },
  ];
}

function signedTriangleArea(point: Point, a: Point, b: Point) {
  return (point.x - b.x) * (a.y - b.y) - (a.x - b.x) * (point.y - b.y);
}

export function pointInTriangle(point: Point, [a, b, c]: SafeTriangle) {
  const d1 = signedTriangleArea(point, a, b);
  const d2 = signedTriangleArea(point, b, c);
  const d3 = signedTriangleArea(point, c, a);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

function distanceToRect(point: Point, rect: RectLike) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

function canHover() {
  return typeof window !== "undefined"
    && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export function closeComposerPopoverGroup(group: ComposerPopoverGroup) {
  if (typeof document === "undefined") return;
  document.dispatchEvent(new CustomEvent<GroupDetail>(CLOSE_GROUP_EVENT, { detail: { group } }));
}

export function useComposerPopover({ group = "composer-footer" }: { group?: ComposerPopoverGroup } = {}) {
  const id = useId();
  const [open, setOpenState] = useState(false);
  const [pinned, setPinnedState] = useState(false);
  const [openReason, setOpenReason] = useState<OpenReason>("hover");
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aimMonitor = useRef<((event: PointerEvent) => void) | null>(null);
  const safePointerMove = useRef<((event: PointerEvent) => void) | null>(null);
  const openRef = useRef(false);
  const pinnedRef = useRef(false);

  const setOpen = useCallback((value: boolean, nextPinned = false) => {
    if (openRef.current !== value || pinnedRef.current !== (value && nextPinned)) {
      markOpen(group, id, value, value && nextPinned, rootRef.current);
    }
    openRef.current = value;
    pinnedRef.current = value && nextPinned;
    setOpenState(value);
    setPinnedState(value && nextPinned);
  }, [group, id]);

  const cancelPendingOpen = useCallback(() => {
    if (openTimer.current) {
      clearTimeout(openTimer.current);
      openTimer.current = null;
    }
    if (aimMonitor.current) {
      document.removeEventListener("pointermove", aimMonitor.current, true);
      aimMonitor.current = null;
    }
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    if (graceTimer.current) {
      clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
    if (safePointerMove.current) {
      document.removeEventListener("pointermove", safePointerMove.current, true);
      safePointerMove.current = null;
    }
  }, []);

  const announceOpen = useCallback(() => {
    document.dispatchEvent(new CustomEvent<GroupDetail>(OPEN_EVENT, { detail: { group, id } }));
  }, [group, id]);

  const close = useCallback(({ restoreFocus = false }: { restoreFocus?: boolean } = {}) => {
    cancelPendingOpen();
    cancelClose();
    setOpen(false);
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  }, [cancelClose, cancelPendingOpen, setOpen]);

  const openFromHover = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    if (!canHover()) return false;
    cancelClose();
    if (openRef.current) return true;
    if (groupHasPinnedPeer(group, id)) return false;
    const openNow = () => {
      openTimer.current = null;
      cancelPendingOpen();
      announceOpen();
      setOpenReason("hover");
      setOpen(true, false);
    };
    const peer = openRootByGroup.get(group);
    if (peer && peer.id !== id) {
      cancelPendingOpen();
      const point = event ? { x: event.clientX, y: event.clientY } : null;
      const arm = (delay: number) => {
        if (openTimer.current) clearTimeout(openTimer.current);
        openTimer.current = setTimeout(openNow, delay);
      };
      arm(aimingAtOpenPeer(group, id, point) ? AIM_DEFER_MS : WARM_OBSERVE_MS);
      const root = rootRef.current;
      const onAimMove = (moveEvent: PointerEvent) => {
        if (!openTimer.current) return;
        const target = moveEvent.target;
        if (!(target instanceof Node) || !root || !root.contains(target)) return;
        if (aimingAtOpenPeer(group, id, { x: moveEvent.clientX, y: moveEvent.clientY })) arm(AIM_DEFER_MS);
      };
      aimMonitor.current = onAimMove;
      document.addEventListener("pointermove", onAimMove, true);
      return true;
    }
    if (groupIsWarm(group)) {
      cancelPendingOpen();
      openNow();
    } else if (!openTimer.current) {
      openTimer.current = setTimeout(openNow, HOVER_OPEN_DELAY_MS);
    }
    return true;
  }, [announceOpen, cancelClose, cancelPendingOpen, group, id, setOpen]);

  const togglePinned = useCallback(({ autoFocus = false }: { autoFocus?: boolean } = {}) => {
    cancelPendingOpen();
    cancelClose();
    if (openRef.current && pinnedRef.current) {
      close();
      return;
    }
    announceOpen();
    setOpenReason(autoFocus ? "press" : "hover");
    setOpen(true, true);
  }, [announceOpen, cancelClose, cancelPendingOpen, close, setOpen]);

  const scheduleClose = useCallback((event?: ReactMouseEvent<HTMLElement>) => {
    if (!canHover()) return;
    cancelPendingOpen();
    if (pinnedRef.current || !openRef.current) return;
    const root = rootRef.current;
    if (event?.relatedTarget instanceof Node && root?.contains(event.relatedTarget)) return;
    cancelClose();

    const menu = directPopoverSurface(root);
    if (!menu) {
      setOpen(false);
      return;
    }

    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const exit = event
      ? { x: event.clientX, y: event.clientY }
      : {
          x: triggerRect ? triggerRect.left + triggerRect.width / 2 : 0,
          y: triggerRect ? triggerRect.top + triggerRect.height / 2 : 0,
        };
    let lastDistance = distanceToRect(exit, menu.getBoundingClientRect());
    let retreat = 0;
    const closeHoverPreview = () => {
      cancelClose();
      setOpen(false);
    };
    const startGrace = () => {
      if (!graceTimer.current) graceTimer.current = setTimeout(closeHoverPreview, HOVER_CLOSE_GRACE_MS);
    };
    const cancelGrace = () => {
      if (graceTimer.current) {
        clearTimeout(graceTimer.current);
        graceTimer.current = null;
      }
    };

    const onPointerMove = (pointerEvent: PointerEvent) => {
      const target = pointerEvent.target;
      if (target instanceof Node && root?.contains(target)) {
        cancelClose();
        return;
      }

      const point = { x: pointerEvent.clientX, y: pointerEvent.clientY };
      const menuRect = menu.getBoundingClientRect();
      const distance = distanceToRect(point, menuRect);
      const stillAiming = pointInTriangle(point, safeTriangleForExit(exit, menuRect));
      retreat = distance > lastDistance ? retreat + (distance - lastDistance) : 0;
      const movingTowardMenu =
        distance <= lastDistance + SAFE_TRIANGLE_DIRECTION_SLOP_PX && retreat <= SAFE_TRIANGLE_DIRECTION_SLOP_PX * 2;
      lastDistance = distance;
      if (!stillAiming || !movingTowardMenu) {
        startGrace();
      } else {
        cancelGrace();
        if (closeTimer.current) clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(closeHoverPreview, SAFE_TRIANGLE_TIMEOUT_MS);
      }
    };

    safePointerMove.current = onPointerMove;
    document.addEventListener("pointermove", onPointerMove, true);
    closeTimer.current = setTimeout(closeHoverPreview, SAFE_TRIANGLE_TIMEOUT_MS);
  }, [cancelClose, cancelPendingOpen, setOpen]);

  useEffect(() => () => {
    cancelPendingOpen();
    cancelClose();
    if (openRef.current) markOpen(group, id, false, false, null);
  }, [cancelClose, cancelPendingOpen, group, id]);

  useEffect(() => {
    const onPeerOpen = (event: Event) => {
      const detail = (event as CustomEvent<GroupDetail>).detail;
      if (detail.group === group && detail.id !== id) close();
    };
    const onCloseGroup = (event: Event) => {
      const detail = (event as CustomEvent<GroupDetail>).detail;
      if (detail.group === group) close();
    };
    document.addEventListener(OPEN_EVENT, onPeerOpen);
    document.addEventListener(CLOSE_GROUP_EVENT, onCloseGroup);
    return () => {
      document.removeEventListener(OPEN_EVENT, onPeerOpen);
      document.removeEventListener(CLOSE_GROUP_EVENT, onCloseGroup);
    };
  }, [close, group, id]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [close, open]);

  return {
    open,
    pinned,
    menuAutoFocus: openReason === "press",
    rootRef,
    triggerRef,
    close,
    scheduleClose,
    openFromHover,
    togglePinned,
  };
}
