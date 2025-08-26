// Backend/routes/tareas.js
import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// Listar con join de cliente
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT t.*, c.nombre AS cliente_nombre
         FROM tareas t
         LEFT JOIN clientes c ON c.id = t.cliente_id
        WHERE t.organizacion_id = $1
        ORDER BY t.completada, COALESCE(t.vence_en, NOW()) ASC, t.id DESC`,
      [req.organizacion_id]
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /tareas]", e);
    res.status(500).json({ message: "Error al obtener tareas" });
  }
});

// Crear
router.post("/", authenticateToken, async (req, res) => {
  const { titulo, descripcion, completada, cliente_id, vence_en } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ message: "Título requerido" });

  try {
    await db.query(
      `INSERT INTO tareas (titulo, descripcion, completada, cliente_id, vence_en, usuario_email, organizacion_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        titulo,
        descripcion ?? null,
        !!completada,
        cliente_id ?? null,
        vence_en ?? null,
        req.usuario_email,
        req.organizacion_id,
      ]
    );
    res.sendStatus(201);
  } catch (e) {
    console.error("[POST /tareas]", e);
    res.status(500).json({ message: "Error al crear tarea" });
  }
});

// Editar
router.put("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { titulo, descripcion, completada, cliente_id, vence_en } = req.body;

  try {
    await db.query(
      `UPDATE tareas
          SET titulo = COALESCE($1, titulo),
              descripcion = COALESCE($2, descripcion),
              completada = COALESCE($3, completada),
              cliente_id = COALESCE($4, cliente_id),
              vence_en = COALESCE($5, vence_en)
        WHERE id = $6 AND organizacion_id = $7`,
      [titulo ?? null, descripcion ?? null, completada, cliente_id ?? null, vence_en ?? null, id, req.organizacion_id]
    );
    res.sendStatus(200);
  } catch (e) {
    console.error("[PUT /tareas/:id]", e);
    res.status(500).json({ message: "Error al editar tarea" });
  }
});

// Marcar completada
router.patch("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query(
      "UPDATE tareas SET completada = TRUE WHERE id = $1 AND organizacion_id = $2",
      [id, req.organizacion_id]
    );
    res.sendStatus(200);
  } catch (e) {
    console.error("[PATCH /tareas/:id]", e);
    res.status(500).json({ message: "Error al completar tarea" });
  }
});

// Eliminar
router.delete("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM tareas WHERE id = $1 AND organizacion_id = $2", [id, req.organizacion_id]);
    res.sendStatus(200);
  } catch (e) {
    console.error("[DELETE /tareas/:id]", e);
    res.status(500).json({ message: "Error al eliminar tarea" });
  }
});

export default router;
