import type express from "express";
import { ORCHESTRATION_READ_MAX, OrchestrationCursorConflictError, decodeOrchestrationCursor, orchestrationReadModel } from "../../orchestration/read-model.ts";
import { boundedRuntimeClient } from "../../runtime/runtime-client.ts";
import { type AuthedRequest, requireAuth } from "../route-helpers.ts";

function queryScalar(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new TypeError(`${name} must be a single value`);
  return value;
}

function queryLimit(value: unknown, name: string): number | undefined {
  const scalar = queryScalar(value, name);
  if (scalar === undefined) return undefined;
  const parsed = Number(scalar);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > ORCHESTRATION_READ_MAX) {
    throw new TypeError(`${name} must be an integer from 1 to ${ORCHESTRATION_READ_MAX}`);
  }
  return parsed;
}

function badRequest(res: express.Response, error: unknown): void {
  if (error instanceof OrchestrationCursorConflictError) {
    res.status(409).json({ error: "cursor_stale", restart: true });
    return;
  }
  res.status(400).json({ error: error instanceof Error ? error.message : "invalid request" });
}

export function registerOrchestrationRoutes(r: express.Router): void {
  r.get("/orchestration/activity", requireAuth, (req: AuthedRequest, res) => {
    try {
      res.json(orchestrationReadModel.activity(req.user!.id, {
        limit: queryLimit(req.query.limit, "limit"),
        before: decodeOrchestrationCursor(queryScalar(req.query.cursor, "cursor")),
      }));
    } catch (error) {
      badRequest(res, error);
    }
  });

  r.get("/sessions/:id/run", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    try {
      const snapshot = orchestrationReadModel.sessionRun(req.user!.id, req.params.id, {
        agentLimit: queryLimit(req.query.agentLimit, "agentLimit"),
        agentBefore: decodeOrchestrationCursor(queryScalar(req.query.agentCursor, "agentCursor")),
        taskLimit: queryLimit(req.query.taskLimit, "taskLimit"),
        taskBefore: decodeOrchestrationCursor(queryScalar(req.query.taskCursor, "taskCursor")),
      });
      if (!snapshot) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(snapshot);
    } catch (error) {
      badRequest(res, error);
    }
  });

  r.get("/orchestration/workflows", requireAuth, (req: AuthedRequest, res) => {
    try {
      res.json(orchestrationReadModel.workflows(req.user!.id, {
        limit: queryLimit(req.query.limit, "limit"),
        before: decodeOrchestrationCursor(queryScalar(req.query.cursor, "cursor")),
      }));
    } catch (error) {
      badRequest(res, error);
    }
  });

  r.get("/orchestration/workflows/:id", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    const detail = orchestrationReadModel.workflowDetail(req.user!.id, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ workflow: detail });
  });

  r.get("/orchestration/teams", requireAuth, (req: AuthedRequest, res) => {
    try {
      res.json(orchestrationReadModel.teams(req.user!.id, {
        limit: queryLimit(req.query.limit, "limit"),
        before: decodeOrchestrationCursor(queryScalar(req.query.cursor, "cursor")),
      }));
    } catch (error) {
      badRequest(res, error);
    }
  });

  r.get("/orchestration/teams/:id", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    const detail = orchestrationReadModel.teamDetail(req.user!.id, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ team: detail });
  });

  r.get("/orchestration/teams/:id/mail", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    try {
      const page = orchestrationReadModel.teamMail(req.user!.id, req.params.id, {
        limit: queryLimit(req.query.limit, "limit"),
        before: decodeOrchestrationCursor(queryScalar(req.query.cursor, "cursor")),
      });
      if (!page) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json(page);
    } catch (error) {
      badRequest(res, error);
    }
  });

  r.get(
    "/orchestration/teams/:id/mail/:mailId",
    requireAuth,
    (req: AuthedRequest<{ id: string; mailId: string }>, res) => {
      const detail = orchestrationReadModel.teamMailDetail(
        req.user!.id,
        req.params.id,
        req.params.mailId,
      );
      if (!detail) {
        res.status(404).json({ error: "not found" });
        return;
      }
      res.json({ mail: detail });
    },
  );

  r.get("/orchestration/agents/:id", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    const detail = orchestrationReadModel.agentDetail(req.user!.id, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ agent: detail });
  });

  r.get("/orchestration/tasks/:id", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    const detail = orchestrationReadModel.taskDetail(req.user!.id, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ task: detail });
  });

  r.get("/orchestration/tasks/:id/result", requireAuth, (req: AuthedRequest<{ id: string }>, res) => {
    const detail = orchestrationReadModel.resultDetail(req.user!.id, req.params.id);
    if (!detail) {
      res.status(404).json({ error: "not found" });
      return;
    }
    res.json({ result: detail });
  });

  r.post("/orchestration/tasks/:id/result/ack", requireAuth, async (req: AuthedRequest<{ id: string }>, res) => {
    const expectedVersion = Number(req.body?.expectedVersion);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      res.status(400).json({ error: "expectedVersion must be a positive integer" });
      return;
    }
    const outcome = await boundedRuntimeClient.acknowledgeTaskResult(
      req.user!.id,
      req.params.id,
      expectedVersion,
    );
    if (!outcome.ok) {
      res.status(outcome.reason === "not_found" ? 404 : 409).json({ error: outcome.reason });
      return;
    }
    res.json(outcome);
  });
}
