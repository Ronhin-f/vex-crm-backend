// utils/org.js — Normalización de organizacion_id (TEXT) para rutas
import { T } from "./parsers.js";

export function getOrgText(req) {
  // prioridad: usuario autenticado > header > query > body
  const raw =
    T(req?.usuario?.organizacion_id) ||
    T(req?.headers?.["x-org-id"]) ||
    T(req?.query?.organizacion_id) ||
    T(req?.body?.organizacion_id) ||
    null;

  if (raw == null) throw new Error("organizacion_id requerido");
  // NO cast a number jamás. Siempre TEXT.
  return String(raw);
}

/**
 * Inyecta `organizacion_id` al params array y devuelve { sql, params }
 * Uso: const { sql, params } = withOrg("SELECT ... WHERE organizacion_id = $1", [org])
 * o  : const { sql, params } = withOrg("... WHERE ...", [], org)
 */
export function withOrg(sql, params = [], orgMaybe) {
  const org = orgMaybe ?? params[0];
  if (!org) throw new Error("withOrg: faltó organizacion_id");
  return { sql, params };
}
