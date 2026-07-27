export function ownedWorkflowPredicate(taskAlias: string, agentAlias: string): string {
  return `(${taskAlias}.workflow_id IS NULL OR EXISTS (
    SELECT 1 FROM workflows owned_workflow
    JOIN sessions workflow_owner
      ON workflow_owner.id = owned_workflow.owner_session_id
     AND workflow_owner.user_id = owned_workflow.user_id
    JOIN agent_nodes workflow_root
      ON workflow_root.id = owned_workflow.root_agent_id
     AND workflow_root.user_id = owned_workflow.user_id
    JOIN sessions root_session
      ON root_session.id = workflow_root.session_id
     AND root_session.user_id = workflow_root.user_id
    WHERE owned_workflow.id = ${taskAlias}.workflow_id
      AND owned_workflow.user_id = ${taskAlias}.user_id
      AND workflow_root.id = ${agentAlias}.root_agent_id
      AND workflow_root.session_id = ${taskAlias}.session_id
      AND workflow_root.root_agent_id = workflow_root.id
      AND workflow_root.parent_agent_id IS NULL
      AND workflow_root.kind = 'session'
      AND workflow_root.purpose = 'addressable'
  ))`;
}

export function trustedCrossSessionTeamRootPredicate(taskAlias: string): string {
  return `(${taskAlias}.parent_task_id IS NOT NULL
    AND ${taskAlias}.kind = 'team_turn'
    AND ${taskAlias}.team_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM runtime_tasks parent_team_task
      JOIN teams trusted_team
        ON trusted_team.id = ${taskAlias}.team_id
       AND trusted_team.user_id = ${taskAlias}.user_id
      JOIN team_mail child_work INDEXED BY idx_team_mail_work_task
        ON child_work.task_id = ${taskAlias}.id
       AND child_work.user_id = ${taskAlias}.user_id
       AND child_work.team_id = ${taskAlias}.team_id
       AND child_work.kind = 'work'
      JOIN team_mail parent_work
        ON parent_work.id = child_work.parent_mail_id
       AND parent_work.task_id = parent_team_task.id
       AND parent_work.user_id = ${taskAlias}.user_id
       AND parent_work.team_id = ${taskAlias}.team_id
       AND parent_work.kind = 'work'
      JOIN team_members source_member
        ON source_member.id = child_work.source_member_id
       AND source_member.team_id = child_work.team_id
       AND source_member.session_id = child_work.source_session_id
       AND source_member.agent_id = parent_team_task.agent_id
      JOIN team_members target_member
        ON target_member.id = child_work.target_member_id
       AND target_member.team_id = child_work.team_id
       AND target_member.session_id = child_work.target_session_id
       AND target_member.agent_id = ${taskAlias}.agent_id
      WHERE parent_team_task.id = ${taskAlias}.parent_task_id
        AND parent_team_task.user_id = ${taskAlias}.user_id
        AND parent_team_task.kind = 'team_turn'
        AND parent_team_task.team_id = ${taskAlias}.team_id
        AND parent_team_task.session_id <> ${taskAlias}.session_id
        AND parent_work.target_member_id = child_work.source_member_id
        AND parent_work.target_session_id = parent_team_task.session_id
        AND child_work.source_session_id = parent_team_task.session_id
        AND ${taskAlias}.owner_session_id = child_work.source_session_id
        AND child_work.target_session_id = ${taskAlias}.session_id
    ))`;
}

function visibleAgentClosureCte(name: string, rootSeed: string): string {
  return `${name}(id, user_id, session_id, root_agent_id, status) AS (
    ${rootSeed}
    UNION ALL
    SELECT child.id, child.user_id, child.session_id, child.root_agent_id, child.status
    FROM ${name} parent
    CROSS JOIN agent_nodes AS child INDEXED BY idx_agent_nodes_visible_children
    WHERE child.user_id = parent.user_id
      AND child.session_id = parent.session_id
      AND child.root_agent_id = parent.root_agent_id
      AND child.parent_agent_id = parent.id
      AND child.purpose = 'addressable'
  )`;
}

const SESSION_ROOT_SEED = `SELECT root.id, root.user_id, root.session_id, root.root_agent_id, root.status
  FROM agent_nodes root
  JOIN sessions root_session
    ON root_session.id = root.session_id AND root_session.user_id = root.user_id
  WHERE root.id = ? AND root.user_id = ? AND root.session_id = ?
    AND root.parent_agent_id IS NULL AND root.id = root.root_agent_id
    AND root.kind = 'session' AND root.purpose = 'addressable'`;

export const SESSION_VISIBLE_AGENT_CTE = `WITH RECURSIVE
  ${visibleAgentClosureCte("visible_agents", SESSION_ROOT_SEED)}`;

function visibleClosureCte(input: {
  rootSeed: string;
  taskRootIndex: string;
  taskRootScope: string;
}): string {
  return `WITH RECURSIVE
    ${visibleAgentClosureCte("visible_agents", input.rootSeed)},
    visible_tasks(id, user_id, session_id, status, await_policy) AS (
      SELECT task.id, task.user_id, task.session_id, task.status, task.await_policy
      FROM runtime_tasks AS task INDEXED BY ${input.taskRootIndex}
      JOIN visible_agents task_agent
        ON task_agent.id = task.agent_id
       AND task_agent.user_id = task.user_id
       AND task_agent.session_id = task.session_id
      JOIN sessions task_owner
        ON task_owner.id = task.owner_session_id
       AND task_owner.user_id = task.user_id
      WHERE ${input.taskRootScope}
        AND (task.parent_task_id IS NULL OR ${trustedCrossSessionTeamRootPredicate("task")})
        AND ${ownedWorkflowPredicate("task", "task_agent")}
      UNION ALL
      SELECT child.id, child.user_id, child.session_id, child.status, child.await_policy
      FROM visible_tasks parent
      CROSS JOIN runtime_tasks AS child INDEXED BY idx_runtime_tasks_visible_children
      JOIN visible_agents child_agent
        ON child_agent.id = child.agent_id
       AND child_agent.user_id = child.user_id
       AND child_agent.session_id = child.session_id
      JOIN sessions child_owner
        ON child_owner.id = child.owner_session_id
       AND child_owner.user_id = child.user_id
      WHERE child.user_id = parent.user_id
        AND child.session_id = parent.session_id
        AND child.parent_task_id = parent.id
        AND ${ownedWorkflowPredicate("child", "child_agent")}
    )`;
}

export const ACCOUNT_VISIBLE_ORCHESTRATION_CTE = visibleClosureCte({
  rootSeed: `SELECT root.id, root.user_id, root.session_id, root.root_agent_id, root.status
    FROM agent_nodes AS root INDEXED BY idx_agent_nodes_visible_roots
    JOIN sessions root_session
      ON root_session.id = root.session_id AND root_session.user_id = root.user_id
    WHERE root.user_id = ? AND root.parent_agent_id IS NULL
      AND root.id = root.root_agent_id
      AND root.kind = 'session' AND root.purpose = 'addressable'`,
  taskRootIndex: "idx_runtime_tasks_visible_roots",
  taskRootScope: "task.user_id = ?",
});

export const SESSION_VISIBLE_ORCHESTRATION_CTE = visibleClosureCte({
  rootSeed: SESSION_ROOT_SEED,
  taskRootIndex: "idx_runtime_tasks_visible_children",
  taskRootScope: "task.user_id = ? AND task.session_id = ?",
});

export const TASK_DETAIL_VISIBILITY_CTE = `WITH RECURSIVE
  target_task(id, user_id, session_id, agent_id, parent_task_id) AS MATERIALIZED (
    SELECT task.id, task.user_id, task.session_id, task.agent_id, task.parent_task_id
    FROM runtime_tasks task
    WHERE task.user_id = ? AND task.id = ?
  ),
  target_root(id, user_id, session_id, root_agent_id, status) AS MATERIALIZED (
    SELECT root.id, root.user_id, root.session_id, root.root_agent_id, root.status
    FROM target_task target
    JOIN agent_nodes target_agent
      ON target_agent.id = target.agent_id
     AND target_agent.user_id = target.user_id
     AND target_agent.session_id = target.session_id
    JOIN agent_nodes root
      ON root.id = target_agent.root_agent_id
     AND root.user_id = target.user_id
     AND root.session_id = target.session_id
    JOIN sessions root_session
      ON root_session.id = root.session_id AND root_session.user_id = root.user_id
    WHERE root.parent_agent_id IS NULL AND root.id = root.root_agent_id
      AND root.kind = 'session' AND root.purpose = 'addressable'
  ),
  ${visibleAgentClosureCte(
    "visible_agents",
    `SELECT root.id, root.user_id, root.session_id, root.root_agent_id, root.status
     FROM target_root root`,
  )},
  visible_task_chain(id, parent_task_id) AS (
    SELECT task.id,
      CASE WHEN ${trustedCrossSessionTeamRootPredicate("task")}
        THEN NULL ELSE task.parent_task_id END AS parent_task_id
    FROM target_task target
    JOIN runtime_tasks task ON task.id = target.id
    JOIN visible_agents task_agent
      ON task_agent.id = task.agent_id
     AND task_agent.user_id = task.user_id
     AND task_agent.session_id = task.session_id
    JOIN sessions task_owner
      ON task_owner.id = task.owner_session_id AND task_owner.user_id = task.user_id
    WHERE ${ownedWorkflowPredicate("task", "task_agent")}
    UNION
    SELECT parent.id, parent.parent_task_id
    FROM visible_task_chain child
    CROSS JOIN runtime_tasks parent
    JOIN target_root scope
      ON scope.user_id = parent.user_id AND scope.session_id = parent.session_id
    JOIN visible_agents parent_agent
      ON parent_agent.id = parent.agent_id
     AND parent_agent.user_id = parent.user_id
     AND parent_agent.session_id = parent.session_id
    JOIN sessions parent_owner
      ON parent_owner.id = parent.owner_session_id AND parent_owner.user_id = parent.user_id
    WHERE parent.id = child.parent_task_id
      AND ${ownedWorkflowPredicate("parent", "parent_agent")}
  )`;

function executableAgentCtes(): string {
  return `${visibleAgentClosureCte("executable_addressable_agents", SESSION_ROOT_SEED)},
  executable_agents(id, user_id, session_id, root_agent_id, status) AS (
    SELECT id, user_id, session_id, root_agent_id, status
    FROM executable_addressable_agents
    UNION ALL
    SELECT slot.id, slot.user_id, slot.session_id, slot.root_agent_id, slot.status
    FROM agent_nodes slot
    JOIN executable_addressable_agents root
      ON root.id = root.root_agent_id
     AND slot.user_id = root.user_id
     AND slot.session_id = root.session_id
     AND slot.root_agent_id = root.id
     AND slot.parent_agent_id = root.id
    WHERE slot.kind = 'subagent'
      AND slot.purpose = 'joined_slot'
      AND slot.label = 'Joined delegation slot'
      AND slot.path GLOB '/root/joined_slot_[1-4]'
      AND slot.provider IS NOT NULL AND slot.model IS NOT NULL
  )`;
}

export const SESSION_EXECUTABLE_OPEN_CTE = `WITH RECURSIVE
  ${executableAgentCtes()},
  open_candidates(id, user_id, session_id, agent_id, parent_task_id) AS MATERIALIZED (
    SELECT task.id, task.user_id, task.session_id, task.agent_id, task.parent_task_id
    FROM executable_agents agent
    CROSS JOIN runtime_tasks AS task INDEXED BY idx_runtime_tasks_agent_open
    WHERE task.agent_id = agent.id
      AND task.user_id = agent.user_id
      AND task.session_id = agent.session_id
      AND agent.status <> 'closed'
      AND task.status IN ('queued','starting','running','waiting','cancel_requested')
  ),
  open_task_chain(candidate_id, user_id, session_id, id, parent_task_id) AS (
    SELECT candidate.id, task.user_id, task.session_id, task.id, task.parent_task_id
    FROM open_candidates candidate
    JOIN runtime_tasks task ON task.id = candidate.id
    JOIN executable_agents task_agent
      ON task_agent.id = task.agent_id
     AND task_agent.user_id = task.user_id
     AND task_agent.session_id = task.session_id
    JOIN sessions task_owner
      ON task_owner.id = task.owner_session_id AND task_owner.user_id = task.user_id
    WHERE ${ownedWorkflowPredicate("task", "task_agent")}
    UNION
    SELECT chain.candidate_id, parent.user_id, parent.session_id, parent.id, parent.parent_task_id
    FROM open_task_chain chain
    CROSS JOIN runtime_tasks parent
    JOIN executable_agents parent_agent
      ON parent_agent.id = parent.agent_id
     AND parent_agent.user_id = parent.user_id
     AND parent_agent.session_id = parent.session_id
    JOIN sessions parent_owner
      ON parent_owner.id = parent.owner_session_id AND parent_owner.user_id = parent.user_id
    WHERE parent.id = chain.parent_task_id
      AND parent.user_id = chain.user_id
      AND parent.session_id = chain.session_id
      AND ${ownedWorkflowPredicate("parent", "parent_agent")}
  ),
  executable_open_tasks(id) AS MATERIALIZED (
    SELECT candidate.id
    FROM open_candidates candidate
    WHERE EXISTS (
      SELECT 1 FROM open_task_chain chain
      WHERE chain.candidate_id = candidate.id AND chain.parent_task_id IS NULL
    )
  )`;

export const SESSION_EXECUTABLE_ORCHESTRATION_CTE = `WITH RECURSIVE
  ${executableAgentCtes()},
  executable_tasks(id, user_id, session_id, status, await_policy) AS (
    SELECT task.id, task.user_id, task.session_id, task.status, task.await_policy
    FROM runtime_tasks AS task INDEXED BY idx_runtime_tasks_visible_children
    JOIN executable_agents task_agent
      ON task_agent.id = task.agent_id
     AND task_agent.user_id = task.user_id
     AND task_agent.session_id = task.session_id
    JOIN sessions task_owner
      ON task_owner.id = task.owner_session_id AND task_owner.user_id = task.user_id
    WHERE task.user_id = ? AND task.session_id = ?
      AND task.parent_task_id IS NULL
      AND ${ownedWorkflowPredicate("task", "task_agent")}
    UNION ALL
    SELECT child.id, child.user_id, child.session_id, child.status, child.await_policy
    FROM executable_tasks parent
    CROSS JOIN runtime_tasks AS child INDEXED BY idx_runtime_tasks_visible_children
    JOIN executable_agents child_agent
      ON child_agent.id = child.agent_id
     AND child_agent.user_id = child.user_id
     AND child_agent.session_id = child.session_id
    JOIN sessions child_owner
      ON child_owner.id = child.owner_session_id AND child_owner.user_id = child.user_id
    WHERE child.user_id = parent.user_id
      AND child.session_id = parent.session_id
      AND child.parent_task_id = parent.id
      AND ${ownedWorkflowPredicate("child", "child_agent")}
  )`;
