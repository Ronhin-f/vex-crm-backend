// utils/slack.js
export function followupBlocks({ titulo, cliente, vence_en, url }) {
  const due = vence_en ? new Date(vence_en).toLocaleString() : "sin fecha";
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${titulo}*` } },
    { type: "section", fields: [
      { type: "mrkdwn", text: `*Cliente:*\n${cliente || "-"}` },
      { type: "mrkdwn", text: `*Vence:*\n${due}` },
    ]},
    ...(url ? [{ type: "actions", elements: [
      { type: "button", text: { type: "plain_text", text: "Ver detalle" }, url }
    ]}] : []),
  ];
}

export async function sendSlackMessage(webhookUrl, text, blocks = null) {
  if (!webhookUrl || !/^https:\/\/hooks\.slack\.com\//.test(webhookUrl)) {
    throw new Error("Slack webhook inválido");
  }
  const payload = blocks ? { text, blocks } : { text };
  const r = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`Slack ${r.status}`);
  return true;
}
