import crypto from "node:crypto";
import type express from "express";
import { automationDao, keyDao } from "../../persistence/index.ts";
import { boundedRuntimeClient } from "../../runtime/runtime-client.ts";
import { listModelsForProviders } from "../../runtime/providers.ts";
import { executionDenial } from "../../identity/access-gate.ts";
import { chooseAutomaticExecutor } from "../../../../shared/src/executor-selection.ts";
import { type AuthedRequest, requireAuth, sendAccessDenial } from "../route-helpers.ts";

const MIN_INTERVAL = 5;
const MAX_INTERVAL = 10080;
const MAX_AUTOMATIONS = Number(process.env.AGENT_WEB_MAX_AUTOMATIONS || 10);

function automationInfo(a: {
  id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  enabled: number;
  last_run_at: number | null;
  session_id: string;
  created_at: number;
}) {
  return {
    id: a.id,
    name: a.name,
    prompt: a.prompt,
    intervalMinutes: a.interval_minutes,
    enabled: a.enabled === 1,
    lastRunAt: a.last_run_at,
    sessionId: a.session_id,
    createdAt: a.created_at,
  };
}

export function registerAutomationRoutes(r: express.Router): void {
  r.get("/automations", requireAuth, (req: AuthedRequest, res) => {
    res.json({ automations: automationDao.listForUser(req.user!.id).map(automationInfo) });
  });

  r.post("/automations", requireAuth, async (req: AuthedRequest, res) => {
    try {
      const name = String(req.body?.name ?? "").trim().slice(0, 120);
      const prompt = String(req.body?.prompt ?? "").trim().slice(0, 8000);
      const intervalMinutes = Number(req.body?.intervalMinutes);
      if (!name || !prompt) {
        res.status(400).json({ error: "name and prompt are required" });
        return;
      }
      if (!Number.isInteger(intervalMinutes) || intervalMinutes < MIN_INTERVAL || intervalMinutes > MAX_INTERVAL) {
        res.status(400).json({ error: `intervalMinutes must be an integer between ${MIN_INTERVAL} and ${MAX_INTERVAL}` });
        return;
      }
      if (automationDao.listForUser(req.user!.id).length >= MAX_AUTOMATIONS) {
        res.status(400).json({ error: `automation limit reached (max ${MAX_AUTOMATIONS})` });
        return;
      }
      const models = listModelsForProviders(keyDao.list(req.user!.id).map((k) => k.provider));
      const model = models.find((m) => !m.mock) ?? models[0];
      if (!model) {
        res.status(400).json({ error: "no model available — add a provider key first" });
        return;
      }
      const executors = await boundedRuntimeClient.getExecutorAvailability();
      let execution = chooseAutomaticExecutor(executors, []);
      if (!execution) {
        execution = chooseAutomaticExecutor(executors, await boundedRuntimeClient.connectorList(req.user!.id));
      }
      if (!execution) {
        throw new Error(
          "No execution environment is available. Connect your own computer to use file uploads and execution tools.",
        );
      }
      const session = await boundedRuntimeClient.createSession(req.user!, {
        title: "⏱ " + name,
        provider: model.provider,
        model: model.id,
        sandboxMode: "workspace-write",
        sandboxKind: execution.kind,
        sandboxTargetId: execution.targetId,
        mode: "coding",
        approvalPolicy: "never",
      });
      const row = {
        id: "auto_" + crypto.randomUUID(),
        user_id: req.user!.id,
        session_id: session.id,
        name,
        prompt,
        interval_minutes: intervalMinutes,
        enabled: 1,
        last_run_at: null,
        created_at: Date.now(),
      };
      automationDao.create(row);
      res.json({ automation: automationInfo(row) });
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : "create failed" });
    }
  });

  r.patch("/automations/:id", requireAuth, (req: AuthedRequest, res) => {
    const a = automationDao.byId(req.user!.id, String(req.params.id));
    if (!a) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (typeof req.body?.enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required" });
      return;
    }
    automationDao.setEnabled(req.user!.id, a.id, req.body.enabled);
    res.json({ automation: automationInfo({ ...a, enabled: req.body.enabled ? 1 : 0 }) });
  });

  r.delete("/automations/:id", requireAuth, (req: AuthedRequest, res) => {
    const a = automationDao.byId(req.user!.id, String(req.params.id));
    if (!a) {
      res.status(404).json({ error: "not found" });
      return;
    }
    automationDao.delete(req.user!.id, a.id);
    res.json({ ok: true });
  });

  r.post("/automations/:id/run-now", requireAuth, async (req: AuthedRequest, res) => {
    const a = automationDao.byId(req.user!.id, String(req.params.id));
    if (!a) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const denial = executionDenial(a.user_id, { includeDraining: true });
    if (denial) { sendAccessDenial(res, denial); return; }
    const r2 = await boundedRuntimeClient.tryStartTurn(a.user_id, a.session_id, a.prompt);
    if ("error" in r2) {
      res.status(r2.error === "busy" ? 409 : 404).json({ error: r2.error === "busy" ? "busy" : "session not found" });
      return;
    }
    automationDao.setLastRun(a.id, Date.now());
    res.json({ ok: true });
  });
}
