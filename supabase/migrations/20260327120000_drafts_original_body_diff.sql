alter table public.drafts
  add column if not exists original_body text,
  add column if not exists draft_diff jsonb;
