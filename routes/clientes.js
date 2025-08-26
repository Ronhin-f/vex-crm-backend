// Backend/routes/clientes.js
import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// Listar
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM clientes WHERE organizacion_id = $1 ORDER BY nombre",
      [req.organizacion_id]
    );
    res.json(rows);
  } catch (e) {
    console.error("[GET /clientes]", e);
    res.status(500).json({ message: "Error al obtener clientes" });
  }
});

// Crear
router.post("/", authenticateToken, async (req, res) => {
  const { nombre, telefono, direccion, observacion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ message: "Nombre requerido" });

  try {
    await db.query(
      `INSERT INTO clientes (nombre, telefono, direccion, observacion, usuario_email, organizacion_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [nombre, telefono ?? null, direccion ?? null, observacion ?? null, req.usuario_email, req.organizacion_id]
    );
    res.sendStatus(201);
  } catch (e) {
    console.error("[POST /clientes]", e);
    res.status(500).json({ message: "Error al crear cliente" });
  }
});

// Editar
router.put("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { nombre, telefono, direccion, observacion } = req.body;

  try {
    await db.query(
      `UPDATE clientes
          SET nombre = COALESCE($1, nombre),
              telefono = COALESCE($2, telefono),
              direccion = COALESCE($3, direccion),
              observacion = COALESCE($4, observacion)
        WHERE id = $5 AND organizacion_id = $6`,
      [nombre ?? null, telefono ?? null, direccion ?? null, observacion ?? null, id, req.organizacion_id]
    );
    res.sendStatus(200);
  } catch (e) {
    console.error("[PUT /clientes/:id]", e);
    res.status(500).json({ message: "Error al editar cliente" });
  }
});

// Eliminar
router.delete("/:id", authenticateToken, async (req, res) => {
  const { id } = req.params;
  try {
    await db.query("DELETE FROM clientes WHERE id = $1 AND organizacion_id = $2", [id, req.organizacion_id]);
    res.sendStatus(200);
  } catch (e) {
    console.error("[DELETE /clientes/:id]", e);
    res.status(500).json({ message: "Error al eliminar cliente" });
  }
});

export default router;
