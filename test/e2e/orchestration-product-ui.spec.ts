import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { signup } from "./helpers.ts";

const NOW = 1_784_700_000_000;
const OWNER_SESSION = "session-owner";
const PEER_SESSION = "session-peer";
const WORKFLOW_ID = "workflow-release";
const TEAM_ID = "team-launch";
const MAIL_ID = "mail-review";
const TASK_ID = "task-ui";

async function maybeCaptureAgentPresence(page: Page, name: string) {
  if (process.env.CAPTURE_AGENT_PRESENCE !== "1") return;
  const captureDir = path.join(process.cwd(), "docs/pr/agent-presence-motion");
  fs.mkdirSync(captureDir, { recursive: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  try {
    const scrollBefore = await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const accountName = document.querySelector<HTMLElement>("[data-account-name]");
      const accountEmail = document.querySelector<HTMLElement>("[data-account-email]");
      if (accountName) accountName.textContent = "tester";
      if (accountEmail) accountEmail.textContent = "tester@example.invalid";
      return { x: window.scrollX, y: window.scrollY };
    });
    const section = page.getByTestId("activity-detail").locator("section").last();
    await expect(section).toBeVisible();
    const box = await section.boundingBox();
    if (!box) throw new Error("Activity section has no visible bounds");
    const workspaceName = name.replace("-detail.png", "-workspace.png");
    await page.screenshot({ path: path.join(captureDir, workspaceName), animations: "disabled" });
    await page.screenshot({
      path: path.join(captureDir, name),
      animations: "disabled",
      clip: {
        x: box.x + 16,
        y: box.y + 16,
        width: Math.min(500, box.width - 32),
        height: Math.min(110, box.height - 32),
      },
    });
    expect(await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }))).toEqual(scrollBefore);
  } finally {
    await page.emulateMedia({ reducedMotion: "no-preference" });
  }
}

function task(sessionId = OWNER_SESSION) {
  return {
    id: TASK_ID,
    sessionId,
    ownerSessionId: sessionId,
    agentId: "agent-ui",
    title: "Build the Run inspector",
    status: "running",
    kind: "delegation",
    awaitPolicy: "background",
    cancelPolicy: "linked",
    checkpointSafe: true,
    activity: "tool:write",
    version: 3,
    createdAt: NOW - 50_000,
    updatedAt: NOW - 4_000,
  };
}

function workflowSummary(sessionId = OWNER_SESSION) {
  return {
    id: WORKFLOW_ID,
    ownerSessionId: sessionId,
    name: "Release readiness",
    status: "running",
    definitionVersion: 2,
    graphRevision: 7,
    graphSealed: true,
    runRevision: 3,
    nodeCount: 2,
    completedNodeCount: 1,
    activeNodeCount: 1,
    version: 8,
    createdAt: NOW - 90_000,
    updatedAt: NOW - 8_000,
    startedAt: NOW - 70_000,
  };
}

function teamSummary(sessionId = OWNER_SESSION) {
  return {
    id: TEAM_ID,
    ownerSessionId: sessionId,
    ownerAvailable: true,
    name: "Launch review",
    status: "active",
    memberCount: 2,
    activeMemberCount: 2,
    queuedMail: 0,
    claimedMail: 1,
    openWork: 1,
    version: 5,
    createdAt: NOW - 80_000,
    updatedAt: NOW - 6_000,
  };
}

async function installOrchestrationRoutes(page: Page, sessionId = OWNER_SESSION) {
  const requests: string[] = [];
  const ownerTitle = "Orchestration design review";
  const members = [
    {
      id: "member-lead",
      sessionId,
      sessionTitle: ownerTitle,
      agentId: "agent-root",
      role: "lead",
      status: "active",
      version: 2,
      createdAt: NOW - 80_000,
      updatedAt: NOW - 6_000,
    },
    {
      id: "member-peer",
      sessionId: PEER_SESSION,
      sessionTitle: "API verification",
      agentId: "agent-peer",
      role: "reviewer",
      status: "active",
      version: 2,
      createdAt: NOW - 70_000,
      updatedAt: NOW - 15_000,
    },
  ];
  const mail = {
    id: MAIL_ID,
    teamId: TEAM_ID,
    seq: 13,
    sourceMemberId: "member-lead",
    sourceSessionId: sessionId,
    targetMemberId: "member-peer",
    targetSessionId: PEER_SESSION,
    kind: "work",
    subject: "Review the narrow Run layout",
    taskId: TASK_ID,
    status: "claimed",
    payloadBytes: 328,
    version: 2,
    createdAt: NOW - 45_000,
    updatedAt: NOW - 12_000,
    claimedAt: NOW - 12_000,
  };
  const workflow = workflowSummary(sessionId);
  let runWorkflow = workflow;
  const team = teamSummary(sessionId);
  const runTask = task(sessionId);

  await page.route("**/api/sessions/*/run*", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({
      json: {
        sessionId,
        rootAgentId: "agent-root",
        revision: 12,
        counts: { tasks: 1, activeAgents: 1, background: 1, queued: 0, waiting: 0, unread: 0 },
        agents: {
          items: [{
            id: "agent-root",
            sessionId,
            rootAgentId: "agent-root",
            label: "Session Agent",
            provider: "mock",
            model: "mock-coder",
            kind: "session",
            status: "running",
            version: 3,
            createdAt: NOW - 60_000,
            updatedAt: NOW - 3_000,
          }],
        },
        tasks: { items: [runTask] },
        linkedWorkflows: { items: [runWorkflow], partial: false },
        teamMemberships: {
          items: [{
            teamId: TEAM_ID,
            name: team.name,
            teamStatus: team.status,
            memberId: "member-lead",
            role: "lead",
            memberStatus: "active",
            memberCount: 2,
            unreadMail: 0,
            version: 5,
            updatedAt: NOW - 6_000,
          }],
          partial: false,
        },
      },
    });
  });

  await page.route("**/api/orchestration/**", async (route) => {
    const url = new URL(route.request().url());
    requests.push(url.toString());
    const path = url.pathname;
    if (path === "/api/orchestration/activity") {
      await route.fulfill({
        json: {
          revision: 22,
          sessions: [{ id: sessionId, title: ownerTitle }],
          items: [{ task: runTask, agent: { id: "agent-ui", label: "Interface", status: "running" } }],
        },
      });
      return;
    }
    if (path === `/api/orchestration/tasks/${TASK_ID}/result`) {
      await route.fulfill({
        json: {
          result: {
            id: "result-ui",
            taskId: TASK_ID,
            summary: "The Run inspector is ready.",
            body: { status: "verified" },
            artifacts: [],
            version: 1,
            createdAt: NOW - 2_000,
          },
        },
      });
      return;
    }
    if (path === `/api/orchestration/tasks/${TASK_ID}`) {
      await route.fulfill({
        json: { task: { ...runTask, payload: { objective: runTask.title }, agentOrd: 1, leaseGeneration: 2 } },
      });
      return;
    }
    if (path === "/api/orchestration/workflows") {
      await route.fulfill({ json: { items: [workflow], sessions: [{ id: sessionId, title: ownerTitle }] } });
      return;
    }
    if (path === `/api/orchestration/workflows/${WORKFLOW_ID}`) {
      await route.fulfill({
        json: {
          workflow: {
            ...workflow,
            controllerAgentId: "agent-root",
            budget: {
              maxNodes: 32,
              maxEdges: 64,
              maxDepth: 6,
              maxAttempts: 20,
              maxRuntimeMs: 3_600_000,
              maxTokens: 100_000,
              maxCostMicros: 5_000_000,
            },
            attemptsUsed: 2,
            tokensUsed: 8_400,
            tokensReserved: 2_000,
            costUsedMicros: 18_000,
            costReservedMicros: 3_000,
            nodes: [
              {
                id: "map",
                name: "Map affected surfaces",
                kind: "work",
                effect: "workspace_read",
                cachePolicy: "evidence",
                status: "succeeded",
                depth: 0,
                maxAttempts: 2,
                attemptCount: 1,
                version: 2,
                createdAt: NOW - 70_000,
                updatedAt: NOW - 50_000,
                settledAt: NOW - 50_000,
              },
              {
                id: "ui",
                name: "Build the Run inspector",
                kind: "work",
                effect: "workspace_write",
                cachePolicy: "none",
                status: "running",
                depth: 1,
                maxAttempts: 2,
                attemptCount: 1,
                version: 4,
                createdAt: NOW - 70_000,
                updatedAt: NOW - 8_000,
              },
            ],
            edges: [{ from: "map", to: "ui", condition: "success" }],
            nodesPartial: false,
            edgesPartial: false,
          },
        },
      });
      return;
    }
    if (path === "/api/orchestration/teams") {
      await route.fulfill({ json: { items: [team], sessions: [{ id: sessionId, title: ownerTitle }] } });
      return;
    }
    if (path === `/api/orchestration/teams/${TEAM_ID}`) {
      await route.fulfill({ json: { team: { ...team, leadAgentId: "agent-root", members, membersPartial: false } } });
      return;
    }
    if (path === `/api/orchestration/teams/${TEAM_ID}/mail`) {
      await route.fulfill({ json: { items: [mail] } });
      return;
    }
    if (path === `/api/orchestration/teams/${TEAM_ID}/mail/${MAIL_ID}`) {
      await route.fulfill({
        json: { mail: { ...mail, payload: { objective: "Review the narrow Run layout." } } },
      });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "not found" } });
  });

  return {
    requests,
    setRunWorkflow(next: ReturnType<typeof workflowSummary>) {
      runWorkflow = next;
    },
  };
}

async function createSessionByApi(page: Page, title = "Orchestration design review"): Promise<string> {
  return page.evaluate(async (sessionTitle) => {
    const token = localStorage.getItem("agentweb.token")!;
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        title: sessionTitle,
        provider: "mock",
        model: "mock-coder",
        sandboxMode: "workspace-write",
        sandboxKind: "local",
        approvalPolicy: "never",
      }),
    });
    const body = await response.json() as { session: { id: string } };
    return body.session.id;
  }, title);
}

async function installControllableWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const sent: unknown[] = [];
    class FakeWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readonly url: string;
      readyState = FakeWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
        sockets.push(this);
        window.setTimeout(() => {
          if (this.readyState !== FakeWebSocket.CONNECTING) return;
          this.readyState = FakeWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }, 0);
      }

      send(value: unknown): void {
        if (typeof value !== "string") return;
        try { sent.push(JSON.parse(value)); } catch {  }
      }

      close(code = 1000, reason = ""): void {
        if (this.readyState === FakeWebSocket.CLOSED) return;
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.({ code, reason } as CloseEvent);
      }

      emit(value: unknown): void {
        this.onmessage?.({ data: JSON.stringify(value) } as MessageEvent);
      }
    }

    const sockets: FakeWebSocket[] = [];
    const testWindow = window as Window & {
      __emitOrchestrationEvent?: (event: unknown) => void;
      __orchestrationSocketSent?: unknown[];
    };
    testWindow.__emitOrchestrationEvent = (event) => sockets.at(-1)?.emit(event);
    testWindow.__orchestrationSocketSent = sent;
    (window as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
  });
}

async function emitOrchestrationEvent(page: Page, event: unknown): Promise<void> {
  await page.evaluate((value) => {
    const emit = (window as Window & {
      __emitOrchestrationEvent?: (event: unknown) => void;
    }).__emitOrchestrationEvent;
    if (!emit) throw new Error("controllable WebSocket was not installed");
    emit(value);
  }, event);
}

test("Agents keeps list intent in the URL and loads exact Activity detail", async ({ page }) => {
  await page.clock.setFixedTime(NOW);
  await signup(page);
  const { requests } = await installOrchestrationRoutes(page);

  await page.goto("/agents/activity");
  await expect(page.getByTestId(`activity-row-${TASK_ID}`)).toBeVisible();
  await expect(page.getByTestId(`activity-row-${TASK_ID}`).getByTestId("agent-activity-glyph")).toHaveCount(0);
  await expect(page.getByTestId("activity-detail")).toHaveCount(0);
  await expect(page.getByText("Select an item")).toBeVisible();

  await page.goto(`/agents/activity/${TASK_ID}`);
  await expect(page.getByTestId("activity-detail")).toContainText("Build the Run inspector");
  await expect(page.getByTestId("activity-detail").getByTestId("agent-activity-glyph")).toHaveAttribute("data-orb-state", "composing");
  await expect(page.getByTestId("activity-detail").getByTestId("agent-activity-glyph")).toHaveAttribute("data-orb-paused", "false");
  await expect(page.getByTestId("activity-detail").getByTestId("agent-activity-glyph")).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("activity-detail").getByText("Changing files", { exact: true })).toBeVisible();
  await maybeCaptureAgentPresence(page, "after-task-detail.png");
  await page.reload();
  await expect(page.getByTestId("activity-detail")).toContainText("Build the Run inspector");
  expect(requests.filter((url) => new URL(url).pathname === `/api/orchestration/tasks/${TASK_ID}`).length).toBeGreaterThanOrEqual(2);
});

test("Activity discards an older page after an invalidation refresh", async ({ page }) => {
  await installControllableWebSocket(page);

  let initialRequests = 0;
  let cursorRequests = 0;
  let releaseOldPage!: () => void;
  const oldPageRelease = new Promise<void>((resolve) => { releaseOldPage = resolve; });
  let markOldPageStarted!: () => void;
  const oldPageStarted = new Promise<void>((resolve) => { markOldPageStarted = resolve; });
  let markOldPageSettled!: () => void;
  const oldPageSettled = new Promise<void>((resolve) => { markOldPageSettled = resolve; });
  const now = Date.now();
  const activityItem = (id: string, title: string, version: number) => ({
    task: {
      id,
      sessionId: "session-race",
      ownerSessionId: "session-race",
      agentId: `agent-${id}`,
      kind: "delegation",
      title,
      status: "running",
      awaitPolicy: "background",
      cancelPolicy: "linked",
      checkpointSafe: true,
      version,
      createdAt: now - 10_000,
      updatedAt: now - version,
    },
    agent: { id: `agent-${id}`, label: `Agent ${id}`, status: "running" },
  });

  await page.route("**/api/orchestration/activity**", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.has("cursor")) {
      cursorRequests += 1;
      markOldPageStarted();
      await oldPageRelease;
      try {
        await route.fulfill({
          json: {
            revision: 1,
            sessions: [{ id: "session-race", title: "Race session" }],
            items: [activityItem("old-page", "STALE PAGINATED ROW", 1)],
          },
        });
      } catch {
      } finally {
        markOldPageSettled();
      }
      return;
    }

    initialRequests += 1;
    await route.fulfill({
      json: initialRequests === 1
        ? {
            revision: 1,
            sessions: [{ id: "session-race", title: "Race session" }],
            items: [activityItem("first", "INITIAL ROW", 1)],
            nextCursor: "cursor-old",
          }
        : {
            revision: 2,
            sessions: [{ id: "session-race", title: "Race session" }],
            items: [activityItem("fresh", "FRESH ROW AFTER INVALIDATION", 2)],
          },
    });
  });

  await signup(page);
  await page.goto("/agents/activity");
  await expect(page.getByTestId("activity-row-first")).toBeVisible();
  await page.getByRole("button", { name: "Load more" }).click();
  await oldPageStarted;

  await emitOrchestrationEvent(page, {
    type: "orchestration_invalidated",
    resource: "activity",
    revision: 2,
  });
  await expect(page.getByTestId("activity-row-fresh")).toBeVisible();
  await expect(page.getByTestId("activity-row-old-page")).toHaveCount(0);

  releaseOldPage();
  await oldPageSettled;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));

  await expect(page.getByTestId("activity-row-fresh")).toHaveCount(1);
  await expect(page.getByTestId("activity-row-old-page")).toHaveCount(0);
  expect(initialRequests).toBeGreaterThanOrEqual(2);
  expect(cursorRequests).toBe(1);
});

test("Workflow deep links and Automations keep separate navigation models", async ({ page }) => {
  await signup(page);
  const { requests } = await installOrchestrationRoutes(page);

  await page.goto(`/agents/workflows/${WORKFLOW_ID}`);
  await expect(page.getByTestId("workflow-detail")).toContainText("Release readiness");
  await expect(page.getByTestId("workflow-detail")).toContainText("Map affected surfaces");
  const listRequest = requests.find((url) => new URL(url).pathname === "/api/orchestration/workflows");
  expect(new URL(listRequest!).searchParams.get("limit")).toBe("100");
  await expect(page.getByRole("link", { name: "Schedules", exact: true })).toHaveCount(0);

  await page.goto("/automations");
  await expect(page).toHaveURL(/\/automations$/);
  await expect(page.getByTestId("automations-view")).toBeVisible();
});

test("Team mail stays a separate ledger and loads payload only from exact detail", async ({ page }) => {
  await signup(page);
  const { requests } = await installOrchestrationRoutes(page);

  await page.goto(`/agents/teams/${TEAM_ID}`);
  await expect(page.getByTestId("team-detail")).toContainText("Launch review");
  await expect(page.getByTestId(`team-mail-${MAIL_ID}`)).toContainText("Review the narrow Run layout");
  expect(requests.filter((url) => new URL(url).pathname.endsWith(`/mail/${MAIL_ID}`))).toHaveLength(0);

  await page.getByTestId(`team-mail-${MAIL_ID}`).click();
  await expect(page.getByTestId("team-mail-detail")).toContainText("Review the narrow Run layout.");
  await expect(page.getByTestId("team-mail-detail")).toContainText("API verification");
  await expect(page.getByTestId("team-mail-detail")).not.toContainText(PEER_SESSION);
  expect(requests.filter((url) => new URL(url).pathname.endsWith(`/mail/${MAIL_ID}`))).toHaveLength(1);
  const listRequest = requests.find((url) => new URL(url).pathname === `/api/orchestration/teams/${TEAM_ID}/mail`);
  expect(new URL(listRequest!).searchParams.get("limit")).toBe("100");
});

test("Run replaces placeholder tabs and uses an explicit narrow detail step", async ({ page }) => {
  await page.setViewportSize({ width: 1_000, height: 760 });
  await signup(page);
  const sessionId = await createSessionByApi(page);
  await installOrchestrationRoutes(page, sessionId);

  await page.goto(`/s/${sessionId}`);
  await page.getByLabel("Toggle details panel").click();
  await page.getByTitle("Run").click();
  await expect(page.getByTestId("run-inspector")).toBeVisible();
  await expect(page.getByTitle("Subagent")).toHaveCount(0);
  await expect(page.getByTitle("Agent Team")).toHaveCount(0);

  await page.getByTestId(`run-task-${TASK_ID}`).click();
  await expect(page.getByTestId("run-task-detail")).toContainText("Build the Run inspector");
  await expect(page.getByTestId("run-list")).not.toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByTestId("run-list")).toBeVisible();
});

test("Team member Sessions show identity and Task truth instead of an empty chat prompt", async ({ page }) => {
  await page.setViewportSize({ width: 1_280, height: 800 });
  await installControllableWebSocket(page);
  await signup(page);
  const ordinarySessionId = await createSessionByApi(page, "Ordinary research Session");
  const idleSessionId = await createSessionByApi(page, "Release reviewer");
  const assignedSessionId = await createSessionByApi(page, "Market analyst");
  const sessions = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token")!;
    const response = await fetch("/api/sessions", { headers: { authorization: `Bearer ${token}` } });
    return (await response.json() as { sessions: Array<Record<string, unknown>> }).sessions;
  });
  let exposeTeamIdentity = false;

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({
      json: {
        sessions: sessions.map((session) => ({
          ...session,
          ...(exposeTeamIdentity && session.id !== ordinarySessionId ? { isTeamMemberSession: true } : {}),
        })),
      },
    });
  });
  await page.route("**/api/sessions/*/run*", async (route) => {
    const sessionId = decodeURIComponent(new URL(route.request().url()).pathname.split("/").at(-2)!);
    const assigned = sessionId === assignedSessionId;
    const taskRow = {
      id: "task-team-member-ui",
      sessionId,
      ownerSessionId: idleSessionId,
      agentId: `agent-${sessionId}`,
      parentTaskId: "task-parent-in-another-session",
      teamId: TEAM_ID,
      title: "Compare coding assistants",
      status: "running",
      kind: "team_turn",
      awaitPolicy: "background",
      cancelPolicy: "detached",
      checkpointSafe: false,
      activity: "tool:search",
      version: 2,
      createdAt: NOW - 20_000,
      updatedAt: NOW - 1_000,
    };
    const unrelatedTask = {
      ...taskRow,
      id: "task-unrelated-background",
      agentId: `agent-unrelated-${sessionId}`,
      parentTaskId: undefined,
      teamId: undefined,
      title: "Refresh unrelated memory",
      kind: "delegation",
      updatedAt: NOW,
    };
    await route.fulfill({
      json: {
        sessionId,
        rootAgentId: `agent-${sessionId}`,
        revision: 2,
        counts: { tasks: assigned ? 1 : 0, activeAgents: 0, background: assigned ? 1 : 0, queued: 0, waiting: 0, unread: 0 },
        agents: {
          items: [{
            id: `agent-${sessionId}`,
            sessionId,
            rootAgentId: `agent-${sessionId}`,
            label: "Team member Session",
            kind: "session",
            status: assigned ? "running" : "idle",
            version: 2,
            createdAt: NOW - 30_000,
            updatedAt: NOW - 1_000,
          }],
        },
        tasks: { items: assigned ? [unrelatedTask] : [] },
        ...(assigned ? { latestTeamTask: taskRow } : {}),
        linkedWorkflows: { items: [], partial: false },
        teamMemberships: {
          items: assigned ? [{
            teamId: "team-unrelated-ui",
            name: "Unrelated Team",
            teamStatus: "active",
            memberId: `member-unrelated-${sessionId}`,
            role: "observer",
            memberStatus: "active",
            memberCount: 2,
            unreadMail: 0,
            version: 5,
            updatedAt: NOW,
          }, {
            teamId: TEAM_ID,
            name: "Release review",
            teamStatus: "active",
            memberId: `member-${sessionId}`,
            role: assigned ? "analyst" : "reviewer",
            memberStatus: "active",
            memberCount: 3,
            unreadMail: 0,
            version: 4,
            updatedAt: NOW - 1_000,
          }] : [{
            teamId: TEAM_ID,
            name: "Release review",
            teamStatus: "active",
            memberId: `member-${sessionId}`,
            role: "reviewer",
            memberStatus: "active",
            memberCount: 3,
            unreadMail: 0,
            version: 4,
            updatedAt: NOW - 1_000,
          }],
          partial: false,
        },
      },
    });
  });

  const captureDir = path.join(process.cwd(), "docs/pr/team-member-session-detail");
  const settleCapture = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const name = document.querySelector<HTMLElement>("[data-account-name]");
      const email = document.querySelector<HTMLElement>("[data-account-email]");
      if (name) name.textContent = "tester";
      if (email) email.textContent = "tester@example.invalid";
    });
  };
  const maybeCapture = async (name: string) => {
    if (process.env.CAPTURE_TEAM_SESSION_DETAIL !== "1") return;
    fs.mkdirSync(captureDir, { recursive: true });
    await settleCapture();
    await page.screenshot({ path: path.join(captureDir, name), animations: "disabled" });
  };

  await page.goto(`/s/${ordinarySessionId}`);
  await emitOrchestrationEvent(page, {
    type: "timeline_replay",
    sessionId: ordinarySessionId,
    epoch: "ordinary-epoch",
    version: 0,
    items: [],
    pending: [],
  });
  await emitOrchestrationEvent(page, { type: "session_status", sessionId: ordinarySessionId, status: "idle" });
  await expect(page.getByText("Start the conversation.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("team-session-context")).toHaveCount(0);

  await page.getByRole("button", { name: "Release reviewer", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${idleSessionId}$`));
  await emitOrchestrationEvent(page, {
    type: "timeline_replay",
    sessionId: idleSessionId,
    epoch: "idle-before-epoch",
    version: 0,
    items: [],
    pending: [],
  });
  await emitOrchestrationEvent(page, { type: "session_status", sessionId: idleSessionId, status: "idle" });
  await expect(page.getByText("Start the conversation.", { exact: true })).toBeVisible();
  await maybeCapture("before-empty-session.png");

  exposeTeamIdentity = true;
  await page.reload();
  await expect(page).toHaveURL(new RegExp(`/s/${idleSessionId}$`));
  await emitOrchestrationEvent(page, {
    type: "timeline_replay",
    sessionId: idleSessionId,
    epoch: "idle-team-epoch",
    version: 0,
    items: [],
    pending: [],
  });
  await emitOrchestrationEvent(page, { type: "session_status", sessionId: idleSessionId, status: "idle" });
  await expect(page.getByTestId("team-session-context")).toContainText("Release review · reviewer");
  await expect(page.getByTestId("team-session-no-task")).toContainText("has not received a Team Task");
  await expect(page.getByText("Start the conversation.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Release reviewer", exact: true })).toContainText("Team");
  await maybeCapture("after-idle-team-member.png");

  await page.getByRole("button", { name: "Market analyst", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/s/${assignedSessionId}$`));
  await emitOrchestrationEvent(page, {
    type: "timeline_replay",
    sessionId: assignedSessionId,
    epoch: "assigned-team-epoch",
    version: 0,
    items: [],
    pending: [],
  });
  await emitOrchestrationEvent(page, {
    type: "agent_event",
    sessionId: assignedSessionId,
    epoch: "assigned-team-epoch",
    version: 1,
    seq: 1,
    ts: NOW - 20_000,
    event: {
      t: "team_assignment",
      id: "team-assignment-ui",
      seq: 1,
      taskId: "task-team-member-ui",
      title: "Compare coding assistants",
      ts: NOW - 20_000,
      turnId: "turn-team-member-ui",
    },
  });
  await emitOrchestrationEvent(page, { type: "session_status", sessionId: assignedSessionId, status: "running" });
  await expect(page.getByTestId("team-session-context")).toContainText("Release review · analyst");
  await expect(page.getByTestId("team-session-latest-task")).toContainText("Compare coding assistants");
  await expect(page.getByTestId("team-session-context")).not.toContainText("Refresh unrelated memory");
  await expect(page.getByTestId("team-session-context")).not.toContainText("Unrelated Team");
  await expect(page.getByTestId("team-session-latest-task").locator('[data-status="running"]')).toBeVisible();
  await expect(page.getByTestId("team-assignment")).toContainText("Compare coding assistants");
  await expect(page.getByTestId("msg-user")).toHaveCount(0);
  await expect(page.getByTestId("live-activity")).toHaveCount(0);
  const composerActivity = page.getByTestId("agent-activity-orb");
  await expect(composerActivity).toHaveCount(1);
  await expect(composerActivity).toHaveAttribute("data-orb-state", "solving");
  await expect(composerActivity).toHaveAttribute("data-orb-paused", "false");
  const activityCanvas = composerActivity.getByTestId("agent-activity-glyph").locator("canvas");
  await expect(activityCanvas).toHaveCount(1);
  const movingFrame = await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(160);
  expect(await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(movingFrame);

  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => activityCanvas.evaluate((canvas) => {
    const context = (canvas as HTMLCanvasElement).getContext("2d");
    return Boolean(context && (canvas as HTMLCanvasElement).width > 0);
  })).toBe(true);
  await expect.poll(async () => {
    const before = await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    await page.waitForTimeout(80);
    const after = await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
    return before === after;
  }).toBe(true);
  const reducedFrame = await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(160);
  expect(await activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(reducedFrame);
  await page.evaluate(() => document.documentElement.classList.add("dark"));
  await expect.poll(() => activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).not.toBe(reducedFrame);
  await page.evaluate(() => document.documentElement.classList.remove("dark"));
  await expect.poll(() => activityCanvas.evaluate((canvas) => (canvas as HTMLCanvasElement).toDataURL())).toBe(reducedFrame);
  await maybeCapture("after-active-team-member.png");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await page.getByRole("button", { name: "Release reviewer", exact: true }).click();
  await page.getByRole("button", { name: "Market analyst", exact: true }).click();
  await expect(page.getByTestId("team-assignment")).toContainText("Compare coding assistants");
  await expect.poll(() => page.evaluate((sessionId) => {
    const sent = (window as Window & { __orchestrationSocketSent?: unknown[] })
      .__orchestrationSocketSent as Array<{
        type?: string;
        sessionId?: string;
        resume?: { epoch?: string; version?: number };
      }> | undefined;
    return sent?.filter((event) => event.type === "subscribe" && event.sessionId === sessionId)
      .at(-1)?.resume ?? null;
  }, assignedSessionId)).toEqual({ epoch: "assigned-team-epoch", version: 1 });
});

test("Run refetches when a linked Workflow changes without a roster revision", async ({ page }) => {
  await installControllableWebSocket(page);
  await page.setViewportSize({ width: 1_000, height: 760 });
  await signup(page);
  const sessionId = await createSessionByApi(page);
  const routes = await installOrchestrationRoutes(page, sessionId);

  await page.goto(`/s/${sessionId}`);
  await page.getByLabel("Toggle details panel").click();
  await page.getByTitle("Run").click();
  const workflowLink = page.getByTestId(`run-workflow-link-${WORKFLOW_ID}`);
  await expect(workflowLink.locator('[data-status="running"]')).toBeVisible();
  const readsBefore = routes.requests.filter((url) =>
    new URL(url).pathname === `/api/sessions/${sessionId}/run`).length;

  routes.setRunWorkflow({
    ...workflowSummary(sessionId),
    status: "waiting",
    version: 9,
    updatedAt: NOW - 1_000,
  });
  await emitOrchestrationEvent(page, {
    type: "orchestration_invalidated",
    resource: "workflow",
    workflowId: WORKFLOW_ID,
    version: 9,
  });

  await expect(workflowLink.locator('[data-status="waiting"]')).toBeVisible();
  await expect.poll(() => routes.requests.filter((url) =>
    new URL(url).pathname === `/api/sessions/${sessionId}/run`).length).toBeGreaterThan(readsBefore);
});
