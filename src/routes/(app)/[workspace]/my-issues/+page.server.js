// @ts-nocheck
import { loadIssuesData, loadPeopleMembers } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	console.log('[my-issues load] load() called');

	depends('app:issues');
	depends('app:people');
	console.log('[my-issues load] registered depends: app:issues, app:people');

	const parentData = await parent();
	const { workspace, userId, role, ownerPersonId } = parentData;
	console.log('[my-issues load] context — workspaceId:', workspace?.id, 'userId:', userId, 'role:', role, 'ownerPersonId:', ownerPersonId ?? null);

	const canViewPeople = role === 'admin' || role === 'member';

	const [issuesData, members] = await Promise.all([
		loadIssuesData(workspace.id, userId, role, ownerPersonId),
		canViewPeople ? loadPeopleMembers(workspace.id) : Promise.resolve([])
	]);

	const totalIssues = issuesData?.issues?.length ?? 0;
	const sectionCount = issuesData?.sections?.length ?? 0;
	const sampleIds = (issuesData?.issues ?? []).slice(0, 3).map((i) => i.readableId ?? i.id);
	console.log('[my-issues load] loadIssuesData resolved — totalIssues:', totalIssues, 'sections:', sectionCount, 'sample IDs:', sampleIds);
	console.log('[my-issues load] returning data');

	return { issuesData, members };
};
