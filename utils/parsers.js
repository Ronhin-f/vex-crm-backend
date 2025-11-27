// backend/utils/parsers.js
// Helpers mínimos reutilizados por org.integrations y otros módulos legacy.

// Texto safe: trim y null si queda vacío
export function T(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

// Normaliza organizacion_id a TEXT (trim) o lanza si no hay valor
export function assertOrgText(v) {
  const t = T(v);
  if (!t) throw new Error("organizacion_id requerido");
  return t;
}

// Entero seguro (o null)
export function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}
