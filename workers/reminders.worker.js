// workers/reminders.worker.js — ESM
import cron from "node-cron";
import fetch from "node-fetch";                // <- asegura fetch en Node
import { pool } from "../utils/db.js";         // <- import correcto al pool

const CRON = process.env.REMINDER_CRON || "*/10 * * * *";
const TZ = process.env.TZ || "America/Argentina/Mendoza";

// Slack (fallbacks)
const GLOBAL_WEBHOOK = process.env.SLACK_WEBHOOK_URL || null;
const FALLBACK_CHANNEL =
  process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || "#reminders-and-follow-ups";

// org “por defecto” como TEXT
const FALLBACK_ORG_ID = (process.env.FALLBACK_ORG_ID || "10").toString();

// Helper para queries fuera de transacción
const q = (text, params = []) => pool.query(text, params);

/**
 * - Toma hasta 100 recordatorios vencidos (FOR UPDATE SKIP LOCKED)
 * - Los marca en_proceso
 * - Intenta enviar a Slack (webhook por org de `integraciones` o global)
 * - Marca enviado / reprograma con backoff simple si falla
 */
export async function runRemindersOnce() {
  const client = await pool.connect();
  let grabbed = [];
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `
      WITH picked AS (
        SELECT r.id
          FROM recordatorios r
         WHERE r.estado = 'pendiente'
           AND r.enviar_en <= NOW()
         ORDER BY r.enviar_en ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 100
      )
      UPDATE recordatorios r
         SET estado = 'en_proceso'
        FROM picked p
        LEFT JOIN tareas   t ON t.id = r.tarea_id
        LEFT JOIN clientes c ON c.id = t.cliente_id
        LEFT JOIN integraciones i
               ON i.organizacion_id = COALESCE(r.organizacion_id, c.organizacion_id, $1::text)
       WHERE r.id = p.id
       RETURNING
         r.id,
         COALESCE(r.mensaje, r.titulo, t.titulo, 'Recordatorio') AS body,
         r.enviar_en,
         COALESCE(r.organizacion_id, c.organizacion_id, $1::text) AS org_id,
         t.usuario_email,
         t.vence_en,
         COALESCE(i.slack_webhook_url, $2::text) AS webhook,
         COALESCE(i.slack_default_channel, $3::text) AS channel
      `,
      [FALLBACK_ORG_ID, GLOBAL_WEBHOOK, FALLBACK_CHANNEL]
    );

    grabbed = rows || [];
    await client.query("COMMIT");
    console.log(`[REMINDERS] Picked ${grabbed.length} reminder(s).`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[NODE-CRON] [ERROR picking reminders]", e?.message || e);
    return;
  } finally {
    client.release();
  }

  if (!grabbed.length) return;

  for (const r of grabbed) {
    const ok = await sendToSlack(r).catch((e) => {
      console.error("[REMINDERS] sendToSlack threw:", e?.message || e);
      return false;
    });

    if (ok) {
      await q(
        `UPDATE recordatorios SET estado='enviado', sent_at=NOW() WHERE id=$1`,
        [r.id]
      );
    } else {
      await q(
        `
        UPDATE recordatorios
           SET estado='pendiente',
               intento_count = COALESCE(intento_count,0)+1,
               last_error = CONCAT(
                 COALESCE(last_error,''), 
                 CASE WHEN last_error IS NULL OR last_error='' THEN '' ELSE E'\n' END,
                 NOW()::text, ': fallo al enviar a Slack'
               ),
               enviar_en = NOW() + INTERVAL '5 minutes'
         WHERE id=$1
        `,
        [r.id]
      );
    }
  }
}

async function sendToSlack({ body, usuario_email, vence_en, channel, webhook }) {
  if (!webhook) {
    console.warn("[REMINDERS] Sin Slack webhook (org ni global). Se reintenta luego.");
    return false;
  }

  const lines = [
    `*${body}*`,
    vence_en ? `Vence: ${new Date(vence_en).toLocaleString("es-AR")}` : "",
    usuario_email ? `Asignado a: ${usuario_email}` : "",
  ].filter(Boolean);

  const payload = {
    text: lines.join("\n"),
    channel: channel || FALLBACK_CHANNEL, // algunos webhooks lo ignoran
    username: "VEX Reminders",
    icon_emoji: ":alarm_clock:",
  };

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => res.statusText);
    console.error("[REMINDERS] Slack error:", res.status, txt);
    return false;
  }
  return true;
}

export function scheduleReminders() {
  const task = cron.schedule(
    CRON,
    () => runRemindersOnce().catch((e) => console.error("[NODE-CRON] [ERROR run]", e)),
    { timezone: TZ }
  );
  console.log(
    `🕒 Reminders ON cron=${CRON} tz=${TZ} | fallbackChannel=${FALLBACK_CHANNEL}`
  );
  return task;
}
