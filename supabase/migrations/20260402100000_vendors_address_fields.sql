ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS street  text,
  ADD COLUMN IF NOT EXISTS street2 text,
  ADD COLUMN IF NOT EXISTS city    text,
  ADD COLUMN IF NOT EXISTS state   text,
  ADD COLUMN IF NOT EXISTS zip     text;
