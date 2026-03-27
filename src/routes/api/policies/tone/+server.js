// @ts-nocheck
import { json } from '@sveltejs/kit';
import { OPENAI_API_KEY } from '$env/static/private';
import { supabaseAdmin } from '$lib/supabaseAdmin';

const openaiModel = 'gpt-5-mini-2025-08-07';

const buildTonePrompt = async ({ policyId, issueLabel, originalBody, updatedBody, diff }) => {
	console.log('tone-policy prompt start', {
		policy_id: policyId,
		issue_label: issueLabel,
		original_len: (originalBody ?? '').length,
		updated_len: (updatedBody ?? '').length,
		diff_segments: Array.isArray(diff) ? diff.length : 0
	});
	if (!OPENAI_API_KEY) {
		throw new Error('Missing OpenAI API key.');
	}

	const system = `You write concise tone guidance for property management emails.
Given an original email, an updated email, and a word-level diff, describe the tone and structure changes.
Write 2-4 sentences that can be used as a prompt for future drafts.
Focus on how the updated version differs (tone, phrasing, structure, level of detail).
Avoid quoting large chunks of the email.
Output JSON only.`.trim();

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: openaiModel,
			input: [
				{ role: 'system', content: system },
				{
					role: 'user',
					content: JSON.stringify({
						policy_id: policyId,
						issue_label: issueLabel,
						original_body: originalBody,
						updated_body: updatedBody,
						diff
					})
				}
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'tone_prompt',
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							prompt: { type: 'string' }
						},
						required: ['prompt']
					}
				}
			}
		})
	});

	if (!response.ok) return '';
	const data = await response.json();
	const outputText = (() => {
		if (typeof data?.output_text === 'string' && data.output_text.trim()) return data.output_text;
		const outputs = Array.isArray(data?.output) ? data.output : [];
		const collected = [];
		outputs.forEach((entry) => {
			const content = Array.isArray(entry?.content) ? entry.content : [];
			content.forEach((item) => {
				if (typeof item?.text === 'string' && item.text.trim()) {
					collected.push(item.text);
					return;
				}
				if (typeof item?.text?.value === 'string' && item.text.value.trim()) {
					collected.push(item.text.value);
					return;
				}
				if (typeof item?.json === 'string' && item.json.trim()) {
					collected.push(item.json);
					return;
				}
				if (typeof item?.output_text === 'string' && item.output_text.trim()) {
					collected.push(item.output_text);
				}
			});
		});
		return collected.join('').trim();
	})();
	if (!outputText) {
		const outputSummary = Array.isArray(data?.output)
			? data.output.map((entry) => ({
					type: entry?.type ?? 'unknown',
					content_types: Array.isArray(entry?.content)
						? entry.content.map((item) => item?.type ?? 'unknown')
						: []
				}))
			: [];
		console.warn('tone-policy prompt no output text', {
			policy_id: policyId,
			output_count: Array.isArray(data?.output) ? data.output.length : 0,
			output_summary: outputSummary
		});
		return '';
	}
	try {
		const parsed = outputText ? JSON.parse(outputText) : null;
		const prompt = typeof parsed?.prompt === 'string' ? parsed.prompt.trim() : '';
		return prompt;
	} catch {
		return typeof outputText === 'string' ? outputText.trim() : '';
	}
};

const updateTonePolicyPrompt = async ({ policyId, meta, issueLabel }) => {
	try {
		const prompt = await buildTonePrompt({
			policyId,
			issueLabel,
			originalBody: meta?.original_body ?? '',
			updatedBody: meta?.updated_body ?? '',
			diff: meta?.diff ?? []
		});
		if (!prompt) {
			const nextMeta = {
				...(meta ?? {}),
				ai_prompt_status: 'error',
				ai_prompt_error: 'Empty AI response.'
			};
			await supabaseAdmin
				.from('workspace_policies')
				.update({ meta: nextMeta, updated_at: new Date().toISOString() })
				.eq('id', policyId);
			console.warn('tone-policy prompt empty', { policy_id: policyId });
			return;
		}
		const nextMeta = {
			...(meta ?? {}),
			ai_prompt: prompt,
			ai_prompt_status: 'ready',
			ai_prompt_error: null
		};
		await supabaseAdmin
			.from('workspace_policies')
			.update({ meta: nextMeta, updated_at: new Date().toISOString() })
			.eq('id', policyId);
		console.log('tone-policy prompt saved', { policy_id: policyId });
	} catch (err) {
		const nextMeta = {
			...(meta ?? {}),
			ai_prompt_status: 'error',
			ai_prompt_error: err?.message ?? 'AI prompt generation failed.'
		};
		await supabaseAdmin
			.from('workspace_policies')
			.update({ meta: nextMeta, updated_at: new Date().toISOString() })
			.eq('id', policyId);
		console.error('tone-policy prompt update failed', err);
	}
};

export const POST = async ({ locals, request }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const payload = await request.json().catch(() => null);
	const issueId = typeof payload?.issue_id === 'string' ? payload.issue_id : '';
	const originalBody = typeof payload?.original_body === 'string' ? payload.original_body : '';
	const updatedBody = typeof payload?.updated_body === 'string' ? payload.updated_body : '';
	const diff = Array.isArray(payload?.diff) ? payload.diff : [];
	console.log('tone-policy create request', {
		issue_id: issueId,
		original_len: originalBody.length,
		updated_len: updatedBody.length,
		diff_segments: diff.length
	});

	if (!issueId || !originalBody || !updatedBody) {
		return json({ error: 'Missing tone policy fields.' }, { status: 400 });
	}

	const { data: issue } = await supabaseAdmin
		.from('issues')
		.select('id, name, workspace_id')
		.eq('id', issueId)
		.maybeSingle();

	if (!issue?.workspace_id) {
		return json({ error: 'Issue not found.' }, { status: 404 });
	}

	const { data: member } = await supabaseAdmin
		.from('people')
		.select('id')
		.eq('workspace_id', issue.workspace_id)
		.eq('user_id', locals.user.id)
		.in('role', ['admin', 'bedrock', 'member', 'owner'])
		.maybeSingle();

	if (!member?.id) {
		const { data: workspace } = await supabaseAdmin
			.from('workspaces')
			.select('id')
			.eq('id', issue.workspace_id)
			.eq('admin_user_id', locals.user.id)
			.maybeSingle();
		if (!workspace?.id) {
			return json({ error: 'Forbidden' }, { status: 403 });
		}
	}

	const issueLabel = issue?.name?.toString().trim() || 'Maintenance issue';
	const meta = {
		source: 'draft-tone',
		maintenance_issue: issueLabel,
		original_body: originalBody,
		updated_body: updatedBody,
		diff,
		ai_prompt: null,
		ai_prompt_status: 'pending',
		ai_prompt_error: null
	};

	const { data, error } = await supabaseAdmin
		.from('workspace_policies')
		.insert({
			workspace_id: issue.workspace_id,
			type: 'tone',
			email: null,
			description: 'Tone',
			created_by: locals.user.id,
			meta
		})
		.select('id, type, email, description, meta, created_at, created_by, users:created_by(name)')
		.single();

	if (error) return json({ error: error.message }, { status: 500 });
	console.log('tone-policy created', { policy_id: data?.id, issue_id: issueId });

	if (data?.id) {
		void updateTonePolicyPrompt({ policyId: data.id, meta, issueLabel });
	}

	return json({
		policy: {
			id: data.id,
			type: data.type ?? 'tone',
			email: data.email ?? '',
			description: data.description ?? '',
			meta: data.meta ?? null,
			createdAt: data.created_at ?? null,
			createdById: data.created_by ?? null,
			createdByName: data.users?.name ?? 'Unknown'
		}
	});
};
