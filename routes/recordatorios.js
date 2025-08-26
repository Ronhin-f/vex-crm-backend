import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

router.get("/", authenticateToken, async (req, res) => {
  const { estado } = req.query; // pendiente|enviado|error
  const params = [req.organizacion_id];
  let sql = "SELECT * FROM recordatorios WHERE organizacion_id = $1";
  if (estado) { params.push(estado); sql += " AND estado = $2"; }
  sql += " ORDER BY enviar_en ASC";

  try {
    const { rows } = await db.query(sql, params);
    res.json(rows);
  } catch (e) {
    console.error("[GET /recordatorios]", e);
    res.status(500).json({ message: "Error al obtener recordatorios" });
  }
});

router.post("/", authenticateToken, async (req, res) => {
  const { titulo, mensaje, enviar_en, cliente_id, tarea_id } = req.body;
  if (!titulo?.trim() || !mensaje?.trim() || !enviar_en)
    return res.status(400).json({ message: "Campos requeridos: titulo, mensaje, enviar_en" });

  try {
    const { rows } = await db.query(
      `INSERT INTO recordatorios (organizacion_id, titulo, mensaje, enviar_en, cliente_id, tarea_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [req.organizacion_id, titulo, mensaje, enviar_en, cliente_id || null, tarea_id || null]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (e) {
    console.error("[POST /recordatorios]", e);
    res.status(500).json({ message: "Error al crear recordatorio" });
  }
});

router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    await db.query("DELETE FROM recordatorios WHERE id=$1 AND organizacion_id=$2",
      [req.params.id, req.organizacion_id]);
    res.sendStatus(204);
  } catch (e) {
    console.error("[DELETE /recordatorios/:id]", e);
    res.status(500).json({ message: "Error al eliminar recordatorio" });
  }
});

export default router;
