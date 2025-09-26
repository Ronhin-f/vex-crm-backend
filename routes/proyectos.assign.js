// routes/proyectos.assign.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const router = Router();

/**
 * PATCH /proyectos/:id/assign
 * Body: { asignado_email, cliente_id?, link? }
 * - Actualiza el assignee del proyecto
 * - Crea Tarea follow-up + Recordatorio + Slack
 */
router.patch("/:id/assign", async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ ok: false, error: "id inválido" });

    const { asignado_email, cliente_id, link } = req.body;
    if (!asignado_email) {
      return res.status(400).json({ ok: false, error: "asignado_email requerido" });
    }

    // 1) Traer proyecto (org, cliente, nombre)
    const pr = await q(
      `SELECT id, nombre, cliente_id, organizacion_id, usuario_email
         FROM proyectos
        WHERE id = $1`,
      [id]
    );
    const proyecto = pr.rows[0];
    if (!proyecto) return res.status(404).json({ ok: false, error: "proyecto no encontrado" });

    const organizacion_id = proyecto.organizacion_id;
    const resolvedClienteId = typeof cliente_id === "number" ? cliente_id : proyecto.cliente_id;

    // 2) Actualizar asignado + (opcional) cliente
    await q(
      `UPDATE proyectos
          SET usuario_email = $1,
              cliente_id = COALESCE($2, cliente_id),
              updated_at = NOW()
        WHERE id = $3`,
      [asignado_email, resolvedClienteId, id]
    );

    // 3) Construir link (si no vino)
    const base =
      process.env.VEX_CRM_URL ||
      process.env.VEX_CORE_URL ||
      ""; // si no hay base, Slack mostrará "(sin link)"
    const safeBase = base.replace(/\/+$/, "");
    const viewLink = link || (safeBase ? `${safeBase}/proyectos/${id}` : "(sin link)");

    // 4) Follow-up + recordatorio + Slack
    await ensureFollowupForAssignment({
      organizacion_id,
      leadId: id,
      leadNombre: proyecto.nombre,
      cliente_id: resolvedClienteId || null,
      asignado_email,
      link: viewLink,
    });

    res.json({
      ok: true,
      proyecto_id: id,
      asignado_email,
      cliente_id: resolvedClienteId || null,
    });
  } catch (e) {
    console.error("PATCH /proyectos/:id/assign error:", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
