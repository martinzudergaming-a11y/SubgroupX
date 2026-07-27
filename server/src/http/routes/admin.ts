import type express from "express";
import { type AuthedUser } from "../../identity/auth.ts";
import { userDao, sessionDao, requestCaptureDao } from "../../persistence/index.ts";
import { unpackCapture } from "../../runtime/capture.ts";
import { replayOperatorRequest } from "../../runtime/replay.ts";
import { banUser, unbanUser } from "../../identity/ban.ts";
import { disposeUserRuntimesEverywhere } from "../../runtime/runtime-client.ts";
import { JAIL_PROVIDER } from "../../runtime/providers.ts";
import { logAudit } from "../../observability/audit-log.ts";
import { type AuthedRequest, requireAuth, requireAdmin } from "../route-helpers.ts";

function logAdminCaptureRead(actor: AuthedUser, sessionId: string, messageId: string | null): void {
  logAudit("admin_capture_read", {
    level: "warn",
    userId: actor.id,
    sessionId,
    data: { actorEmail: actor.email, messageId },
  });
}

function logAdminReplay(actor: AuthedUser, sessionId: string, messageId: string): void {
  logAudit("admin_capture_replay", {
    level: "warn",
    userId: actor.id,
    sessionId,
    data: { actorEmail: actor.email, messageId },
  });
}

export function registerAdminRoutes(r: express.Router): void {
  r.post("/admin/users/ban", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const { email, reason } = req.body ?? {};
    const target = userDao.byEmail(String(email ?? "").trim().toLowerCase());
    if (!target) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    if (target.id === req.user!.id) {
      res.status(400).json({ error: "you can't suspend your own account" });
      return;
    }
    banUser(target.id, typeof reason === "string" && reason.trim() ? reason.trim().slice(0, 500) : null);
    const disposed = await disposeUserRuntimesEverywhere(target.id);
    logAudit("admin_user_ban", {
      level: "warn",
      userId: req.user!.id,
      data: { actorEmail: req.user!.email, targetId: target.id, targetEmail: target.email, disposed },
    });
    res.json({ ok: true, email: target.email });
  });

  r.post("/admin/users/unban", requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const { email } = req.body ?? {};
    const target = userDao.byEmail(String(email ?? "").trim().toLowerCase());
    if (!target) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    unbanUser(target.id);
    logAudit("admin_user_unban", {
      level: "warn",
      userId: req.user!.id,
      data: { actorEmail: req.user!.email, targetId: target.id, targetEmail: target.email },
    });
    res.json({ ok: true, email: target.email });
  });

  r.get("/admin/sessions/:id/captures", requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const session = sessionDao.byId(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    logAdminCaptureRead(req.user!, session.id, null);
    res.json({ captures: requestCaptureDao.listMeta(session.id) });
  });

  r.get("/admin/sessions/:id/captures/:messageId", requireAuth, requireAdmin, (req: AuthedRequest, res) => {
    const session = sessionDao.byId(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const row = requestCaptureDao.get(session.id, String(req.params.messageId));
    if (!row) {
      res.status(404).json({ error: "not found" });
      return;
    }
    logAdminCaptureRead(req.user!, session.id, row.message_id);
    res.json({
      sessionId: row.session_id,
      messageId: row.message_id,
      provider: row.provider,
      model: row.model,
      request: unpackCapture(row.request_json),
      responseMeta: row.response_meta_json ? JSON.parse(row.response_meta_json) : null,
      responseMsg: unpackCapture(row.response_msg_json),
      createdAt: row.created_at,
    });
  });

  r.post("/admin/sessions/:id/captures/:messageId/replay", requireAuth, requireAdmin, async (req: AuthedRequest, res) => {
    const session = sessionDao.byId(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    if (session.provider !== JAIL_PROVIDER) {
      res.status(400).json({ error: `replay is only supported for the ${JAIL_PROVIDER} provider` });
      return;
    }
    const request = (req.body as { request?: unknown } | undefined)?.request;
    if (!request || typeof request !== "object") {
      res.status(400).json({ error: "body must be { request: <object> }" });
      return;
    }
    logAdminReplay(req.user!, session.id, String(req.params.messageId));
    const result = await replayOperatorRequest(request);
    res.json(result);
  });
}
