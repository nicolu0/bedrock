-- Allow 'manager' sender for outbound management texts, 'agent' for existing agent messages
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_sender_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_sender_check
  CHECK (sender IN ('tenant', 'vendor', 'unknown', 'agent', 'manager'));

-- Allow 'manager' participant_type on threads
ALTER TABLE public.threads DROP CONSTRAINT IF EXISTS threads_participant_type_check;
ALTER TABLE public.threads ADD CONSTRAINT threads_participant_type_check
  CHECK (participant_type IN ('tenant', 'vendor', 'unknown', 'manager'));

-- Phone column on threads for phone-based thread lookup
ALTER TABLE public.threads ADD COLUMN IF NOT EXISTS phone text;
CREATE INDEX IF NOT EXISTS threads_phone_idx ON public.threads (phone) WHERE phone IS NOT NULL;
