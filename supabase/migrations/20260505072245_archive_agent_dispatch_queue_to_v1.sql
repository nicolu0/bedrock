-- agent_dispatch_queue was the V1 work queue between appfolio-sync /
-- appfolio-email-trigger (producers) and the legacy agent function (consumer).
-- V2 replaces this with direct HTTP — intake-agent calls vendor-agent via
-- dispatchVendorAgent(), no queue. Cross-schema FKs to public.workspaces are
-- preserved automatically; the issue_id FK already points at v1.issues.

alter table public.agent_dispatch_queue set schema v1;
