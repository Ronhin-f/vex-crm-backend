// routes/workers/reminders.worker.js (ACTUALIZADO)
import cron from "node-cron";
import { q } from "../../utils/db.js";        // ← usamos q(), no pool
import { postSlack } from "../../services/slack.service.js";

/**
 * Busca recordatorios vencidos (estado='pendiente') y los envía a Slack
 * usando la integración de la organización (tabla integraciones).
 */
async function runRemindersOnce() {
  const { rows } = await q(`
    SELECT
      r.id,
      COALESCE(r.mensaje, r.titulo, t.titulo, 'Recordatorio') AS body,
      r.enviar_en,
      COALESCE(r.organizacion_id, c.organizacion_id)          AS org_id,
      t.usuario_email,
      t.vence_en
    FROM recordatorios r
    LEFT JOIN tareas   t ON t.id = r.tarea_id
    LEFT JOIN clientes c ON c.id = t.cliente_id
    WHERE r.estado = 'pendiente'
      AND r.enviar_en <= NOW()
    ORDER BY r.enviar_en ASC
    LIMIT 100;
  `);

  for (const r of rows) {
    try {
      const due = r.vence_en ? new Date(r.vence_en).toLocaleString("es-AR") : null;
      const text = due ? `🔔 ${r.body} (vence ${due})` : `🔔 ${r.body}`;

      if (!r.org_id) throw new Error("org_id no resuelto para el recordatorio");

      await postSlack({ orgId: r.org_id, text, emailAsignado: r.usuario_email });

      await q(
        `UPDATE recordatorios
           SET estado='enviado', sent_at=NOW(), last_error=NULL
         WHERE id=$1`,
        [r.id]
      );
      console.log("[reminders] enviado id", r.id);
    } catch (e) {
      console.error("[reminders] fallo id", r.id, e.message);
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
  // Para probar rápido, cada 1 min. Podés pasar REMINDER_CRON en Railway.
  const expr = process.env.REMINDER_CRON || "*/1 * * * *";
  cron.schedule(expr, runRemindersOnce, { timezone: "UTC" });
  // Ejecuta 1 vez al boot para limpiar pendientes
  runRemindersOnce().catch(() => {});
}
