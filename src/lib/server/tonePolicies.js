// @ts-nocheck
export const normalizePolicyLabel = (value) =>
	(value ?? '')
		.toString()
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, ' ')
		.replace(/\s+/g, ' ');

export const buildTonePolicyText = ({ policies, issueLabel, subject, body }) => {
	const normalizedIssue = normalizePolicyLabel(issueLabel);
	const normalizedSource = normalizePolicyLabel(
		[issueLabel, subject, body].filter(Boolean).join(' ')
	);

	const matches = (policies ?? [])
		.filter((policy) => policy?.type === 'tone' && policy?.meta?.ai_prompt)
		.filter((policy) => {
			const candidate = normalizePolicyLabel(
				policy?.meta?.maintenance_issue ?? policy?.description ?? ''
			);
			if (!candidate) return false;
			if (normalizedIssue && candidate === normalizedIssue) return true;
			if (normalizedSource && normalizedSource.includes(candidate)) return true;
			return false;
		});

	if (!matches.length) return '';
	const lines = matches.map((policy) => {
		const label = policy?.meta?.maintenance_issue ?? policy?.description ?? 'Similar issue';
		const prompt = policy?.meta?.ai_prompt ?? '';
		return `- ${label}: ${prompt}`;
	});
	return `Tone guidance (apply to draft tone and structure when relevant):\n${lines.join('\n')}`;
};
