// workers/reminders.worker.js
import cron from "node-cron";
import { q } from "../utils/db.js";               // 👈 IMPORT RELATIVO (no "/utils/...").
import { postSlack } from "../services/slack.service.js";

async function runRemindersOnce() {
  // Trae pendientes vencidos (no toca tabla "organizaciones")
  const { rows } = await q(`
    SELECT
      r.id,
      COALESCE(r.mensaje, r.titulo, t.titulo, 'Recordatorio') AS body,
      r.enviar_en,
      COALESCE(r.organizacion_id, c.organizacion_id, 10)      AS org_id,   -- fallback SJ=10
      t.usuario_email,
      t.vence_en
    FROM recordatorios r
    LEFT JOIN tareas   t ON t.id = r.tarea_id
    LEFT JOIN clientes c ON c.id = t.cliente_id
    WHERE r.estado = 'pendiente'
      AND r.enviar_en <= NOW()
    ORDER BY r.enviar_en ASC
    LIMIT 100
  `);

  for (const r of rows) {
    try {
      const due = r.vence_en ? new Date(r.vence_en).toLocaleString("es-AR") : null;
      const text = due ? `🔔 ${r.body} (vence ${due})` : `🔔 ${r.body}`;

      await postSlack({ orgId: r.org_id, text, emailAsignado: r.usuario_email });

      await q(
        `UPDATE recordatorios
           SET estado='enviado', sent_at=NOW(), last_error=NULL
         WHERE id=$1`,
        [r.id]
      );

      console.log("[reminders] enviado id", r.id);
    } catch (e) {
      console.error("[reminders] fallo id", r.id, e?.message);
      await q(
        `UPDATE recordatorios
           SET intento_count = COALESCE(intento_count,0)+1,
               last_error=$2
         WHERE id=$1`,
        [r.id, String(e?.message || e)]
      );
    }
  }
}

export function scheduleReminders() {
  const expr = process.env.REMINDER_CRON || "*/10 * * * *"; // usa tu default del index
  console.log(`🕒 Reminders ON cron=${expr} tz=America/Argentina/Mendoza`);
  cron.schedule(expr, runRemindersOnce, { timezone: "America/Argentina/Mendoza" });
  // Ejecuta una vez al boot para drenar pendientes:
  runRemindersOnce().catch(() => {});
}
