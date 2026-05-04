-- Archive legacy public tables into a new v1 schema.
-- The product has moved to a text-based UX backed by issues_v2 / agent_runs.
-- These tables back the dormant SvelteKit web app and the deprecated
-- supabase/functions/agent edge function. No application code is updated;
-- those code paths will fail against public.<table> as intended.
--
-- FKs from kept public tables (agent_events.issue_id, agent_dispatch_queue.issue_id,
-- workspaces.coordinator_thread_id) are preserved as cross-schema FKs after the move.

create schema if not exists v1;
grant usage on schema v1 to postgres, anon, authenticated, service_role;

alter table public.issues             set schema v1;
alter table public.threads            set schema v1;
alter table public.messages           set schema v1;
alter table public.drafts             set schema v1;
alter table public.activity_logs      set schema v1;
alter table public.notifications      set schema v1;
alter table public.issue_reads        set schema v1;
alter table public.chat_threads       set schema v1;
alter table public.chat_messages      set schema v1;
alter table public.workspace_policies set schema v1;

grant all on all tables in schema v1 to postgres, service_role;
grant usage, select on all sequences in schema v1 to postgres, service_role;
