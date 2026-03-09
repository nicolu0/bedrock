drop trigger if exists trg_issue_activity_log_changes on public.issues;
drop function if exists public.log_issue_activity_changes();
drop function if exists public.upsert_issue_activity_log(uuid, uuid, text, text, text);
