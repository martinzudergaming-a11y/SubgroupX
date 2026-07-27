import { expect, test } from "@playwright/test";
import { signup } from "./helpers.ts";

test("orchestration snapshots are auth-scoped and do not hydrate an unopened Session", async ({ page }) => {
  await signup(page);
  const contract = await page.evaluate(async () => {
    const token = localStorage.getItem("agentweb.token")!;
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const createdResponse = await fetch("/api/sessions", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "Read model contract",
        provider: "mock",
        model: "mock-coder",
        sandboxMode: "workspace-write",
        sandboxKind: "local",
        approvalPolicy: "never",
      }),
    });
    const created = await createdResponse.json() as { session: { id: string } };
    const runResponse = await fetch(`/api/sessions/${created.session.id}/run`, { headers });
    const activityResponse = await fetch("/api/orchestration/activity", { headers });
    const malformedResponse = await fetch("/api/orchestration/activity?cursor=invalid", { headers });
    return {
      createdStatus: createdResponse.status,
      runStatus: runResponse.status,
      run: await runResponse.json(),
      activityStatus: activityResponse.status,
      activity: await activityResponse.json(),
      malformedStatus: malformedResponse.status,
    };
  });

  expect(contract.createdStatus).toBe(200);
  expect(contract.runStatus).toBe(200);
  expect(contract.run).toMatchObject({ revision: 0, agents: { items: [] }, tasks: { items: [] } });
  expect(contract.activityStatus).toBe(200);
  expect(contract.activity).toEqual({ revision: 0, items: [], sessions: [] });
  expect(contract.malformedStatus).toBe(400);
});
