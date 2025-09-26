// utils/org.integrations.js (ESM)
import { pool } from "./db.js";

export async function getOrgIntegrations(orgId) {
  if (!orgId) return { webhookUrl: null, defaultChannel: null, overrides: {} };
  const { rows } = await pool.query(
    "SELECT integraciones FROM organizaciones WHERE id = $1",
    [orgId]
  );
  const integ = rows[0]?.integraciones || {};
  return {
    webhookUrl: integ.slack_webhook_url || null,
    defaultChannel: integ.slack_default_channel || null,
    overrides: integ.slack_user_overrides || {},
  };
}

export async function getSlackIdForEmail(orgId, email) {
  if (!orgId || !email) return null;

  // 1) overrides JSON en organizaciones
  const { overrides } = await getOrgIntegrations(orgId);
  if (overrides && overrides[email]) return overrides[email];

  // 2) tabla slack_users (opción A recomendada)
  const { rows } = await pool.query(
    "SELECT slack_user_id FROM slack_users WHERE org_id = $1 AND email = $2",
    [orgId, email]
  );
  return rows[0]?.slack_user_id || null;
}
