# Agent Prompt / Tool-Call Evals

Tests whether the agent uses the provided context correctly in one work-order flow.

Scope:
- Prompt adherence
- Tool selection
- Tool argument shape
- PM / tenant / vendor message bodies inside tool calls
- Context and lane separation
- Work-order status updates caused by the agent turn

Out of scope:
- Memory retrieval quality
- Belief formation
- Burst/session coalescing
- AppFolio or iMessage adapter behavior

