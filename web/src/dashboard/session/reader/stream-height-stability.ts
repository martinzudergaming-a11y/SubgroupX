export type StreamHeightState = { floor: number | null };

export const MAX_STREAM_HEIGHT_COMPENSATION_PX = 32;

export function resolveStreamHeight(
  state: StreamHeightState,
  naturalHeight: number,
  live: boolean,
  maxCompensation = MAX_STREAM_HEIGHT_COMPENSATION_PX,
): { state: StreamHeightState; spacer: number } {
  const natural = Number.isFinite(naturalHeight) ? Math.max(0, naturalHeight) : 0;
  const cap = Math.max(0, maxCompensation);
  let floor = state.floor;

  if (live) {
    if (floor == null || natural >= floor) floor = natural;
    else if (floor - natural > cap) floor = natural + cap;
  } else if (floor != null) {
    if (natural >= floor) floor = null;
    else if (floor - natural > cap) floor = natural + cap;
  }

  return { state: { floor }, spacer: floor == null ? 0 : Math.max(0, floor - natural) };
}
