-- Agrega campos para vertical Salud/Veterinaria en contactos
ALTER TABLE IF EXISTS public.contactos
  ADD COLUMN IF NOT EXISTS peso TEXT,
  ADD COLUMN IF NOT EXISTS vacunas TEXT,
  ADD COLUMN IF NOT EXISTS proxima_vacuna DATE;

-- Garantiza organizacion_id en texto para scope multi-tenant
ALTER TABLE IF EXISTS public.contactos
  ALTER COLUMN organizacion_id TYPE TEXT USING organizacion_id::text;
