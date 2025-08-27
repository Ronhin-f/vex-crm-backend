// routes/clientes.js
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

function normCategoria(cat) {
  if (!cat || typeof cat !== "string") return "Incoming Leads";
  const c = cat.trim();
  return CANON_CATS.includes(c) ? c : "Incoming Leads";
}

// Listar
router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const params = [];
    let where = "";
    if (org) { params.push(org); where = `WHERE organizacion_id = $${params.length}`; }

    const rows = await q(
      `SELECT id, nombre, telefono, categoria, email, organizacion_id, created_at
         FROM clientes
         ${where}
         ORDER BY created_at DESC NULLS LAST, id DESC`,
      params
    );
    res.json(rows.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando clientes" });
  }
});

// Crear
router.post("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id || null;
    const { nombre, telefono, categoria, email } = req.body || {};

    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "El nombre es obligatorio" });
    }

    const cat = normCategoria(categoria);

    const cols = ["nombre", "telefono", "categoria", "email"];
    const vals = [nombre.trim(), telefono ?? null, cat, email ?? null];
    const phs  = ["$1", "$2", "$3", "$4"];

    if (org) { cols.push("organizacion_id"); vals.push(org); phs.push(`$${phs.length + 1}`); }

    const r = await q(
      `INSERT INTO clientes (${cols.join(",")}) VALUES (${phs.join(",")}) RETURNING *`,
      vals
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al crear cliente" });
  }
});

// Update simple
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    let { nombre, telefono, categoria, email } = req.body || {};
    if (categoria !== undefined) categoria = normCategoria(categoria);

    const sets = [];
    const params = [];
    if (nombre !== undefined)  { params.push(nombre);   sets.push(`nombre=$${params.length}`); }
    if (telefono !== undefined){ params.push(telefono); sets.push(`telefono=$${params.length}`); }
    if (categoria !== undefined){params.push(categoria);sets.push(`categoria=$${params.length}`); }
    if (email !== undefined)   { params.push(email);    sets.push(`email=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    params.push(id);
    const r = await q(`UPDATE clientes SET ${sets.join(",")} WHERE id=$${params.length} RETURNING *`, params);
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PUT /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al actualizar cliente" });
  }
});

// Delete
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const r = await q(`DELETE FROM clientes WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al eliminar cliente" });
  }
});

export default router;
