// @ts-nocheck
import { json } from '@sveltejs/kit';
import { GOOGLE_API_KEY } from '$env/static/private';

export const GET = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const input = url.searchParams.get('input');
	const placeId = url.searchParams.get('place_id');

	if (placeId) {
		const res = await fetch(
			`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
			{
				headers: {
					'X-Goog-Api-Key': GOOGLE_API_KEY,
					'X-Goog-FieldMask': 'addressComponents'
				}
			}
		);
		const data = await res.json();
		if (!res.ok || !data.addressComponents) {
			return json({ error: data.error?.message ?? 'Failed to fetch place details' }, { status: 400 });
		}
		const components = data.addressComponents ?? [];
		const get = (type, useShort = false) => {
			const c = components.find((c) => c.types.includes(type));
			return c ? (useShort ? c.shortText : c.longText) : null;
		};
		return json({
			streetNumber: get('street_number'),
			route: get('route'),
			city: get('locality'),
			state: get('administrative_area_level_1'),
			postalCode: get('postal_code'),
			country: get('country')
		});
	}

	if (input) {
		const res = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
			method: 'POST',
			headers: {
				'X-Goog-Api-Key': GOOGLE_API_KEY,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ input })
		});
		const data = await res.json();
		if (!res.ok) {
			return json({ error: data.error?.message ?? 'Autocomplete failed' }, { status: 400 });
		}
		const suggestions = (data.suggestions ?? []).map((s) => ({
			description: s.placePrediction.text.text,
			place_id: s.placePrediction.placeId
		}));
		return json(suggestions);
	}

	return json({ error: 'Missing input or place_id' }, { status: 400 });
};
