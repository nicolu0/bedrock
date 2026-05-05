-- Rename gmail_message_dedup → intake_dedup. The table dedupes inbound work
-- order ingest events; today the only producer is the Gmail Pub/Sub path, but
-- the upcoming AppFolio polling fallback (for staff-created WOs that don't
-- email) will share this same dedup key space using synthetic message_ids
-- like 'poll-7627-2026-05-05'. The "gmail_message_" prefix would be a lie.

alter table public.gmail_message_dedup rename to intake_dedup;
alter index public.gmail_message_dedup_processed_at_idx rename to intake_dedup_processed_at_idx;
