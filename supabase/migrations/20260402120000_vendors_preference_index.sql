-- Add preference ordering for vendors
ALTER TABLE public.vendors
ADD COLUMN IF NOT EXISTS preference_index integer;

WITH ranked AS (
	SELECT
		id,
		workspace_id,
		trade,
		row_number() OVER (
			PARTITION BY workspace_id, trade
			ORDER BY name, created_at, id
		) AS pref
	FROM public.vendors
)
UPDATE public.vendors v
SET preference_index = ranked.pref
FROM ranked
WHERE v.id = ranked.id;

ALTER TABLE public.vendors
ALTER COLUMN preference_index SET DEFAULT 0;

ALTER TABLE public.vendors
ALTER COLUMN preference_index SET NOT NULL;
