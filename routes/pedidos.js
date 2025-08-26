import { Router } from "express";
import { db } from "../db.js";
import { authenticateToken } from "../middlewares/auth.js";

const router = Router();

// Listar (con items)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const pedidosRes = await db.query(
      "SELECT * FROM pedidos WHERE organizacion_id = $1 ORDER BY fecha DESC",
      [req.organizacion_id]
    );
    const pedidos = pedidosRes.rows;
    if (pedidos.length === 0) return res.json([]);

    const ids = pedidos.map(p => p.id);
    const itemsRes = await db.query(
      "SELECT * FROM pedido_items WHERE pedido_id = ANY($1)",
      [ids]
    );

    const map = new Map();
    for (const it of itemsRes.rows) {
      if (!map.has(it.pedido_id)) map.set(it.pedido_id, []);
      map.get(it.pedido_id).push(it);
    }

    const payload = pedidos.map(p => ({ ...p, items: map.get(p.id) || [] }));
    res.json(payload);
  } catch (e) {
    console.error("[GET /pedidos]", e);
    res.status(500).json({ message: "Error al obtener pedidos" });
  }
});

// Crear (con items)
router.post("/", authenticateToken, async (req, res) => {
  const { cliente_id, observacion, estado, items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: "Debe haber al menos un item" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const ped = await client.query(
      `INSERT INTO pedidos (cliente_id, observacion, estado, usuario_email, organizacion_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [cliente_id || null, observacion, estado || "pendiente", req.usuario_email, req.organizacion_id]
    );
    const pedido_id = ped.rows[0].id;

    for (const it of items) {
      await client.query(
        `INSERT INTO pedido_items (pedido_id, producto, cantidad, observacion)
         VALUES ($1, $2, $3, $4)`,
        [pedido_id, it.producto, it.cantidad, it.observacion || ""]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ pedido_id });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /pedidos]", e);
    res.status(500).json({ message: "Error al crear pedido" });
  } finally {
    client.release();
  }
});

// Editar (reemplazo total de items)
router.put("/:id", authenticateToken, async (req, res) => {
  const { cliente_id, observacion, estado, items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: "Debe haber al menos un item" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE pedidos SET cliente_id = $1, observacion = $2, estado = $3
       WHERE id = $4 AND organizacion_id = $5`,
      [cliente_id || null, observacion, estado || "pendiente", req.params.id, req.organizacion_id]
    );
    await client.query("DELETE FROM pedido_items WHERE pedido_id = $1", [req.params.id]);
    for (const it of items) {
      await client.query(
        `INSERT INTO pedido_items (pedido_id, producto, cantidad, observacion)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, it.producto, it.cantidad, it.observacion || ""]
      );
    }
    await client.query("COMMIT");
    res.sendStatus(200);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PUT /pedidos/:id]", e);
    res.status(500).json({ message: "Error al editar pedido" });
  } finally {
    client.release();
  }
});

// Eliminar
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM pedidos WHERE id = $1 AND organizacion_id = $2",
      [req.params.id, req.organizacion_id]
    );
    res.sendStatus(204);
  } catch (e) {
    console.error("[DELETE /pedidos/:id]", e);
    res.status(500).json({ message: "Error al eliminar pedido" });
  }
});

export default router;
