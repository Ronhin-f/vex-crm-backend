// utils/org.js — resolver de organización TEXT-safe con fallback (sin nocache)
const T = (v) => (v == null ? null : String(v).trim() || null);

export function getOrgText(req, opts = { require: false }) {
  const fromToken =
    T(req?.usuario?.organizacion_id) ||
    T(req?.usuario?.org_id) || null;

  const fromHeaders =
    T(req?.headers?.["x-org-id"]) ||
    T(req?.headers?.["x-organization-id"]) || null;

  const fromParams =
    T(req?.query?.organizacion_id) ||
    T(req?.query?.organization_id) ||
    T(req?.query?.org_id) ||
    T(req?.body?.organizacion_id) ||
    T(req?.body?.organization_id) ||
    T(req?.body?.org_id) || null;

  const fromEnv = T(process.env.DEFAULT_ORG_ID) || null;
  const org = fromToken || fromHeaders || fromParams || fromEnv;

  if (!org && opts?.require) throw new Error("organizacion_id requerido");
  return org || null;
}
