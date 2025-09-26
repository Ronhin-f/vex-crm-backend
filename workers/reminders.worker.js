// workers/reminders.worker.js
import cron from "node-cron";
import { pool } from "../utils/db.js";
import { postSlack } from "../services/slack.service.js";

async function runReminders() {
  // Tomamos hasta 100 por tanda para no saturar
  const { rows } = await pool.query(`
    SELECT r.id, r.tarea_id, r.payload, r.motivo,
           t.usuario_email, t.vence_en, t.titulo,
           COALESCE(c.org_id, o.id) AS org_id
    FROM recordatorios r
    JOIN tareas t ON t.id = r.tarea_id
    LEFT JOIN clientes c ON c.id = t.cliente_id
    LEFT JOIN organizaciones o ON o.id = c.org_id -- fallback por si hiciera falta
    WHERE r.enviado = FALSE
      AND r.enviar_en <= NOW()
    ORDER BY r.enviar_en ASC
    LIMIT 100
  `);

  for (const row of rows) {
    const fechaFmt = new Date(row.vence_en).toLocaleString("es-AR");
    const link = row.payload?.link || "(sin link)";

    const text =
      row.motivo === "followup_reminder"
        ? `⏰ Recordatorio follow-up: ${row.titulo} – ${link} – vence ${fechaFmt}`
        : `🔔 Recordatorio: ${row.titulo} – ${link} – vence ${fechaFmt}`;

    await postSlack({
      orgId: row.org_id,
      text,
      emailAsignado: row.usuario_email,
    });

    await pool.query(
      `UPDATE recordatorios
       SET enviado = TRUE, enviado_en = NOW()
       WHERE id = $1`,
      [row.id]
    );
  }
}

export function scheduleReminders() {
  const expr = process.env.REMINDER_CRON || "*/10 * * * *";
  cron.schedule(expr, runReminders, {
    timezone: "America/Argentina/Mendoza",
  });

  // Opcional: disparar al boot para limpiar pendientes
  // runReminders().catch(() => {});
}
