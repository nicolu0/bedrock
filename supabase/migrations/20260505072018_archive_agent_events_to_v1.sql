-- agent_events was the V1 streaming-event log for the old multi-step agent.
-- V2 uses agent_runs (lifecycle status per (issue, agent_name)) instead, so
-- agent_events is dormant. Cross-schema FKs to public.users / public.workspaces
-- are preserved automatically; the issue_id FK already points at v1.issues.

alter table public.agent_events set schema v1;
