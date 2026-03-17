// @ts-nocheck
import { loadIssuesData } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:issues');

	const parentData = await parent();
	const { workspace, userId, role, ownerPersonId } = parentData;

	const issuesData = loadIssuesData(workspace.id, userId, role, ownerPersonId);

	return { issuesData };
};
