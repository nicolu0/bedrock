drop index if exists agent_events_workspace_issue_unique;

alter table public.agent_events
  add constraint agent_events_workspace_issue_unique
  unique (workspace_id, issue_id);
