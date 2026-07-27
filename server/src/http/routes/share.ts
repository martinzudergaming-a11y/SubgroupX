import type express from "express";
import { sessionDao, shareDao, timelineDao } from "../../persistence/index.ts";
import { boundedRuntimeClient } from "../../runtime/runtime-client.ts";
import { buildShareSnapshot, redactTitle } from "../../sharing/redact.ts";
import { listModelsForProviders } from "../../runtime/providers.ts";
import {
  type AuthedRequest,
  requireAuth,
  isLoopback,
  shareAllowed,
  SHARE_TOKEN_RE,
  mintShareToken,
  setShareSecurityHeaders,
  publicOrigin,
} from "../route-helpers.ts";

export function registerShareRoutes(r: express.Router): void {
  r.get("/share/:token", (req: AuthedRequest, res) => {
    setShareSecurityHeaders(res);
    const ip = req.ip ?? "";
    if (!isLoopback(ip) && !shareAllowed(ip)) {
      res.status(429).json({ error: "too many requests" });
      return;
    }
    const token = String(req.params.token);
    if (!SHARE_TOKEN_RE.test(token)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const row = shareDao.byToken(token);
    if (!row || row.revoked_at) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const m = JSON.parse(row.meta_json) as Record<string, unknown>;
    const itemCount = typeof m.itemCount === "number" ? m.itemCount : 0;
    res.json({
      title: row.title,
      items: JSON.parse(row.snapshot_json),
      meta: {
        model: m.model,
        provider: m.provider,
        createdAt: m.createdAt,
        itemCount,
        reasoning: m.reasoning,
        contextWindow: m.contextWindow,
        scope: m.scope === "selected" ? "selected" : "full",
        detailed: m.detailed === true,
      },
      createdAt: row.created_at,
      originalCount: typeof m.originalCount === "number" ? m.originalCount : itemCount,
      truncated: m.truncated === true,
      sharedVia: "oiia",
    });
  });

  r.get("/self/:token/trajectory", (req: AuthedRequest, res) => {
    setShareSecurityHeaders(res);
    const ip = req.ip ?? "";
    if (!isLoopback(ip) && !shareAllowed(ip)) {
      res.status(429).json({ error: "too many requests" });
      return;
    }
    const token = String(req.params.token);
    if (!SHARE_TOKEN_RE.test(token)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const sessionId = sessionDao.idBySelfToken(token);
    if (!sessionId) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const after = Math.max(0, Math.floor(Number(req.query.after)) || 0);
    const limitRaw = Math.floor(Number(req.query.limit)) || 200;
    const limit = Math.min(500, Math.max(1, limitRaw));
    const page = timelineDao.listPage(sessionId, after, limit, 1_500_000);
    res.json({
      items: page.items,
      total: page.total,
      nextAfter: page.hasMore && page.items.length > 0 ? page.items[page.items.length - 1].seq : null,
    });
  });

  r.post("/sessions/:id/share", requireAuth, async (req: AuthedRequest, res) => {
    const session = await boundedRuntimeClient.getSessionInfo(req.user!.id, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const SCOPE_ID_CAP = 5000;
    const rawScope = (req.body as { scope?: { itemIds?: unknown } } | undefined)?.scope;
    let idSet: Set<string> | null = null;
    if (rawScope && Array.isArray(rawScope.itemIds)) {
      idSet = new Set(
        rawScope.itemIds.filter((x): x is string => typeof x === "string").slice(0, SCOPE_ID_CAP),
      );
    }
    const detailed = (req.body as { detailed?: unknown } | undefined)?.detailed === true;
    const raw = timelineDao.list(session.id);
    const selected = idSet ? raw.filter((i) => idSet!.has(i.id)) : raw;
    const { items, itemCount, originalCount, truncated } = buildShareSnapshot(selected, { detailed });
    const isSelected = !!idSet && selected.length < raw.length;
    const scope: "full" | "selected" = isSelected ? "selected" : "full";
    const token = mintShareToken();
    const now = Date.now();
    const modelInfo = listModelsForProviders([session.provider]).find(
      (mi) => mi.provider === session.provider && mi.id === session.model,
    );
    const meta = {
      model: session.model,
      provider: session.provider,
      createdAt: session.createdAt,
      itemCount,
      ...(modelInfo ? { reasoning: modelInfo.reasoning, contextWindow: modelInfo.contextWindow, modelName: modelInfo.name } : {}),
    };
    shareDao.create({
      token,
      session_id: session.id,
      created_by: req.user!.id,
      title: redactTitle(session.title),
      snapshot_json: JSON.stringify(items),
      meta_json: JSON.stringify({ ...meta, originalCount, truncated, scope, detailed }),
      created_at: now,
      revoked_at: null,
    });
    res.json({ token, url: `${publicOrigin(req)}/share/${token}`, createdAt: now, itemCount });
  });

  r.get("/sessions/:id/shares", requireAuth, async (req: AuthedRequest, res) => {
    const session = await boundedRuntimeClient.getSessionInfo(req.user!.id, req.params.id);
    if (!session) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const shares = shareDao.listForSession(req.user!.id, session.id).map((s) => ({
      token: s.token,
      url: `${publicOrigin(req)}/share/${s.token}`,
      createdAt: s.created_at,
    }));
    res.json({ shares });
  });

  r.delete("/share/:token", requireAuth, (req: AuthedRequest, res) => {
    const token = String(req.params.token);
    if (!SHARE_TOKEN_RE.test(token)) {
      res.status(404).json({ error: "not found" });
      return;
    }
    const ok = shareDao.revoke(req.user!.id, token);
    res.status(ok ? 200 : 404).json({ ok });
  });
}
