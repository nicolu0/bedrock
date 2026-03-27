// @ts-nocheck
const tokenizeWords = (value) => {
	if (!value) return [];
	return String(value)
		.split(/(\s+)/)
		.filter((token) => token !== '');
};

const mergeSegments = (segments) => {
	if (!segments.length) return [];
	const merged = [];
	for (const segment of segments) {
		if (!segment?.text) continue;
		const last = merged[merged.length - 1];
		if (last && last.type === segment.type) {
			last.text += segment.text;
		} else {
			merged.push({ type: segment.type, text: segment.text });
		}
	}
	return merged;
};

export const diffWords = (original, updated) => {
	const originalTokens = tokenizeWords(original);
	const updatedTokens = tokenizeWords(updated);

	if (!originalTokens.length && !updatedTokens.length) return [];
	if (!originalTokens.length) {
		return mergeSegments(updatedTokens.map((text) => ({ type: 'insert', text })));
	}
	if (!updatedTokens.length) {
		return mergeSegments(originalTokens.map((text) => ({ type: 'delete', text })));
	}

	const rows = originalTokens.length + 1;
	const cols = updatedTokens.length + 1;
	const dp = Array.from({ length: rows }, () => Array(cols).fill(0));

	for (let i = rows - 2; i >= 0; i -= 1) {
		for (let j = cols - 2; j >= 0; j -= 1) {
			if (originalTokens[i] === updatedTokens[j]) {
				dp[i][j] = dp[i + 1][j + 1] + 1;
			} else {
				dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
			}
		}
	}

	const segments = [];
	let i = 0;
	let j = 0;
	while (i < originalTokens.length && j < updatedTokens.length) {
		if (originalTokens[i] === updatedTokens[j]) {
			segments.push({ type: 'equal', text: originalTokens[i] });
			i += 1;
			j += 1;
			continue;
		}
		if (dp[i + 1][j] >= dp[i][j + 1]) {
			segments.push({ type: 'delete', text: originalTokens[i] });
			i += 1;
		} else {
			segments.push({ type: 'insert', text: updatedTokens[j] });
			j += 1;
		}
	}

	while (i < originalTokens.length) {
		segments.push({ type: 'delete', text: originalTokens[i] });
		i += 1;
	}

	while (j < updatedTokens.length) {
		segments.push({ type: 'insert', text: updatedTokens[j] });
		j += 1;
	}

	return mergeSegments(segments);
};
