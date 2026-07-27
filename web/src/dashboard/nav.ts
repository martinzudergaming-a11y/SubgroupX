import type { AgentsSection, ViewType } from "./types";

export const VIEW_PATH: Record<ViewType, string> = {
  chat: "/",
  channel: "/channels",
  search: "/search",
  shell: "/terminal",
  skills: "/skills",
  plugins: "/plugins",
  agents: "/agents/activity",
  automations: "/automations",
  settings: "/settings",
};

const PATH_VIEW: Record<string, ViewType> = Object.fromEntries(
  Object.entries(VIEW_PATH).map(([v, p]) => [p, v as ViewType]),
);

const AGENT_SECTION_PATH: Record<string, AgentsSection> = {
  "/agents": "activity",
  "/agents/activity": "activity",
  "/agents/workflows": "workflows",
  "/agents/teams": "teams",
};

interface ParsedAgentsPath {
  section: AgentsSection;
  entityId?: string;
  subEntityId?: string;
}

function decodeSegment(value: string): string | undefined {
  if (!value || value.includes("/")) return undefined;
  try {
    return decodeURIComponent(value) || undefined;
  } catch {
    return undefined;
  }
}

function parseAgentPath(pathname: string): ParsedAgentsPath | undefined {
  const exact = AGENT_SECTION_PATH[pathname];
  if (exact) return { section: exact };

  const teamMail = /^\/agents\/teams\/([^/]+)\/mail\/([^/]+)$/.exec(pathname);
  if (teamMail) {
    const entityId = decodeSegment(teamMail[1]);
    const subEntityId = decodeSegment(teamMail[2]);
    return entityId && subEntityId
      ? { section: "teams", entityId, subEntityId }
      : undefined;
  }

  const entity = /^\/agents\/(activity|workflows|teams)\/([^/]+)$/.exec(pathname);
  if (entity) {
    const entityId = decodeSegment(entity[2]);
    return entityId ? { section: entity[1] as AgentsSection, entityId } : undefined;
  }
  return undefined;
}

export function parseAppPath(pathname: string): {
  view: ViewType;
  sessionId?: string;
  agentsSection?: AgentsSection;
  agentsEntityId?: string;
  agentsSubEntityId?: string;
  redirectTo?: string;
} {
  if (pathname.startsWith("/s/")) {
    const sessionId = decodeURIComponent(pathname.slice(3).split("/")[0] ?? "");
    if (sessionId) return { view: "chat", sessionId };
  }
  const agentPath = parseAgentPath(pathname);
  if (agentPath) {
    return {
      view: "agents",
      agentsSection: agentPath.section,
      agentsEntityId: agentPath.entityId,
      agentsSubEntityId: agentPath.subEntityId,
      redirectTo: pathname === "/agents" ? "/agents/activity" : undefined,
    };
  }
  return { view: PATH_VIEW[pathname] ?? "chat" };
}

export function isKnownAppPath(pathname: string): boolean {
  if (pathname === "/") return true;
  if (pathname in PATH_VIEW) return true;
  if (parseAgentPath(pathname)) return true;
  return pathname.startsWith("/s/") && pathname.slice(3).length > 0;
}
