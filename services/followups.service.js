// services/followups.service.js
import { pool } from "../utils/db.js";
import { postSlack } from "./slack.service.js";

export async function ensureFollowupForAssignment({
  orgId,
  leadId,
  leadNombre,
  clienteId,
  asignadoEmail,
  link,
}) {
  const now = Date.now();
  const venceEn = new Date(now + 48 * 60 * 60 * 1000);
  const enviarEn = new Date(venceEn.getTime() - 24 * 60 * 60 * 1000);

  // 1) Crear tarea (siempre 1 por evento; simplificamos: insert directa)
  const { rows: tRows } = await pool.query(
    `INSERT INTO tareas (titulo, estado, cliente_id, usuario_email, vence_en, origen)
     VALUES ($1, 'todo', $2, $3, $4, 'followup-auto')
     RETURNING id, titulo, vence_en`,
    [`Follow-up: ${leadNombre}`, clienteId || null, asignadoEmail, venceEn]
  );

  const tarea = tRows[0];

  // 2) Recordatorio T-24h
  await pool.query(
    `INSERT INTO recordatorios (tarea_id, enviar_en, motivo, payload)
     VALUES ($1, $2, 'followup_reminder', $3)`,
    [tarea.id, enviarEn, { leadId, leadNombre, link }]
  );

  // 3) Slack: lead_assigned
  const fechaFmt = new Date(tarea.vence_en).toLocaleString("es-AR");
  const text = `Nuevo Lead asignado a <MENTION> – ${leadNombre} – ${link} – vence ${fechaFmt}`;
  await postSlack({ orgId, text, emailAsignado: asignadoEmail });

  return { tareaId: tarea.id };
}
