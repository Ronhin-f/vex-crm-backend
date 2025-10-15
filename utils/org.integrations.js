// backend/utils/org.integrations.js
import { q } from "./db.js";
import { coreListUsers } from "./core.client.js";

function envJson(name) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : null; } catch { return null; }
}

export async function getOrgIntegrations(orgId) {
  try {
    const r = await q(
      `select slack_webhook_url, slack_default_channel, slack_users_map
         from org_integrations
        where organizacion_id = $1
        limit 1`,
      [orgId]
    );
    const row = r.rows?.[0] || {};
    return {
      webhookUrl: row.slack_webhook_url || process.env.SLACK_WEBHOOK_URL || null,
      defaultChannel: row.slack_default_channel || process.env.SLACK_DEFAULT_CHANNEL || null,
      usersMap: row.slack_users_map || envJson("SLACK_USERS_MAP") || {}, // {"email":"UXXXX"}
    };
  } catch {
    return {
      webhookUrl: process.env.SLACK_WEBHOOK_URL || null,
      defaultChannel: process.env.SLACK_DEFAULT_CHANNEL || null,
      usersMap: envJson("SLACK_USERS_MAP") || {},
    };
  }
}

export async function getSlackIdForEmail(orgId, email, bearerFromReq) {
  if (!email) return null;
  const norm = String(email).trim().toLowerCase();

  // 1) mapa local (DB/ENV)
  const { usersMap } = await getOrgIntegrations(orgId);
  if (usersMap && usersMap[norm]) return usersMap[norm];

  // 2) directorio Core
  try {
    const list = await coreListUsers(orgId, bearerFromReq);
    const u = list.find(x => (x.email || x.usuario_email || "").toLowerCase() === norm);
    return u?.slack_id || u?.slack_user_id || u?.slack?.user_id || null;
  } catch {
    return null;
  }
}
