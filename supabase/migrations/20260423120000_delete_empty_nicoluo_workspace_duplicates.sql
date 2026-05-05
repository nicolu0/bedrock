-- Remove 5 empty workspace rows inadvertently created by a cascade in
-- ensureWorkspace (src/lib/server/workspaces.js). Verified to have zero
-- rows in every FK-referencing table at authoring time.
DELETE FROM public.workspaces
WHERE id IN (
  '43984af5-598a-4505-a3da-16146754d964',
  'f6436c0e-acf3-469e-9933-50ffa406e248',
  '10adf9f0-8e94-47e6-942c-bf68667e5ac3',
  '98163805-dc6a-4902-a226-09e32bfff703',
  'a1949e2a-d1ba-44c3-8a68-defb055e2bd3'
);
