// routes/contactos.js — Contactos por cliente (blindado + multi-tenant, TEXT-safe)
import { Router } from "express";
import { q, pool } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";
import { T, resolveOrgId, hasTable, tableColumns } from "../utils/schema.js";

const router = Router();

/* -------------------------- helpers -------------------------- */
async function hasInfra() {
  const hasCt = await hasTable("contactos");
  const hasCl = await hasTable("clientes");
  return hasCt && hasCl;
}

function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

/* ============================ GET ============================ */
/** Lista los contactos de un cliente (valida organización) */
router.get(
  "/clientes/:clienteId/contactos",
  authenticateToken,
  nocache,
  async (req, res) => {
    try {
      if (!(await hasInfra())) return res.json({ ok: true, items: [] });

      const orgId = await resolveOrgId(req);
      if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

      const clienteId = Number(req.params.clienteId);
      if (!Number.isInteger(clienteId) || clienteId <= 0) {
        return res.status(400).json({ ok: false, error: "clienteId inválido" });
      }

      // Cliente debe pertenecer a tu organización (si la columna existe)
      const cCols = await tableColumns("clientes");
      const params = [clienteId];
      let ownSQL = `SELECT 1 FROM clientes WHERE id=$1`;
      if (cCols.has("organizacion_id")) {
        params.push(orgId);
        ownSQL += ` AND organizacion_id=$2`;
      }
      const own = await q(ownSQL, params);
      if (!own.rowCount) {
        return res.status(404).json({ ok: false, error: "cliente no encontrado" });
      }

      const r = await q(
        `SELECT id, cliente_id, nombre, email, telefono, cargo, rol, es_principal, notas,
                usuario_email, organizacion_id, created_at, updated_at
           FROM contactos
          WHERE cliente_id=$1
          ORDER BY es_principal DESC, nombre ASC NULLS LAST, id ASC`,
        [clienteId]
      );
      return res.json({ ok: true, items: r.rows || [] });
    } catch (e) {
      console.error("[GET /clientes/:id/contactos]", e?.stack || e?.message || e);
      return res.status(200).json({ ok: true, items: [] });
    }
  }
);

/* ============================ POST =========================== */
/** Crea un contacto bajo un cliente (si no hay principal, este pasa a serlo) */
router.post(
  "/clientes/:clienteId/contactos",
  authenticateToken,
  async (req, res) => {
    const client = await pool.connect();
    try {
      if (!(await hasInfra()))
        return res.status(501).json({ ok: false, error: "Módulo de contactos no instalado" });

      const orgId = await resolveOrgId(req);
      if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

      const clienteId = Number(req.params.clienteId);
      if (!Number.isInteger(clienteId) || clienteId <= 0) {
        return res.status(400).json({ ok: false, error: "clienteId inválido" });
      }

      // Verifica que el cliente sea tuyo (si existe la columna)
      const cCols = await tableColumns("clientes");
      const params = [clienteId];
      let ownSQL = `SELECT organizacion_id FROM clientes WHERE id=$1`;
      if (cCols.has("organizacion_id")) {
        params.push(orgId);
        ownSQL += ` AND organizacion_id=$2`;
      }
      const c = await q(ownSQL, params);
      if (!c.rowCount)
        return res.status(404).json({ ok: false, error: "cliente no encontrado" });

      const organizacion_id = c.rows[0].organizacion_id ?? orgId ?? null;
      const usuario_email =
        req.usuario?.email ?? req.usuario?.usuario_email ?? req.usuario_email ?? null;

      let { nombre, email, telefono, cargo, rol, es_principal = false, notas } = req.body || {};
      if (!T(nombre) && !T(email) && !T(telefono)) {
        return res.status(400).json({ ok: false, error: "nombre, email o teléfono requerido" });
      }

      const ctCols = await tableColumns("contactos");

      await client.query("BEGIN");

      // ¿Existe algún principal? (solo si la columna existe)
      let makePrimary = false;
      if (ctCols.has("es_principal")) {
        const hasPrincipal = await client.query(
          `SELECT 1 FROM contactos WHERE cliente_id=$1 AND es_principal=TRUE LIMIT 1`,
          [clienteId]
        );
        makePrimary = hasPrincipal.rowCount ? bool(es_principal) : true;
      }

      // Inserta dinámicamente
      const fields = [];
      const vals = [];
      function add(col, val) {
        if (ctCols.has(col)) {
          fields.push(col);
          vals.push(val);
        }
      }
      add("cliente_id", clienteId);
      add("nombre", T(nombre));
      add("email", T(email));
      add("telefono", T(telefono));
      add("cargo", T(cargo));
      add("rol", T(rol));
      if (ctCols.has("es_principal")) add("es_principal", makePrimary);
      add("notas", T(notas));
      add("usuario_email", usuario_email);
      add("organizacion_id", organizacion_id);
      if (ctCols.has("created_at")) add("created_at", new Date());
      if (ctCols.has("updated_at")) add("updated_at", new Date());

      if (!fields.length) {
        await client.query("ROLLBACK");
        return res.status(501).json({ ok: false, error: "Schema inválido en contactos" });
      }
      const placeholders = fields.map((_, i) => `$${i + 1}`);
      const ins = await client.query(
        `INSERT INTO contactos (${fields.join(",")}) VALUES (${placeholders.join(",")}) RETURNING *`,
        vals
      );
      const contacto = ins.rows[0];

      // Si marcamos como principal, apagar los demás (misma TX)
      if (ctCols.has("es_principal") && contacto?.es_principal) {
        await client.query(
          `UPDATE contactos SET es_principal=FALSE, updated_at = COALESCE(updated_at, NOW())
            WHERE cliente_id=$1 AND id<>$2`,
          [clienteId, contacto.id]
        );
      }

      await client.query("COMMIT");
      return res.status(201).json({ ok: true, item: contacto });
    } catch (e) {
      await client.query("ROLLBACK");
      console.error("[POST /clientes/:id/contactos]", e?.stack || e?.message || e);
      return res.status(500).json({ ok: false, error: "Error creando contacto" });
    } finally {
      client.release();
    }
  }
);

/* ============================ PATCH ========================== */
/** Edita un contacto (si es_principal=true, apaga al resto) */
router.patch("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ ok: false, error: "Módulo de contactos no instalado" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "id inválido" });

    const cCols = await tableColumns("clientes");
    const ctCols = await tableColumns("contactos");

    // Verifica pertenencia por organización (si existe la columna)
    const params = [id];
    let curSQL = `SELECT ct.id, ct.cliente_id
                    FROM contactos ct
                    JOIN clientes c ON c.id = ct.cliente_id
                   WHERE ct.id=$1`;
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      curSQL += ` AND c.organizacion_id=$2`;
    }
    const cur = await q(curSQL, params);
    if (!cur.rowCount)
      return res.status(404).json({ ok: false, error: "no encontrado" });

    const cliente_id = cur.rows[0].cliente_id;

    const allowed = ["nombre", "email", "telefono", "cargo", "rol", "es_principal", "notas"];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (!(k in (req.body || {}))) continue;
      if (!ctCols.has(k)) continue;
      if (k === "es_principal") {
        sets.push(`es_principal = $${vals.length + 1}`);
        vals.push(bool(req.body[k]));
      } else {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(T(req.body[k]));
      }
    }
    if (ctCols.has("updated_at")) {
      sets.push(`updated_at = NOW()`);
    }
    if (!sets.length)
      return res.status(400).json({ ok: false, error: "nada para actualizar" });

    await client.query("BEGIN");

    vals.push(id);
    const r = await client.query(
      `UPDATE contactos SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "no encontrado" });
    }
    const contacto = r.rows[0];

    if (ctCols.has("es_principal") && contacto.es_principal) {
      await client.query(
        `UPDATE contactos SET es_principal=FALSE, updated_at = COALESCE(updated_at, NOW())
           WHERE cliente_id=$1 AND id<>$2`,
        [cliente_id, contacto.id]
      );
    }

    await client.query("COMMIT");
    return res.json({ ok: true, item: contacto });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /contactos/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "Error actualizando contacto" });
  } finally {
    client.release();
  }
});

/* =========================== DELETE ========================== */
/** Borra contacto. Si era principal y hay otros, promueve uno (estable) */
router.delete("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ ok: false, error: "Módulo de contactos no instalado" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "id inválido" });

    const cCols = await tableColumns("clientes");
    const ctCols = await tableColumns("contactos");

    // Traer contacto y validar org (si existe la columna)
    const params = [id];
    let curSQL = `SELECT ct.id, ct.cliente_id, ${ctCols.has("es_principal") ? "ct.es_principal" : "FALSE AS es_principal"}
                    FROM contactos ct
                    JOIN clientes c ON c.id = ct.cliente_id
                   WHERE ct.id=$1`;
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      curSQL += ` AND c.organizacion_id=$2`;
    }
    const cur = await q(curSQL, params);
    if (!cur.rowCount)
      return res.status(404).json({ ok: false, error: "no encontrado" });

    const { cliente_id, es_principal } = cur.rows[0];

    await client.query("BEGIN");

    await client.query(`DELETE FROM contactos WHERE id=$1`, [id]);

    if (ctCols.has("es_principal") && es_principal) {
      // Promueve un contacto estable (por nombre, luego id)
      const nxt = await client.query(
        `SELECT id
           FROM contactos
          WHERE cliente_id=$1
          ORDER BY nombre ASC NULLS LAST, id ASC
          LIMIT 1`,
        [cliente_id]
      );
      if (nxt.rowCount) {
        await client.query(`UPDATE contactos SET es_principal=TRUE WHERE id=$1`, [nxt.rows[0].id]);
        await client.query(
          `UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`,
          [cliente_id, nxt.rows[0].id]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[DELETE /contactos/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "Error eliminando contacto" });
  } finally {
    client.release();
  }
});

export default router;
