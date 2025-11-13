// utils/org.js — resolver ORGANIZACION como INTEGER (único source of truth)
const T = (v) => (v == null ? null : String(v).trim() || null);

export function getOrgId(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.query?.organization_id) ||
    T(req.query?.org_id) ||
    T(req.body?.organizacion_id) ||
    T(req.body?.organization_id) ||
    T(req.body?.org_id) ||
    null;

  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("organizacion_id requerido");
  return n; // INTEGER
}

export function hasOrg(req) {
  try { return Number.isFinite(getOrgId(req)); } catch { return false; }
}
