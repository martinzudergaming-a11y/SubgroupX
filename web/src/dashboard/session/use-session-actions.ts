/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import { api } from '../../platform/api.ts';
import { chooseAutomaticExecutor, modelExecutorAvailability } from '../../platform/executors';
import { navigate } from '../../platform/router';
import { showToast } from '../../platform/toast';
import { useT } from '../../i18n';
import { deriveSessionTitle } from '../app-helpers';
import type { ApprovalPolicy, SessionInfo, ThinkingLevel } from '@shared/protocol';

export function useSessionActions(params: {
  activeSession: SessionInfo | null;
  setSessions: Dispatch<SetStateAction<SessionInfo[]>>;
  setActiveSession: Dispatch<SetStateAction<SessionInfo | null>>;
  openSession: (session: SessionInfo, opts?: { replace?: boolean }) => void;
  setSessionsLoaded: Dispatch<SetStateAction<boolean>>;
  activeSessionRef: { current: SessionInfo | null };
}) {
  const {
    activeSession,
    setSessions,
    setActiveSession,
    openSession,
    setSessionsLoaded,
    activeSessionRef,
  } = params;
  const t = useT();
  const defaultSessionRef = useRef<Promise<void> | null>(null);

  const renameSession = useCallback(async (id: string, rawTitle: string) => {
    const title = rawTitle.trim().slice(0, 120);
    if (!title) return;
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, title } : s)));
    setActiveSession((cur) => (cur && cur.id === id ? { ...cur, title } : cur));
    try {
      await api.renameSession(id, title);
    } catch {
      const res = await api.sessions().catch(() => null);
      if (res) setSessions(res.sessions);
    }
  }, []);

  const forkSession = useCallback(async (fromSeq: number) => {
    const src = activeSession;
    if (!src) return;
    try {
      const { session } = await api.forkSession(src.id, fromSeq);
      setSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]));
      openSession(session);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('fork.failed'));
    }
  }, [activeSession, t]);

  const setThinkingLevel = useCallback(async (id: string, level: ThinkingLevel) => {
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, thinkingLevel: level } : s)));
    setActiveSession((cur) => (cur && cur.id === id ? { ...cur, thinkingLevel: level } : cur));
    try {
      await api.setThinkingLevel(id, level);
    } catch {
      const res = await api.sessions().catch(() => null);
      if (res) setSessions(res.sessions);
    }
  }, []);

  const setApprovalPolicy = useCallback(async (id: string, policy: ApprovalPolicy) => {
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, approvalPolicy: policy } : s)));
    setActiveSession((cur) => (cur && cur.id === id ? { ...cur, approvalPolicy: policy } : cur));
    try {
      await api.setApprovalPolicy(id, policy);
    } catch {
      const res = await api.sessions().catch(() => null);
      if (res) setSessions(res.sessions);
    }
  }, []);

  const setModel = useCallback(async (id: string, provider: string, model: string) => {
    setSessions((cur) => cur.map((s) => (s.id === id ? { ...s, provider, model } : s)));
    setActiveSession((cur) => (cur && cur.id === id ? { ...cur, provider, model } : cur));
    try {
      await api.setModel(id, provider, model);
    } catch {
      const res = await api.sessions().catch(() => null);
      if (res) setSessions(res.sessions);
    }
  }, []);

  const handleAutoTitle = useCallback(
    (id: string, currentTitle: string, text: string) => {
      const defaultTitle = t('session.untitled');
      if (currentTitle !== defaultTitle) return;
      const title = deriveSessionTitle(text, defaultTitle);
      if (title && title !== defaultTitle) void renameSession(id, title);
    },
    [renameSession, t],
  );

  const ensureDefaultSession = useCallback((): Promise<void> => {
    if (defaultSessionRef.current) return defaultSessionRef.current;
    const pending = (async () => {
      try {
        const modelResponse = await api.models();
        const { models } = modelResponse;
        const model = models.find((m) => !m.mock);
        if (!model) return;
        const executors = modelExecutorAvailability(modelResponse);
        let execution = chooseAutomaticExecutor(executors, []);
        if (!execution) {
          const { connectors } = await api.connectors().catch(() => ({ connectors: [] }));
          execution = chooseAutomaticExecutor(executors, connectors);
        }
        if (!execution) return;
        const { session } = await api.createSession({
          title: t('session.untitled'),
          provider: model.provider,
          model: model.id,
          sandboxMode: 'danger-full-access',
          sandboxKind: execution.kind,
          sandboxTargetId: execution.targetId,
          mode: 'coding',
          approvalPolicy: 'never',
        });
        setSessions((cur) => (cur.some((s) => s.id === session.id) ? cur : [session, ...cur]));
        openSession(session, { replace: true });
      } catch {
        defaultSessionRef.current = null;
      }
    })();
    defaultSessionRef.current = pending;
    return pending;
  }, [t]);

  const refreshSessions = useCallback(async () => {
    const res = await api.sessions();
    setSessions(res.sessions);
    if (res.sessions.length === 0) {
      await ensureDefaultSession();
      setSessionsLoaded(true);
      return;
    }
    if (window.location.pathname.startsWith('/s/')) {
      setSessionsLoaded(true);
      return;
    }
    const cur = activeSessionRef.current;
    const picked = cur
      ? res.sessions.find((session) => session.id === cur.id) ?? res.sessions[0] ?? null
      : res.sessions[0] ?? null;
    setActiveSession(picked);
    if (picked && window.location.pathname === '/') navigate(`/s/${picked.id}`, { replace: true });
    setSessionsLoaded(true);
  }, [ensureDefaultSession, setSessionsLoaded]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  return { renameSession, forkSession, setThinkingLevel, setApprovalPolicy, setModel, handleAutoTitle };
}
