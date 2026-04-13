/**
 * Encodes a single URL path segment (so `/` becomes `%2F`).
 * @param {string | number | null | undefined} value
 * @returns {string}
 */
export const encodePathSegment = (value) => encodeURIComponent((value ?? '').toString());
