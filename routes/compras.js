// routes/compras.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/**
 * Lista de compras (flat): trae los items (pedido_items) de la organización,
 * con datos del pedido padre. Ordenado reciente primero.
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const params = [];
    let where = "";
    if (org) { params.push(org); where = `WHERE p.organizacion_id = $${params.length}`; }

    const r = await q(
      `
      SELECT
        i.id,
        i.producto,
        COALESCE(i.cantidad,1) AS cantidad,
        i.observacion,
        p.id AS pedido_id,
        p.estado,
        p.fecha,
        p.created_at
      FROM pedido_items i
      JOIN pedidos p ON p.id = i.pedido_id
      ${where}
      ORDER BY i.id DESC
      `,
      params
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /compras]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al listar compras" });
  }
});

/**
 * Alta rápida de item de compra.
 * Crea (o reutiliza) un pedido “bucket” del día para la org y agrega el item.
 * Body: { producto: string, cantidad?: number, observacion?: string }
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const email = req.usuario_email || null;

    let { producto, cantidad = 1, observacion = null } = req.body || {};
    if (!producto || typeof producto !== "string" || !producto.trim()) {
      return res.status(400).json({ message: "producto requerido" });
    }
    producto = producto.trim();
    cantidad = Number.isFinite(+cantidad) ? Math.max(1, parseInt(cantidad, 10)) : 1;

    // Reutilizo un “pedido bucket” del día para la org
    const paramsFind = [];
    let whereFind = "WHERE fecha = CURRENT_DATE";
    if (org) { paramsFind.push(org); whereFind += ` AND organizacion_id = $${paramsFind.length}`; }

    const f = await q(
      `SELECT id FROM pedidos ${whereFind} AND estado = 'pendiente' AND cliente_id IS NULL LIMIT 1`,
      paramsFind
    );

    let pedidoId = f.rows?.[0]?.id;
    if (!pedidoId) {
      const ins = await q(
        `INSERT INTO pedidos (cliente_id, observacion, estado, usuario_email, organizacion_id)
         VALUES (NULL, 'lista-compras', 'pendiente', $1, $2)
         RETURNING id`,
        [email, org]
      );
      pedidoId = ins.rows[0].id;
    }

    const insItem = await q(
      `INSERT INTO pedido_items (pedido_id, producto, cantidad, observacion)
       VALUES ($1, $2, $3, $4)
       RETURNING id, producto, cantidad, observacion`,
      [pedidoId, producto, cantidad, observacion]
    );

    res.status(201).json({
      id: insItem.rows[0].id,
      producto: insItem.rows[0].producto,
      cantidad: insItem.rows[0].cantidad,
      observacion: insItem.rows[0].observacion,
      pedido_id: pedidoId,
      estado: "pendiente",
    });
  } catch (e) {
    console.error("[POST /compras]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al agregar item" });
  }
});

/**
 * Update parcial de un item.
 * Body: { producto?, cantidad?, observacion? }
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
    if (req.body?.observacion !== undefined) {
      fields.push(`observacion = $${idx++}`); values.push(req.body.observacion || null);
    }

    if (!fields.length) return res.status(400).json({ message: "Nada para actualizar" });

    values.push(id);
    const r = await q(
      `UPDATE pedido_items SET ${fields.join(", ")} WHERE id = $${idx} RETURNING id, producto, cantidad, observacion`,
      values
    );
    if (!r.rowCount) return res.status(404).json({ message: "Item no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando item" });
  }
});

/**
 * Borrado de item; si el pedido queda vacío, lo limpio para no acumular basura.
 */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const p = await q(
      `DELETE FROM pedido_items WHERE id = $1 RETURNING pedido_id`,
      [id]
    );
    if (!p.rowCount) return res.status(404).json({ message: "Item no encontrado" });

    const pedidoId = p.rows[0].pedido_id;
    const c = await q(`SELECT 1 FROM pedido_items WHERE pedido_id = $1 LIMIT 1`, [pedidoId]);
    if (!c.rowCount) {
      await q(`DELETE FROM pedidos WHERE id = $1`, [pedidoId]);
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /compras/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando item" });
  }
});

export default router;
x