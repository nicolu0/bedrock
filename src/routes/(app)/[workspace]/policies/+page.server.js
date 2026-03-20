// @ts-nocheck
import { loadPoliciesData } from '$lib/server/loaders';

export const load = async ({ parent, depends }) => {
	depends('app:policies');

	const parentData = await parent();
	const { workspace } = parentData;

	const policiesData = loadPoliciesData(workspace.id);

	return { policies: policiesData };
};
