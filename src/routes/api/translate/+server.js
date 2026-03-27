// @ts-nocheck
import { json } from '@sveltejs/kit';
import { OPENAI_API_KEY } from '$env/static/private';

const openaiModel = 'gpt-5-mini-2025-08-07';

const systemPrompt = `Translate the provided message to Spanish.
Rules:
- Preserve paragraph breaks and formatting.
- Do not translate names, email addresses, URLs, phone numbers, or unit/property identifiers.
- Keep dates, times, and numbers as-is.
- Maintain the original tone (polite, direct, etc.).
- Output only the translated text.`.trim();

export const POST = async ({ request }) => {
	const payload = await request.json().catch(() => null);
	const body = typeof payload?.body === 'string' ? payload.body.trim() : '';
	if (!body) {
		return json({ error: 'Missing body' }, { status: 400 });
	}
	if (!OPENAI_API_KEY) {
		return json({ error: 'Missing OpenAI API key' }, { status: 500 });
	}

	const response = await fetch('https://api.openai.com/v1/responses', {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${OPENAI_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			model: openaiModel,
			input: [
				{ role: 'system', content: systemPrompt },
				{ role: 'user', content: body }
			],
			text: {
				format: {
					type: 'json_schema',
					name: 'translation_output',
					schema: {
						type: 'object',
						additionalProperties: false,
						properties: {
							translation: { type: 'string' }
						},
						required: ['translation']
					}
				}
			}
		})
	});

	if (!response.ok) {
		return json({ error: await response.text() }, { status: 500 });
	}

	const data = await response.json();
	const outputText = data.output_text ?? '';
	try {
		const parsed = outputText ? JSON.parse(outputText) : null;
		const translation = typeof parsed?.translation === 'string' ? parsed.translation.trim() : '';
		if (!translation) {
			return json({ error: 'Empty translation' }, { status: 500 });
		}
		return json({ translation });
	} catch {
		const fallback = typeof outputText === 'string' ? outputText.trim() : '';
		if (!fallback) {
			return json({ error: 'Empty translation' }, { status: 500 });
		}
		return json({ translation: fallback });
	}
};
