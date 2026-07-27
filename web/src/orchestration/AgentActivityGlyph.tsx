import { ThinkingOrb, type OrbState } from "thinking-orbs";

export function AgentActivityGlyph({
  state,
  paused = false,
  className = "",
}: {
  state: OrbState;
  paused?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      data-testid="agent-activity-glyph"
      data-orb-state={state}
      data-orb-paused={paused ? "true" : "false"}
      className={`inline-flex size-5 shrink-0 items-center justify-center overflow-hidden ${className}`}
    >
      <ThinkingOrb
        state={state}
        size={20}
        speed={0.82}
        paused={paused}
        role="presentation"
        aria-hidden="true"
      />
    </span>
  );
}
