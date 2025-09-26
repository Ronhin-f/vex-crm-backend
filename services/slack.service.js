// services/slack.service.js
import { getOrgIntegrations, getSlackIdForEmail } from "../utils/org.integrations.js";

export async function postSlack({ orgId, text, emailAsignado }) {
  const { webhookUrl, defaultChannel } = await getOrgIntegrations(orgId);
  const fallback = process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || null;

  if (!webhookUrl) {
    return { ok: false, reason: "no_webhook_configured" };
  }

  // Preparar mención
  const slackId = await getSlackIdForEmail(orgId, emailAsignado);
  const mention = slackId ? `<@${slackId}>` : (emailAsignado || "");

  // Slack Incoming Webhook ignora "channel" a veces si el webhook está atado a un canal;
  // lo incluimos igual si tenemos default.
  const body = {
    text: text.replace("<MENTION>", mention),
    ...(defaultChannel ? { channel: defaultChannel } : fallback ? { channel: fallback } : {}),
  };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return { ok: res.ok, status: res.status };
}
