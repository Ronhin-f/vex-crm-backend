// routes/categorias.js — Pipeline Categories (TEXT-safe, tenancy estricto)
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { nocache } from "../middleware/nocache.js";
import { hasTable, tableColumns } from "../utils/schema.js";
import { getOrgText } from "../utils/org.js";

const router = Router();

/* ------------------------ helpers locales ------------------------ */
function firstText(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return null;
}

/* =========================== GET =========================== */
/**
 * Devuelve categorías ordenadas.
 * - Si falta la tabla: lista virtual desde CANON_CATS (no rompe FE).
 * - Seed suave canónicas globales (NULL) con su orden.
 * - Mezcla globales + org (si hay) y ordena por CANON_CATS; desconocidas al final.
 */
router.get("/", authenticateToken, nocache, async (req, res) => {
  try {
    const orgId = getOrgText(req); // requerido y TEXT
    const hasCats = await hasTable("categorias");

    // Si no existe la tabla, devolvemos lista virtual canónica
    if (!hasCats) {
      const virtual = (CANON_CATS || []).map((nombre, i) => ({
        id: null,
        nombre,
        organizacion_id: null,
        created_at: null,
        orden: i,
      }));
      return res.json(virtual);
    }

    // Seed idempotente de canónicas globales (organizacion_id NULL)
    for (let i = 0; i < (CANON_CATS || []).length; i++) {
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

    // Columnas seguras
    const cols = await tableColumns("categorias");
    const idSel = cols.has("id") ? "id" : "NULL::int AS id";
    const nombreSel = cols.has("nombre") ? "nombre" : "NULL::text AS nombre";
    const orgSel = cols.has("organizacion_id")
      ? "organizacion_id"
      : "NULL::text AS organizacion_id";
    const createdSel = cols.has("created_at")
      ? "created_at"
      : "NULL::timestamptz AS created_at";

    const params = [orgId, CANON_CATS || []];

    const r = await q(
      `
      SELECT
        ${idSel},
        ${nombreSel},
        ${orgSel},
        ${createdSel},
        COALESCE(array_position($2::text[], nombre), 9999) AS orden
      FROM categorias
      WHERE (organizacion_id IS NULL OR organizacion_id = $1)
      ORDER BY orden ASC, nombre ASC
      `,
      params
    );

    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /categorias]", e?.stack || e?.message || e);
    res.status(200).json([]); // degradamos a vacío
  }
});

/* =========================== POST ========================== */
/**
 * Crea categoría canónica global (NULL org).
 * Si falta la tabla => 501 (módulo no instalado).
 */
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("categorias"))) {
      return res.status(501).json({ message: "Módulo de categorías no instalado" });
    }

    let { nombre } = req.body || {};
    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }
    nombre = nombre.trim();

    const idx = (CANON_CATS || []).indexOf(nombre);
    if (idx === -1) {
      return res.status(400).json({ message: "Categoría no permitida (fuera del pipeline)" });
    }

    try {
      const r = await q(
        `INSERT INTO categorias (nombre, organizacion_id, orden)
         SELECT $1, NULL, $2
          WHERE NOT EXISTS (
            SELECT 1 FROM categorias WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)
          )
         RETURNING id, nombre, organizacion_id, (NOW())::timestamptz AS created_at`,
        [nombre, idx]
      );
      if (!r.rowCount) return res.status(409).json({ message: "Categoría ya existe" });
      res.status(201).json(r.rows[0]);
    } catch (err) {
      if (err?.code === "23505") {
        return res.status(409).json({ message: "Categoría duplicada" });
      }
      throw err;
    }
  } catch (e) {
    console.error("[POST /categorias]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando categoría" });
  }
});

/* ============================ PUT =========================== */
/**
 * Renombra a un nombre canónico. No cambia la org, solo el nombre.
 * Si falta la tabla => 501.
 */
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("categorias"))) {
      return res.status(501).json({ message: "Módulo de categorías no instalado" });
    }

    const id = Number(req.params.id);
    let { nombre } = req.body || {};

    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!nombre || typeof nombre !== "string" || !nombre.trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }

    nombre = nombre.trim();
    if (!(CANON_CATS || []).includes(nombre)) {
      return res.status(400).json({ message: "Categoría no permitida (fuera del pipeline)" });
    }

    try {
      const r = await q(
        `UPDATE categorias
            SET nombre=$1
          WHERE id=$2
          RETURNING id, nombre, organizacion_id, (NOW())::timestamptz AS created_at`,
        [nombre, id]
      );
      if (!r.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });
      res.json(r.rows[0]);
    } catch (err) {
      if (err?.code === "23505") {
        return res.status(409).json({ message: "Categoría duplicada" });
      }
      throw err;
    }
  } catch (e) {
    console.error("[PUT /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error renombrando categoría" });
  }
});

/* ========================== DELETE ========================== */
/**
 * Borra categoría NO canónica.
 * - Si es canónica global (NULL y en CANON_CATS) => 400.
 * - ?reassignTo=Qualified (opcional, debe ser canónica).
 * - Solo permite borrar si pertenece a la misma organización que el request.
 * - Si falta tabla => 501.
 */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasTable("categorias"))) {
      return res.status(501).json({ message: "Módulo de categorías no instalado" });
    }

    const orgId = getOrgText(req);
    const id = Number(req.params.id);
    const reassignTo = firstText(req.query?.reassignTo);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const c = await q(
      `SELECT id, nombre, organizacion_id FROM categorias WHERE id=$1`,
      [id]
    );
    if (!c.rowCount) return res.status(404).json({ message: "Categoría no encontrada" });

    const row = c.rows[0];
    const nombreActual = row.nombre;
    const isCanonGlobal = (CANON_CATS || []).includes(nombreActual) && row.organizacion_id === null;
    if (isCanonGlobal) {
      return res.status(400).json({ message: "No se puede eliminar una categoría del pipeline" });
    }

    // Solo puede borrar la org dueña (o global NO canónica si querés limpiar, pero evitamos efecto lateral)
    if (row.organizacion_id !== orgId) {
      return res.status(403).json({ message: "No autorizado para eliminar esta categoría" });
    }

    // Reasignación opcional
    if (reassignTo) {
      if (!(CANON_CATS || []).includes(reassignTo)) {
        return res.status(400).json({ message: "reassignTo no pertenece al pipeline" });
      }
      const hasClientes = await hasTable("clientes");
      if (!hasClientes) {
        return res.status(501).json({ message: "Módulo de clientes no instalado; no se puede reasignar antes de borrar" });
      }
      const ccols = await tableColumns("clientes");
      const sets = [];
      if (ccols.has("stage")) sets.push(`stage=$1`);
      if (ccols.has("categoria")) sets.push(`categoria=$1`);
      if (!sets.length) {
        return res.status(501).json({ message: "Tabla clientes no tiene columnas stage/categoria para reasignar" });
      }
      const wheres = [];
      if (ccols.has("categoria")) wheres.push(`categoria=$2`);
      if (ccols.has("stage")) wheres.push(`stage=$2`);
      // solo dentro de la misma org
      wheres.push(`organizacion_id = $3`);

      await q(
        `UPDATE clientes SET ${sets.join(", ")}, updated_at=NOW()
         WHERE (${wheres.join(" OR ")})`,
        [reassignTo, nombreActual, orgId]
      );
    }

    await q(`DELETE FROM categorias WHERE id=$1 AND organizacion_id = $2`, [id, orgId]);
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /categorias/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando categoría" });
  }
});

/* =========== Move cliente entre etapas del pipeline =========== */
/**
 * PATCH /categorias/clientes/:id/move
 * Body: { stage?: string, categoria?: string }
 * - Requiere módulo clientes; no sembramos categorías aquí (no crítico).
 * - Actualiza stage y/o categoria si existen las columnas.
 * - Restringido por `organizacion_id` TEXT.
 */
router.patch("/clientes/:id/move", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req);
    const id = Number(req.params.id);
    const nextRaw = firstText(req.body?.stage, req.body?.categoria);

    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    if (!nextRaw) return res.status(400).json({ message: "stage requerido" });
    if (!(CANON_CATS || []).includes(nextRaw)) {
      return res.status(400).json({ message: "stage fuera del pipeline" });
    }

    if (!(await hasTable("clientes"))) {
      return res.status(501).json({ message: "Módulo de clientes no instalado" });
    }
    const ccols = await tableColumns("clientes");
    const sets = [];
    const returning = [`id`, `nombre`];
    const params = [nextRaw, orgId, id];
    let i = 1;

    if (ccols.has("stage")) {
      sets.push(`stage=$${i++}`);
      if (!returning.includes("stage")) returning.push("stage");
    }
    if (ccols.has("categoria")) {
      sets.push(`categoria=$${i++}`);
      if (!returning.includes("categoria")) returning.push("categoria");
    }

    if (!sets.length) {
      return res.status(501).json({
        message: "Tabla clientes no tiene columnas stage/categoria para mover en pipeline",
      });
    }

    // WHERE por id y por org
    const r = await q(
      `
      UPDATE clientes
         SET ${sets.join(", ")}, updated_at=NOW()
       WHERE organizacion_id = $2 AND id = $3
       RETURNING ${returning.join(", ")}
      `,
      params
    );

    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /categorias/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

export default router;
