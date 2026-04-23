// @ts-nocheck
import { supabaseAdmin } from '$lib/supabaseAdmin';

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

function matchByIssueName(text, issues) {
	const normalizedText = normalize(text);
	if (!normalizedText) return null;
	let best = null;
	for (const issue of issues) {
		if (!issue.name) continue;
		if (includesPhrase(normalizedText, issue.name)) {
			return { issue_id: issue.id, method: 'issue_name_phrase', confidence: 0.85 };
		}
		const score = tokenOverlapScore(normalizedText, issue.name);
		if (score >= 0.8 && (!best || score > best.score)) {
			best = { score, issue };
		}
	}
	if (best) {
		return { issue_id: best.issue.id, method: 'issue_name_tokens', confidence: best.score };
	}
	return null;
}

/**
 * Attempt to link a free-text iMessage body to an existing open issue in the workspace.
 * Short-circuits on the first confident match. Regex / token-based only — no LLM.
 * @returns {Promise<{issue_id: string, method: string, confidence: number} | null>}
 */
export async function linkMessageToIssue(text, workspaceId) {
	const body = String(text ?? '').trim();
	if (!body) return null;
	const issues = await loadOpenIssues(workspaceId);
	if (!issues.length) return null;

	return (
		matchByServiceRequestNumber(body, issues) ||
		matchByPropertyOrUnit(body, issues) ||
		matchByTenantName(body, issues) ||
		matchByIssueName(body, issues) ||
		null
	);
}
