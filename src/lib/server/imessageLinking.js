// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';
import { OPENAI_API_KEY } from '$env/static/private';

const OPENAI_MODEL = 'gpt-5-mini-2025-08-07';

const SR_NUMBER_RE = /\b(\d{4,6}(?:-\d+)?)\b/g;

const normalize = (value) =>
	String(value ?? '')
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();

const tokenize = (value) =>
	normalize(value)
		.split(' ')
		.filter((t) => t.length >= 3);

const includesPhrase = (haystack, needle) => {
	if (!haystack || !needle) return false;
	return normalize(haystack).includes(normalize(needle));
};

const tokenOverlapScore = (text, candidate) => {
	const textTokens = new Set(tokenize(text));
	const candidateTokens = tokenize(candidate);
	if (!candidateTokens.length) return 0;
	let hits = 0;
	for (const token of candidateTokens) {
		if (textTokens.has(token)) hits += 1;
	}
	return hits / candidateTokens.length;
};

async function loadOpenIssues(workspaceId) {
	const { data, error } = await supabaseAdmin
		.from('issues')
		.select(
			`id, name, description, status, service_request_number, updated_at,
			 property_id, unit_id, tenant_id,
			 properties:property_id (id, name),
			 units:unit_id (id, name),
			 tenants:tenant_id (id, name)`
		)
		.eq('workspace_id', workspaceId)
		.neq('status', 'done')
		.order('updated_at', { ascending: false })
		.limit(100);
	if (error) {
		console.warn('imessageLinking: loadOpenIssues error', error.message);
		return [];
	}
	return data ?? [];
}

function matchByServiceRequestNumber(text, issues) {
	const matches = text.match(SR_NUMBER_RE);
	if (!matches?.length) return null;
	const candidates = new Set();
	for (const m of matches) {
		candidates.add(m);
		const base = m.split('-')[0];
		if (base !== m) candidates.add(base);
	}
	for (const issue of issues) {
		const sr = issue.service_request_number;
		if (!sr) continue;
		if (candidates.has(String(sr)) || candidates.has(String(sr).split('-')[0])) {
			return { issue_id: issue.id, method: 'service_request_number', confidence: 0.95 };
		}
	}
	return null;
}

function matchByPropertyOrUnit(text, issues) {
	const normalizedText = normalize(text);
	if (!normalizedText) return null;
	let best = null;
	for (const issue of issues) {
		const propertyName = issue.properties?.name;
		const unitName = issue.units?.name;
		let score = 0;
		if (propertyName && includesPhrase(normalizedText, propertyName)) score = Math.max(score, 0.85);
		if (unitName && includesPhrase(normalizedText, unitName)) score = Math.max(score, 0.8);
		if (propertyName) {
			const tokenScore = tokenOverlapScore(normalizedText, propertyName);
			if (tokenScore >= 0.75) score = Math.max(score, 0.7 + tokenScore * 0.1);
		}
		if (!best || score > best.score) best = { score, issue };
	}
	if (best && best.score >= 0.75) {
		return { issue_id: best.issue.id, method: 'property_or_unit', confidence: best.score };
	}
	return null;
}

function matchByTenantName(text, issues) {
	const normalizedText = normalize(text);
	if (!normalizedText) return null;
	for (const issue of issues) {
		const fullName = issue.tenants?.name;
		if (!fullName) continue;
		if (includesPhrase(normalizedText, fullName)) {
			return { issue_id: issue.id, method: 'tenant_name', confidence: 0.9 };
		}
		const parts = fullName.split(/\s+/).filter((p) => p.length >= 4);
		const last = parts[parts.length - 1];
		if (last && includesPhrase(normalizedText, last)) {
			return { issue_id: issue.id, method: 'tenant_last_name', confidence: 0.7 };
		}
	}
	return null;
}

async function matchByLLM(text, issues) {
	if (!OPENAI_API_KEY || !issues.length) return null;
	const trimmed = text.trim();
	if (trimmed.length < 8) return null;
	const candidates = issues.slice(0, 15).map((issue) => ({
		id: issue.id,
		name: issue.name,
		description: (issue.description ?? '').slice(0, 400),
		property: issue.properties?.name ?? null,
		unit: issue.units?.name ?? null,
		tenant: issue.tenants?.name ?? null
	}));

	const systemPrompt = [
		'You match short iMessage chat messages from a maintenance coordinator to the single open work-order issue they most likely refer to.',
		'You will receive a message and a list of candidate issues (id, name, description, property, unit, tenant).',
		'If the message is clearly about one issue, return that issue id with a one-sentence reason.',
		'If it is ambiguous, off-topic, or does not match any candidate, return null.',
		'Prefer null over a weak guess.'
	].join(' ');

	const userPrompt = JSON.stringify({ message: trimmed, candidates });

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			input: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: userPrompt }
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'issue_match',
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							issue_id: { type: ['string', 'null'] },
							reason: { type: 'string' }
						},
						required: ['issue_id', 'reason']
					}
				}
			}
		})
	}).catch((err) => {
		console.warn('imessageLinking: LLM fetch error', err?.message);
		return null;
	});

	if (!response || !response.ok) {
		if (response) console.warn('imessageLinking: LLM non-ok', response.status);
		return null;
	}
	const data = await response.json().catch(() => null);
	const outputText = data?.output_text ?? '';
	if (!outputText) return null;
	let parsed = null;
	try {
		parsed = JSON.parse(outputText);
	} catch {
		return null;
	}
	if (!parsed?.issue_id) return null;
	const exists = candidates.some((c) => c.id === parsed.issue_id);
	if (!exists) return null;
	return {
		issue_id: parsed.issue_id,
		method: 'llm_name_description',
		confidence: 0.6,
		reason: parsed.reason ?? null
	};
}

/**
 * Attempt to link a free-text iMessage body to an existing open issue in the workspace.
 * Short-circuits on the first confident match.
 * @returns {Promise<{issue_id: string, method: string, confidence: number, reason?: string} | null>}
 */
export async function linkMessageToIssue(text, workspaceId) {
	const body = String(text ?? '').trim();
	if (!body) return null;
	const issues = await loadOpenIssues(workspaceId);
	if (!issues.length) return null;

	const byNumber = matchByServiceRequestNumber(body, issues);
	if (byNumber) return byNumber;

	const byProperty = matchByPropertyOrUnit(body, issues);
	if (byProperty) return byProperty;

	const byTenant = matchByTenantName(body, issues);
	if (byTenant) return byTenant;

	try {
		const byLlm = await matchByLLM(body, issues);
		if (byLlm) return byLlm;
	} catch (err) {
		console.warn('imessageLinking: LLM fallback threw', err?.message);
	}

	return null;
}
