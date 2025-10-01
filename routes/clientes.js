// routes/clientes.js — CRUD de clientes + contactos (múltiples)
import { Router } from "express";
import { q, pool } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: u.organizacion_id ?? req.organizacion_id ?? u.organization_id ?? null,
  };
}
const T = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

/* ===================== CLIENTES ===================== */

/* ============== GET /clientes ============== */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const { q: qtext } = req.query || {};
    const params = [];
    const where = [];

    if (organizacion_id) {
      params.push(organizacion_id);
      where.push(`c.organizacion_id = $${params.length}`);
    }
    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      where.push(`(c.nombre ILIKE $${i} OR c.email ILIKE $${i} OR CAST(c.telefono AS TEXT) ILIKE $${i})`);
    }

    const sql = `
      SELECT
        c.id,
        c.nombre,
        -- compat: si no hay c.contacto_nombre, usamos el principal
        COALESCE(c.contacto_nombre, pc.nombre)       AS contacto_nombre,
        COALESCE(c.email, pc.email)                  AS email,
        COALESCE(c.telefono, pc.telefono)            AS telefono,
        c.direccion,
        c.observacion,
        c.usuario_email,
        c.organizacion_id,
        c.created_at,
        -- opcional: devolvemos un JSON resumido del principal (no rompe FE)
        CASE WHEN pc.id IS NULL THEN NULL ELSE jsonb_build_object(
          'id', pc.id,
          'nombre', pc.nombre,
          'email', pc.email,
          'telefono', pc.telefono,
          'es_principal', true
        ) END AS primary_contact
      FROM clientes c
      LEFT JOIN LATERAL (
        SELECT id, nombre, email, telefono
        FROM contactos
        WHERE cliente_id = c.id AND COALESCE(es_principal, false) = true
        ORDER BY id ASC
        LIMIT 1
      ) pc ON TRUE
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY c.created_at DESC NULLS LAST, c.id DESC
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    res.status(200).json([]);
  }
});

/* ============== POST /clientes ============== */
router.post("/", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    let { nombre, contacto_nombre, email, telefono, direccion, observacion } = req.body || {};
    if (!nombre || !String(nombre).trim()) return res.status(400).json({ message: "Nombre requerido" });

    await client.query("BEGIN");

    // 1) Crear cliente (guardamos campos contacto por compatibilidad FE)
    const rCli = await client.query(
      `INSERT INTO clientes
        (nombre, contacto_nombre, email, telefono, direccion, observacion, usuario_email, organizacion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id, nombre, contacto_nombre, email, telefono, direccion, observacion,
                 usuario_email, organizacion_id, created_at`,
      [String(nombre).trim(), T(contacto_nombre), T(email), T(telefono), T(direccion), T(observacion), usuario_email, organizacion_id]
    );
    const cli = rCli.rows[0];

    // 2) Si vinieron datos de contacto → crear contacto principal
    if (T(contacto_nombre) || T(email) || T(telefono)) {
      await client.query(
        `INSERT INTO contactos
          (cliente_id, nombre, email, telefono, es_principal, usuario_email, organizacion_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW(),NOW())`,
        [cli.id, T(contacto_nombre), T(email), T(telefono), usuario_email, organizacion_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(cli);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando cliente" });
  } finally {
    client.release();
  }
});

/* ============== PATCH /clientes/:id ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { email: usuario_email, organizacion_id } = getUserFromReq(req);

    // Campos del cliente
    const allowed = ["nombre","contacto_nombre","email","telefono","direccion","observacion"];
    const fields = []; const values = []; let i = 1;
    for (const k of allowed) {
      if (k in (req.body || {})) {
        fields.push(`${k}=$${i++}`);
        values.push(T(req.body[k]));
      }
    }
    if (!fields.length && !("contacto_nombre" in req.body || "email" in req.body || "telefono" in req.body)) {
      return res.status(400).json({ message: "Nada para actualizar" });
    }

    await client.query("BEGIN");

    // 1) Update cliente (si hay fields)
    if (fields.length) {
      values.push(id);
      const r = await client.query(
        `UPDATE clientes SET ${fields.join(", ")}, updated_at = NOW() WHERE id=$${i}
         RETURNING id, nombre, contacto_nombre, email, telefono, direccion, observacion,
                   usuario_email, organizacion_id, created_at`,
        values
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Cliente no encontrado" });
      }
    }

    // 2) Upsert del contacto principal si llegaron campos de contacto
    const anyContactField = ["contacto_nombre","email","telefono"].some(k => k in (req.body || {}));
    if (anyContactField) {
      const rPC = await client.query(
        `SELECT id FROM contactos WHERE cliente_id = $1 AND COALESCE(es_principal, false) = true ORDER BY id ASC LIMIT 1`,
        [id]
      );
      const nuevoNombre = T(req.body?.contacto_nombre);
      const nuevoEmail  = T(req.body?.email);
      const nuevoTel    = T(req.body?.telefono);

      if (rPC.rowCount) {
        // update principal solo en campos provistos
        const setC = []; const valC = []; let j = 1;
        if ("contacto_nombre" in (req.body || {})) { setC.push(`nombre=$${j++}`); valC.push(nuevoNombre); }
        if ("email" in (req.body || {}))          { setC.push(`email=$${j++}`);  valC.push(nuevoEmail); }
        if ("telefono" in (req.body || {}))       { setC.push(`telefono=$${j++}`); valC.push(nuevoTel); }
        if (setC.length) {
          valC.push(rPC.rows[0].id);
          await client.query(`UPDATE contactos SET ${setC.join(", ")}, updated_at=NOW() WHERE id=$${j}`, valC);
        }
      } else if (nuevoNombre || nuevoEmail || nuevoTel) {
        await client.query(
          `INSERT INTO contactos
            (cliente_id, nombre, email, telefono, es_principal, usuario_email, organizacion_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW(),NOW())`,
          [id, nuevoNombre, nuevoEmail, nuevoTel, usuario_email, organizacion_id]
        );
      }
    }

    await client.query("COMMIT");

    const rBack = await q(
      `SELECT id, nombre, contacto_nombre, email, telefono, direccion, observacion,
              usuario_email, organizacion_id, created_at
         FROM clientes WHERE id=$1`,
      [id]
    );
    res.json(rBack.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando cliente" });
  } finally {
    client.release();
  }
});

/* ============== DELETE /clientes/:id ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    // Bloquea si tiene proyectos asociados
    const rProj = await client.query(`SELECT 1 FROM proyectos WHERE cliente_id = $1 LIMIT 1`, [id]);
    if (rProj.rowCount) {
      return res.status(409).json({ message: "No se puede borrar: tiene proyectos asociados" });
    }

    await client.query("BEGIN");
    // Si no tenés FK ON DELETE CASCADE, limpiamos contactos
    await client.query(`DELETE FROM contactos WHERE cliente_id = $1`, [id]);
    const r = await client.query(`DELETE FROM clientes WHERE id = $1`, [id]);
    await client.query("COMMIT");

    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[DELETE /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando cliente" });
  } finally {
    client.release();
  }
});

/* ===================== CONTACTOS ===================== */

/**
 * GET /clientes/:id/contactos
 * Lista contactos de un cliente
 */
router.get("/:id/contactos", authenticateToken, async (req, res) => {
  try {
    const cliente_id = Number(req.params.id);
    if (!Number.isInteger(cliente_id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(
      `SELECT id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
              usuario_email, organizacion_id, created_at, updated_at
         FROM contactos
        WHERE cliente_id = $1
        ORDER BY es_principal DESC, id DESC`,
      [cliente_id]
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes/:id/contactos]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando contactos" });
  }
});

/**
 * POST /clientes/:id/contactos
 * Crea un contacto (opcional marcar como principal)
 */
router.post("/:id/contactos", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const cliente_id = Number(req.params.id);
    if (!Number.isInteger(cliente_id)) return res.status(400).json({ message: "ID inválido" });
    const { email: usuario_email, organizacion_id } = getUserFromReq(req);

    const {
      nombre, email, telefono, cargo, rol, notas, es_principal = false,
    } = req.body || {};
    if (!T(nombre) && !T(email) && !T(telefono)) {
      return res.status(400).json({ message: "Nombre, email o teléfono requerido" });
    }

    await client.query("BEGIN");

    let makePrimary = !!es_principal;

    // Si ya existe un principal y piden otro, bajamos el actual
    if (makePrimary) {
      await client.query(
        `UPDATE contactos SET es_principal = FALSE, updated_at = NOW()
          WHERE cliente_id = $1 AND COALESCE(es_principal, false) = TRUE`,
        [cliente_id]
      );
    }

    // Si no hay principal, este será principal aunque no lo pidan
    if (!makePrimary) {
      const rP = await client.query(
        `SELECT 1 FROM contactos WHERE cliente_id = $1 AND COALESCE(es_principal, false) = TRUE LIMIT 1`,
        [cliente_id]
      );
      if (!rP.rowCount) makePrimary = true;
    }

    const r = await client.query(
      `INSERT INTO contactos
        (cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
         usuario_email, organizacion_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       RETURNING id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
                 usuario_email, organizacion_id, created_at, updated_at`,
      [cliente_id, T(nombre), T(email), T(telefono), T(cargo), T(rol), T(notas), makePrimary, usuario_email, organizacion_id]
    );

    await client.query("COMMIT");
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /clientes/:id/contactos]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando contacto" });
  } finally {
    client.release();
  }
});

/**
 * PATCH /contactos/:id
 * Actualiza contacto (si es_principal=true, desmarca anteriores)
 */
router.patch("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const upd = {
      nombre: "nombre",
      email: "email",
      telefono: "telefono",
      cargo: "cargo",
      rol: "rol",
      notas: "notas",
      es_principal: "es_principal",
    };
    const sets = [];
    const vals = [];
    let i = 1;
    for (const k of Object.keys(upd)) {
      if (k in (req.body || {})) {
        if (k === "es_principal") {
          sets.push(`es_principal = $${i++}`);
          vals.push(!!req.body.es_principal);
        } else {
          sets.push(`${upd[k]} = $${i++}`);
          vals.push(T(req.body[k]));
        }
      }
    }
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    await client.query("BEGIN");

    // Si marcan como principal este contacto, quitar bandera del resto
    if ("es_principal" in (req.body || {}) && !!req.body.es_principal) {
      const rCli = await client.query(`SELECT cliente_id FROM contactos WHERE id = $1`, [id]);
      const cliente_id = rCli.rows?.[0]?.cliente_id;
      if (cliente_id) {
        await client.query(
          `UPDATE contactos SET es_principal = FALSE, updated_at = NOW()
           WHERE cliente_id = $1 AND id <> $2`,
          [cliente_id, id]
        );
      }
    }

    vals.push(id);
    const r = await client.query(
      `UPDATE contactos SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${i}
       RETURNING id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
                 usuario_email, organizacion_id, created_at, updated_at`,
      vals
    );

    await client.query("COMMIT");
    if (!r.rowCount) return res.status(404).json({ message: "Contacto no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /contactos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando contacto" });
  } finally {
    client.release();
  }
});

/**
 * DELETE /contactos/:id
 */
router.delete("/contactos/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const r = await q(`DELETE FROM contactos WHERE id = $1`, [id]);
    if (!r.rowCount) return res.status(404).json({ message: "Contacto no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /contactos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando contacto" });
  }
});

export default router;
