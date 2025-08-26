// Backend/utils/slack.js
import fetch from "node-fetch";

/** Envía un mensaje simple a Slack usando un Incoming Webhook */
export async function sendSlackMessage(webhookUrl, text, blocks = null) {
  if (!webhookUrl) throw new Error("Missing Slack webhook");
  const body = blocks ? { text, blocks } : { text };
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const msg = await r.text().catch(() => "");
    throw new Error(`Slack error ${r.status}: ${msg}`);
  }
}

/** Bloques vistosos para recordatorios de seguimiento */
export function followupBlocks({ titulo, cliente, vence_en, url = null }) {
  const due = vence_en ? new Date(vence_en).toLocaleString() : "—";
  return [
    { type: "section", text: { type: "mrkdwn", text: `*Seguimiento pendiente:* ${titulo}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `Cliente: *${cliente || "—"}* • Vence: *${due}*` }] },
    ...(url ? [{ type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Abrir en CRM" }, url }]}] : []),
  ];
}
