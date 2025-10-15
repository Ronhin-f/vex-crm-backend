// backend/utils/org.integrations.js
import { q } from "./db.js";
import { coreListUsers } from "./core.client.js";

// Lee JSON desde env sin romper si no es válido
function envJson(name) {
  try {
    return process.env[name] ? JSON.parse(process.env[name]) : null;
  } catch {
    return null;
  }
}

/**
 * Config de Slack por organización.
 * - webhookUrl / defaultChannel: de tabla `integraciones` o ENV fallback
 * - usersMap: de tabla `slack_users` (email→user_id). Si está vacío, usa SLACK_USERS_MAP (ENV)
 */
export async function getOrgIntegrations(orgId) {
  // 1) integraciones (1 fila por org)
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

  // 2) mapa de usuarios desde slack_users
  let usersMap = {};
  try {
    const r = await q(
      `SELECT email, slack_user_id
         FROM slack_users
        WHERE organizacion_id = $1`,
      [orgId]
    );
    for (const it of r.rows || []) {
      if (!it?.email || !it?.slack_user_id) continue;
      usersMap[String(it.email).trim().toLowerCase()] = String(it.slack_user_id).trim();
    }
  } catch {
    // seguimos con fallbacks
  }

  // 3) Fallbacks de ENV
  const envMap = envJson("SLACK_USERS_MAP") || {};
  if (!Object.keys(usersMap).length && Object.keys(envMap).length) {
    usersMap = envMap;
  }

  return {
    webhookUrl: row.slack_webhook_url || process.env.SLACK_WEBHOOK_URL || null,
    defaultChannel: row.slack_default_channel || process.env.SLACK_DEFAULT_CHANNEL || null,
    usersMap,
  };
}

/**
 * Resuelve Slack User ID para un email.
 * Orden:
 *   1) Mapa local (DB slack_users o ENV SLACK_USERS_MAP)
 *   2) Directorio del Core (si está disponible) → slack_id/slack_user_id
 *
 * @param {string|number} orgId
 * @param {string} email
 * @param {string} [bearerFromReq] - opcional, por si querés pasar el Authorization del request
 */
export async function getSlackIdForEmail(orgId, email, bearerFromReq) {
  if (!email) return null;
  const norm = String(email).trim().toLowerCase();

  // 1) DB/ENV
  const { usersMap } = await getOrgIntegrations(orgId);
  if (usersMap && usersMap[norm]) return usersMap[norm];

  // 2) Core directory
  try {
    const list = await coreListUsers(orgId, bearerFromReq);
    const u = (list || []).find(
      x => (x.email || x.usuario_email || "").toLowerCase() === norm
    );
    return u?.slack_id || u?.slack_user_id || u?.slack?.user_id || null;
  } catch {
    return null;
  }
}

/**
 * Upsert rápido de mapeo email→slack_user_id (útil para admin/seed).
 */
export async function upsertSlackUser(orgId, email, slackUserId) {
  if (!orgId || !email || !slackUserId) return { ok: false, error: "missing_params" };
  const normEmail = String(email).trim().toLowerCase();
  await q(
    `INSERT INTO slack_users (organizacion_id, email, slack_user_id)
     VALUES ($1,$2,$3)
     ON CONFLICT (organizacion_id, email)
     DO UPDATE SET slack_user_id = EXCLUDED.slack_user_id`,
    [orgId, normEmail, String(slackUserId).trim()]
  );
  return { ok: true };
}
