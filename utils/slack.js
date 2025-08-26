// backend/utils/slack.js
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
