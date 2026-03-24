alter table public.agent_events
  add column if not exists updated_at timestamptz not null default now();

update public.agent_events
set updated_at = created_at
where updated_at is null;

with ranked as (
  select id,
    row_number() over (partition by workspace_id, run_id order by created_at desc, id desc) as rn
  from public.agent_events
)
delete from public.agent_events
using ranked
where public.agent_events.id = ranked.id
  and ranked.rn > 1;

create unique index if not exists agent_events_workspace_run_unique
  on public.agent_events (workspace_id, run_id);
