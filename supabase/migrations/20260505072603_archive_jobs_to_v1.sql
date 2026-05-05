-- jobs was the V1 generic background-job queue (Gmail webhook ingest, agent
-- invocations, etc.). V2 has no queue — pubsub-hook calls intake-agent
-- directly and intake-agent calls vendor-agent directly. The table has 8,969
-- rows of historical job records preserved in v1 for audit / debugging.

alter table public.jobs set schema v1;
