-- Align realtime RLS with people-based membership

-- Messages policies (use workspace_id + people membership)
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'messages'
  ) then
    drop policy if exists "Workspace members can view messages" on public.messages;
    drop policy if exists "Workspace members can insert messages" on public.messages;
    drop policy if exists "Workspace members can update messages" on public.messages;
    drop policy if exists "Workspace members can delete messages" on public.messages;

    create policy "Workspace members can view messages"
      on public.messages for select
      using (
        public.is_workspace_member(messages.workspace_id, auth.uid())
      );

    create policy "Workspace members can insert messages"
      on public.messages for insert
      with check (
        public.is_workspace_member(messages.workspace_id, auth.uid())
      );

    create policy "Workspace members can update messages"
      on public.messages for update
      using (
        public.is_workspace_member(messages.workspace_id, auth.uid())
      )
      with check (
        public.is_workspace_member(messages.workspace_id, auth.uid())
      );

    create policy "Workspace members can delete messages"
      on public.messages for delete
      using (
        public.is_workspace_member(messages.workspace_id, auth.uid())
      );
  end if;
end $$;

-- Email drafts policies (use denormalized workspace_id)
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'email_drafts'
  ) then
    drop policy if exists "Workspace members can view email drafts" on public.email_drafts;
    drop policy if exists "Workspace members can insert email drafts" on public.email_drafts;
    drop policy if exists "Workspace members can update email drafts" on public.email_drafts;
    drop policy if exists "Workspace members can delete email drafts" on public.email_drafts;

    create policy "Workspace members can view email drafts"
      on public.email_drafts for select
      using (
        public.is_workspace_member(email_drafts.workspace_id, auth.uid())
      );

    create policy "Workspace members can insert email drafts"
      on public.email_drafts for insert
      with check (
        public.is_workspace_member(email_drafts.workspace_id, auth.uid())
      );

    create policy "Workspace members can update email drafts"
      on public.email_drafts for update
      using (
        public.is_workspace_member(email_drafts.workspace_id, auth.uid())
      )
      with check (
        public.is_workspace_member(email_drafts.workspace_id, auth.uid())
      );

    create policy "Workspace members can delete email drafts"
      on public.email_drafts for delete
      using (
        public.is_workspace_member(email_drafts.workspace_id, auth.uid())
      );
  end if;
end $$;

-- Workspace policies policies (use workspace_id + people membership)
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'workspace_policies'
  ) then
    drop policy if exists "Workspace members can view workspace policies" on public.workspace_policies;
    drop policy if exists "Workspace members can insert workspace policies" on public.workspace_policies;
    drop policy if exists "Workspace members can update workspace policies" on public.workspace_policies;
    drop policy if exists "Workspace members can delete workspace policies" on public.workspace_policies;

    create policy "Workspace members can view workspace policies"
      on public.workspace_policies for select
      using (
        public.is_workspace_member(workspace_policies.workspace_id, auth.uid())
      );

    create policy "Workspace members can insert workspace policies"
      on public.workspace_policies for insert
      with check (
        public.is_workspace_member(workspace_policies.workspace_id, auth.uid())
      );

    create policy "Workspace members can update workspace policies"
      on public.workspace_policies for update
      using (
        public.is_workspace_member(workspace_policies.workspace_id, auth.uid())
      )
      with check (
        public.is_workspace_member(workspace_policies.workspace_id, auth.uid())
      );

    create policy "Workspace members can delete workspace policies"
      on public.workspace_policies for delete
      using (
        public.is_workspace_member(workspace_policies.workspace_id, auth.uid())
      );
  end if;
end $$;

-- Ensure realtime publication includes all subscribed tables
do $$
begin
  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'messages'
  ) then
    alter table public.messages replica identity full;
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'messages'
    ) then
      alter publication supabase_realtime add table public.messages;
    end if;
  end if;

  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'activity_logs'
  ) then
    alter table public.activity_logs replica identity full;
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'activity_logs'
    ) then
      alter publication supabase_realtime add table public.activity_logs;
    end if;
  end if;

  if exists (
    select 1
    from information_schema.tables
    where table_schema = 'public'
      and table_name = 'workspace_policies'
  ) then
    alter table public.workspace_policies replica identity full;
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = 'workspace_policies'
    ) then
      alter publication supabase_realtime add table public.workspace_policies;
    end if;
  end if;
end $$;
