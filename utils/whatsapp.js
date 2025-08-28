// utils/whatsapp.js
const GRAPH_BASE = process.env.WHATSAPP_GRAPH_BASE || "https://graph.facebook.com";
const GRAPH_VER  = process.env.WHATSAPP_GRAPH_VER  || "v20.0";

export async function sendWhatsAppText({ metaToken, phoneId, to, text }) {
  if (!metaToken || !phoneId || !to || !text) throw new Error("WhatsApp: parámetros faltantes");
  const url = `${GRAPH_BASE}/${GRAPH_VER}/${phoneId}/messages`;
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${metaToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text.slice(0, 4000) },
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data?.error?.message || `WhatsApp ${r.status}`;
    const err = new Error(msg);
    err.data = data;
    throw err;
  }
  return data;
}
