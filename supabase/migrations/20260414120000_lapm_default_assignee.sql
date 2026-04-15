-- LAPM: assign new issues/subissues to Andrew by default.
-- The agent uses workspaces.default_assignee_id as its fallback assignee.
update public.workspaces
set default_assignee_id = '089ed731-51c8-48a8-af30-8967841bf268'
where slug = 'lapm';
