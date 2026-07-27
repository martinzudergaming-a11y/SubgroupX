export type StreamFollowState = {
  position: number;
  velocity: number;
};

const RESPONSE_MS = 160;
const OMEGA = 4.8 / (RESPONSE_MS / 1_000);
const MAX_FRAME_MS = 34;
export const MAX_STREAM_FOLLOW_DELTA = 96;

export function nextStreamFollow(
  state: StreamFollowState,
  target: number,
  dtMs: number,
): StreamFollowState {
  const dt = Math.min(MAX_FRAME_MS, Math.max(0, dtMs)) / 1_000;
  if (dt === 0) return state;
  const displacement = state.position - target;
  const coefficient = state.velocity + OMEGA * displacement;
  const decay = Math.exp(-OMEGA * dt);
  return {
    position: target + (displacement + coefficient * dt) * decay,
    velocity: (state.velocity - OMEGA * coefficient * dt) * decay,
  };
}

export function shouldAnimateStreamFollow(delta: number, active: boolean, reducedMotion: boolean): boolean {
  return active && !reducedMotion && delta > 0.75 && delta <= MAX_STREAM_FOLLOW_DELTA;
}

type ScrollPort = Pick<HTMLElement, 'clientHeight' | 'scrollHeight' | 'scrollTop'>;

export type StreamScrollFollower = {
  cancel: () => void;
  follow: (port: ScrollPort, animate: boolean) => void;
};

export function createStreamScrollFollower(onPosition?: (scrollTop: number) => void): StreamScrollFollower {
  let frame = 0;
  let lastTime = 0;
  let port: ScrollPort | null = null;
  let target = 0;
  let state: StreamFollowState = { position: 0, velocity: 0 };

  const cancel = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    lastTime = 0;
    port = null;
    state = { position: 0, velocity: 0 };
  };

  const write = (next: number) => {
    if (!port) return;
    port.scrollTop = next;
    state.position = port.scrollTop;
    onPosition?.(port.scrollTop);
  };

  const tick = (now: number) => {
    if (!port) return;
    if (Math.abs(port.scrollTop - state.position) > 1.5) {
      cancel();
      return;
    }
    const dt = lastTime ? now - lastTime : 16;
    lastTime = now;
    state = nextStreamFollow(state, target, dt);
    if (state.position >= target || (target - state.position < 0.35 && Math.abs(state.velocity) < 3)) {
      write(target);
      cancel();
      return;
    }
    write(state.position);
    frame = requestAnimationFrame(tick);
  };

  const follow = (nextPort: ScrollPort, animate: boolean) => {
    const nextTarget = Math.max(0, nextPort.scrollHeight - nextPort.clientHeight);
    const delta = nextTarget - nextPort.scrollTop;
    if (!animate || delta <= 0.75 || delta > MAX_STREAM_FOLLOW_DELTA || typeof requestAnimationFrame !== 'function') {
      cancel();
      nextPort.scrollTop = nextTarget;
      onPosition?.(nextPort.scrollTop);
      return;
    }

    if (port !== nextPort || !frame) {
      port = nextPort;
      state = { position: nextPort.scrollTop, velocity: 0 };
      lastTime = 0;
    } else {
      state.position = nextPort.scrollTop;
    }
    target = nextTarget;
    if (!frame) frame = requestAnimationFrame(tick);
  };

  return { cancel, follow };
}
