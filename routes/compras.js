// routes/compras.js — Lista de Compras (tenancy TEXT, blindado / degradación elegante)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";
import {
  T,
  resolveOrgId,
  hasTable,
  tableColumns,
} from "../utils/schema.js";

const router = Router();

/* -------------------------- helpers -------------------------- */

function getUserEmail(req) {
  const u = req.usuario || {};
  return u.email ?? req.usuario_email ?? u.usuario ?? null;
}

async function hasInfra() {
  const hasC = await hasTable("compras");
  const hasI = await hasTable("compra_items");
  return hasC && hasI;
}

function numOr(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// Build INSERT dinámico según columnas presentes
function buildInsert(table, colsSet, payload, returning = "id") {
  const keys = Object.keys(payload).filter((k) => colsSet.has(k));
  if (!keys.length) {
    return {
      sql: `INSERT INTO ${table} DEFAULT VALUES RETURNING ${returning}`,
      values: [],
    };
  }
  const placeholders = keys.map((_, i) => `$${i + 1}`);
  const values = keys.map((k) => payload[k]);
  const sql = `INSERT INTO ${table} (${keys.join(",")}) VALUES (${placeholders.join(
    ","
  )}) RETURNING ${returning}`;
  return { sql, values };
}

// Recalcula total de una compra si las columnas existen; si no, no falla
async function recalcTotal(compraId) {
  if (!(await hasInfra())) return;
  const ciCols = await tableColumns("compra_items");
  const cCols = await tableColumns("compras");
  if (!cCols.has("total")) return; // si no hay total, nada que hacer

  const cantidad = ciCols.has("cantidad") ? "COALESCE(ci.cantidad,1)" : "1";
  const precio = ciCols.has("precio_unitario")
    ? "COALESCE(ci.precio_unitario,0)"
    : "0";
  const imp = ciCols.has("impuesto") ? "COALESCE(ci.impuesto,0)" : "0";

  const updCols = [];
  updCols.push(
    `total = COALESCE((SELECT SUM(${cantidad} * ${precio} + ${imp}) FROM compra_items ci WHERE ci.compra_id = c.id), 0)`
  );
  if (cCols.has("updated_at")) updCols.push(`updated_at = NOW()`);

  const sql = `
    UPDATE compras c
       SET ${updCols.join(", ")}
     WHERE c.id = $1
  `;
  await q(sql, [compraId]);
}

/* ---------------------------- GET ---------------------------- */
/**
 * Lista "flat" de items de compra con datos de la compra padre.
 * Si no está instalado el módulo, devuelve [] (sin romper FE).
 */
router.get("/", authenticateToken, nocache, async (req, res) => {
  try {
    if (!(await hasInfra())) return res.json([]);

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ message: "organizacion_id requerido" });

    const cCols = await tableColumns("compras");
    const iCols = await tableColumns("compra_items");

    // SELECT seguro (alias a nombres esperados desde FE)
    const ci_id = iCols.has("id") ? "ci.id" : "NULL::int";
    const producto = iCols.has("producto") ? "ci.producto" : "NULL::text";
    const cantidad = iCols.has("cantidad") ? "COALESCE(ci.cantidad,1)" : "1";
    const precio_unitario = iCols.has("precio_unitario")
      ? "COALESCE(ci.precio_unitario,0)"
      : "0";
    const impuesto = iCols.has("impuesto") ? "COALESCE(ci.impuesto,0)" : "0";
    const ci_obs = iCols.has("observacion")
      ? "ci.observacion"
      : "NULL::text";

    const compra_id = cCols.has("id") ? "c.id" : "NULL::int";
    const proveedor = cCols.has("proveedor") ? "c.proveedor" : "NULL::text";
    const numero = cCols.has("numero") ? "c.numero" : "NULL::text";
    const estado = cCols.has("estado") ? "c.estado" : "'draft'";
    const moneda = cCols.has("moneda") ? "c.moneda" : "'ARS'";
    const total = cCols.has("total") ? "COALESCE(c.total,0)" : "0";
    const fecha = cCols.has("fecha") ? "c.fecha" : "NULL::timestamptz";
    const created_at = cCols.has("created_at")
      ? "c.created_at"
      : "NULL::timestamptz";
    const updated_at = cCols.has("updated_at")
      ? "c.updated_at"
      : "NULL::timestamptz";

    const where = [];
    const params = [];
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      where.push(`c.organizacion_id = $${params.length}`);
    }

    const sql = `
      SELECT
        ${ci_id}        AS id,
        ${producto}     AS producto,
        ${cantidad}     AS cantidad,
        ${precio_unitario} AS precio_unitario,
        ${impuesto}     AS impuesto,
        ${ci_obs}       AS observacion,

        ${compra_id}    AS compra_id,
        ${proveedor}    AS proveedor,
        ${numero}       AS numero,
        ${estado}       AS estado,
        ${moneda}       AS moneda,
        ${total}        AS total,
        ${fecha}        AS fecha,
        ${created_at}   AS created_at,
        ${updated_at}   AS updated_at
      FROM compra_items ci
      JOIN compras c ON c.id = ci.compra_id
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ORDER BY ci.id DESC NULLS LAST
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /compras]", e?.stack || e?.message || e);
    res.status(200).json([]); // no romper FE
  }
});

/* --------------------------- POST ---------------------------- */
/**
 * Alta rápida de item de compra.
 * Si no hay infra => 501 “no instalado”.
 * Bucket diario: usa c.fecha o c.created_at; si no existen, crea siempre nueva.
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ message: "Módulo de compras no instalado" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ message: "organizacion_id requerido" });
    const userEmail = getUserEmail(req);

    let {
      producto,
      cantidad = 1,
      precio_unitario = 0,
      impuesto = 0,
      observacion = null,
      proveedor = "lista-compras",
      numero = null,
      moneda = "ARS",
    } = req.body || {};

    if (!producto || !String(producto).trim()) {
      return res.status(400).json({ message: "producto requerido" });
    }
    producto = String(producto).trim();
    cantidad = Number.isFinite(+cantidad) ? Math.max(1, parseInt(cantidad, 10)) : 1;
    precio_unitario = numOr(precio_unitario, 0);
    impuesto = numOr(impuesto, 0);

    const cCols = await tableColumns("compras");
    const iCols = await tableColumns("compra_items");

    // Buscar bucket del día
    let compraId = null;
    if (cCols.has("estado")) {
      const params = [];
      const wh = [];
      wh.push(`c.estado = 'draft'`);
      if (cCols.has("fecha")) {
        wh.push(`DATE(c.fecha) = CURRENT_DATE`);
      } else if (cCols.has("created_at")) {
        wh.push(`DATE(c.created_at) = CURRENT_DATE`);
      }
      if (cCols.has("organizacion_id")) {
        params.push(orgId);
        wh.push(`c.organizacion_id = $${params.length}`);
      }
      const f = await q(
        `SELECT c.id FROM compras c WHERE ${wh.join(" AND ")} LIMIT 1`,
        params
      );
      compraId = f.rows?.[0]?.id ?? null;
    }

    // Crear compra si no hay bucket o no podemos reutilizar
    if (!compraId) {
      const payload = {
        proveedor: T(proveedor),
        numero: T(numero),
        estado: "draft",
        total: 0,
        moneda: T(moneda) || "ARS",
        notas: "lista-compras",
        fecha: new Date(),
        usuario_email: userEmail,
        organizacion_id: orgId,
        created_at: new Date(),
        updated_at: new Date(),
      };
      // Ajustes por columnas que no existen
      if (!cCols.has("fecha") && cCols.has("created_at")) delete payload.fecha;
      if (!cCols.has("created_at")) delete payload.created_at;
      if (!cCols.has("updated_at")) delete payload.updated_at;
      if (!cCols.has("usuario_email")) delete payload.usuario_email;
      if (!cCols.has("organizacion_id")) delete payload.organizacion_id;
      if (!cCols.has("notas")) delete payload.notas;
      if (!cCols.has("moneda")) delete payload.moneda;
      if (!cCols.has("numero")) delete payload.numero;
      if (!cCols.has("proveedor")) delete payload.proveedor;
      if (!cCols.has("estado")) delete payload.estado;
      if (!cCols.has("total")) delete payload.total;
      if (!cCols.has("fecha")) delete payload.fecha;

      const { sql, values } = buildInsert("compras", cCols, payload, "id");
      const ins = await q(sql, values);
      compraId = ins.rows[0].id;
    }

    // Insert item (con org/usuario si existen columnas)
    const itemPayload = {
      compra_id: compraId,
      producto: T(producto),
      cantidad,
      precio_unitario,
      impuesto,
      observacion: T(observacion),
      usuario_email: userEmail,
      organizacion_id: orgId,
      created_at: new Date(),
      updated_at: new Date(),
    };
    if (!iCols.has("created_at")) delete itemPayload.created_at;
    if (!iCols.has("updated_at")) delete itemPayload.updated_at;
    if (!iCols.has("usuario_email")) delete itemPayload.usuario_email;
    if (!iCols.has("organizacion_id")) delete itemPayload.organizacion_id;
    if (!iCols.has("impuesto")) delete itemPayload.impuesto;
    if (!iCols.has("precio_unitario")) delete itemPayload.precio_unitario;
    if (!iCols.has("cantidad")) delete itemPayload.cantidad;
    if (!iCols.has("observacion")) delete itemPayload.observacion;
    if (!iCols.has("producto")) delete itemPayload.producto;
    if (!iCols.has("compra_id")) {
      return res.status(500).json({ message: "Schema inválido: falta compra_id en compra_items" });
    }

    const { sql: iSql, values: iVals } = buildInsert(
      "compra_items",
      iCols,
      itemPayload,
      "id, compra_id, producto, cantidad, precio_unitario, impuesto, observacion"
    );
    const insItem = await q(iSql, iVals);

    await recalcTotal(compraId);

    res.status(201).json({
      ...insItem.rows[0],
      estado: cCols.has("estado") ? "draft" : null,
    });
  } catch (e) {
    console.error("[POST /compras]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al agregar item" });
  }
});

/* -------------------------- PATCH ---------------------------- */
/**
 * Update parcial de un item.
 * Body: { producto?, cantidad?, precio_unitario?, impuesto?, observacion? }
 */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ message: "Módulo de compras no instalado" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ message: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const iCols = await tableColumns("compra_items");
    const cCols = await tableColumns("compras");

    // Verificar pertenencia del item a la org (JOIN compras)
    const paramsCheck = [id];
    let checkSQL = `SELECT ci.compra_id
                      FROM compra_items ci
                      JOIN compras c ON c.id = ci.compra_id
                     WHERE ci.id = $1`;
    if (cCols.has("organizacion_id")) {
      paramsCheck.push(orgId);
      checkSQL += ` AND c.organizacion_id = $2`;
    }
    const check = await q(checkSQL, paramsCheck);
    if (!check.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    const fields = [];
    const values = [];
    let idx = 1;

    if (iCols.has("producto") && typeof req.body?.producto === "string" && req.body.producto.trim()) {
      fields.push(`producto = $${idx++}`); values.push(req.body.producto.trim());
    }
    if (iCols.has("cantidad") && req.body?.cantidad != null && Number.isFinite(+req.body.cantidad)) {
      fields.push(`cantidad = $${idx++}`); values.push(Math.max(1, parseInt(req.body.cantidad, 10)));
    }
    if (iCols.has("precio_unitario") && req.body?.precio_unitario != null && Number.isFinite(+req.body.precio_unitario)) {
      fields.push(`precio_unitario = $${idx++}`); values.push(+req.body.precio_unitario);
    }
    if (iCols.has("impuesto") && req.body?.impuesto != null && Number.isFinite(+req.body.impuesto)) {
      fields.push(`impuesto = $${idx++}`); values.push(+req.body.impuesto);
    }
    if (iCols.has("observacion") && req.body?.observacion !== undefined) {
      fields.push(`observacion = $${idx++}`); values.push(req.body.observacion || null);
    }
    if (iCols.has("updated_at")) {
      fields.push(`updated_at = NOW()`);
    }

    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    const r = await q(
      `UPDATE compra_items SET ${fields.join(", ")} WHERE id = $${idx} RETURNING id, compra_id`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    const compraId = r.rows[0].compra_id;
    await recalcTotal(compraId);

    const back = await q(
      `SELECT id, compra_id,
              ${iCols.has("producto") ? "producto" : "NULL::text AS producto"},
              ${iCols.has("cantidad") ? "cantidad" : "NULL::int AS cantidad"},
              ${iCols.has("precio_unitario") ? "precio_unitario" : "NULL::numeric AS precio_unitario"},
              ${iCols.has("impuesto") ? "impuesto" : "NULL::numeric AS impuesto"},
              ${iCols.has("observacion") ? "observacion" : "NULL::text AS observacion"}
       FROM compra_items WHERE id = $1`,
      [id]
    );
    res.json(back.rows[0]);
  } catch (e) {
    console.error("[PATCH /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando item" });
  }
});

/* -------------------------- DELETE --------------------------- */
/**
 * Borrado de item; si la compra queda vacía, elimina la compra (si la tabla existe).
 */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ message: "Módulo de compras no instalado" });

    const orgId = await resolveOrgId(req);
    if (!orgId) return res.status(400).json({ message: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const iCols = await tableColumns("compra_items");
    const cCols = await tableColumns("compras");

    // Verificar pertenencia por JOIN con compras
    const paramsSel = [id];
    let selSQL = `SELECT ci.compra_id
                    FROM compra_items ci
                    JOIN compras c ON c.id = ci.compra_id
                   WHERE ci.id = $1`;
    if (cCols.has("organizacion_id")) {
      paramsSel.push(orgId);
      selSQL += ` AND c.organizacion_id = $2`;
    }
    const sel = await q(selSQL, paramsSel);
    if (!sel.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    const compraId = sel.rows[0].compra_id;

    // Borrar item
    const delItem = await q(`DELETE FROM compra_items WHERE id = $1`, [id]);
    if (!delItem.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    // ¿Quedan items?
    const c = await q(
      `SELECT 1 FROM compra_items WHERE ${iCols.has("compra_id") ? "compra_id" : "NULL"} = $1 LIMIT 1`,
      [compraId]
    );

    if (!c.rowCount) {
      // No quedan items → eliminar compra si la tabla lo permite (scoped por org cuando exista)
      if (cCols.has("id")) {
        if (cCols.has("organizacion_id")) {
          await q(`DELETE FROM compras WHERE id = $1 AND organizacion_id = $2`, [compraId, orgId]);
        } else {
          await q(`DELETE FROM compras WHERE id = $1`, [compraId]);
        }
        return res.json({ ok: true, compra_deleted: compraId });
      }
    } else {
      await recalcTotal(compraId);
    }

    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando item" });
  }
});

export default router;
