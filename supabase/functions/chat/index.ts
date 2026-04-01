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

const buildContext = async (workspaceId) => {
	if (!workspaceId) return { workspace: null };
	const [issuesRes, propertiesRes, peopleRes, policiesRes] = await Promise.all([
		supabase
			.from('issues')
			.select('id, readable_id, name, status, urgent, updated_at')
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
		const history = Array.isArray(payload?.history) ? payload.history : [];
		if (!message) {
			return new Response(JSON.stringify({ error: 'Missing message' }), {
				status: 400,
				headers: { ...corsHeaders, 'Content-Type': 'application/json' }
			});
		}
		const workspace = await resolveWorkspace(payload?.workspace_id, payload?.workspace_slug);
		const context = await buildContext(workspace?.id ?? null);
		const systemPrompt =
			'You are the Bedrock assistant. You have read-only access to workspace data provided in context. ' +
			'Answer questions about the product and workspace data. If asked to perform actions, explain how to do it ' +
			'but do not claim to have completed it. If you are unsure, say so.';
		const contextPrompt = `Workspace context: ${JSON.stringify({
			workspace,
			...context
		})}`;
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
				input: messages
			})
		});
		if (!response.ok) {
			const errText = await response.text();
			throw new Error(errText);
		}
		const data = await response.json();
		const reply = extractReply(data);
		return new Response(JSON.stringify({ reply }), {
			status: 200,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	} catch (error) {
		return new Response(JSON.stringify({ error: error?.message ?? 'Chat failed' }), {
			status: 500,
			headers: { ...corsHeaders, 'Content-Type': 'application/json' }
		});
	}
});
