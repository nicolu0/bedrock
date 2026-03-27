alter table public.agent_events
  add column if not exists dismissed_at timestamptz;

alter table public.agent_events
  add column if not exists dismissed_by uuid;

drop policy if exists "Workspace members can update agent events" on public.agent_events;

create policy "Workspace members can update agent events"
  on public.agent_events for update
  using (
    public.is_workspace_member(agent_events.workspace_id, auth.uid())
  )
  with check (
    public.is_workspace_member(agent_events.workspace_id, auth.uid())
  );
