#!/usr/bin/env node

import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const PORT = 3455;
const OPENAI_MODEL = 'gpt-4.1-mini';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(SCRIPT_DIR, '.env');
const APPLESCRIPT_SEND = path.join(SCRIPT_DIR, 'scripts', 'send.applescript');

async function loadDotEnv() {
	try {
		const raw = await fs.readFile(ENV_PATH, 'utf8');
		for (const line of raw.split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith('#')) continue;
			const idx = trimmed.indexOf('=');
			if (idx <= 0) continue;
			const key = trimmed.slice(0, idx).trim();
			let value = trimmed.slice(idx + 1).trim();
			if (
				(value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'"))
			) {
				value = value.slice(1, -1);
			}
			if (!(key in process.env)) process.env[key] = value;
		}
	} catch {
		// .env optional
	}
}

function log(msg, extra = {}) {
	console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));
}

async function sendIMessage(handle, text) {
	try {
		const { stdout, stderr } = await execFileAsync('osascript', [
			APPLESCRIPT_SEND,
			'',
			handle,
			text
		]);
		if (stdout?.trim()) log(`applescript stdout: ${stdout.trim()}`);
		if (stderr?.trim()) log(`applescript stderr: ${stderr.trim()}`);
		return true;
	} catch (err) {
		log(`applescript error: ${err.message}`);
		return false;
	}
}

async function generateSuggestion({ serviceRequestNumber, description, address, tenantName, urgency, vendor }) {
	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) throw new Error('OPENAI_API_KEY not set');

	const lines = [
		`Work Order #${serviceRequestNumber}`,
		description ? `Issue: ${description}` : null,
		address ? `Location: ${address}` : null,
		tenantName ? `Tenant: ${tenantName}` : null,
		urgency ? `Priority: ${urgency}` : null,
		vendor ? `Assigned vendor: ${vendor}` : null,
	].filter(Boolean);

	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: OPENAI_MODEL,
			messages: [
				{
					role: 'system',
					content:
						'You are a property management assistant. A new work order just came in via AppFolio. ' +
						'Generate a short groupchat message (2-3 sentences) that a property manager would send to their team. ' +
						'Include the work order number, what the issue is, the location, tenant name if available, urgency, ' +
						'and a suggested next step (e.g. assign vendor, call tenant, schedule inspection). ' +
						'Be concise and conversational. Plain text only, no bullet points or markdown.',
				},
				{
					role: 'user',
					content: lines.join('\n'),
				},
			],
			max_tokens: 200,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenAI ${response.status}: ${err}`);
	}

	const data = await response.json();
	return data.choices?.[0]?.message?.content?.trim() ?? '';
}

async function handleNotify(req, res) {
	const authHeader = req.headers['authorization'] ?? '';
	const secret = process.env.MACMINI_WEBHOOK_SECRET;
	if (!secret || authHeader !== `Bearer ${secret}`) {
		res.writeHead(401);
		res.end(JSON.stringify({ error: 'Unauthorized' }));
		return;
	}

	let body = '';
	for await (const chunk of req) body += chunk;

	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		res.writeHead(400);
		res.end(JSON.stringify({ error: 'Invalid JSON' }));
		return;
	}

	const targetPhone = process.env.TARGET_PHONE_NUMBER;
	if (!targetPhone) {
		log('TARGET_PHONE_NUMBER not set');
		res.writeHead(500);
		res.end(JSON.stringify({ error: 'TARGET_PHONE_NUMBER not configured' }));
		return;
	}

	// Respond immediately so the edge function isn't blocked
	res.writeHead(202);
	res.end(JSON.stringify({ ok: true }));

	setImmediate(async () => {
		try {
			log('work order received', { wo: payload.serviceRequestNumber });
			const suggestion = await generateSuggestion(payload);
			if (!suggestion) {
				log('empty suggestion from OpenAI');
				return;
			}
			log('sending iMessage', { to: targetPhone, suggestion });
			const sent = await sendIMessage(targetPhone, suggestion);
			log(sent ? 'imessage sent' : 'imessage failed');
		} catch (err) {
			log(`processing error: ${err.message}`);
		}
	});
}

async function main() {
	await loadDotEnv();

	const server = http.createServer(async (req, res) => {
		res.setHeader('Content-Type', 'application/json');

		try {
			if (req.method === 'POST' && req.url === '/notify') {
				await handleNotify(req, res);
			} else if (req.method === 'GET' && req.url === '/health') {
				res.writeHead(200);
				res.end(JSON.stringify({ ok: true }));
			} else {
				res.writeHead(404);
				res.end(JSON.stringify({ error: 'Not found' }));
			}
		} catch (err) {
			log(`request error: ${err.message}`);
			if (!res.headersSent) {
				res.writeHead(500);
				res.end(JSON.stringify({ error: 'Internal server error' }));
			}
		}
	});

	server.listen(PORT, '127.0.0.1', () => {
		log(`appfolio-server listening on port ${PORT}`);
	});
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
