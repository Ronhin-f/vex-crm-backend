// routes/compras.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* -------------------------- helpers -------------------------- */
function getUserFromReq(req) {
  const usuario = req.usuario || {};
  const email =
    usuario.email ??
    req.usuario_email ??
    usuario.usuario_email ??
    null;

  const organizacion_id =
    usuario.organizacion_id ??
    req.organizacion_id ??
    usuario.organization_id ??
    null;

  return { email, organizacion_id };
}

async function recalcTotal(compraId) {
  await q(
    `
    UPDATE compras c
       SET total = COALESCE((
         SELECT SUM( COALESCE(ci.cantidad,1) * COALESCE(ci.precio_unitario,0) + COALESCE(ci.impuesto,0) )
           FROM compra_items ci
          WHERE ci.compra_id = c.id
       ), 0),
           updated_at = NOW()
     WHERE c.id = $1
    `,
    [compraId]
  );
}

/* ---------------------------- GET ---------------------------- */
/**
 * Lista "flat" de items de compra con datos de la compra padre.
 * Soporta filtro por organización (desde token). Orden: más reciente primero.
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    const params = [];
    let where = "";
    if (organizacion_id) {
      params.push(organizacion_id);
      where = `WHERE c.organizacion_id = $${params.length}`;
    }

    const r = await q(
      `
      SELECT
        ci.id,
        ci.producto,
        COALESCE(ci.cantidad,1)        AS cantidad,
        COALESCE(ci.precio_unitario,0) AS precio_unitario,
        COALESCE(ci.impuesto,0)        AS impuesto,
        ci.observacion,

        c.id            AS compra_id,
        c.proveedor,
        c.numero,
        c.estado,
        c.moneda,
        COALESCE(c.total,0) AS total,
        c.fecha,
        c.created_at,
        c.updated_at
      FROM compra_items ci
      JOIN compras c ON c.id = ci.compra_id
      ${where}
      ORDER BY ci.id DESC
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /compras]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al listar compras" });
  }
});

/* --------------------------- POST ---------------------------- */
/**
 * Alta rápida de item de compra.
 * Crea (o reutiliza) una "compra bucket" del día (estado=draft) y agrega el item.
 * Body: { producto: string, cantidad?: number, precio_unitario?: number, impuesto?: number, observacion?: string }
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { email, organizacion_id } = getUserFromReq(req);

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

    if (!producto || typeof producto !== "string" || !producto.trim()) {
      return res.status(400).json({ message: "producto requerido" });
    }
    producto = producto.trim();

    cantidad = Number.isFinite(+cantidad) ? Math.max(1, parseInt(cantidad, 10)) : 1;
    precio_unitario = Number.isFinite(+precio_unitario) ? +precio_unitario : 0;
    impuesto = Number.isFinite(+impuesto) ? +impuesto : 0;

    // Reutiliza una compra "bucket" del día
    const findParams = [];
    let where = "WHERE DATE(c.fecha) = CURRENT_DATE AND c.estado = 'draft'";
    if (organizacion_id) {
      findParams.push(organizacion_id);
      where += ` AND c.organizacion_id = $${findParams.length}`;
    }
    const f = await q(`SELECT id FROM compras c ${where} LIMIT 1`, findParams);

    let compraId = f.rows?.[0]?.id;
    if (!compraId) {
      const ins = await q(
        `
        INSERT INTO compras (proveedor, cliente_id, numero, estado, total, moneda, notas, fecha,
                             usuario_email, organizacion_id, created_at, updated_at)
        VALUES ($1, NULL, $2, 'draft', 0, $3, 'lista-compras', NOW(),
                $4, $5, NOW(), NOW())
        RETURNING id
        `,
        [proveedor, numero, moneda, email, organizacion_id]
      );
      compraId = ins.rows[0].id;
    }

    const insItem = await q(
      `
      INSERT INTO compra_items (compra_id, producto, cantidad, precio_unitario, impuesto, observacion)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING id, producto, cantidad, precio_unitario, impuesto, observacion
      `,
      [compraId, producto, cantidad, precio_unitario, impuesto, observacion]
    );

    await recalcTotal(compraId);

    res.status(201).json({
      id: insItem.rows[0].id,
      producto: insItem.rows[0].producto,
      cantidad: insItem.rows[0].cantidad,
      precio_unitario: insItem.rows[0].precio_unitario,
      impuesto: insItem.rows[0].impuesto,
      observacion: insItem.rows[0].observacion,
      compra_id: compraId,
      estado: "draft",
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
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const fields = [];
    const values = [];
    let idx = 1;

    if (typeof req.body?.producto === "string" && req.body.producto.trim()) {
      fields.push(`producto = $${idx++}`); values.push(req.body.producto.trim());
    }
    if (req.body?.cantidad != null && Number.isFinite(+req.body.cantidad)) {
      fields.push(`cantidad = $${idx++}`); values.push(Math.max(1, parseInt(req.body.cantidad, 10)));
    }
    if (req.body?.precio_unitario != null && Number.isFinite(+req.body.precio_unitario)) {
      fields.push(`precio_unitario = $${idx++}`); values.push(+req.body.precio_unitario);
    }
    if (req.body?.impuesto != null && Number.isFinite(+req.body.impuesto)) {
      fields.push(`impuesto = $${idx++}`); values.push(+req.body.impuesto);
    }
    if (req.body?.observacion !== undefined) {
      fields.push(`observacion = $${idx++}`); values.push(req.body.observacion || null);
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

    // devolvemos el item actualizado (opcionalmente podrías select con más campos)
    const item = await q(
      `SELECT id, producto, cantidad, precio_unitario, impuesto, observacion FROM compra_items WHERE id = $1`,
      [id]
    );
    res.json(item.rows[0]);
  } catch (e) {
    console.error("[PATCH /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando item" });
  }
});

/* -------------------------- DELETE --------------------------- */
/**
 * Borrado de item; si la compra queda vacía, elimina la compra.
 */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const p = await q(
      `DELETE FROM compra_items WHERE id = $1 RETURNING compra_id`,
      [id]
    );
    if (!p.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    const compraId = p.rows[0].compra_id;
    const c = await q(`SELECT 1 FROM compra_items WHERE compra_id = $1 LIMIT 1`, [compraId]);

    if (!c.rowCount) {
      await q(`DELETE FROM compras WHERE id = $1`, [compraId]);
      return res.json({ ok: true, compra_deleted: compraId });
    }

    await recalcTotal(compraId);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando item" });
  }
});

export default router;
