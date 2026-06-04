// Judge — calls the full gpt-5.4 model to score fuzzy criteria that aren't
// expressible as code-level assertions (voice/tone, phrasing intent, etc.).
//
// Input: the agent's output (string or array) + criteria (a one-paragraph
// description of what the output must satisfy). Output: { pass: bool, reason }.
//
// Reliability: runs at temperature 0 (deterministic verdict on identical input,
// like every other gpt-5.4 call in the repo) on the full model, not the mini —
// it grades full-model output, so the grader shouldn't be the weak link. The
// system prompt forbids failing on outcomes not visible in the output (tool
// calls / status changes are asserted in code via tool_args, not by the judge).
//
// Costs: tiny per call — output is one line; the full model raises per-call cost
// modestly but the orchestrator turn dominates the suite's spend, not the judge.

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-5.4-2026-03-05';

const SYSTEM = `You are a strict eval judge. You are given an agent's output and a list of criteria the output must satisfy. Decide whether the output meets all criteria.

Reply with exactly:
PASS — <one short sentence explaining why it passes>
or
FAIL — <one short sentence explaining what fails>

Be strict. If any criterion is unmet, FAIL. If the output exhibits the required behavior even if not in the exact phrasing, PASS. Do not be charitable about missing requirements.

Judge ONLY what is observable in the agent output shown to you. That output is the agent's user-facing text; it does NOT include tool calls, internal state, database writes, or status changes unless they literally appear in the text. If a criterion references an outcome you cannot observe in the output (e.g. "moves the WO to triaging", "closes the ticket", "records the preference"), do NOT assume it did or did not happen — that outcome is verified separately in code. Judge only the observable behavior, and never FAIL solely because an unobservable outcome is not visible in the text.`;

export async function judge({ output, criteria }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const outputStr = typeof output === 'string' ? output : JSON.stringify(output, null, 2);

	const user = `# Agent output

${outputStr}

# Criteria

${criteria}

Reply with PASS or FAIL plus one sentence.`;

	const res = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: JUDGE_MODEL,
			temperature: 0,
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: user }
			],
			max_completion_tokens: 300
		})
	});

	if (!res.ok) {
		const errText = await res.text().catch(() => '');
		throw new Error(`judge call failed: ${res.status} ${errText}`);
	}

	const data = await res.json();
	const reply = (data.choices?.[0]?.message?.content ?? '').trim();
	const passMatch = /^PASS\b/i.test(reply);
	const failMatch = /^FAIL\b/i.test(reply);
	const reason = reply.replace(/^(PASS|FAIL)\s*[—\-:]\s*/i, '').trim();

	if (!passMatch && !failMatch) {
		return { pass: false, reason: `judge returned non-conforming reply: ${reply}` };
	}
	return { pass: passMatch, reason };
}
