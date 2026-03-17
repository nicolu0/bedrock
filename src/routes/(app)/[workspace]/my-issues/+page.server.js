// @ts-nocheck
import { loadIssuesData, loadPeopleMembers } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:issues');
	depends('app:people');

	const parentData = await parent();
	const { workspace, userId, role, ownerPersonId } = parentData;

	const members = loadPeopleMembers(workspace.id);
	const issuesData = loadIssuesData(workspace.id, userId, role, ownerPersonId);

	return { issuesData, members };
};
