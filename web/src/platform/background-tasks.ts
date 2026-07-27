import { useEffect, useRef, useState } from "react";
import type { WsClient } from "./ws";
import type { ServerEvent, SessionStatus, SessionInfo, SandboxKind } from "@shared/protocol";
import { notifyBackground } from "./notify";
import { useT } from "../i18n";
import {
  applySessionActivity,
  removeSessionActivity,
  replaceSessionActivities,
} from "./session-activity-state";

export interface BackgroundTask {
  id: string;
  title: string;
}

export function useBackgroundTasks(
  ws: WsClient | null,
  activeId: string | null,
  titleOf: (id: string) => string,
  onStatus?: (sessionId: string, status: SessionStatus) => void,
  onSessionListEvent?: (
    ev:
      | { type: "created"; session: SessionInfo }
      | { type: "renamed"; sessionId: string; title: string }
      | { type: "deleted"; sessionId: string }
      | { type: "sandbox"; sessionId: string; kind: SandboxKind; targetId: string | null }
      | { type: "invalidate"; sessionId: string },
  ) => void,
): BackgroundTask[] {
  const t = useT();
  const [running, setRunning] = useState<Record<string, true>>({});
  const titleRef = useRef(titleOf);
  titleRef.current = titleOf;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const onListRef = useRef(onSessionListEvent);
  onListRef.current = onSessionListEvent;

  useEffect(() => {
    if (!ws) return;
    const handle = (ev: ServerEvent) => {
      if (ev.type === "session_status") {
        onStatusRef.current?.(ev.sessionId, ev.status);
      } else if (ev.type === "session_activity") {
        setRunning((cur) => applySessionActivity(cur, ev.sessionId, ev.activity));
      } else if (ev.type === "session_activity_snapshot") {
        setRunning((cur) => replaceSessionActivities(cur, ev.activities));
      } else if (ev.type === "session_created") {
        onListRef.current?.({ type: "created", session: ev.session });
      } else if (ev.type === "session_renamed") {
        onListRef.current?.({ type: "renamed", sessionId: ev.sessionId, title: ev.title });
      } else if (ev.type === "session_deleted") {
        setRunning((cur) => removeSessionActivity(cur, ev.sessionId));
        onListRef.current?.({ type: "deleted", sessionId: ev.sessionId });
      } else if (ev.type === "sandbox_changed") {
        onListRef.current?.({ type: "sandbox", sessionId: ev.sessionId, kind: ev.kind, targetId: ev.targetId ?? null });
      } else if (ev.type === "session_rewound") {
        onListRef.current?.({ type: "invalidate", sessionId: ev.sessionId });
      } else if (ev.type === "session_wake") {
        const title = ev.title || titleRef.current(ev.sessionId);
        if (ev.kind === "done") notifyBackground("oiia", t("notify.done", { title }), `done-${ev.sessionId}`);
        else if (ev.kind === "approval") notifyBackground("oiia", t("notify.bgPerm", { title }), `perm-${ev.sessionId}`);
        else if (ev.kind === "error") notifyBackground("oiia", t("notify.bgError", { title }), `err-${ev.sessionId}`);
      }
    };
    const unsubMsg = ws.addHandler(handle);
    const subscribe = () => ws.send({ type: "subscribe_status" });
    const unsubConn = ws.onConnect((connected) => {
      if (connected) subscribe();
    });
    if (ws.connected) subscribe();
    return () => {
      unsubMsg();
      unsubConn();
    };
  }, [ws, t]);

  return Object.keys(running).flatMap((id) =>
    id !== activeId ? [{ id, title: titleOf(id) }] : [],
  );
}
