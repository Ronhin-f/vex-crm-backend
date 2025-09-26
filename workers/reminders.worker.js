// workers/reminders.worker.js — ESM
import cron from "node-cron";
import { db, q } from "../utils/db.js"; // <- ¡import relativo!

const CRON = process.env.REMINDER_CRON || "*/10 * * * *";
const TZ = process.env.TZ || "America/Argentina/Mendoza";

// Slack
const GLOBAL_WEBHOOK = process.env.SLACK_WEBHOOK_URL || null; // fallback global
const FALLBACK_CHANNEL =
  process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL || "#reminders-and-follow-ups";

// Si usabas un org “por defecto”, ahora como TEXT:
const FALLBACK_ORG_ID = (process.env.FALLBACK_ORG_ID || "10").toString();

/**
 * Corre una pasada:
 * - Toma hasta 100 recordatorios vencidos con FOR UPDATE SKIP LOCKED
 * - Los marca en_proceso (para que otras instancias no los vuelvan a tomar)
 * - Envía a Slack (webhook por org desde `integraciones` o global)
 * - Marca enviado / reprograma con backoff simple si falla
 */
export async function runRemindersOnce() {
  const client = await db.connect();
  let grabbed = [];
  try {
    await client.query("BEGIN");

    // 1) “Reservo” filas para esta pasada y traigo los datos necesarios
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
         COALESCE(r.mensaje, r.titulo, t.titulo, 'Recordatorio')        AS body,
         r.enviar_en,
         COALESCE(r.organizacion_id, c.organizacion_id, $1::text)       AS org_id,
         t.usuario_email,
         t.vence_en,
         COALESCE(i.slack_webhook_url, $2::text)                         AS webhook,
         COALESCE(i.slack_default_channel, $3::text)                     AS channel
      `,
      [FALLBACK_ORG_ID, GLOBAL_WEBHOOK, FALLBACK_CHANNEL]
    );

    grabbed = rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[NODE-CRON] [ERROR]", e?.message || e);
    return;
  } finally {
    client.release();
  }

  // 2) Envío uno por uno (fuera de la transacción)
  for (const r of grabbed) {
    const ok = await sendToSlack(r).catch(() => false);

    if (ok) {
      await q(
        `UPDATE recordatorios SET estado='enviado', sent_at=NOW() WHERE id=$1`,
        [r.id]
      );
    } else {
      // Backoff sencillo: reintento en 5 minutos, dejo estado 'pendiente'
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
    console.warn("[REMINDERS] No hay Slack webhook configurado para este org.");
    return false;
  }

  const lines = [
    `*${body}*`,
    vence_en ? `Vence: ${new Date(vence_en).toLocaleString("es-AR")}` : "",
    usuario_email ? `Asignado a: ${usuario_email}` : "",
  ].filter(Boolean);

  const payload = {
    text: lines.join("\n"),
    // algunos webhooks ignoran channel override; igual lo mandamos
    channel: channel || FALLBACK_CHANNEL,
    username: "VEX Reminders",
    icon_emoji: ":alarm_clock:",
  };

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => res.statusText);
      throw new Error(`Slack ${res.status} ${txt}`);
    }
    return true;
  } catch (e) {
    console.error("[REMINDERS] Slack send failed:", e?.message || e);
    return false;
  }
}

export function scheduleReminders() {
  const task = cron.schedule(
    CRON,
    () => runRemindersOnce().catch((e) => console.error("[NODE-CRON] [ERROR]", e)),
    { timezone: TZ }
  );
  console.log(
    `🕒 Reminders ON cron=${CRON} tz=${TZ} | fallbackChannel=${FALLBACK_CHANNEL}`
  );
  return task;
}
