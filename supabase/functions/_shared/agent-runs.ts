// Shared helpers for the V2 per-agent run lifecycle (agent_runs table).
// Used by intake-v2, intake-agent, vendor-agent.

import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

export type AgentName = 'intake' | 'vendor';
export type AgentStatus = 'pending' | 'processing' | 'done' | 'failed';

// Insert pending rows for the agents we want to run on this issue. Idempotent
// via the (issue_id, agent_name) unique index — re-runs after a failure won't
// duplicate.
export async function ensureAgentRuns(
  supabase: SupabaseClient,
  issueId: string,
  agentNames: AgentName[]
): Promise<void> {
  const rows = agentNames.map((agent_name) => ({
    issue_id: issueId,
    agent_name,
    status: 'pending' as AgentStatus
  }));
  const { error } = await supabase
    .from('agent_runs')
    .upsert(rows, { onConflict: 'issue_id,agent_name', ignoreDuplicates: true });
  if (error) throw new Error(`ensureAgentRuns: ${error.message}`);
}

// Atomic claim. Returns the run_id if we won the claim, null otherwise (already
// done or actively processing). Stale processing rows (>15 min) are reclaimable.
export async function claimAgentRun(
  supabase: SupabaseClient,
  issueId: string,
  agentName: AgentName
): Promise<string | null> {
  const { data, error } = await supabase.rpc('claim_agent_run', {
    p_issue_id: issueId,
    p_agent_name: agentName
  });
  if (error) throw new Error(`claimAgentRun: ${error.message}`);
  return (data as string | null) ?? null;
}

export async function completeAgentRun(
  supabase: SupabaseClient,
  issueId: string,
  agentName: AgentName
): Promise<void> {
  const { error } = await supabase
    .from('agent_runs')
    .update({ status: 'done', completed_at: new Date().toISOString(), error: null })
    .eq('issue_id', issueId)
    .eq('agent_name', agentName);
  if (error) throw new Error(`completeAgentRun: ${error.message}`);
}

export async function failAgentRun(
  supabase: SupabaseClient,
  issueId: string,
  agentName: AgentName,
  err: unknown
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  const { error } = await supabase
    .from('agent_runs')
    .update({ status: 'failed', completed_at: new Date().toISOString(), error: message })
    .eq('issue_id', issueId)
    .eq('agent_name', agentName);
  if (error) console.error(`failAgentRun: ${error.message}`);
}
