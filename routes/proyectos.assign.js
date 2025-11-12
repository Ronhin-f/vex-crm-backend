// routes/proyectos.assign.js — Assign robusto (multi-tenant + schema-agnostic)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { emit as emitFlow } from "../services/flows.client.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";
import { hasTable, tableColumns } from "../utils/schema.js";

const router = Router();

/* ------------------------ helpers ------------------------ */
const T = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};
const E = (v) => (T(v)?.toLowerCase() ?? null); // email normalizado

const toInt = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? (n | 0) : null;
};

function getOrg(req) {
  const raw =
    T(req.usuario?.organizacion_id) ||
    T(req.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? u.usuario_email ?? req.usuario_email ?? null,
    organizacion_id: getOrg(req),
  };
}

function getBearer(req) {
  return req.headers?.authorization || null;
}

async function maybeClientBelongsToOrg(clienteId, orgId) {
  if (!clienteId) return { ok: false, reason: "no_id" };
  if (!(await hasTable("clientes"))) return { ok: false, reason: "no_clientes_table" };
  const params = [clienteId];
  let where = `id = $1`;
  if (orgId != null) {
    params.push(orgId);
    where += ` AND organizacion_id = $2`;
  }
  const r = await q(`SELECT 1 FROM clientes WHERE ${where} LIMIT 1`, params);
  return { ok: r.rowCount > 0, reason: r.rowCount ? "ok" : "not_found_or_wrong_org" };
}

/**
 * PATCH /proyectos/:id/assign
 * Body: { asignado_email | assignee_email, cliente_id?, link? }
 * Efectos:
 *  - Actualiza columnas existentes entre: assignee, usuario_email, cliente_id, updated_at
 *  - Dispara follow-up/bot (best-effort; nunca rompe la asignación)
 *  - Emite evento a Flows (best-effort, idempotente)
 * Respuestas:
 *  - 501 si falta la tabla o no hay columnas asignables en este esquema
 *  - 404 si el proyecto no existe / no pertenece a tu org
 */
router.patch("/:id/assign", authenticateToken, async (req, res) => {
  try {
    // Infra mínima
    if (!(await hasTable("proyectos"))) {
      return res.status(501).json({ ok: false, error: "modulo_proyectos_no_instalado" });
    }

    const bearer = getBearer(req);
    const { organizacion_id } = getUserFromReq(req);

    const id = toInt(req.params.id);
    if (id == null) return res.status(400).json({ ok: false, error: "id_invalido" });

    const asignado_email_raw = T(req.body?.asignado_email ?? req.body?.assignee_email);
    const asignado_email = E(asignado_email_raw);
    const in_cliente_id = toInt(req.body?.cliente_id);
    const linkIn = T(req.body?.link);

    if (!asignado_email) {
      return res.status(400).json({ ok: false, error: "asignado_email_requerido" });
    }

    // Columnas disponibles en proyectos
    const cols = await tableColumns("proyectos");
    const canAssignee = cols.has("assignee");
    const canUsuario  = cols.has("usuario_email");
    const canCliente  = cols.has("cliente_id");
    const canUpdated  = cols.has("updated_at");

    if (!canAssignee && !canUsuario && !canCliente) {
      return res.status(501).json({
        ok: false,
        error: "schema_no_soporta_asignacion",
        detail: "No existen columnas assignee/usuario_email/cliente_id",
      });
    }

    // 1) Traer proyecto (guardia por organización si existe columna)
    const paramsSel = [id];
    let whereSel = `id = $1`;
    if (cols.has("organizacion_id") && organizacion_id != null) {
      paramsSel.push(organizacion_id);
      whereSel += ` AND organizacion_id = $2`;
    }
    const pr = await q(
      `SELECT id, nombre, ${cols.has("organizacion_id") ? "organizacion_id" : "NULL::int AS organizacion_id"},
              ${canCliente ? "cliente_id" : "NULL::int AS cliente_id"},
              ${canAssignee ? "assignee" : "NULL::text AS assignee"},
              ${canUsuario ? "usuario_email" : "NULL::text AS usuario_email"}
         FROM proyectos
        WHERE ${whereSel}
        LIMIT 1`,
      paramsSel
    );
    const proyecto = pr.rows?.[0];
    if (!proyecto) {
      return res.status(404).json({ ok: false, error: "proyecto_no_encontrado" });
    }

    // 2) Validar/Resolver cliente_id
    let warnings = [];
    let resolvedClienteId = proyecto.cliente_id ?? null;
    if (canCliente && in_cliente_id != null) {
      const belongs = await maybeClientBelongsToOrg(in_cliente_id, cols.has("organizacion_id") ? organizacion_id : null);
      if (belongs.ok) {
        resolvedClienteId = in_cliente_id;
      } else {
        warnings.push(`cliente_id_ignorado:${belongs.reason}`);
      }
    }

    // 3) Construir UPDATE dinámico según columnas existentes
    const sets = [];
    const vals = [];
    let i = 1;

    if (canAssignee) { sets.push(`assignee = $${i++}`); vals.push(asignado_email); }
    if (canUsuario)  { sets.push(`usuario_email = $${i++}`); vals.push(asignado_email); }
    if (canCliente && resolvedClienteId != null) {
      sets.push(`cliente_id = $${i++}`); vals.push(resolvedClienteId);
    }
    if (canUpdated)  { sets.push(`updated_at = NOW()`); }

    if (!sets.length) {
      // Nada para cambiar: seguimos con side-effects igualmente
      warnings.push("sin_cambios_en_db");
    }

    // WHERE update con guardia de org si aplica
    vals.push(id);
    let whereUpd = `id = $${i++}`;
    if (cols.has("organizacion_id") && organizacion_id != null) {
      vals.push(organizacion_id);
      whereUpd += ` AND organizacion_id = $${i++}`;
    }

    if (sets.length) {
      const upd = await q(
        `UPDATE proyectos SET ${sets.join(", ")} WHERE ${whereUpd}
         RETURNING id`,
        vals
      );
      if (!upd.rowCount) {
        return res.status(404).json({ ok: false, error: "proyecto_no_encontrado" });
      }
    }

    // 4) Link “view” (fallbacks)
    const base = process.env.VEX_CRM_URL || process.env.VEX_CORE_URL || "";
    const safeBase = base ? base.replace(/\/+$/, "") : "";
    const viewLink = linkIn || (safeBase ? `${safeBase}/proyectos/${id}` : "(sin link)");

    // 5) Side-effects en best-effort
    try {
      await ensureFollowupForAssignment({
        organizacion_id: proyecto.organizacion_id ?? organizacion_id ?? null,
        leadId: id,
        leadNombre: proyecto.nombre,
        cliente_id: canCliente ? (resolvedClienteId ?? null) : null,
        asignado_email,
        link: viewLink,
      });
    } catch (e) {
      warnings.push(`followup_error:${String(e?.message || e)}`);
    }

    try {
      await emitFlow(
        "crm.lead.assigned",
        {
          org_id: String((proyecto.organizacion_id ?? organizacion_id) ?? ""),
          idempotency_key: `lead:${id}:assigned:${asignado_email}`,
          lead: {
            id: String(id),
            name: proyecto.nombre,
            assignee: { email: asignado_email },
            client_id: canCliente && resolvedClienteId ? String(resolvedClienteId) : null,
            link: viewLink,
          },
          meta: { source: "vex-crm", version: "v1" },
        },
        { bearer }
      );
    } catch (e) {
      warnings.push(`flows_emit_error:${String(e?.message || e)}`);
    }

    return res.json({
      ok: true,
      proyecto_id: id,
      asignado_email,
      cliente_id: canCliente ? (resolvedClienteId ?? null) : null,
      link: viewLink,
      ...(warnings.length ? { warnings } : {}),
    });
  } catch (e) {
    console.error("[PATCH /proyectos/:id/assign] error:", e?.stack || e?.message || e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

export default router;
