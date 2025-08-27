// routes/categorias.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

const CANON_CATS = [
  "Incoming Leads",
  "Qualified",
  "Bid/Estimate Sent",
  "Won",
  "Lost",
];

// GET: seed suave + orden por pipeline
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;

    for (let i = 0; i < CANON_CATS.length; i++) {
      const name = CANON_CATS[i];
      await q(
        `UPDATE categorias SET orden=$2
           WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)`,
        [name, i]
      );
      await q(
        `INSERT INTO categorias (nombre, organizacion_id, orden)
         SELECT $1, NULL, $2
          WHERE NOT EXISTS (
            SELECT 1 FROM categorias WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)
          )`,
        [name, i]
      );
    }

    const params = [];
    let where = "WHERE organizacion_id IS NULL";
    if (org) { params.push(org); where = `WHERE (organizacion_id IS NULL OR organizacion_id = $${params.length})`; }

    params.push(CANON_CATS);
    const r = await q(
      `
      SELECT id, nombre, organizacion_id, created_at,
             COALESCE(array_position($${params.length}::text[], nombre), 9999) AS orden
        FROM categorias
        ${where}
        ORDER BY orden ASC, nombre ASC
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /categorias]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando categorías" });
  }
});

// POST: solo canon; evita duplicados por lower(nombre)
router.post("/", authenticateToken, async (req, res) => {
  try {
    let { nombre } = req.body || {};
    if (!nombre || typeof nombre !== "string") return res.status(400).json({ message: "Nombre requerido" });
    nombre = nombre.trim();
    const idx = CANON_CATS.indexOf(nombre);
    if (idx === -1) return res.status(400).json({ message: "Categoría no permitida (fuera del pipeline)" });

    const r = await q(
      `INSERT INTO categorias (nombre, organizacion_id, orden)
       SELECT $1, NULL, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM categorias WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)
        )
       RETURNING id, nombre, organizacion_id, created_at`,
      [nombre, idx]
    );
    if (!r.rowCount) return res.status(409).json({ message: "Categoría ya existe" });
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /categorias]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando categoría" });
  }
});

// PUT: solo canon; maneja duplicado (índice único lower(nombre))
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { nombre } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!nombre || typeof nombre !== "string" || !nombre.trim()) return res.status(400).json({ message: "Nombre requerido" });
    nombre = nombre.trim();
    if (!CANON_CATS.includes(nombre)) return res.status(400).json({ message: "Categoría no permitida (fuera del pipeline)" });

    try {
      const r = await q(
        `UPDATE categorias
            SET nombre=$1
          WHERE id=$2
          RETURNING id, nombre, organizacion_id, created_at`,
        [nombre, id]
      );
      if (!r.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });
      res.json(r.rows[0]);
    } catch (err) {
      if (err?.code === "23505") return res.status(409).json({ message: "Categoría duplicada" });
      throw err;
    }
  } catch (e) {
    console.error("[PUT /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error renombrando categoría" });
  }
});

// DELETE: no permite borrar del pipeline global
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { reassignTo } = req.query;
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const c = await q(`SELECT nombre, organizacion_id FROM categorias WHERE id=$1`, [id]);
    if (!c.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });

    const nombreActual = c.rows[0].nombre;
    const isCanonGlobal = CANON_CATS.includes(nombreActual) && c.rows[0].organizacion_id === null;
    if (isCanonGlobal) return res.status(400).json({ message: "No se puede eliminar una categoría del pipeline" });

    if (reassignTo && typeof reassignTo === "string" && reassignTo.trim()) {
      const target = reassignTo.trim();
      if (!CANON_CATS.includes(target)) return res.status(400).json({ message: "reassignTo no pertenece al pipeline" });
      await q(`UPDATE clientes SET categoria=$1 WHERE categoria=$2`, [target, nombreActual]);
    }

    await q(`DELETE FROM categorias WHERE id=$1`, [id]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando categoría" });
  }
});

// Mover cliente entre etapas del pipeline
router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    let { categoria } = req.body || {};
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!categoria || typeof categoria !== "string") return res.status(400).json({ message: "Categoría requerida" });
    categoria = categoria.trim();
    if (!CANON_CATS.includes(categoria)) return res.status(400).json({ message: "Categoría no permitida (fuera del pipeline)" });

    // Aseguro que exista en catálogo global
    const idx = CANON_CATS.indexOf(categoria);
    await q(
      `UPDATE categorias SET orden=$2
         WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)`,
      [categoria, idx]
    );
    await q(
      `INSERT INTO categorias (nombre, organizacion_id, orden)
       SELECT $1, NULL, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM categorias WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)
        )`,
      [categoria, idx]
    );

    const r = await q(
      `UPDATE clientes SET categoria=$1 WHERE id=$2 RETURNING id, nombre, categoria`,
      [categoria, id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /categorias/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

export default router;
