// @ts-nocheck
import { serve } from 'https://deno.land/std@0.224.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const supabaseUrl = Deno.env.get('SUPABASE_URL');
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const openaiApiKey = Deno.env.get('OPENAI_API_KEY');

if (!supabaseUrl || !supabaseServiceKey) {
	throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const openaiModel = 'gpt-5-mini-2025-08-07';

const supabase = createClient(supabaseUrl, supabaseServiceKey, {
	auth: { persistSession: false, autoRefreshToken: false }
});

const corsHeaders = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

const resolveWorkspace = async (workspaceId, workspaceSlug) => {
	if (workspaceId) {
		const { data } = await supabase
			.from('workspaces')
			.select('id, name, slug')
			.eq('id', workspaceId)
			.maybeSingle();
		return data ?? null;
	}
	if (workspaceSlug) {
		const { data } = await supabase
			.from('workspaces')
			.select('id, name, slug')
			.eq('slug', workspaceSlug)
			.maybeSingle();
		return data ?? null;
	}
	return null;
};

const getDefaultThread = async (userId, workspaceId) => {
	let query = supabase
		.from('chat_threads')
		.select('id')
		.eq('user_id', userId)
		.eq('is_default', true);
	if (workspaceId) {
		query = query.eq('workspace_id', workspaceId);
	} else {
		query = query.is('workspace_id', null);
	}
	const { data: existing } = await query.maybeSingle();
	if (existing?.id) return existing.id;
	const { data: created } = await supabase
		.from('chat_threads')
		.insert({ user_id: userId, workspace_id: workspaceId ?? null, is_default: true })
		.select('id')
		.single();
	return created?.id ?? null;
};

const resolveThreadId = async (userId, workspaceId, requestedThreadId) => {
	if (requestedThreadId) {
		const { data: requested } = await supabase
			.from('chat_threads')
			.select('id, user_id, workspace_id')
			.eq('id', requestedThreadId)
			.maybeSingle();
		if (
			requested?.id &&
			requested.user_id === userId &&
			(workspaceId ? requested.workspace_id === workspaceId : requested.workspace_id == null)
		) {
			return requested.id;
		}
	}
	return getDefaultThread(userId, workspaceId);
};

const getThreadHistory = async (threadId) => {
	if (!threadId) return [];
	const { data } = await supabase
		.from('chat_messages')
		.select('sender, content')
		.eq('thread_id', threadId)
		.order('created_at', { ascending: true })
		.limit(12);
	return (data ?? []).map((m) => ({
		role: m.sender === 'assistant' ? 'assistant' : 'user',
		content: m.content
	}));
};

const buildContext = async (workspaceId) => {
	if (!workspaceId) return { workspace: null };
	const [issuesRes, propertiesRes, peopleRes, policiesRes] = await Promise.all([
		supabase
			.from('issues')
			.select('id, readable_id, name, status, urgent, created_at, updated_at')
			.eq('workspace_id', workspaceId)
			.order('updated_at', { ascending: false })
			.limit(20),
		supabase
			.from('properties')
			.select('id, name, address, city, state')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true })
			.limit(20),
		supabase
			.from('people')
			.select('id, name, email, role')
			.eq('workspace_id', workspaceId)
			.order('name', { ascending: true })
			.limit(20),
		supabase
			.from('workspace_policies')
			.select('id, type, maintenance_issue, urgency, created_at')
			.eq('workspace_id', workspaceId)
			.order('created_at', { ascending: false })
			.limit(10)
	]);

	return {
		issues: issuesRes.data ?? [],
		properties: propertiesRes.data ?? [],
		people: peopleRes.data ?? [],
		policies: policiesRes.data ?? []
	};
};

const extractReply = (data) => {
	if (data?.output_text) return data.output_text;
	const messageItem = Array.isArray(data?.output)
		? data.output.find((item) => item?.type === 'message')
		: null;
	if (messageItem?.content?.length) {
		return messageItem.content
			.map((c) => c?.text ?? '')
			.join('')
			.trim();
	}
	return data?.choices?.[0]?.message?.content ?? '';
};

const ISSUE_REF_REGEX = /\[\[issue_ref:([a-zA-Z0-9.-]+)\]\]/g;
const PROPERTY_REF_REGEX = /\[\[property_ref:([a-zA-Z0-9.-]+)\]\]/g;

const isUuid = (value) =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const normalizeStatus = (value) => {
	if (!value) return 'todo';
	const normalized = String(value).toLowerCase().trim().replace(/\s+/g, '_').replace(/-/g, '_');
	if (normalized === 'in_progress') return 'in_progress';
	if (normalized === 'done' || normalized === 'completed' || normalized === 'complete')
		return 'done';
	if (normalized === 'todo' || normalized === 'to_do' || normalized === 'backlog') return 'todo';
	return normalized;
};

const slugify = (value) =>
	value
		?.toString()
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)+/g, '') || 'property';

const resolveIssuesByRefs = async (workspaceId, refs) => {
	if (!workspaceId || !refs?.length) return new Map();
	const uniqueRefs = Array.from(new Set(refs.filter(Boolean)));
	const ids = uniqueRefs.filter((ref) => isUuid(ref));
	const readableIds = uniqueRefs.filter((ref) => !isUuid(ref));
	let query = supabase
		.from('issues')
		.select(
			'id, name, status, urgent, parent_id, unit_id, property_id, issue_number, readable_id, assignee_id, created_at, updated_at'
		)
		.eq('workspace_id', workspaceId);
	if (ids.length && readableIds.length) {
		query = query.or(
			`id.in.(${ids.join(',')}),readable_id.in.(${readableIds
				.map((value) => `"${value}"`)
				.join(',')})`
		);
	} else if (ids.length) {
		query = query.in('id', ids);
	} else if (readableIds.length) {
		query = query.in('readable_id', readableIds);
	} else {
		return new Map();
	}
	const { data: issues } = await query;
	const unitIds = Array.from(new Set((issues ?? []).map((i) => i.unit_id).filter(Boolean)));
	const { data: units } = unitIds.length
		? await supabase.from('units').select('id, name, property_id').in('id', unitIds)
		: { data: [] };
	const unitMap = new Map((units ?? []).map((u) => [u.id, u]));
	const propertyIds = Array.from(
		new Set([
			...(units ?? []).map((u) => u.property_id).filter(Boolean),
			...(issues ?? []).map((i) => i.property_id).filter(Boolean)
		])
	);
	const { data: properties } = propertyIds.length
		? await supabase.from('properties').select('id, name').in('id', propertyIds)
		: { data: [] };
	const propertyMap = new Map((properties ?? []).map((p) => [p.id, p]));
	const normalized = (issues ?? []).map((issue) => {
		const unit = issue.unit_id ? unitMap.get(issue.unit_id) : null;
		const resolvedPropertyId = issue.property_id ?? unit?.property_id ?? null;
		const property = resolvedPropertyId ? propertyMap.get(resolvedPropertyId) : null;
		return {
			id: issue.id,
			issueId: issue.id,
			title: issue.name,
			status: normalizeStatus(issue.status),
			urgent: issue.urgent ?? false,
			property: property?.name ?? 'Unknown',
			unit: unit?.name ?? 'Unknown',
			issueNumber: issue.issue_number ?? null,
			readableId: issue.readable_id ?? null,
			assigneeId: issue.assignee_id ?? null,
			assignee_id: issue.assignee_id ?? null,
			created_at: issue.created_at ?? null,
			updated_at: issue.updated_at ?? null
		};
	});
	const map = new Map();
	for (const issue of normalized) {
		map.set(issue.id, issue);
		if (issue.readableId) map.set(issue.readableId, issue);
	}
	return map;
};

const replaceIssueRefs = (text, issueMap) =>
	text.replace(ISSUE_REF_REGEX, (_match, ref) => {
		const issue = issueMap.get(ref);
		if (!issue) return '';
		return `[[issue:${JSON.stringify(issue)}]]`;
	});

const resolvePropertiesByRefs = async (workspaceId, refs) => {
	if (!workspaceId || !refs?.length) return new Map();
	const uniqueRefs = Array.from(new Set(refs.filter(Boolean)));
	const ids = uniqueRefs.filter((ref) => isUuid(ref));
	if (!ids.length) return new Map();
	const { data: properties } = await supabase
		.from('properties')
		.select('id, name')
		.eq('workspace_id', workspaceId)
		.in('id', ids);
	const map = new Map();
	for (const property of properties ?? []) {
		map.set(property.id, {
			id: property.id,
			name: property.name,
			slug: slugify(property.name)
		});
	}
	return map;
};

const replacePropertyRefs = (text, propertyMap) =>
	text.replace(PROPERTY_REF_REGEX, (_match, ref) => {
		const property = propertyMap.get(ref);
		if (!property) return '';
		return `[[property:${JSON.stringify(property)}]]`;
	});

const sseHeaders = {
	...corsHeaders,
	'Content-Type': 'text/event-stream',
	'Cache-Control': 'no-cache',
	Connection: 'keep-alive'
};

serve(async (req) => {
	if (req.method === 'OPTIONS') {
		return new Response('ok', { headers: corsHeaders });
	}
	if (req.method !== 'POST') {
		return new Response(JSON.stringify({ error: 'Method not allowed' }), {
			status: 405,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}
	if (!openaiApiKey) {
		return new Response(JSON.stringify({ error: 'Missing OPENAI_API_KEY' }), {
			status: 500,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}
	try {
		const payload = await req.json();
		const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
		const userId = payload?.user_id ?? null;
		const wantsStream =
			req.headers.get('accept')?.includes('text/event-stream') || payload?.stream === true;
		if (!userId) {
			return new Response(JSON.stringify({ error: 'Missing user_id' }), {
				status: 400,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}
		const workspace = await resolveWorkspace(payload?.workspace_id, payload?.workspace_slug);
		const threadId = await resolveThreadId(
			userId,
			workspace?.id ?? null,
			payload?.thread_id ?? null
		);
		if (!threadId) {
			return new Response(JSON.stringify({ error: 'Unable to create chat thread' }), {
				status: 500,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}
		const history = await getThreadHistory(threadId);
		if (!message) {
			return new Response(JSON.stringify({ error: 'Missing message' }), {
				status: 400,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}
		const context = await buildContext(workspace?.id ?? null);
		const systemPrompt =
			'You are the Bedrock assistant. You have read-only access to workspace data provided in context. ' +
			'Answer questions about the product and workspace data concisely. Prefer short, direct responses. ' +
			'If asked to perform actions, explain how to do it ' +
			'but do not claim to have completed it. If you are unsure, say so. ' +
			'When referencing any specific issue, you MUST insert an inline placeholder using the exact format ' +
			'[[issue_ref:ID]] where ID is the issue UUID if available; use readable id only when UUID is not available. ' +
			'When referencing any specific property, you MUST insert an inline placeholder using the exact format ' +
			'[[property_ref:ID]] where ID is the property UUID. ' +
			'Do not include JSON. Placeholders can appear multiple times inline. ' +
			'If you include an issue_ref marker, do not repeat the issue details (title, status, dates) in text; rely on the card. ' +
			'If you include a property_ref marker, do not repeat the property details in text; rely on the card. ' +
			'Never list issue identifiers without an issue_ref marker. ' +
			'Do not use bullet points, hyphens, numbering, commas, or other separators around issue_ref markers. ' +
			'If multiple issue_ref markers are needed, output them back-to-back with no characters between, like [[issue_ref:A]][[issue_ref:B]]. ' +
			'Issue_ref markers must never appear mid-sentence. ' +
			'Each issue_ref marker must be the only content on its own line with no punctuation before or after it. ' +
			'Avoid extra blank lines; keep issue_ref marker blocks tight with no empty lines between markers. ' +
			'When returning to normal text after a marker block, resume on the next line only.';
		const contextPrompt = `Workspace context: ${JSON.stringify({
			workspace,
			...context
		})}`;
		if (threadId) {
			await supabase.from('chat_messages').insert({
				thread_id: threadId,
				sender: 'user',
				content: message
			});
			await supabase
				.from('chat_threads')
				.update({ updated_at: new Date().toISOString() })
				.eq('id', threadId);
		}
		const messages = [
			{ role: 'system', content: systemPrompt },
			{ role: 'system', content: contextPrompt },
			...history,
			{ role: 'user', content: message }
		];
		const response = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${openaiApiKey}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({
				model: openaiModel,
				input: messages,
				stream: wantsStream
			})
		});
		if (!response.ok) {
			const errText = await response.text();
			throw new Error(errText);
		}

		if (!wantsStream) {
			const data = await response.json();
			const reply = extractReply(data);
			const issueRefs = Array.from(reply.matchAll(ISSUE_REF_REGEX)).map((m) => m[1]);
			const propertyRefs = Array.from(reply.matchAll(PROPERTY_REF_REGEX)).map((m) => m[1]);
			const issueMap = await resolveIssuesByRefs(workspace?.id ?? null, issueRefs);
			const propertyMap = await resolvePropertiesByRefs(workspace?.id ?? null, propertyRefs);
			const withIssues = replaceIssueRefs(reply, issueMap);
			const finalReply = replacePropertyRefs(withIssues, propertyMap);
			if (threadId) {
				await supabase.from('chat_messages').insert({
					thread_id: threadId,
					sender: 'assistant',
					content: finalReply
				});
				await supabase
					.from('chat_threads')
					.update({ updated_at: new Date().toISOString() })
					.eq('id', threadId);
			}
			return new Response(JSON.stringify({ reply: finalReply }), {
				status: 200,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}

		const reader = response.body?.getReader();
		if (!reader) {
			throw new Error('Missing stream');
		}
		const decoder = new TextDecoder();
		const encoder = new TextEncoder();
		let buffer = '';
		let currentEvent = '';
		let replyText = '';

		const stream = new ReadableStream({
			async start(controller) {
				const sendEvent = (event, data) => {
					controller.enqueue(encoder.encode(`event: ${event}\ndata: ${data}\n\n`));
				};
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (done) break;
						buffer += decoder.decode(value, { stream: true });
						const lines = buffer.split('\n');
						buffer = lines.pop() ?? '';
						for (const line of lines) {
							if (line.startsWith('event:')) {
								currentEvent = line.replace('event:', '').trim();
								continue;
							}
							if (!line.startsWith('data:')) continue;
							const data = line.replace('data:', '').trim();
							if (!data || data === '[DONE]') continue;
							let parsed = null;
							try {
								parsed = JSON.parse(data);
							} catch {
								parsed = null;
							}
							if (currentEvent === 'response.output_text.delta') {
								const delta = parsed?.delta ?? '';
								if (delta) {
									replyText += delta;
									sendEvent('delta', JSON.stringify({ delta }));
								}
							}
							if (currentEvent === 'response.completed') {
								sendEvent('done', JSON.stringify({ done: true }));
							}
						}
					}
					const issueRefs = Array.from(replyText.matchAll(ISSUE_REF_REGEX)).map((m) => m[1]);
					const propertyRefs = Array.from(replyText.matchAll(PROPERTY_REF_REGEX)).map((m) => m[1]);
					const issueMap = await resolveIssuesByRefs(workspace?.id ?? null, issueRefs);
					const propertyMap = await resolvePropertiesByRefs(workspace?.id ?? null, propertyRefs);
					const withIssues = replaceIssueRefs(replyText, issueMap);
					const finalReply = replacePropertyRefs(withIssues, propertyMap);
					sendEvent('final', JSON.stringify({ text: finalReply }));
					if (threadId) {
						await supabase.from('chat_messages').insert({
							thread_id: threadId,
							sender: 'assistant',
							content: finalReply
						});
						await supabase
							.from('chat_threads')
							.update({ updated_at: new Date().toISOString() })
							.eq('id', threadId);
					}
					controller.close();
				} catch (error) {
					sendEvent('error', JSON.stringify({ error: error?.message ?? 'Stream error' }));
					controller.close();
				}
			}
		});

		return new Response(stream, { status: 200, headers: sseHeaders });
	} catch (error) {
		return new Response(JSON.stringify({ error: error?.message ?? 'Chat failed' }), {
			status: 500,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}
});
