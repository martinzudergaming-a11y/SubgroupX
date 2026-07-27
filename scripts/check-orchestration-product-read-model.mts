import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "oiia-orchestration-product-read-"));
process.env.AGENT_WEB_DATA_DIR = tmp;
process.env.AGENT_WEB_LOCAL_ROOT = path.join(tmp, "workspace");
process.env.AGENT_WEB_ALLOW_UNCONFINED_LOCAL = "1";

const express = (await import("express")).default;
const [{ createApiRouter }, auth, persistence, providers] = await Promise.all([
  import("../server/src/http/api.ts"),
  import("../server/src/identity/auth.ts"),
  import("../server/src/persistence/index.ts"),
  import("../server/src/runtime/providers.ts"),
]);
providers.registerMockProvider();

const {
  agentNodeDao,
  db,
  sessionDao,
  teamDao,
  teamMailDao,
  userDao,
  workflowDao,
} = persistence;
const now = 1_910_000_000_000;
const userId = "product_read_user";
const otherUserId = "product_read_other";
userDao.create({
  id: userId,
  email: "product-read@example.invalid",
  password_hash: "x",
  created_at: now,
});
userDao.create({
  id: otherUserId,
  email: "product-read-other@example.invalid",
  password_hash: "x",
  created_at: now,
});

function createSession(id: string, owner: string, title: string) {
  sessionDao.create({
    id,
    user_id: owner,
    title,
    provider: "mock",
    model: "mock-coder",
    sandbox_mode: "workspace-write",
    sandbox_kind: "local",
    sandbox_id: null,
    sandbox_target_id: null,
    e2b_snapshot_id: null,
    mode: "coding",
    approval_policy: "never",
    status: "idle",
    thinking_level: "medium",
    cwd: "/tmp",
    created_at: now,
    updated_at: now,
  });
  return agentNodeDao.create({
    id: `agent_${id}`,
    userId: owner,
    sessionId: id,
    rootAgentId: `agent_${id}`,
    path: "/root",
    kind: "session",
    status: "idle",
    createdAt: now,
  });
}

const ownerRoot = createSession("session_owner", userId, "Owner session");
const peerRoot = createSession("session_peer", userId, "Peer session");
const otherRoot = createSession("session_other", otherUserId, "Other session");
const ownerWorker = agentNodeDao.create({
  id: "agent_owner_worker",
  userId,
  sessionId: "session_owner",
  rootAgentId: ownerRoot.id,
  parentAgentId: ownerRoot.id,
  path: "/root/worker",
  label: "Worker",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  status: "idle",
  createdAt: now + 1,
});
const otherWorker = agentNodeDao.create({
  id: "agent_other_worker",
  userId: otherUserId,
  sessionId: "session_other",
  rootAgentId: otherRoot.id,
  parentAgentId: otherRoot.id,
  path: "/root/worker",
  label: "Other worker",
  provider: "mock",
  model: "mock-coder",
  kind: "subagent",
  status: "idle",
  createdAt: now + 1,
});

const workflowNode = (id: string, executorAgentId: string, secret: string) => ({
  id,
  name: `Node ${id}`,
  kind: "work" as const,
  payload: { message: secret },
  effect: "workspace_read" as const,
  cachePolicy: "none" as const,
  maxAttempts: 1,
  executorAgentId,
});
const alphaNodes = Array.from({ length: 64 }, (_, index) =>
  workflowNode(
    `alpha_${String(index).padStart(2, "0")}`,
    ownerWorker.id,
    index === 0 ? "WORKFLOW_PAYLOAD_SECRET" : `workflow assignment ${index}`,
  ));
const alphaEdges: Array<{ from: string; to: string; condition: "success" }> = [];
for (let from = 0; from < alphaNodes.length && alphaEdges.length < 256; from += 1) {
  for (let to = from + 1; to < alphaNodes.length && alphaEdges.length < 256; to += 1) {
    alphaEdges.push({ from: alphaNodes[from]!.id, to: alphaNodes[to]!.id, condition: "success" });
  }
}
workflowDao.create({
  id: "workflow_alpha",
  userId,
  ownerSessionId: "session_owner",
  rootAgentId: ownerRoot.id,
  name: "Alpha workflow",
  nodes: alphaNodes,
  edges: alphaEdges,
  createdAt: now + 10,
});
workflowDao.create({
  id: "workflow_beta",
  userId,
  ownerSessionId: "session_owner",
  rootAgentId: ownerRoot.id,
  name: "Beta workflow",
  nodes: [workflowNode("beta", ownerWorker.id, "BETA_PAYLOAD_SECRET")],
  edges: [],
  createdAt: now + 11,
});
workflowDao.create({
  id: "workflow_other",
  userId: otherUserId,
  ownerSessionId: "session_other",
  rootAgentId: otherRoot.id,
  name: "Other workflow",
  nodes: [workflowNode("other", otherWorker.id, "OTHER_WORKFLOW_SECRET")],
  edges: [],
  createdAt: now + 12,
});

teamDao.create({
  id: "team_cross_session",
  userId,
  ownerSessionId: "session_owner",
  actorSessionId: "session_owner",
  rootAgentId: ownerRoot.id,
  name: "Cross-session Team",
  members: [
    { id: "member_owner", sessionId: "session_owner", agentId: ownerRoot.id, role: "lead" },
    { id: "member_peer", sessionId: "session_peer", agentId: peerRoot.id, role: "reviewer" },
  ],
  leadMemberId: "member_owner",
  createdAt: now + 20,
});
teamDao.create({
  id: "team_owner_only",
  userId,
  ownerSessionId: "session_owner",
  actorSessionId: "session_owner",
  rootAgentId: ownerRoot.id,
  name: "Owner-only Team",
  members: [
    { id: "member_owner_second", sessionId: "session_owner", agentId: ownerRoot.id, role: "lead" },
  ],
  leadMemberId: "member_owner_second",
  createdAt: now + 21,
});
teamDao.create({
  id: "team_other",
  userId: otherUserId,
  ownerSessionId: "session_other",
  actorSessionId: "session_other",
  rootAgentId: otherRoot.id,
  name: "Other Team",
  members: [
    { id: "member_other", sessionId: "session_other", agentId: otherRoot.id, role: "lead" },
  ],
  leadMemberId: "member_other",
  createdAt: now + 22,
});

teamMailDao.send({
  id: "mail_secret",
  userId,
  teamId: "team_cross_session",
  sourceSessionId: "session_owner",
  targetMemberId: "member_peer",
  kind: "note",
  subject: "Private note",
  payload: { secret: "MAIL_PAYLOAD_SECRET" },
  idempotencyKey: "IDEMPOTENCY_SECRET",
  deadlineAt: now + 60_000,
  createdAt: now + 30,
});
teamMailDao.send({
  id: "mail_second",
  userId,
  teamId: "team_cross_session",
  sourceSessionId: "session_owner",
  targetMemberId: "member_peer",
  kind: "note",
  subject: "Second note",
  payload: { secret: "SECOND_MAIL_PAYLOAD" },
  idempotencyKey: "SECOND_IDEMPOTENCY_SECRET",
  deadlineAt: now + 60_000,
  createdAt: now + 31,
});
const claimed = teamMailDao.claimNext({
  userId,
  targetSessionId: "session_peer",
  claimToken: "CLAIM_TOKEN_SECRET",
  at: now + 32,
});
assert.equal(claimed?.id, "mail_secret");
const rawMail = db.prepare(
  "SELECT payload_json, idempotency_key, claim_token FROM team_mail WHERE id = ?",
).get("mail_secret") as { payload_json: string; idempotency_key: string; claim_token: string };
assert.match(rawMail.payload_json, /MAIL_PAYLOAD_SECRET/);
assert.equal(rawMail.idempotency_key, "IDEMPOTENCY_SECRET");
assert.equal(rawMail.claim_token, "CLAIM_TOKEN_SECRET");

const app = express();
app.use("/api", createApiRouter());
const server = app.listen(0, "127.0.0.1");
await new Promise<void>((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
const base = `http://127.0.0.1:${address.port}/api`;
const token = auth.issueToken({ id: userId, email: "product-read@example.invalid" });
const otherToken = auth.issueToken({ id: otherUserId, email: "product-read-other@example.invalid" });

async function api(
  route: string,
  bearer = token,
): Promise<{ status: number; json: Record<string, any>; text: string }> {
  const response = await fetch(`${base}${route}`, {
    headers: { authorization: `Bearer ${bearer}` },
  });
  const text = await response.text();
  return { status: response.status, json: JSON.parse(text) as Record<string, any>, text };
}

try {
  const ownerRun = await api("/sessions/session_owner/run");
  assert.equal(ownerRun.status, 200);
  assert.deepEqual(
    new Set(ownerRun.json.linkedWorkflows.items.map((item: any) => item.id)),
    new Set(["workflow_alpha", "workflow_beta"]),
  );
  assert.ok(ownerRun.json.teamMemberships.items.some((item: any) =>
    item.teamId === "team_cross_session" && item.role === "lead"));
  const peerRun = await api("/sessions/session_peer/run");
  assert.equal(peerRun.status, 200);
  assert.ok(peerRun.json.teamMemberships.items.some((item: any) =>
    item.teamId === "team_cross_session" && item.role === "reviewer"));
  assert.doesNotMatch(ownerRun.text + peerRun.text, /WORKFLOW_PAYLOAD_SECRET|MAIL_PAYLOAD_SECRET|CLAIM_TOKEN_SECRET|IDEMPOTENCY_SECRET/);

  const workflowsOne = await api("/orchestration/workflows?limit=1");
  assert.equal(workflowsOne.status, 200);
  assert.equal(workflowsOne.json.items.length, 1);
  assert.ok(workflowsOne.json.nextCursor);
  const workflowsTwo = await api(`/orchestration/workflows?limit=1&cursor=${workflowsOne.json.nextCursor}`);
  assert.equal(workflowsTwo.status, 200);
  assert.notEqual(workflowsOne.json.items[0].id, workflowsTwo.json.items[0].id);
  assert.equal((await api("/orchestration/workflows?limit=101")).status, 400);
  assert.doesNotMatch(workflowsOne.text + workflowsTwo.text, /workflow_other|WORKFLOW_PAYLOAD_SECRET|OTHER_WORKFLOW_SECRET/);

  const workflowDetail = await api("/orchestration/workflows/workflow_alpha");
  assert.equal(workflowDetail.status, 200);
  assert.equal(workflowDetail.json.workflow.nodes.length, 64);
  assert.equal(workflowDetail.json.workflow.edges.length, 256);
  assert.ok(workflowDetail.json.workflow.nodes.length <= 64);
  assert.ok(workflowDetail.json.workflow.edges.length <= 256);
  assert.equal(workflowDetail.json.workflow.nodesPartial, false);
  assert.equal(workflowDetail.json.workflow.edgesPartial, false);
  assert.doesNotMatch(workflowDetail.text, /WORKFLOW_PAYLOAD_SECRET|payload|evidence|outputDigest/);
  assert.equal((await api("/orchestration/workflows/workflow_alpha", otherToken)).status, 404);
  assert.equal((await api("/orchestration/workflows/workflow_other")).status, 404);

  const teamsOne = await api("/orchestration/teams?limit=1");
  assert.equal(teamsOne.status, 200);
  assert.equal(teamsOne.json.items.length, 1);
  assert.ok(teamsOne.json.nextCursor);
  const teamsTwo = await api(`/orchestration/teams?limit=1&cursor=${teamsOne.json.nextCursor}`);
  assert.equal(teamsTwo.status, 200);
  assert.notEqual(teamsOne.json.items[0].id, teamsTwo.json.items[0].id);
  assert.equal((await api("/orchestration/teams?limit=101")).status, 400);
  assert.doesNotMatch(teamsOne.text + teamsTwo.text, /team_other|MAIL_PAYLOAD_SECRET|CLAIM_TOKEN_SECRET|IDEMPOTENCY_SECRET/);

  const teamDetail = await api("/orchestration/teams/team_cross_session");
  assert.equal(teamDetail.status, 200);
  assert.deepEqual(
    new Set(teamDetail.json.team.members.map((member: any) => member.sessionId)),
    new Set(["session_owner", "session_peer"]),
  );
  assert.equal(teamDetail.json.team.membersPartial, false);
  assert.doesNotMatch(teamDetail.text, /MAIL_PAYLOAD_SECRET|CLAIM_TOKEN_SECRET|IDEMPOTENCY_SECRET/);
  assert.equal((await api("/orchestration/teams/team_cross_session", otherToken)).status, 404);
  assert.equal((await api("/orchestration/teams/team_other")).status, 404);

  const mailOne = await api("/orchestration/teams/team_cross_session/mail?limit=1");
  assert.equal(mailOne.status, 200);
  assert.equal(mailOne.json.items.length, 1);
  assert.ok(mailOne.json.nextCursor);
  const mailTwo = await api(
    `/orchestration/teams/team_cross_session/mail?limit=1&cursor=${mailOne.json.nextCursor}`,
  );
  assert.equal(mailTwo.status, 200);
  assert.notEqual(mailOne.json.items[0].id, mailTwo.json.items[0].id);
  const mailCollection = mailOne.text + mailTwo.text;
  assert.doesNotMatch(mailCollection, /MAIL_PAYLOAD_SECRET|SECOND_MAIL_PAYLOAD|CLAIM_TOKEN_SECRET|IDEMPOTENCY_SECRET/);
  assert.doesNotMatch(mailCollection, /"(?:claimToken|claimGeneration|idempotencyKey|deadlineAt|budget|payload)":/);

  const mailDetail = await api("/orchestration/teams/team_cross_session/mail/mail_secret");
  assert.equal(mailDetail.status, 200);
  assert.equal(mailDetail.json.mail.payload.secret, "MAIL_PAYLOAD_SECRET");
  assert.doesNotMatch(mailDetail.text, /CLAIM_TOKEN_SECRET|IDEMPOTENCY_SECRET|"(?:claimToken|claimGeneration|idempotencyKey)":/);
  assert.equal((await api("/orchestration/teams/team_cross_session/mail/mail_secret", otherToken)).status, 404);
  assert.equal((await api("/orchestration/teams/team_owner_only/mail/mail_secret")).status, 404);
  assert.equal((await api("/orchestration/teams/missing/mail")).status, 404);
  assert.equal((await api("/orchestration/teams/team_cross_session/mail?limit=101")).status, 400);

  teamMailDao.send({
    id: "mail_cursor_change",
    userId,
    teamId: "team_cross_session",
    sourceSessionId: "session_owner",
    targetMemberId: "member_peer",
    kind: "note",
    subject: "Cursor change",
    payload: {},
    idempotencyKey: "cursor-change",
    deadlineAt: now + 60_000,
    createdAt: now + 33,
  });
  const staleMailPage = await api(
    `/orchestration/teams/team_cross_session/mail?limit=1&cursor=${mailOne.json.nextCursor}`,
  );
  assert.equal(staleMailPage.status, 409);
  assert.deepEqual(staleMailPage.json, { error: "cursor_stale", restart: true });

  console.log("OK orchestration-product-read-model: real deep links + safe bounded projections + ownership");
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
