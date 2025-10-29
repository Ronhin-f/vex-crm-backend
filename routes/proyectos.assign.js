// routes/proyectos.assign.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
const T = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const toInt = (v) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
};
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? u.organization_id ?? req.organizacion_id ?? null,
  };
}
function getBearer(req) {
  return req.headers?.authorization || null;
}

/**
 * PATCH /proyectos/:id/assign
 * Body: { asignado_email | assignee_email, cliente_id?, link? }
 * - Actualiza el assignee del proyecto (assignee + usuario_email)
 * - Crea Tarea follow-up + Recordatorio + Slack
 * - Emite evento a Flows
 */
router.patch("/:id/assign", authenticateToken, async (req, res) => {
  try {
    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);

    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: "id inválido" });

    const asignado_email =
      T(req.body?.asignado_email ?? req.body?.assignee_email) || null;
    const in_cliente_id = toInt(req.body?.cliente_id);
    const linkIn = T(req.body?.link);

    if (!asignado_email) {
      return res.status(400).json({ ok: false, error: "asignado_email requerido" });
    }

    // 1) Traer proyecto con guardia por organización
    const pr = await q(
      `
      SELECT id, nombre, cliente_id, organizacion_id
        FROM proyectos
       WHERE id = $1
         AND (${organizacion_id != null ? "organizacion_id = $2" : "organizacion_id IS NULL"})
      `,
      organizacion_id != null ? [id, organizacion_id] : [id]
    );
    const proyecto = pr.rows?.[0];
    if (!proyecto) return res.status(404).json({ ok: false, error: "proyecto no encontrado" });

    const resolvedClienteId = in_cliente_id ?? proyecto.cliente_id ?? null;

    // 2) Actualizar asignado (assignee + usuario_email) y (opcional) cliente
    await q(
      `
      UPDATE proyectos
         SET assignee = $1,
             usuario_email = $1,
             cliente_id = COALESCE($2, cliente_id),
             updated_at = NOW()
       WHERE id = $3
         AND (${organizacion_id != null ? "organizacion_id = $4" : "organizacion_id IS NULL"})
      `,
      organizacion_id != null
        ? [asignado_email, resolvedClienteId, id, organizacion_id]
        : [asignado_email, resolvedClienteId, id]
    );

    // 3) Construir link (fallback)
    const base =
      process.env.VEX_CRM_URL ||
      process.env.VEX_CORE_URL ||
      "";
    const safeBase = base ? base.replace(/\/+$/, "") : "";
    const viewLink = linkIn || (safeBase ? `${safeBase}/proyectos/${id}` : "(sin link)");

    // 4) Follow-up + recordatorio + Slack (servicio existente)
    await ensureFollowupForAssignment({
      organizacion_id: proyecto.organizacion_id,
      leadId: id,
      leadNombre: proyecto.nombre,
      cliente_id: resolvedClienteId || null,
      asignado_email,
      link: viewLink,
    });

    // 5) Emit a Flows (no bloqueante)
    emitFlow(
      "crm.lead.assigned",
      {
        org_id: String(proyecto.organizacion_id || ""),
        idempotency_key: `lead:${id}:assigned:${asignado_email.toLowerCase()}`,
        lead: {
          id: String(id),
          name: proyecto.nombre,
          assignee: { email: asignado_email },
          client_id: resolvedClienteId ? String(resolvedClienteId) : null,
          link: viewLink,
        },
        meta: { source: "vex-crm", version: "v1" },
      },
      { bearer }
    ).catch((e) => console.warn("[Flows emit lead.assigned]", e?.message));

    res.json({
      ok: true,
      proyecto_id: id,
      asignado_email,
      cliente_id: resolvedClienteId || null,
      link: viewLink,
    });
  } catch (e) {
    console.error("PATCH /proyectos/:id/assign error:", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
