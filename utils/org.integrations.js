// backend/utils/org.integrations.js
import { q } from "./db.js";
import { coreListUsers } from "./core.client.js";
import { assertOrgText, T } from "./parsers.js";

// Lee JSON desde env sin romper si no es válido
function envJson(name) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : null; }
  catch { return null; }
}

/**
 * Config de Slack por organización.
 * - webhookUrl / defaultChannel: tabla `integraciones` o ENV fallback
 * - usersMap: tabla `slack_users` (email→user_id). Si está vacío, usa SLACK_USERS_MAP (ENV)
 */
export async function getOrgIntegrations(orgIdRaw) {
  const orgId = assertOrgText(orgIdRaw);

  // 1) Integraciones (1 fila por org)
  let row = {};
  try {
    const r = await q(
      `SELECT slack_webhook_url, slack_default_channel
         FROM integraciones
        WHERE organizacion_id = $1
        LIMIT 1`,
      [orgId]
    );
    row = r.rows?.[0] || {};
  } catch {
    // seguimos con fallbacks
  }

  // 2) Mapa de usuarios desde slack_users
  let usersMap = {};
  try {
    const r = await q(
      `SELECT email, slack_user_id
         FROM slack_users
        WHERE organizacion_id = $1`,
      [orgId]
    );
    for (const it of r.rows || []) {
      const email = T(it?.email)?.toLowerCase();
      const sid = T(it?.slack_user_id);
      if (!email || !sid) continue;
      usersMap[email] = sid;
    }
  } catch {
    // seguimos con fallbacks
  }

  // 3) Fallbacks de ENV
  const envMap = envJson("SLACK_USERS_MAP") || {};
  if (!Object.keys(usersMap).length && Object.keys(envMap).length) usersMap = envMap;

  // 4) Fallback de canal: primero integraciones, luego envs
  const envDefault = process.env.SLACK_DEFAULT_CHANNEL || null;
  const envFallback = process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || null;

  return {
    webhookUrl: row.slack_webhook_url || process.env.SLACK_WEBHOOK_URL || null,
    defaultChannel: row.slack_default_channel || envDefault || envFallback,
    usersMap,
  };
}

/**
 * Resuelve Slack User ID para un email.
 * Orden:
 *   1) Mapa local (DB slack_users o ENV SLACK_USERS_MAP)
 *   2) Directorio del Core (si está disponible) → slack_id/slack_user_id
 *   3) Si lo trae del Core, lo persiste en slack_users (upsert)
 *
 * @param {string} orgIdRaw
 * @param {string} email
 * @param {string} [bearerFromReq]
 */
export async function getSlackIdForEmail(orgIdRaw, email, bearerFromReq) {
  const orgId = assertOrgText(orgIdRaw);
  if (!email) return null;
  const norm = T(email)?.toLowerCase();
  if (!norm) return null;

  // 1) DB/ENV
  const { usersMap } = await getOrgIntegrations(orgId);
  if (usersMap && usersMap[norm]) return usersMap[norm];

  // 2) Core directory
  try {
    const list = await coreListUsers(orgId, bearerFromReq);
    const u = (list || []).find(
      (x) => (x.email || x.usuario_email || "").toLowerCase() === norm
    );
    const sid = u?.slack_id || u?.slack_user_id || u?.slack?.user_id || null;

    // 3) Persistir para próximas consultas
    if (sid) {
      await upsertSlackUser(orgId, norm, sid).catch(() => {});
      return sid;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Upsert de mapeo email→slack_user_id.
 * Requiere UNIQUE (organizacion_id, email) en tabla slack_users (ver migración).
 */
export async function upsertSlackUser(orgIdRaw, email, slackUserId) {
  const orgId = assertOrgText(orgIdRaw);
  const normEmail = T(email)?.toLowerCase();
  const sid = T(slackUserId);
  if (!normEmail || !sid) return { ok: false, error: "missing_params" };

  await q(
    `INSERT INTO slack_users (organizacion_id, email, slack_user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (organizacion_id, email)
     DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id,
                   updated_at = NOW()`,
    [orgId, normEmail, sid]
  );
  return { ok: true };
}
