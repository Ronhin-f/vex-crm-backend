// workers/reminders.worker.js — ESM
import cron from "node-cron";
import { pool } from "../utils/db.js";
import { emit as emitFlow } from "../services/flows.client.js"; // ⬅️ Flows (Bearer de Core)

// Cron & TZ
const CRON = process.env.REMINDER_CRON ?? "*/10 * * * *";
const TZ = process.env.TZ ?? "America/Argentina/Mendoza";

// Slack fallbacks
const GLOBAL_WEBHOOK = process.env.SLACK_WEBHOOK_URL ?? null;
const FALLBACK_CHANNEL =
  process.env.SLACK_WEBHOOK_FALLBACK_CHANNEL ?? "#reminders-and-follow-ups";

// Si usabas un org “por defecto”, mantener como TEXT:
const FALLBACK_ORG_ID = String(process.env.FALLBACK_ORG_ID ?? "10");

// helper simple
const q = (text, params) => pool.query(text, params);

/**
 * Una pasada:
 * - Toma hasta 100 recordatorios vencidos (FOR UPDATE SKIP LOCKED)
 * - Los marca en_proceso y devuelve datos enriquecidos
 * - Emite evento a Flows (Bearer de Core) + Slack fallback
 * - Marca enviado o reprograma con backoff si falla Slack
 */
export async function runRemindersOnce() {
  const client = await pool.connect();
  let grabbed = [];
  try {
    await client.query("BEGIN");

    // 1) Pick + update + enrich (sin referenciar r en JOINs del UPDATE)
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
      ),
      upd AS (
        UPDATE recordatorios r
           SET estado = 'en_proceso'
          FROM picked p
         WHERE r.id = p.id
      RETURNING
         r.id,
         r.tarea_id,
         r.mensaje,
         r.titulo,
         r.enviar_en,
         r.organizacion_id
      )
      SELECT
        u.id,
        u.tarea_id,                                                     -- ⬅️ lo traemos para Flows
        COALESCE(u.mensaje, u.titulo, t.titulo, 'Recordatorio') AS body,
        u.enviar_en,
        COALESCE(u.organizacion_id, c.organizacion_id, $1::text) AS org_id,
        t.usuario_email,
        t.vence_en,
        COALESCE(i.slack_webhook_url, $2::text) AS webhook,
        COALESCE(i.slack_default_channel, $3::text) AS channel
      FROM upd u
      LEFT JOIN tareas   t ON t.id = u.tarea_id
      LEFT JOIN clientes c ON c.id = t.cliente_id
      LEFT JOIN integraciones i
             ON i.organizacion_id = COALESCE(u.organizacion_id, c.organizacion_id, $1::text);
      `,
      [FALLBACK_ORG_ID, GLOBAL_WEBHOOK, FALLBACK_CHANNEL]
    );

    grabbed = rows;
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[REMINDERS] SQL error:", e?.message || e);
    return;
  } finally {
    client.release();
  }

  if (!grabbed.length) return;

  // 2) Emisión a Flows + Slack fuera de la transacción
  for (const r of grabbed) {
    // Emit a Flows (no bloquea Slack; usa CORE_MACHINE_TOKEN en flows.client)
    try {
      await emitFlow("crm.reminder.due", {
        org_id: String(r.org_id || ""),
        idempotency_key: `reminder:${r.id}:${new Date(r.enviar_en).toISOString()}`,
        reminder: {
          id: String(r.id),
          tarea_id: r.tarea_id != null ? String(r.tarea_id) : null,
          body: r.body,
          scheduled_at: new Date(r.enviar_en).toISOString(),
        },
        task: {
          id: r.tarea_id != null ? String(r.tarea_id) : null,
          due_at: r.vence_en ? new Date(r.vence_en).toISOString() : null,
          assigned_to: { email: r.usuario_email || null },
        },
        notify: { channel: r.channel || null, provider: "slack" },
        meta: { source: "vex-crm", version: "v1" },
      });
    } catch (e) {
      console.warn("[Flows emit crm.reminder.due]", e?.message || e);
    }

    // Slack fallback
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

async function sendToSlack({ body, usuario_email, vence_en, channel, webhook, org_id }) {
  if (!webhook) {
    console.warn("[REMINDERS] No hay Slack webhook configurado (org", org_id, ").");
    return false;
  }

  const lines = [
    `*${body}*`,
    vence_en ? `Vence: ${new Date(vence_en).toLocaleString("es-AR")}` : "",
    usuario_email ? `Asignado a: ${usuario_email}` : "", // si no hay asignado, se omite
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
