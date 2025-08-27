// routes/categorias.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

// Listado (por organización si viene en JWT)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const params = [];
    let where = "";
    if (org) {
      params.push(org);
      where = `WHERE organizacion_id = $${params.length}`;
    }
    const r = await q(
      `SELECT id, nombre, organizacion_id, created_at
         FROM categorias
         ${where}
         ORDER BY nombre ASC`,
      params
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /categorias]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando categorías" });
  }
});

// Crear (unique por organizacion_id + nombre, case-insensitive)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    let { nombre } = req.body || {};
    if (!nombre || typeof nombre !== "string") {
      return res.status(400).json({ message: "Nombre requerido" });
    }
    nombre = nombre.trim();
    if (!nombre) return res.status(400).json({ message: "Nombre requerido" });

    const r = await q(
      `
      INSERT INTO categorias (nombre, organizacion_id)
      VALUES ($1, $2)
      ON CONFLICT (organizacion_id, nombre_ci) DO NOTHING
      RETURNING id, nombre, organizacion_id, created_at
      `,
      [nombre, org]
    );
    if (!r.rowCount) return res.status(409).json({ message: "Categoría ya existe" });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /categorias]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando categoría" });
  }
});

// Renombrar
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { nombre } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }
    nombre = nombre.trim();

    const r = await q(
      `
      UPDATE categorias
         SET nombre = $1,
             nombre_ci = LOWER($1)
       WHERE id = $2
       RETURNING id, nombre, organizacion_id, created_at
      `,
      [nombre, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PUT /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error renombrando categoría" });
  }
});

// Eliminar (opcionalmente reasignar clientes a otra categoría)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reassignTo } = req.query; // nombre destino opcional
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    // Busco nombre actual
    const c = await q(`SELECT nombre FROM categorias WHERE id=$1`, [id]);
    if (!c.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });
    const nombreActual = c.rows[0].nombre;

    if (reassignTo && typeof reassignTo === "string" && reassignTo.trim()) {
      await q(`UPDATE clientes SET categoria=$1 WHERE categoria=$2`, [reassignTo.trim(), nombreActual]);
    }

    await q(`DELETE FROM categorias WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando categoría" });
  }
});

export default router;
