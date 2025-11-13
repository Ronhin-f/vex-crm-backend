// routes/proveedores.js — Proveedores/Subcontratistas (blindado + multi-tenant, TEXT-safe, sin deps fantasma)
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* ---------------------------- helpers inline ---------------------------- */
const T = (v) => (v == null ? null : (String(v).trim() || null));

function getOrgText(req) {
  return (
    T(req.usuario?.organizacion_id) ||
    T(req.headers?.["x-org-id"]) ||
    T(req.query?.organizacion_id) ||
    T(req.body?.organizacion_id) ||
    null
  );
}
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: getOrgText(req),
  };
}
function normTipo(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "proveedor" || s === "subcontratista" ? s : null;
}
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch { return false; }
}
async function hasTable(name) { return regclassExists(name); }
async function tableColumns(name) {
  try {
    const r = await q(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='public' AND table_name=$1`,
      [name]
    );
    return new Set((r.rows || []).map((x) => x.column_name));
  } catch { return new Set(); }
}
async function hasInfra() { return await hasTable("proveedores"); }

/* ============================== GET ============================== */
// Requiere org si existe columna de org; si no hay tabla => []
router.get("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra())) return res.status(200).json([]);

    const cols = await tableColumns("proveedores");
    const { organizacion_id } = getUserFromReq(req);
    if (cols.has("organizacion_id") && !organizacion_id) {
      return res.status(400).json({ message: "organizacion_id requerido" });
    }

    const { tipo, q: qtext } = req.query || {};

    // SELECT seguro (alias si faltan columnas)
    const sel = {
      id: cols.has("id") ? "p.id" : "NULL::int AS id",
      nombre: cols.has("nombre") ? "p.nombre" : "NULL::text AS nombre",
      tipo: cols.has("tipo") ? "p.tipo" : "NULL::text AS tipo",
      email: cols.has("email") ? "p.email" : "NULL::text AS email",
      telefono: cols.has("telefono") ? "CAST(p.telefono AS TEXT)" : "NULL::text AS telefono",
      direccion: cols.has("direccion") ? "p.direccion" : "NULL::text AS direccion",
      notas: cols.has("notas") ? "p.notas" : "NULL::text AS notas",
      usuario_email: cols.has("usuario_email") ? "p.usuario_email" : "NULL::text AS usuario_email",
      organizacion_id: cols.has("organizacion_id") ? "p.organizacion_id" : "NULL::text AS organizacion_id",
      created_at: cols.has("created_at") ? "p.created_at" : "NULL::timestamptz AS created_at",
      updated_at: cols.has("updated_at") ? "p.updated_at" : "NULL::timestamptz AS updated_at",
    };

    const params = [];
    const where = [];

    if (cols.has("organizacion_id") && organizacion_id != null) {
      params.push(String(organizacion_id));
      where.push(`p.organizacion_id::text = $${params.length}::text`);
    }
    if (cols.has("tipo") && tipo) {
      const t = normTipo(tipo);
      if (t) { params.push(t); where.push(`p.tipo = $${params.length}`); }
    }
    if (qtext) {
      const qv = `%${String(qtext).trim()}%`;
      params.push(qv);
      const i = params.length;
      const likeParts = [];
      if (cols.has("nombre")) likeParts.push(`p.nombre ILIKE $${i}`);
      if (cols.has("email")) likeParts.push(`p.email ILIKE $${i}`);
      if (cols.has("telefono")) likeParts.push(`CAST(p.telefono AS TEXT) ILIKE $${i}`);
      if (likeParts.length) where.push(`(${likeParts.join(" OR ")})`);
    }

    const order =
      cols.has("created_at")
        ? "ORDER BY p.created_at DESC NULLS LAST, p.id DESC"
        : "ORDER BY p.id DESC";

    const sql = `
      SELECT
        ${sel.id}, ${sel.nombre}, ${sel.tipo}, ${sel.email}, ${sel.telefono},
        ${sel.direccion}, ${sel.notas}, ${sel.usuario_email},
        ${sel.organizacion_id}, ${sel.created_at}, ${sel.updated_at}
      FROM proveedores p
      ${where.length ? "WHERE " + where.join(" AND ") : ""}
      ${order}
      LIMIT 1000
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /proveedores]", e?.stack || e?.message || e);
    res.status(200).json([]); // no romper FE
  }
});

/* ============================== POST ============================= */
// Si no hay tabla => 501 (módulo no instalado). Requiere org si la columna existe.
router.post("/", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra())) {
      return res.status(501).json({ message: "Módulo de proveedores no instalado" });
    }
    const cols = await tableColumns("proveedores");
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);

    if (cols.has("organizacion_id") && !organizacion_id) {
      return res.status(400).json({ message: "organizacion_id requerido" });
    }

    let { nombre, tipo, email, telefono, direccion, notas } = req.body || {};
    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }
    const t = normTipo(tipo);
    if (!t) return res.status(400).json({ message: "tipo requerido: proveedor | subcontratista" });
    nombre = String(nombre).trim();

    // Anti-duplicado lógico (si existen columnas mínimas)
    if (cols.has("nombre")) {
      const params = [nombre];
      let where = `LOWER(nombre)=LOWER($1)`;
      if (cols.has("organizacion_id")) {
        params.push(String(organizacion_id));
        where += ` AND organizacion_id::text = $2::text`;
      }
      const dup = await q(`SELECT 1 FROM proveedores WHERE ${where} LIMIT 1`, params);
      if (dup.rowCount) return res.status(409).json({ message: "Proveedor ya existe" });
    }

    // INSERT dinámico según columnas presentes
    const payload = {
      nombre,
      tipo: t,
      email: T(email),
      telefono: T(telefono),
      direccion: T(direccion),
      notas: T(notas),
      usuario_email: usuario_email,
      organizacion_id: organizacion_id,
      created_at: new Date(),
      updated_at: new Date(),
    };

    const fields = [];
    const values = [];
    for (const [k, v] of Object.entries(payload)) {
      if (v === undefined || v === null) {
        // incluimos null solo si existe la columna y el valor aporta
        if (!cols.has(k)) continue;
        // permitimos null explícito (p.ej., notas)
        fields.push(k); values.push(v);
      } else {
        if (!cols.has(k)) continue;
        fields.push(k); values.push(v);
      }
    }
    if (!fields.length) return res.status(500).json({ message: "Schema inválido en proveedores" });

    const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(",");
    const r = await q(
      `INSERT INTO proveedores (${fields.join(",")})
       VALUES (${placeholders})
       RETURNING id,
         ${cols.has("nombre") ? "nombre" : "NULL::text AS nombre"},
         ${cols.has("tipo") ? "tipo" : "NULL::text AS tipo"},
         ${cols.has("email") ? "email" : "NULL::text AS email"},
         ${cols.has("telefono") ? "CAST(telefono AS TEXT)" : "NULL::text AS telefono"},
         ${cols.has("direccion") ? "direccion" : "NULL::text AS direccion"},
         ${cols.has("notas") ? "notas" : "NULL::text AS notas"},
         ${cols.has("usuario_email") ? "usuario_email" : "NULL::text AS usuario_email"},
         ${cols.has("organizacion_id") ? "organizacion_id" : "NULL::text AS organizacion_id"},
         ${cols.has("created_at") ? "created_at" : "NOW()::timestamptz AS created_at"},
         ${cols.has("updated_at") ? "updated_at" : "NOW()::timestamptz AS updated_at"}`,
      values
    );
    res.status(201).json(r.rows[0]);
  } catch (e) {
    // Unicidad a nivel DB (si existe constraint)
    if (e?.code === "23505") {
      return res.status(409).json({ message: "Proveedor duplicado" });
    }
    console.error("[POST /proveedores]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando proveedor" });
  }
});

/* ============================== PATCH ============================ */
router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra())) {
      return res.status(501).json({ message: "Módulo de proveedores no instalado" });
    }
    const cols = await tableColumns("proveedores");

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (cols.has("organizacion_id") && !organizacion_id) {
      return res.status(400).json({ message: "organizacion_id requerido" });
    }

    const allowed = ["nombre","tipo","email","telefono","direccion","notas"];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (!(k in (req.body || {}))) continue;
      if (!cols.has(k)) continue;

      if (k === "tipo") {
        const t = normTipo(req.body[k]);
        if (!t) return res.status(400).json({ message: "tipo inválido" });
        sets.push(`tipo = $${vals.length + 1}`); vals.push(t);
      } else if (k === "nombre") {
        const v = String(req.body[k] || "").trim();
        if (!v) return res.status(400).json({ message: "nombre inválido" });
        sets.push(`nombre = $${vals.length + 1}`); vals.push(v);
      } else {
        sets.push(`${k} = $${vals.length + 1}`); vals.push(T(req.body[k]));
      }
    }
    if (cols.has("updated_at")) sets.push(`updated_at = NOW()`);
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    // Dedupe si cambia nombre
    const nameIdx = sets.findIndex((s) => s.startsWith("nombre = "));
    if (nameIdx !== -1 && cols.has("nombre")) {
      const candName = vals[nameIdx];
      const params = [candName, id];
      let where = `LOWER(nombre)=LOWER($1) AND id<>$2`;
      if (cols.has("organizacion_id")) {
        params.push(String(organizacion_id));
        where += ` AND organizacion_id::text = $3::text`;
      }
      const dup = await q(`SELECT 1 FROM proveedores WHERE ${where} LIMIT 1`, params);
      if (dup.rowCount) return res.status(409).json({ message: "Proveedor duplicado" });
    }

    // Filtro por org si existe columna
    vals.push(id);
    let where = `id = $${vals.length}`;
    if (cols.has("organizacion_id")) {
      vals.push(String(organizacion_id));
      where += ` AND organizacion_id::text = $${vals.length}::text`;
    }

    const r = await q(
      `UPDATE proveedores SET ${sets.join(", ")} WHERE ${where}
       RETURNING id,
         ${cols.has("nombre") ? "nombre" : "NULL::text AS nombre"},
         ${cols.has("tipo") ? "tipo" : "NULL::text AS tipo"},
         ${cols.has("email") ? "email" : "NULL::text AS email"},
         ${cols.has("telefono") ? "CAST(telefono AS TEXT)" : "NULL::text AS telefono"},
         ${cols.has("direccion") ? "direccion" : "NULL::text AS direccion"},
         ${cols.has("notas") ? "notas" : "NULL::text AS notas"},
         ${cols.has("usuario_email") ? "usuario_email" : "NULL::text AS usuario_email"},
         ${cols.has("organizacion_id") ? "organizacion_id" : "NULL::text AS organizacion_id"},
         ${cols.has("created_at") ? "created_at" : "NULL::timestamptz AS created_at"},
         ${cols.has("updated_at") ? "updated_at" : "NULL::timestamptz AS updated_at"}`,
      vals
    );
    if (!r.rowCount) return res.status(404).json({ message: "Proveedor no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    if (e?.code === "23505") {
      return res.status(409).json({ message: "Proveedor duplicado" });
    }
    console.error("[PATCH /proveedores/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando proveedor" });
  }
});

/* ============================== DELETE ============================ */
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra())) {
      return res.status(501).json({ message: "Módulo de proveedores no instalado" });
    }
    const cols = await tableColumns("proveedores");

    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });

    const { organizacion_id } = getUserFromReq(req);
    if (cols.has("organizacion_id") && !organizacion_id) {
      return res.status(400).json({ message: "organizacion_id requerido" });
    }

    const params = [id];
    let where = `id = $1`;
    if (cols.has("organizacion_id")) {
      params.push(String(organizacion_id));
      where += ` AND organizacion_id::text = $2::text`;
    }

    const r = await q(`DELETE FROM proveedores WHERE ${where}`, params);
    if (!r.rowCount) return res.status(404).json({ message: "Proveedor no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /proveedores/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando proveedor" });
  }
});

export default router;
