// routes/clientes.js — CRUD Clientes + Contactos (tenancy TEXT estricto, esquema variable)
import { Router } from "express";
import { q, pool } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";

const router = Router();

/* ---------------------------- helpers ---------------------------- */
function getUserFromReq(req) {
  const u = req.usuario || {};
  return {
    email: u.email ?? req.usuario_email ?? u.usuario_email ?? null,
    organizacion_id: getOrgText(req) || null, // <-- TEXT estricto
  };
}
const T = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s.length ? s : null;
};

// existencia rápida de objetos
async function regclassExists(name) {
  try {
    const r = await q(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${name}`]);
    return !!r.rows?.[0]?.ok;
  } catch {
    return false;
  }
}

// cache columnas por tabla
const COLS_CACHE = new Map();
async function tableColumns(table) {
  const now = Date.now();
  const cached = COLS_CACHE.get(table);
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.set;
  const r = await q(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table]
  );
  const set = new Set((r.rows || []).map((x) => x.column_name));
  COLS_CACHE.set(table, { ts: now, set });
  return set;
}
function pickOne(cols, candidates) {
  for (const c of candidates) if (cols.has(c)) return c;
  return null;
}

// assert pertenencia de cliente a la org (evita cross-tenant en contactos)
async function assertClienteBelongs(orgId, clienteId) {
  const r = await q(
    `SELECT 1 FROM clientes WHERE id = $1 AND organizacion_id = $2`,
    [clienteId, orgId]
  );
  return r.rowCount > 0;
}

/* ===================== CLIENTES ===================== */

/* ============== GET /clientes ============== */
/**
 * Soporta:
 *   - ?status=active,bid,inactive,all  (default: "active,bid")
 *   - ?q=texto                         (nombre/email/teléfono)
 */
router.get("/", authenticateToken, async (req, res) => {
  try {
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    // Normalización de status
    const rawStatus = String(req.query?.status ?? "").trim().toLowerCase();
    const VALID = new Set(["active", "bid", "inactive"]);
    let statuses = null; // null = sin filtro (all)

    if (rawStatus === "all") {
      statuses = null;
    } else if (rawStatus) {
      statuses = rawStatus
        .split(",")
        .map((s) => s.trim())
        .filter((s) => VALID.has(s));
      if (!statuses.length) statuses = ["active", "bid"];
    } else {
      statuses = ["active", "bid"];
    }

    const qtext = String(req.query?.q ?? "").trim();

    // detección de columnas/tablas
    const colsC = await tableColumns("clientes");
    const contactosOk = await regclassExists("contactos");

    // status derivado robusto
    const hasStatus = colsC.has("status");
    const stageCol = pickOne(colsC, ["stage", "estado", "etapa"]);
    const statusExpr = hasStatus
      ? `COALESCE(c.status,'active')`
      : stageCol
        ? `(CASE
             WHEN ${stageCol} ~* '(bid|presup|estimate)' THEN 'bid'
             WHEN ${stageCol} ~* '(inact|archiv|dormid|closed)' THEN 'inactive'
             ELSE 'active'
           END)`
        : `'active'`;

    // filtros
    const params = [organizacion_id];
    const where = [`c.organizacion_id = $1`];

    if (statuses) {
      params.push(statuses);
      where.push(`${statusExpr} = ANY($${params.length}::text[])`);
    }

    if (qtext) {
      const like = `%${qtext}%`;
      params.push(like);
      const i = params.length;
      // tolerante si telefono no es texto
      const parts = [
        `c.nombre ILIKE $${i}`,
        `c.email ILIKE $${i}`,
        `CAST(c.telefono AS TEXT) ILIKE $${i}`,
      ];
      if (contactosOk) {
        parts.push(
          `pc.nombre ILIKE $${i}`,
          `pc.email ILIKE $${i}`,
          `CAST(pc.telefono AS TEXT) ILIKE $${i}`
        );
      }
      where.push(`(${parts.join(" OR ")})`);
    }

    // LATERAL a contactos si existe tabla
    let selectPrimary =
      `NULL::jsonb AS primary_contact, ` +
      `COALESCE(c.contacto_nombre, NULL) AS contacto_nombre, ` +
      `COALESCE(c.email, NULL) AS email, ` +
      `COALESCE(c.telefono, NULL) AS telefono`;
    let fromJoin = "";
    if (contactosOk) {
      selectPrimary =
        `CASE WHEN pc.id IS NULL THEN NULL ELSE jsonb_build_object(
           'id', pc.id,'nombre', pc.nombre,'email', pc.email,'telefono', pc.telefono,'es_principal', true
         ) END AS primary_contact, ` +
        `COALESCE(pc.nombre, c.contacto_nombre) AS contacto_nombre, ` +
        `COALESCE(pc.email, c.email) AS email, ` +
        `COALESCE(pc.telefono, c.telefono) AS telefono`;
      fromJoin = `
        LEFT JOIN LATERAL (
          SELECT id, nombre, email, telefono
          FROM contactos
          WHERE cliente_id = c.id AND COALESCE(es_principal, false) = TRUE
          ORDER BY id ASC
          LIMIT 1
        ) pc ON TRUE`;
    }

    const sql = `
      SELECT
        c.id,
        c.nombre,
        ${selectPrimary},
        c.direccion,
        c.observacion,
        c.usuario_email,
        c.organizacion_id,
        ${statusExpr} AS status,
        ${colsC.has("created_at") ? "c.created_at" : "NULL::timestamptz AS created_at"},
        ${colsC.has("updated_at") ? "c.updated_at" : "NULL::timestamptz AS updated_at"}
      FROM clientes c
      ${fromJoin}
      WHERE ${where.join(" AND ")}
      ORDER BY ${colsC.has("created_at") ? "c.created_at DESC NULLS LAST," : ""} c.id DESC
      LIMIT 1000
    `;
    const r = await q(sql, params);
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes]", e?.stack || e?.message || e);
    res.status(200).json([]); // no romper FE
  }
});

/* ============== POST /clientes ============== */
router.post("/", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const { organizacion_id, email: usuario_email } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    let {
      nombre,
      contacto_nombre,
      email,
      telefono,
      direccion,
      observacion,
      status = "active",
    } = req.body || {};

    if (!nombre || !String(nombre).trim()) {
      return res.status(400).json({ message: "Nombre requerido" });
    }

    const colsC = await tableColumns("clientes");
    const contactosOk = await regclassExists("contactos");

    // normalizamos status solo si existe columna
    const hasStatus = colsC.has("status");
    if (hasStatus) {
      status = ["active", "bid", "inactive"].includes(status) ? status : "active";
    }

    await client.query("BEGIN");

    // armamos INSERT dinámico
    const cols = ["nombre", "contacto_nombre", "email", "telefono", "direccion", "observacion", "usuario_email", "organizacion_id"];
    const vals = [String(nombre).trim(), T(contacto_nombre), T(email), T(telefono), T(direccion), T(observacion), usuario_email, organizacion_id];

    if (hasStatus) {
      cols.splice(6, 0, "status"); // antes de usuario_email
      vals.splice(6, 0, status);
    }

    const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");
    const rCli = await client.query(
      `INSERT INTO clientes (${cols.join(",")}) VALUES (${placeholders}) RETURNING *`,
      vals
    );
    const cli = rCli.rows[0];

    // contacto principal si hay tabla y datos
    if (contactosOk && (T(contacto_nombre) || T(email) || T(telefono))) {
      await client.query(
        `INSERT INTO contactos
          (cliente_id, nombre, email, telefono, es_principal, usuario_email, organizacion_id, created_at, updated_at)
         VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW(),NOW())`,
        [cli.id, T(contacto_nombre), T(email), T(telefono), usuario_email, organizacion_id]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(cli);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /clientes]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando cliente" });
  } finally {
    client.release();
  }
});

/* ============== PATCH /clientes/:id ============== */
router.patch("/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { email: usuario_email, organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const colsC = await tableColumns("clientes");
    const contactosOk = await regclassExists("contactos");

    const allowedBase = ["nombre", "contacto_nombre", "email", "telefono", "direccion", "observacion"];
    const allowed = colsC.has("status") ? [...allowedBase, "status"] : allowedBase;

    const fields = [];
    const values = [];
    let i = 1;

    for (const k of allowed) {
      if (k in (req.body || {})) {
        if (k === "status") {
          const val = ["active", "bid", "inactive"].includes(req.body.status)
            ? req.body.status
            : "active";
          fields.push(`status=$${i++}`);
          values.push(val);
        } else {
          fields.push(`${k}=$${i++}`);
          values.push(T(req.body[k]));
        }
      }
    }

    const wantsContactUpdate = ["contacto_nombre", "email", "telefono"].some(
      (k) => k in (req.body || {})
    );

    if (!fields.length && !wantsContactUpdate) {
      return res.status(400).json({ message: "Nada para actualizar" });
    }

    await client.query("BEGIN");

    // 1) Update cliente (scoped por org)
    if (fields.length) {
      // updated_at solo si existe
      const setUpdated = colsC.has("updated_at") ? ", updated_at = NOW()" : "";
      values.push(organizacion_id, id);
      const r = await client.query(
        `UPDATE clientes SET ${fields.join(", ")}${setUpdated} WHERE organizacion_id = $${i} AND id=$${i + 1} RETURNING *`,
        values
      );
      if (!r.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Cliente no encontrado" });
      }
    }

    // 2) Upsert del contacto principal si llegó data y existe tabla (scoped por org)
    if (contactosOk && wantsContactUpdate) {
      // aseguramos que el cliente pertenezca a la org
      const belongs = await assertClienteBelongs(organizacion_id, id);
      if (!belongs) {
        await client.query("ROLLBACK");
        return res.status(403).json({ message: "No autorizado" });
      }

      const rPC = await client.query(
        `SELECT id FROM contactos WHERE cliente_id = $1 AND COALESCE(es_principal, false) = TRUE ORDER BY id ASC LIMIT 1`,
        [id]
      );
      const nuevoNombre = T(req.body?.contacto_nombre);
      const nuevoEmail = T(req.body?.email);
      const nuevoTel = T(req.body?.telefono);

      if (rPC.rowCount) {
        const setC = [];
        const valC = [];
        let j = 1;
        if ("contacto_nombre" in (req.body || {})) {
          setC.push(`nombre=$${j++}`); valC.push(nuevoNombre);
        }
        if ("email" in (req.body || {})) {
          setC.push(`email=$${j++}`); valC.push(nuevoEmail);
        }
        if ("telefono" in (req.body || {})) {
          setC.push(`telefono=$${j++}`); valC.push(nuevoTel);
        }
        if (setC.length) {
          valC.push(rPC.rows[0].id, organizacion_id);
          await client.query(
            `UPDATE contactos SET ${setC.join(", ")}, updated_at=NOW()
             WHERE id=$${j} AND organizacion_id = $${j + 1}`,
            valC
          );
        }
      } else if (nuevoNombre || nuevoEmail || nuevoTel) {
        await client.query(
          `INSERT INTO contactos
            (cliente_id, nombre, email, telefono, es_principal, usuario_email, organizacion_id, created_at, updated_at)
           VALUES ($1,$2,$3,$4,TRUE,$5,$6,NOW(),NOW())`,
          [id, nuevoNombre, nuevoEmail, nuevoTel, usuario_email, organizacion_id]
        );
      }
    }

    await client.query("COMMIT");

    const rBack = await q(`SELECT * FROM clientes WHERE id=$1 AND organizacion_id=$2`, [id, organizacion_id]);
    res.json(rBack.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando cliente" });
  } finally {
    client.release();
  }
});

/* ============== POST /clientes/:id/convertir-a-activo ============== */
router.post("/:id/convertir-a-activo", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const colsC = await tableColumns("clientes");
    if (colsC.has("status")) {
      const r = await q(`UPDATE clientes SET status='active', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    const stageCol = pickOne(colsC, ["stage", "estado", "etapa"]);
    if (stageCol) {
      const r = await q(`UPDATE clientes SET ${stageCol}='Active', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    return res.status(501).json({ message: "Estado no soportado en este esquema" });
  } catch (e) {
    console.error("[POST /clientes/:id/convertir-a-activo]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al convertir" });
  }
});

/* ============== POST /clientes/:id/marcar-como-bid ============== */
router.post("/:id/marcar-como-bid", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const colsC = await tableColumns("clientes");
    if (colsC.has("status")) {
      const r = await q(`UPDATE clientes SET status='bid', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    const stageCol = pickOne(colsC, ["stage", "estado", "etapa"]);
    if (stageCol) {
      const r = await q(`UPDATE clientes SET ${stageCol}='Bid/Estimate', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    return res.status(501).json({ message: "Estado no soportado en este esquema" });
  } catch (e) {
    console.error("[POST /clientes/:id/marcar-como-bid]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al marcar como BID" });
  }
});

/* ============== POST /clientes/:id/marcar-inactivo ============== */
router.post("/:id/marcar-inactivo", authenticateToken, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const colsC = await tableColumns("clientes");
    if (colsC.has("status")) {
      const r = await q(`UPDATE clientes SET status='inactive', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    const stageCol = pickOne(colsC, ["stage", "estado", "etapa"]);
    if (stageCol) {
      const r = await q(`UPDATE clientes SET ${stageCol}='Inactive', updated_at=NOW() WHERE id=$1 AND organizacion_id=$2 RETURNING *`, [id, organizacion_id]);
      if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
      return res.json(r.rows[0]);
    }
    return res.status(501).json({ message: "Estado no soportado en este esquema" });
  } catch (e) {
    console.error("[POST /clientes/:id/marcar-inactivo]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error al marcar como inactivo" });
  }
});

/* ============== DELETE /clientes/:id ============== */
router.delete("/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const proyectosOk = await regclassExists("proyectos");
    const tareasOk = await regclassExists("tareas");
    const contactosOk = await regclassExists("contactos");

    // Bloquea si tiene proyectos/tareas asociados (scoped por org)
    if (proyectosOk) {
      const rProj = await client.query(
        `SELECT 1 FROM proyectos WHERE cliente_id = $1 AND organizacion_id = $2 LIMIT 1`,
        [id, organizacion_id]
      );
      if (rProj.rowCount) {
        return res.status(409).json({ message: "No se puede borrar: tiene proyectos asociados" });
      }
    }
    if (tareasOk) {
      const rTar = await client.query(
        `SELECT 1 FROM tareas WHERE cliente_id = $1 AND organizacion_id = $2 LIMIT 1`,
        [id, organizacion_id]
      );
      if (rTar.rowCount) {
        return res.status(409).json({ message: "No se puede borrar: tiene tareas asociadas" });
      }
    }

    await client.query("BEGIN");
    if (contactosOk) {
      await client.query(
        `DELETE FROM contactos WHERE cliente_id = $1 AND organizacion_id = $2`,
        [id, organizacion_id]
      );
    }
    const r = await client.query(
      `DELETE FROM clientes WHERE id = $1 AND organizacion_id = $2`,
      [id, organizacion_id]
    );
    await client.query("COMMIT");

    if (!r.rowCount) return res.status(404).json({ message: "Cliente no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[DELETE /clientes/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando cliente" });
  } finally {
    client.release();
  }
});

/* ===================== CONTACTOS ===================== */

// Guardas por si el esquema no tiene la tabla
async function ensureContactTable(res) {
  const ok = await regclassExists("contactos");
  if (!ok) {
    res.status(501).json({ message: "Módulo de contactos no habilitado en este esquema" });
  }
  return ok;
}

/**
 * GET /clientes/:id/contactos
 * Lista contactos de un cliente (scoped por org)
 */
router.get("/:id/contactos", authenticateToken, async (req, res) => {
  try {
    if (!(await ensureContactTable(res))) return;
    const cliente_id = Number(req.params.id);
    if (!Number.isInteger(cliente_id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    // verifica pertenencia del cliente
    const belongs = await assertClienteBelongs(organizacion_id, cliente_id);
    if (!belongs) return res.status(403).json({ message: "No autorizado" });

    const r = await q(
      `SELECT id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
              usuario_email, organizacion_id, created_at, updated_at
         FROM contactos
        WHERE cliente_id = $1 AND organizacion_id = $2
        ORDER BY es_principal DESC, id DESC`,
      [cliente_id, organizacion_id]
    );
    res.json(r.rows || []);
  } catch (e) {
    console.error("[GET /clientes/:id/contactos]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error listando contactos" });
  }
});

/**
 * POST /clientes/:id/contactos
 * Crea un contacto (opcional marcar como principal)
 */
router.post("/:id/contactos", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await ensureContactTable(res))) return;
    const cliente_id = Number(req.params.id);
    if (!Number.isInteger(cliente_id)) return res.status(400).json({ message: "ID inválido" });
    const { email: usuario_email, organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    // asegurar pertenencia del cliente
    const belongs = await assertClienteBelongs(organizacion_id, cliente_id);
    if (!belongs) return res.status(403).json({ message: "No autorizado" });

    const { nombre, email, telefono, cargo, rol, notas, es_principal = false } = req.body || {};
    if (!T(nombre) && !T(email) && !T(telefono)) {
      return res.status(400).json({ message: "Nombre, email o teléfono requerido" });
    }

    await client.query("BEGIN");

    let makePrimary = !!es_principal;

    if (makePrimary) {
      await client.query(
        `UPDATE contactos SET es_principal = FALSE, updated_at = NOW()
          WHERE cliente_id = $1 AND organizacion_id = $2 AND COALESCE(es_principal, false) = TRUE`,
        [cliente_id, organizacion_id]
      );
    }

    // Si no hay principal, este será principal aunque no lo pidan
    if (!makePrimary) {
      const rP = await client.query(
        `SELECT 1 FROM contactos WHERE cliente_id = $1 AND organizacion_id = $2 AND COALESCE(es_principal, false) = TRUE LIMIT 1`,
        [cliente_id, organizacion_id]
      );
      if (!rP.rowCount) makePrimary = true;
    }

    const r = await client.query(
      `INSERT INTO contactos
        (cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
         usuario_email, organizacion_id, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
       RETURNING id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
                 usuario_email, organizacion_id, created_at, updated_at`,
      [cliente_id, T(nombre), T(email), T(telefono), T(cargo), T(rol), T(notas), makePrimary, usuario_email, organizacion_id]
    );

    await client.query("COMMIT");
    res.status(201).json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /clientes/:id/contactos]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error creando contacto" });
  } finally {
    client.release();
  }
});

/**
 * PATCH /contactos/:id
 * Actualiza contacto (si es_principal=true, desmarca anteriores) con scope por org
 */
router.patch("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await ensureContactTable(res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const rCli = await client.query(
      `SELECT c.cliente_id
         FROM contactos c
         JOIN clientes cl ON cl.id = c.cliente_id
        WHERE c.id = $1 AND cl.organizacion_id = $2`,
      [id, organizacion_id]
    );
    const cliente_id = rCli.rows?.[0]?.cliente_id;
    if (!cliente_id) return res.status(404).json({ message: "Contacto no encontrado" });

    const upd = {
      nombre: "nombre",
      email: "email",
      telefono: "telefono",
      cargo: "cargo",
      rol: "rol",
      notas: "notas",
      es_principal: "es_principal",
    };
    const sets = [];
    const vals = [];
    let i = 1;
    for (const k of Object.keys(upd)) {
      if (k in (req.body || {})) {
        if (k === "es_principal") {
          sets.push(`es_principal = $${i++}`);
          vals.push(!!req.body.es_principal);
        } else {
          sets.push(`${upd[k]} = $${i++}`);
          vals.push(T(req.body[k]));
        }
      }
    }
    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    await client.query("BEGIN");

    if ("es_principal" in (req.body || {}) && !!req.body.es_principal) {
      await client.query(
        `UPDATE contactos SET es_principal = FALSE, updated_at = NOW()
         WHERE cliente_id = $1 AND id <> $2 AND organizacion_id = $3`,
        [cliente_id, id, organizacion_id]
      );
    }

    vals.push(id, organizacion_id);
    const r = await client.query(
      `UPDATE contactos SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${i} AND organizacion_id = $${i + 1}
       RETURNING id, cliente_id, nombre, email, telefono, cargo, rol, notas, es_principal,
                 usuario_email, organizacion_id, created_at, updated_at`,
      vals
    );

    await client.query("COMMIT");
    if (!r.rowCount) return res.status(404).json({ message: "Contacto no encontrado" });
    res.json(r.rows[0]);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /contactos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error actualizando contacto" });
  } finally {
    client.release();
  }
});

/**
 * DELETE /contactos/:id (scoped por org)
 */
router.delete("/contactos/:id", authenticateToken, async (req, res) => {
  try {
    if (!(await ensureContactTable(res))) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ message: "ID inválido" });
    const { organizacion_id } = getUserFromReq(req);
    if (!organizacion_id) return res.status(400).json({ message: "organizacion_id requerido" });

    const r = await q(
      `DELETE FROM contactos WHERE id = $1 AND organizacion_id = $2`,
      [id, organizacion_id]
    );
    if (!r.rowCount) return res.status(404).json({ message: "Contacto no encontrado" });
    res.json({ ok: true });
  } catch (e) {
    console.error("[DELETE /contactos/:id]", e?.stack || e?.message || e);
    res.status(500).json({ message: "Error eliminando contacto" });
  }
});

export default router;
