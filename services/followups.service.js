// services/followups.service.js
import { pool } from "../utils/db.js";
import { postSlack } from "./slack.service.js";
import { emit as emitFlow } from "./flows.client.js";

export async function ensureFollowupForAssignment({
  orgId,
  leadId,
  leadNombre,
  clienteId,
  asignadoEmail,
  link,
  bearer, // ⬅️ nuevo: Authorization del request (opcional)
}) {
  const now = Date.now();
  const venceEn = new Date(now + 48 * 60 * 60 * 1000);
  const enviarEn = new Date(venceEn.getTime() - 24 * 60 * 60 * 1000);

  // 1) Crear tarea
  const { rows: tRows } = await pool.query(
    `INSERT INTO tareas (titulo, estado, cliente_id, usuario_email, vence_en, origen)
     VALUES ($1, 'todo', $2, $3, $4, 'followup-auto')
     RETURNING id, titulo, vence_en, usuario_email`,
    [`Follow-up: ${leadNombre}`, clienteId || null, asignadoEmail, venceEn]
  );
  const tarea = tRows[0];

  // 2) Recordatorio T-24h
  await pool.query(
    `INSERT INTO recordatorios (tarea_id, enviar_en, motivo, payload)
     VALUES ($1, $2, 'followup_reminder', $3)`,
    [tarea.id, enviarEn, { leadId, leadNombre, link }]
  );

  // 3) Slack (fallback actual)
  const fechaFmt = new Date(tarea.vence_en).toLocaleString("es-AR");
  const text = `Nuevo Lead asignado a <MENTION> – ${leadNombre} – ${link} – vence ${fechaFmt}`;
  await postSlack({ orgId, text, emailAsignado: asignadoEmail });

  // 4) Flows — dual-emit con Bearer de Core (passthrough o machine token)
  const basePayload = {
    org_id: String(orgId ?? ""),
    task: {
      id: String(tarea.id),
      title: tarea.titulo,
      due_at: new Date(tarea.vence_en).toISOString(),
      assigned_to: { email: tarea.usuario_email || asignadoEmail || null },
      kind: "followup-auto",
    },
    lead: leadId ? { id: String(leadId), name: leadNombre || null, link: link || null } : null,
    meta: { source: "vex-crm", version: "v1" },
  };

  emitFlow("crm.lead.assigned", {
    ...basePayload,
    idempotency_key: `lead_assigned:${leadId || "na"}:${tarea.id}`,
  }, { bearer }).catch((e) => console.warn("[Flows emit crm.lead.assigned]", e?.message));

  emitFlow("crm.task.created", {
    ...basePayload,
    idempotency_key: `task:${tarea.id}:created`,
  }, { bearer }).catch((e) => console.warn("[Flows emit crm.task.created]", e?.message));

  return { tareaId: tarea.id };
}
