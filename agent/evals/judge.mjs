// Judge — calls gpt-5.4-mini-2026-03-17 to score fuzzy criteria that aren't
// expressible as code-level assertions (voice/tone, phrasing intent, etc.).
//
// Input: the agent's output (string or array) + criteria (a one-paragraph
// description of what the output must satisfy). Output: { pass: bool, reason }.
//
// Costs: tiny per call. Full v1 eval suite runs ~$0.10.

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'gpt-5.4-mini-2026-03-17';

const SYSTEM = `You are a strict eval judge. You are given an agent's output and a list of criteria the output must satisfy. Decide whether the output meets all criteria.

Reply with exactly:
PASS — <one short sentence explaining why it passes>
or
FAIL — <one short sentence explaining what fails>

Be strict. If any criterion is unmet, FAIL. If the output exhibits the required behavior even if not in the exact phrasing, PASS. Do not be charitable about missing requirements.`;

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
			messages: [
				{ role: 'system', content: SYSTEM },
				{ role: 'user', content: user }
			],
			max_completion_tokens: 200
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
