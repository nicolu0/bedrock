drop policy if exists "Team members can view memberships" on public.team_members;

create policy "Members can view own membership"
  on public.team_members for select
  using (user_id = auth.uid());

create policy "Admins can view team memberships"
  on public.team_members for select
  using (
    exists (
      select 1
      from public.team_members tm
      where tm.team_id = team_members.team_id
        and tm.user_id = auth.uid()
        and tm.role = 'admin'
    )
  );
