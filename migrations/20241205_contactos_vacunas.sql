-- Agrega campos para vertical Salud/Veterinaria en contactos
ALTER TABLE IF EXISTS public.contactos
  ADD COLUMN IF NOT EXISTS organizacion_id TEXT,
  ADD COLUMN IF NOT EXISTS peso TEXT,
  ADD COLUMN IF NOT EXISTS vacunas TEXT,
  ADD COLUMN IF NOT EXISTS proxima_vacuna DATE;

-- Garantiza organizacion_id en texto para scope multi-tenant
ALTER TABLE IF EXISTS public.contactos
  ALTER COLUMN organizacion_id TYPE TEXT USING organizacion_id::text;

-- Index para dashboard (vacunas proximas por organizacion)
CREATE INDEX IF NOT EXISTS idx_contactos_org_vacuna
  ON public.contactos (organizacion_id, proxima_vacuna);
