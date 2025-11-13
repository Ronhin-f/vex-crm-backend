// routes/categorias.js — Pipeline Categories (TEXT-safe, tenancy estricto, sin deps externas)
import { Router } from "express";
import { q, CANON_CATS } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ------------------------ helpers locales ------------------------ */
const T = (v) => (v == null ? null : String(v).trim() || null);

function firstText(...vals) {
  for (const v of vals) {
    const s = T(v);
    if (s) return s;
  }
  return null;
}

function getOrgText(req) {
  return (
    T(req.usuario?.organizacion_id) ||
    T(req.headers["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null
  );
}

async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}
async function hasTable(name) { return regclassExists(name); }

async function tableColumns(name) {
  try {
    const r = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    const set = new Set();
    for (const row of r.rows || []) set.add(row.column_name);
    return set;
  } catch {
    return new Set();
  }
}

const sameOrg = (a, b) => T(a) !== null && T(b) !== null && String(a) === String(b);

/* =========================== GET =========================== */
/**
 * Devuelve categorías ordenadas.
 * - Si falta la tabla o columnas mínimas: lista virtual desde CANON_CATS (no rompe FE).
 * - Seed suave canónicas globales (NULL) con su orden cuando la tabla está OK.
 * - Mezcla globales + org y ordena por CANON_CATS; desconocidas al final.
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req); // TEXT
    const hasCats = await hasTable("categorias");

    // Lista virtual canónica (fallback)
    const virtual = (CANON_CATS || []).map((nombre, i) => ({
      id: null,
      nombre,
      organizacion_id: null,
      created_at: null,
      orden: i,
    }));

    if (!hasCats) return res.json(virtual);

    // Columnas seguras
    const cols = await tableColumns("categorias");
    const hasOrgCol = cols.has("organizacion_id");
    const hasNombre = cols.has("nombre");

    // Si no están las mínimas, devolvemos virtual
    if (!hasNombre || !hasOrgCol) return res.json(virtual);

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

    const idSel      = cols.has("id") ? "id" : "NULL::int AS id";
    const nombreSel  = "nombre";
    const orgSel     = "organizacion_id";
    const createdSel = cols.has("created_at") ? "created_at" : "NULL::timestamptz AS created_at";

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
      WHERE (organizacion_id IS NULL OR organizacion_id::text = $1::text)
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

    // Solo puede borrar la org dueña
    if (!sameOrg(row.organizacion_id, orgId)) {
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
      if (!ccols.has("organizacion_id")) {
        return res.status(501).json({ message: "Tabla clientes no es multi-tenant (falta organizacion_id)" });
      }
      const sets = [];
      if (ccols.has("stage"))     sets.push(`stage=$1`);
      if (ccols.has("categoria")) sets.push(`categoria=$1`);
      if (!sets.length) {
        return res.status(501).json({ message: "Tabla clientes no tiene columnas stage/categoria para reasignar" });
      }
      const wheres = [];
      if (ccols.has("categoria")) wheres.push(`categoria=$2`);
      if (ccols.has("stage"))     wheres.push(`stage=$2`);

      await q(
        `UPDATE clientes SET ${sets.join(", ")}, updated_at=NOW()
         WHERE (${wheres.join(" OR ")})
           AND organizacion_id::text = $3::text`,
        [reassignTo, nombreActual, orgId]
      );
    }

    await q(
      `DELETE FROM categorias WHERE id=$1 AND organizacion_id::text = $2::text`,
      [id, orgId]
    );
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
 * - Requiere módulo clientes y columna organizacion_id; no sembramos categorías acá.
 * - Actualiza stage y/o categoria si existen las columnas (ambas a $1).
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
    if (!ccols.has("organizacion_id")) {
      return res.status(501).json({ message: "Tabla clientes no es multi-tenant (falta organizacion_id)" });
    }

    const sets = [];
    if (ccols.has("stage"))     sets.push(`stage=$1`);
    if (ccols.has("categoria")) sets.push(`categoria=$1`);
    if (!sets.length) {
      return res.status(501).json({
        message: "Tabla clientes no tiene columnas stage/categoria para mover en pipeline",
      });
    }

    const returning = ["id"];
    if (ccols.has("nombre"))    returning.push("nombre");
    if (ccols.has("stage"))     returning.push("stage");
    if (ccols.has("categoria")) returning.push("categoria");

    const r = await q(
      `
      UPDATE clientes
         SET ${sets.join(", ")}, updated_at=NOW()
       WHERE organizacion_id::text = $2::text AND id = $3
       RETURNING ${returning.join(", ")}
      `,
      [nextRaw, orgId, id]
    );

    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    console.error("[PATCH /categorias/clientes/:id/move]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error moviendo cliente" });
  }
});

export default router;
