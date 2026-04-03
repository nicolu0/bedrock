// @ts-nocheck
import { loadPeople } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:people');

	const { workspace, role, userId } = await parent();
	const canViewPeople = role === 'admin' || role === 'bedrock' || role === 'member';

	if (!canViewPeople) {
		return { people: [], currentUserId: userId };
	}

	const people = await loadPeople(workspace.id);
	return { people, currentUserId: userId };
};
