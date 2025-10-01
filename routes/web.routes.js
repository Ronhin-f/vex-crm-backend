// routes/web.routes.js
import { Router } from "express";
import { pool, q } from "../utils/db.js";
import { ensureFollowupForAssignment } from "../services/followups.service.js";

const r = Router();

/**
 * POST /web/leads
 * Uso típico: formularios públicos o integraciones no autenticadas.
 *
 * Body (campos tolerantes):
 * {
 *   org_id | organizacion_id: string (requerido),
 *   // Empresa (cliente)
 *   empresa | company | cliente_nombre | nombre_cliente: string (recomendado),
 *   cliente_id?: number (si ya existe),
 *   source?: string,
 *   // Contacto
 *   contacto_nombre?: string,
 *   email?: string,
 *   telefono?: string,
 *   cargo?: string,
 *   rol?: string,
 *   // Proyecto
 *   crear_proyecto?: boolean,
 *   proyecto_nombre?: string,
 *   notas | nota | descripcion?: string,
 *   due_date?: string (ISO o YYYY-MM-DD HH:mm),
 *   estimate_amount?: number,
 *   estimate_currency?: string,
 *   // Asignación / deep link
 *   asignado_email?: string,
 *   link?: string
 * }
 *
 * Respuesta:
 *   { ok:true, cliente_id, contacto_id, proyecto_id }
 */
r.post("/leads", async (req, res) => {
  const body = req.body || {};
  const organizacion_id = body.organizacion_id || body.org_id;
  if (!organizacion_id) {
    return res.status(400).json({ ok: false, error: "organizacion_id requerido" });
  }

  // Normalización “suave”
  const empresa =
    body.empresa ||
    body.company ||
    body.cliente_nombre ||
    body.nombre_cliente ||
    null;

  const cliente_id_in = Number(body.cliente_id) || null;
  const source = (body.source || "web").trim();
  const asignado_email = body.asignado_email ? String(body.asignado_email).trim() : null;

  const contacto_nombre = body.contacto_nombre || null;
  const email = body.email || null;
  const telefono = body.telefono || null;
  const cargo = body.cargo || null;
  const rol = body.rol || null;

  const crear_proyecto = !!body.crear_proyecto;
  const proyecto_nombre =
    body.proyecto_nombre ||
    (empresa ? `Lead — ${empresa}` : null);
  const notas = body.notas || body.nota || body.descripcion || null;
  const due_date = body.due_date ? new Date(body.due_date) : null;
  const estimate_amount = body.estimate_amount != null ? Number(body.estimate_amount) : null;
  const estimate_currency = body.estimate_currency || null;

  const link =
    body.link ||
    (process.env.VEX_CRM_URL || process.env.VEX_CORE_URL || "").replace(/\/+$/, "");

  const cx = await pool.connect();
  try {
    await cx.query("BEGIN");

    /* 1) Resolver/crear CLIENTE (empresa) sin duplicar */
    let cliente_id = cliente_id_in;

    if (!cliente_id) {
      // a) intentar por contacto (email) + org
      let found = null;
      if (email) {
        const r1 = await cx.query(
          `SELECT c.id
             FROM clientes c
             JOIN contactos k ON k.cliente_id = c.id
            WHERE c.organizacion_id = $1
              AND lower(k.email) = lower($2)
            LIMIT 1`,
          [organizacion_id, email]
        );
        found = r1.rows[0]?.id || null;
      }

      // b) intentar por nombre exacto + org
      if (!found && empresa) {
        const r2 = await cx.query(
          `SELECT id FROM clientes
            WHERE organizacion_id = $1 AND lower(nombre) = lower($2)
            LIMIT 1`,
          [organizacion_id, empresa.trim()]
        );
        found = r2.rows[0]?.id || null;
      }

      // c) crear si no existe
      if (!found) {
        const ins = await cx.query(
          `INSERT INTO clientes
              (nombre, source, stage, categoria, usuario_email, organizacion_id, observacion)
           VALUES ($1, $2, 'Incoming Leads', 'Incoming Leads', $3, $4, $5)
           RETURNING id`,
          [empresa || "(sin nombre)", source, asignado_email, organizacion_id, notas]
        );
        cliente_id = ins.rows[0].id;
      } else {
        cliente_id = found;
      }
    }

    /* 2) Crear CONTACTO (si viene info). Si no hay principal, este lo será. */
    let contacto_id = null;
    if (contacto_nombre || email || telefono) {
      // ¿ya existe ese email para este cliente?
      let exists = null;
      if (email) {
        const r = await cx.query(
          `SELECT id FROM contactos WHERE cliente_id=$1 AND lower(email)=lower($2) LIMIT 1`,
          [cliente_id, email]
        );
        exists = r.rows[0]?.id || null;
      }

      if (exists) {
        contacto_id = exists;
        // actualización suave (no pisamos si vienen nulls)
        await cx.query(
          `UPDATE contactos
              SET nombre        = COALESCE($2, nombre),
                  telefono      = COALESCE($3, telefono),
                  cargo         = COALESCE($4, cargo),
                  rol           = COALESCE($5, rol),
                  updated_at    = NOW()
            WHERE id=$1`,
          [contacto_id, contacto_nombre, telefono, cargo, rol]
        );
      } else {
        // set principal=true si no hay ninguno
        const hasPrincipal = await cx.query(
          `SELECT 1 FROM contactos WHERE cliente_id=$1 AND es_principal=TRUE LIMIT 1`,
          [cliente_id]
        );
        const es_principal = hasPrincipal.rowCount ? false : true;

        const insC = await cx.query(
          `INSERT INTO contactos
              (cliente_id, nombre, email, telefono, cargo, rol, es_principal, notas, usuario_email, organizacion_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            cliente_id,
            contacto_nombre || empresa || "Contacto",
            email || null,
            telefono || null,
            cargo || null,
            rol || null,
            es_principal,
            notas,
            asignado_email,
            organizacion_id,
          ]
        );
        contacto_id = insC.rows[0].id;

        if (es_principal) {
          await cx.query(
            `UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`,
            [cliente_id, contacto_id]
          );
        }
      }
    }

    /* 3) (Opcional) Crear PROYECTO */
    let proyecto_id = null;
    if (crear_proyecto) {
      const insP = await cx.query(
        `INSERT INTO proyectos
           (nombre, descripcion, cliente_id, stage, categoria,
            source, assignee, due_date, estimate_amount, estimate_currency,
            usuario_email, organizacion_id, updated_at)
         VALUES
           ($1,$2,$3,'Incoming Leads','Incoming Leads',
            $4,$5,$6,$7,$8,
            $9,$10,NOW())
         RETURNING id`,
        [
          proyecto_nombre || empresa || "Nuevo proyecto",
          notas,
          cliente_id,
          source,
          asignado_email,
          due_date ? new Date(due_date).toISOString() : null,
          estimate_amount,
          estimate_currency,
          asignado_email,
          organizacion_id,
        ]
      );
      proyecto_id = insP.rows[0].id;
    }

    await cx.query("COMMIT");

    /* 4) Follow-up + Recordatorio + Slack */
    const deepLink =
      link && proyecto_id
        ? `${link.replace(/\/+$/, "")}/proyectos/${proyecto_id}`
        : link && cliente_id
        ? `${link.replace(/\/+$/, "")}/clientes/${cliente_id}`
        : null;

    await ensureFollowupForAssignment({
      organizacion_id,
      leadId: proyecto_id || cliente_id,
      leadNombre: proyecto_nombre || empresa || contacto_nombre || "(nuevo lead)",
      cliente_id,
      asignado_email,
      link: deepLink || undefined,
    });

    return res.json({ ok: true, cliente_id, contacto_id, proyecto_id });
  } catch (err) {
    try { await cx.query("ROLLBACK"); } catch {}
    console.error("POST /web/leads error", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  } finally {
    cx.release();
  }
});

export default r;
