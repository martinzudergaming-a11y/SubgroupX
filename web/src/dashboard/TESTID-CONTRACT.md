# Dashboard wiring and testid contract

The frontend renders persisted product state. It does not infer orchestration from tool names.

The product nouns are distinct:

- A Session is one durable conversation container.
- An Agent is one addressable runtime identity.
- A Task is durable work assigned to an Agent.
- A Background Task can outlive its parent Turn.
- A Workflow is a durable dependency graph.
- An Agent Team contains real member Sessions and a separate mail ledger.

A nested `spawn_subagent` Timeline is legacy transcript evidence. It is not the Team or Run read model.

Backend reality (what's real, to wire to):
- `api` (web/src/platform/api.ts): signup/login/me, providers/setKey/deleteKey/models, sessions/
  createSession/deleteSession, files/readFile.
- `WsClient` (web/src/platform/ws.ts): subscribe/send_message/interrupt/permission_response;
  receives timeline_replay, agent_event{epoch,seq,event}, permission_request/resolved,
  session_status.
- `reduceTimeline` (shared/src/timeline-reducer.ts): folds wire events into TimelineItem[],
  including subagent_event → parent tool item `.children` (nested timeline) and `toolKind`.
- `server/src/orchestration/read-model.ts` owns browser-safe Run and global Agents projections.
- Team mail stays outside user and assistant Messages.

Required `data-testid`s (the Playwright suite depends on these EXACT ids):

Login.tsx (already present): email, password, auth-submit, toggle-mode, auth-error
LeftSidebar.tsx: new-session (button) · open-settings (nav→settings view) · logout ·
  `.session-item` (class on each session row, contains the title text) · `.session-del`
  (delete control inside a row) · `.session-share` (share control inside a row, opens the
  share dialog) · empty state text exactly "No sessions yet."
ShareDialog.tsx: share-dialog (container) · share-create (button) · share-url (read-only link
  input) · share-copy (copy button) · share-revoke (per-link revoke control)
NewSession.tsx: new-session-modal (container) · new-session-overlay · ns-title · ns-mode
  (fieldset) · ns-mode-cards · ns-mode-card-{coding|bold|pentest|exploit} (radio inputs) ·
  ns-mode-option-{coding|bold|pentest|exploit} (visible cards) · ns-model
  (select) · ns-sandbox (select) · ns-approval (select) · ns-create (button). Modal hides after create.
SettingsView.tsx: settings-modal (the view container) · `.key-row` per provider (contains
  the provider name text, a password input, a Save button; if a key exists, a Remove button)
MainContent.tsx: composer (textarea) · composer-shell (responsive composer surface) · send (button) · interrupt (button, shown while running)
  · timeline (scroll container) · msg-user · msg-assistant (contains assistant text) ·
  `tool-<name>` (e.g. tool-bash, tool-write_file, tool-spawn_subagent, tool-mcp__demo__echo)
  · tool-status (status pill inside a tool) · tool-result (result <pre>) · tool-file-link
  (clickable path for read/write/edit tools → calls onOpenFile) · permission · perm-summary ·
  perm-approve · perm-approve-session · perm-deny · subagent-timeline (nested children container
  inside a spawn_subagent tool) · session-status
RightSidebar.tsx: workspace-rail (desktop activity rail) · file-<name> (each file row) ·
  file-view (preview container). FilePreview/PdfPreview: file-header · pdf-preview · pdf-toolbar ·
  pdf-stage; the integrated toolbar remains a DOM descendant of pdf-preview. RunInspector:
  run-inspector · run-list · run-agent-<id> · run-task-<id> · run-agent-detail · run-task-detail.
AgentsView: agents-view · agents-tab-<section> · activity-row-<id> · activity-detail ·
  workflow-row-<id> · workflow-detail · team-row-<id> · team-detail · team-mail-<id> ·
  team-mail-detail.

Render rules:
- Tools: icon/affordance by `item.toolKind` (shell|read|write|edit|list|subagent|external|
  other); file-link when toolKind ∈ {read,write,edit} and `item.path` set.
- Subagent: a `spawn_subagent` tool item has `item.children: TimelineItem[]` — render them
  as a nested timeline (`subagent-timeline`) using the SAME row renderer recursively.
- Status pill text must be exactly the status string (streaming_args|pending|approved|running|success|error|denied).
