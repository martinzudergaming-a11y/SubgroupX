import { ArrowLeft, ArrowUpRight, Braces, Mail, Users } from "lucide-react";
import { useT } from "../../../i18n";
import { Link, navigate } from "../../../platform/router";
import { OrchestrationStatus, useRelativeTime } from "../../../orchestration/OrchestrationStatus";
import { OrchestrationEmpty, ReadModelError, ReadModelLoading } from "../../../orchestration/ReadModelBoundary";
import {
  useTeamDetailReadModel,
  useTeamMailDetailReadModel,
  useTeamMailReadModel,
  type TeamSummaryRow,
} from "../../../orchestration/read-model";
import {
  AgentsMasterDetail,
  DefinitionRow,
  DetailHeader,
  MasterListHeader,
  masterRowClass,
} from "./AgentsMasterDetail";

export function TeamsSection({ items, selectedId, selectedMailId, partial }: {
  items: TeamSummaryRow[];
  selectedId?: string;
  selectedMailId?: string;
  partial: boolean;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const selectedSummary = selectedId ? items.find((item) => item.id === selectedId) : undefined;

  if (items.length === 0 && !selectedId) {
    return <OrchestrationEmpty title={t("agents.teams.emptyTitle")} detail={t("agents.teams.emptyDetail")} />;
  }

  return (
    <AgentsMasterDetail
      listLabel={t("agents.teams.title")}
      detailOpen={Boolean(selectedId)}
      onBack={() => navigate("/agents/teams")}
      list={(
        <>
          <MasterListHeader title={t("agents.teams.title")} count={partial ? `${items.length}+` : items.length} />
          <div className="min-h-0 flex-1 overflow-y-auto hide-scrollbar">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                data-testid={`team-row-${item.id}`}
                onClick={() => navigate(`/agents/teams/${encodeURIComponent(item.id)}`)}
                className={masterRowClass(item.id === selectedId)}
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <span className="min-w-0">
                    <span className="block truncate text-[12.5px] font-medium">{item.name}</span>
                    <span className="mt-1 block truncate text-[11.5px] text-[#7F837C] dark:text-[#858A82]">{item.ownerSessionTitle || t("agents.teams.ownerUnavailable")}</span>
                  </span>
                  <OrchestrationStatus value={item.status} compact />
                </div>
                <div className="mt-2 flex items-center justify-between text-[10.5px] text-[#777C74] dark:text-[#92968F]">
                  <span>{t("agents.teams.activeCount", { active: item.activeMemberCount, total: item.memberCount })}</span>
                  <span>{item.openWork > 0 ? t("agents.teams.openWork", { count: item.openWork }) : relativeTime(item.updatedAt)}</span>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
      detail={selectedId
        ? <TeamDetail id={selectedId} summary={selectedSummary} selectedMailId={selectedMailId} />
        : <OrchestrationEmpty title={t("agents.selectTitle")} detail={t("agents.selectDetail")} />}
    />
  );
}

function TeamDetail({ id, summary, selectedMailId }: {
  id: string;
  summary?: TeamSummaryRow;
  selectedMailId?: string;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useTeamDetailReadModel(id);
  if (state.status === "loading") return <ReadModelLoading rows={6} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  const team = state.data;
  const sessionNames = new Map(team.members.map((member) => [member.sessionId, member.sessionTitle]));
  if (selectedMailId) {
    return <MailDetail teamId={id} mailId={selectedMailId} sessionNames={sessionNames} />;
  }
  const ownerName = summary?.ownerSessionTitle
    || (team.ownerSessionId ? sessionNames.get(team.ownerSessionId) : undefined)
    || (team.ownerSessionId ? sessionReference(team.ownerSessionId, t("agents.teams.session")) : undefined)
    || t("agents.teams.ownerUnavailable");
  return (
    <article data-testid="team-detail">
      <DetailHeader
        eyebrow={t("agents.teams.team")}
        title={team.name}
        trailing={<OrchestrationStatus value={team.status} />}
      />
      <dl className="border-b border-[#DDE1D8] dark:border-[#383B37]">
        <DefinitionRow label={t("agents.teams.owner")}>{ownerName}</DefinitionRow>
        <DefinitionRow label={t("agents.teams.members")}>{t("agents.teams.memberCount", { count: team.memberCount })}</DefinitionRow>
        <DefinitionRow label={t("agents.teams.openWorkLabel")}>{team.openWork}</DefinitionRow>
        <DefinitionRow label={t("agents.activity.updated")}>{relativeTime(team.updatedAt)}</DefinitionRow>
      </dl>

      <section className="border-b border-[#DDE1D8] dark:border-[#383B37]">
        <div className="flex h-9 items-center gap-2 px-5 @2xl/agents-body:px-7">
          <Users className="size-3.5 text-[#858981] dark:text-[#777C74]" strokeWidth={1.5} />
          <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#777C74]">{t("agents.teams.memberSessions")}</h3>
        </div>
        <div className="border-t border-[#E8EBE3] dark:border-[#343632]">
          {team.members.map((member) => (
            <Link
              key={member.id}
              to={`/s/${member.sessionId}`}
              className="group grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#EEF0EB] px-5 last:border-b-0 hover:bg-black/[0.025] dark:border-[#30322F] dark:hover:bg-white/[0.035] @2xl/agents-body:px-7"
            >
              <span className="min-w-0">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-[12.5px] font-medium text-[#3A3E38] dark:text-[#D7DAD4]">{member.sessionTitle}</span>
                  <span className="shrink-0 text-[10.5px] text-[#92968F] dark:text-[#72766F]">{member.role}</span>
                </span>
                <span className="mt-1 block truncate text-[11px] text-[#858981] dark:text-[#777C74]">{relativeTime(member.updatedAt)}</span>
              </span>
              <span className="flex items-center gap-2">
                <OrchestrationStatus value={member.status} />
                <ArrowUpRight className="size-3.5 text-[#9A9E97] group-hover:text-[#555A53] dark:group-hover:text-[#C5C8C1]" />
              </span>
            </Link>
          ))}
          {team.membersPartial && <p className="px-5 py-2 text-[10.5px] text-[#777C74] dark:text-[#92968F] @2xl/agents-body:px-7">{t("agents.teams.partialMembers")}</p>}
        </div>
      </section>

      <TeamMailLedger teamId={id} sessionNames={sessionNames} />
    </article>
  );
}

function TeamMailLedger({ teamId, sessionNames }: {
  teamId: string;
  sessionNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useTeamMailReadModel(teamId);
  return (
    <section>
      <div className="flex h-9 items-center gap-2 px-5 @2xl/agents-body:px-7">
        <Mail className="size-3.5 text-[#858981] dark:text-[#777C74]" strokeWidth={1.5} />
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#777C74]">{t("agents.teams.mail")}</h3>
      </div>
      <div className="border-t border-[#E8EBE3] dark:border-[#343632]">
        {state.status === "loading" ? <ReadModelLoading rows={3} /> : state.status === "error" ? <ReadModelError onRetry={retry} /> : state.data.items.length === 0 ? (
          <p className="px-5 py-4 text-[12px] text-[#8C9089] dark:text-[#858A82] @2xl/agents-body:px-7">{t("agents.teams.noMail")}</p>
        ) : (
          <>
            {state.data.items.map((message) => (
              <Link
                key={message.id}
                to={`/agents/teams/${encodeURIComponent(teamId)}/mail/${encodeURIComponent(message.id)}`}
                data-testid={`team-mail-${message.id}`}
                className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-[#EEF0EB] px-5 last:border-b-0 hover:bg-black/[0.025] dark:border-[#30322F] dark:hover:bg-white/[0.035] @2xl/agents-body:px-7"
              >
                <span className="min-w-0">
                  <span className="block truncate text-[12.5px] font-medium text-[#3A3E38] dark:text-[#D7DAD4]">{message.subject}</span>
                  <span className="mt-1 block truncate text-[11px] text-[#858981] dark:text-[#777C74]">
                    {message.kind} · {sessionNames.get(message.sourceSessionId) ?? message.sourceSessionId.slice(-6)} → {sessionNames.get(message.targetSessionId) ?? message.targetSessionId.slice(-6)}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <OrchestrationStatus value={message.status} compact />
                  <span className="text-[10.5px] tabular-nums text-[#777C74] dark:text-[#92968F]">{relativeTime(message.createdAt)}</span>
                </span>
              </Link>
            ))}
            {state.data.nextCursor && (
              <p className="border-t border-[#E8EBE3] px-5 py-2 text-[10.5px] text-[#777C74] dark:border-[#343632] dark:text-[#92968F] @2xl/agents-body:px-7">
                {t("agents.teams.partialMail")}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function sessionReference(sessionId: string, label: string): string {
  const suffix = sessionId.slice(-6);
  return suffix ? `${label} …${suffix}` : label;
}

function MailDetail({ teamId, mailId, sessionNames }: {
  teamId: string;
  mailId: string;
  sessionNames: ReadonlyMap<string, string>;
}) {
  const t = useT();
  const relativeTime = useRelativeTime();
  const { state, retry } = useTeamMailDetailReadModel(teamId, mailId);
  if (state.status === "loading") return <ReadModelLoading rows={5} />;
  if (state.status === "error") return <ReadModelError onRetry={retry} />;
  const mail = state.data;
  const payload = JSON.stringify(mail.payload, null, 2) ?? "null";
  const preview = payload.length > 12_000 ? `${payload.slice(0, 12_000)}\n…` : payload;
  return (
    <article data-testid="team-mail-detail">
      <Link
        to={`/agents/teams/${encodeURIComponent(teamId)}`}
        className="flex h-10 items-center gap-1.5 border-b border-[#E8EBE3] px-5 text-[12px] font-medium text-[#656A63] hover:bg-black/[0.025] dark:border-[#343632] dark:text-[#A5A9A1] dark:hover:bg-white/[0.035] @2xl/agents-body:px-7"
      >
        <ArrowLeft className="size-3.5" strokeWidth={1.7} />
        {t("agents.teams.backToTeam")}
      </Link>
      <DetailHeader
        eyebrow={t("agents.teams.mailItem")}
        title={mail.subject}
        trailing={<OrchestrationStatus value={mail.status} />}
      />
      <dl className="border-b border-[#DDE1D8] dark:border-[#383B37]">
        <DefinitionRow label={t("agents.teams.kind")}>{mail.kind}</DefinitionRow>
        <DefinitionRow label={t("agents.teams.source")}>
          {sessionNames.get(mail.sourceSessionId) ?? sessionReference(mail.sourceSessionId, t("agents.teams.session"))}
        </DefinitionRow>
        <DefinitionRow label={t("agents.teams.target")}>
          {sessionNames.get(mail.targetSessionId) ?? sessionReference(mail.targetSessionId, t("agents.teams.session"))}
        </DefinitionRow>
        <DefinitionRow label={t("agents.teams.created")}>{relativeTime(mail.createdAt)}</DefinitionRow>
      </dl>
      <section>
        <div className="flex h-9 items-center gap-1.5 px-5 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-[#858981] dark:text-[#777C74] @2xl/agents-body:px-7">
          <Braces className="size-3.5" strokeWidth={1.5} />
          {t("agents.teams.payload")}
        </div>
        <pre className="max-h-[32rem] overflow-auto border-t border-[#EEF0EB] bg-[#F7F7F3] px-5 py-4 text-[10.5px] leading-[1.55] text-[#4B5048] dark:border-[#30322F] dark:bg-[#171815] dark:text-[#BEC2BA] @2xl/agents-body:px-7">{preview}</pre>
      </section>
    </article>
  );
}
