// Draft queue abstraction backed by the web UI's local draft storage.
//
// The queue owns scheduling/hold calculation. Callers describe the review item;
// this module decides whether it should be held until work hours and writes the
// draft record the UI already knows how to approve, schedule, send, or dismiss.

import * as db from '../state/helpers.mjs';
import { nextSendTime } from './work-hours.mjs';

export async function enqueuePmReviewDraft({
	trigger,
	channel,
	workspace_id,
	workspace_label,
	issue_id,
	to,
	to_participants = [],
	messages
}) {
	if (!trigger) throw new Error('enqueuePmReviewDraft: trigger required');
	if (!channel) throw new Error('enqueuePmReviewDraft: channel required');
	if (!workspace_id) throw new Error('enqueuePmReviewDraft: workspace_id required');
	if (!workspace_label) throw new Error('enqueuePmReviewDraft: workspace_label required');
	if (!issue_id) throw new Error('enqueuePmReviewDraft: issue_id required');
	if (!to) throw new Error('enqueuePmReviewDraft: to required');
	if (!Array.isArray(messages) || messages.length === 0) {
		throw new Error('enqueuePmReviewDraft: messages required');
	}

	const cleanMessages = messages
		.map((m) => ({ body: String(m?.body ?? '').trim() }))
		.filter((m) => m.body);
	if (cleanMessages.length === 0) throw new Error('enqueuePmReviewDraft: empty messages');

	return db.createDraft({
		trigger,
		channel,
		workspace_id,
		workspace_label,
		issue_id,
		to,
		to_participants,
		messages: cleanMessages,
		hold_until: nextSendTime(),
		pm_review_required: true
	});
}
