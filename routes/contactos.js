// routes/contactos.js â€” Contactos por cliente (blindado + multi-tenant, TEXT-safe)
import { Router } from "express";
import { q, pool } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/* -------------------------- helpers inline -------------------------- */
const T = (v) => (v == null ? null : String(v).trim() || null);

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
    return new Set((r.rows || []).map((x) => x.column_name));
  } catch {
    return new Set();
  }
}

function bool(v) {
  return v === true || v === "true" || v === 1 || v === "1";
}

function yesNo(v) {
  return v === true || v === "true" || v === "si" || v === 1 || v === "1";
}

function cleanPreguntas(val) {
  if (val == null) return {};
  let obj = {};
  if (typeof val === "string") {
    try { obj = JSON.parse(val); }
    catch { return {}; }
  } else if (typeof val === "object") {
    obj = val;
  } else {
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null) continue;
    out[k] = yesNo(v) ? "si" : "no";
  }
  return out;
}

async function hasInfra() {
  const hasCt = await hasTable("contactos");
  const hasCl = await hasTable("clientes");
  return hasCt && hasCl;
}

/* ============================ GET ============================ */
/** Lista los contactos de un cliente (valida organizaciÃ³n) */
router.get("/clientes/:clienteId/contactos", authenticateToken, async (req, res) => {
  try {
    if (!(await hasInfra())) return res.json([]);

    const orgId = getOrgText(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const clienteId = Number(req.params.clienteId);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ ok: false, error: "clienteId invÃ¡lido" });
    }

    // Cliente debe pertenecer a tu organizaciÃ³n (si la columna existe)
    const cCols = await tableColumns("clientes");
    const ownParams = [clienteId];
    let ownSQL = `SELECT 1 FROM clientes WHERE id=$1`;
    if (cCols.has("organizacion_id")) {
      ownParams.push(orgId);
      ownSQL += ` AND organizacion_id::text = $2::text`;
    }
    const own = await q(ownSQL, ownParams);
    if (!own.rowCount) {
      return res.status(404).json({ ok: false, error: "cliente no encontrado" });
    }

    // Select blindado de contactos
    const ctCols = await tableColumns("contactos");
    const S = (col, type = "text") => {
      if (ctCols.has(col)) return `ct.${col}`;
      if (type === "int") return `NULL::int`;
      if (type === "timestamptz") return `NULL::timestamptz`;
      if (type === "bool") return `FALSE`;
       if (type === "jsonb") return `'{}'::jsonb`;
      return `NULL::text`;
    };

    const rows = await q(
      `
      SELECT
        ${S("id","int")}              AS id,
        ${S("cliente_id","int")}      AS cliente_id,
        ${S("nombre")}                AS nombre,
        ${S("email")}                 AS email,
        ${S("telefono")}              AS telefono,
        ${S("cargo")}                 AS cargo,
        ${S("rol")}                   AS rol,
        ${S("peso")}                  AS peso,
        ${S("vacunas")}               AS vacunas,
        ${S("proxima_vacuna")}        AS proxima_vacuna,
        ${S("es_principal","bool")}   AS es_principal,
        ${S("notas")}                 AS notas,
        ${S("obra_social")}           AS obra_social,
        ${S("plan")}                  AS plan,
        ${S("numero_afiliado")}       AS numero_afiliado,
        ${S("preguntas","jsonb")}     AS preguntas,
        ${S("motivo_consulta")}       AS motivo_consulta,
        ${S("ultima_consulta")}       AS ultima_consulta,
        ${S("cepillados_diarios")}    AS cepillados_diarios,
        ${S("sangrado")}              AS sangrado,
        ${S("momentos_azucar")}       AS momentos_azucar,
        ${S("dolor")}                 AS dolor,
        ${S("golpe")}                 AS golpe,
        ${S("dificultad")}            AS dificultad,
        ${S("usuario_email")}         AS usuario_email,
        ${S("organizacion_id")}       AS organizacion_id,
        ${S("created_at","timestamptz")} AS created_at,
        ${S("updated_at","timestamptz")} AS updated_at
      FROM contactos ct
      WHERE ${ctCols.has("cliente_id") ? "ct.cliente_id" : "NULL"} = $1
      ORDER BY
        ${ctCols.has("es_principal") ? "ct.es_principal DESC," : ""} 
        ${ctCols.has("nombre") ? "ct.nombre ASC NULLS LAST," : ""} 
        ${ctCols.has("id") ? "ct.id ASC" : "1"}
      `,
      [clienteId]
    );

    return res.json(rows.rows || []);
  } catch (e) {
    console.error("[GET /clientes/:id/contactos]", e?.stack || e?.message || e);
    return res.status(200).json([]);
  }
});

/* ============================ POST =========================== */
/** Crea un contacto bajo un cliente (si no hay principal, este pasa a serlo) */
router.post("/clientes/:clienteId/contactos", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ ok: false, error: "MÃ³dulo de contactos no instalado" });

    const orgId = getOrgText(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const clienteId = Number(req.params.clienteId);
    if (!Number.isInteger(clienteId) || clienteId <= 0) {
      return res.status(400).json({ ok: false, error: "clienteId invÃ¡lido" });
    }

    // Verifica que el cliente sea tuyo (si existe la columna)
    const cCols = await tableColumns("clientes");
    const params = [clienteId];
    let ownSQL = `SELECT organizacion_id FROM clientes WHERE id=$1`;
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      ownSQL += ` AND organizacion_id::text = $2::text`;
    }
    const c = await q(ownSQL, params);
    if (!c.rowCount)
      return res.status(404).json({ ok: false, error: "cliente no encontrado" });

    const organizacion_id = c.rows[0].organizacion_id ?? orgId ?? null;
    const usuario_email =
      req.usuario?.email ?? req.usuario?.usuario_email ?? req.usuario_email ?? null;

    const body = req.body || {};
    let {
      nombre,
      email,
      telefono,
      cargo,
      rol,
      peso,
      vacunas,
      proxima_vacuna,
      es_principal = false,
      notas,
      obra_social,
      plan,
      numero_afiliado,
      preguntas,
      motivo_consulta,
      ultima_consulta,
      cepillados_diarios,
      sangrado,
      momentos_azucar,
      dolor,
      golpe,
      dificultad,
    } = body;
    if (!T(nombre) && !T(email) && !T(telefono)) {
      return res.status(400).json({ ok: false, error: "nombre, email o telÃ©fono requerido" });
    }

    const ctCols = await tableColumns("contactos");
    const preguntasClean = cleanPreguntas(preguntas);
    await client.query("BEGIN");

    // Â¿Existe algÃºn principal? (solo si la columna existe)
    let makePrimary = false;
    if (ctCols.has("es_principal")) {
      const hasPrincipal = await client.query(
        `SELECT 1 FROM contactos WHERE cliente_id=$1 AND es_principal=TRUE LIMIT 1`,
        [clienteId]
      );
      makePrimary = hasPrincipal.rowCount ? bool(es_principal) : true;
    }

    // Inserta dinÃ¡micamente
    const fields = [];
    const vals = [];
    const add = (col, val) => { if (ctCols.has(col)) { fields.push(col); vals.push(val); } };

    add("cliente_id", clienteId);
    add("nombre", T(nombre));
    add("email", T(email));
    add("telefono", T(telefono));
    add("cargo", T(cargo));
    add("rol", T(rol));
    add("peso", T(peso));
    add("vacunas", T(vacunas));
    add("proxima_vacuna", T(proxima_vacuna));
    if (ctCols.has("es_principal")) add("es_principal", makePrimary);
    add("notas", T(notas));
    add("obra_social", T(obra_social));
    add("plan", T(plan));
    add("numero_afiliado", T(numero_afiliado));
    add("preguntas", preguntasClean);
    add("motivo_consulta", T(motivo_consulta));
    add("ultima_consulta", T(ultima_consulta));
    add("cepillados_diarios", T(cepillados_diarios));
    add("sangrado", T(sangrado));
    add("momentos_azucar", T(momentos_azucar));
    add("dolor", T(dolor));
    add("golpe", T(golpe));
    add("dificultad", T(dificultad));
    add("usuario_email", usuario_email);
    add("organizacion_id", organizacion_id);
    if (ctCols.has("created_at")) add("created_at", new Date());
    if (ctCols.has("updated_at")) add("updated_at", new Date());

    if (!fields.length) {
      await client.query("ROLLBACK");
      return res.status(501).json({ ok: false, error: "Schema invÃ¡lido en contactos" });
    }

    const placeholders = fields.map((_, i) => `$${i + 1}`);
    const ins = await client.query(
      `INSERT INTO contactos (${fields.join(",")}) VALUES (${placeholders.join(",")}) RETURNING *`,
      vals
    );
    const contacto = ins.rows[0];

    // Si marcamos como principal, apagar los demÃ¡s (misma TX)
    if (ctCols.has("es_principal") && contacto?.es_principal) {
      await client.query(
        `UPDATE contactos
            SET es_principal=FALSE${ctCols.has("updated_at") ? ", updated_at=NOW()" : ""}
          WHERE cliente_id=$1 AND id<>$2`,
        [clienteId, contacto.id]
      );
    }

    await client.query("COMMIT");
    return res.status(201).json(contacto);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[POST /clientes/:id/contactos]", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "Error creando contacto" });
  } finally {
    client.release();
  }
});

/* ============================ PATCH ========================== */
/** Edita un contacto (si es_principal=true, apaga al resto) */
router.patch("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ ok: false, error: "MÃ³dulo de contactos no instalado" });

    const orgId = getOrgText(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "id invÃ¡lido" });

    const cCols = await tableColumns("clientes");
    const ctCols = await tableColumns("contactos");

    // Verifica pertenencia por organizaciÃ³n (si existe la columna)
    const params = [id];
    let curSQL = `SELECT ct.id, ct.cliente_id
                    FROM contactos ct
                    JOIN clientes c ON c.id = ct.cliente_id
                   WHERE ct.id=$1`;
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      curSQL += ` AND c.organizacion_id::text = $2::text`;
    }
    const cur = await q(curSQL, params);
    if (!cur.rowCount)
      return res.status(404).json({ ok: false, error: "no encontrado" });

    const cliente_id = cur.rows[0].cliente_id;

    const allowed = [
      "nombre",
      "email",
      "telefono",
      "cargo",
      "rol",
      "peso",
      "vacunas",
      "proxima_vacuna",
      "es_principal",
      "notas",
      "obra_social",
      "plan",
      "numero_afiliado",
      "preguntas",
      "motivo_consulta",
      "ultima_consulta",
      "cepillados_diarios",
      "sangrado",
      "momentos_azucar",
      "dolor",
      "golpe",
      "dificultad",
    ];
    const sets = [];
    const vals = [];
    for (const k of allowed) {
      if (!(k in (req.body || {}))) continue;
      if (!ctCols.has(k)) continue;
      if (k === "es_principal") {
        sets.push(`es_principal = $${vals.length + 1}`);
        vals.push(bool(req.body[k]));
      } else if (k === "preguntas") {
        sets.push(`preguntas = $${vals.length + 1}`);
        vals.push(cleanPreguntas(req.body[k]));
      } else {
        sets.push(`${k} = $${vals.length + 1}`);
        vals.push(T(req.body[k]));
      }
    }
    if (ctCols.has("updated_at")) sets.push(`updated_at = NOW()`);
    if (!sets.length)
      return res.status(400).json({ ok: false, error: "nada para actualizar" });

    await client.query("BEGIN");

    vals.push(id);
    const r = await client.query(
      `UPDATE contactos SET ${sets.join(", ")} WHERE id=$${vals.length} RETURNING *`,
      vals
    );
    if (!r.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ ok: false, error: "no encontrado" });
    }
    const contacto = r.rows[0];

    if (ctCols.has("es_principal") && contacto.es_principal) {
      await client.query(
        `UPDATE contactos
            SET es_principal=FALSE${ctCols.has("updated_at") ? ", updated_at=NOW()" : ""}
          WHERE cliente_id=$1 AND id<>$2`,
        [cliente_id, contacto.id]
      );
    }

    await client.query("COMMIT");
    return res.json(contacto);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[PATCH /contactos/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "Error actualizando contacto" });
  } finally {
    client.release();
  }
});

/* =========================== DELETE ========================== */
/** Borra contacto. Si era principal y hay otros, promueve uno (estable) */
router.delete("/contactos/:id", authenticateToken, async (req, res) => {
  const client = await pool.connect();
  try {
    if (!(await hasInfra()))
      return res.status(501).json({ ok: false, error: "MÃ³dulo de contactos no instalado" });

    const orgId = getOrgText(req);
    if (!orgId) return res.status(400).json({ ok: false, error: "organizacion_id requerido" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0)
      return res.status(400).json({ ok: false, error: "id invÃ¡lido" });

    const cCols = await tableColumns("clientes");
    const ctCols = await tableColumns("contactos");

    // Traer contacto y validar org (si existe la columna)
    const params = [id];
    let curSQL = `SELECT ct.id, ct.cliente_id, ${ctCols.has("es_principal") ? "ct.es_principal" : "FALSE AS es_principal"}
                    FROM contactos ct
                    JOIN clientes c ON c.id = ct.cliente_id
                   WHERE ct.id=$1`;
    if (cCols.has("organizacion_id")) {
      params.push(orgId);
      curSQL += ` AND c.organizacion_id::text = $2::text`;
    }
    const cur = await q(curSQL, params);
    if (!cur.rowCount)
      return res.status(404).json({ ok: false, error: "no encontrado" });

    const { cliente_id, es_principal } = cur.rows[0];

    await client.query("BEGIN");

    await client.query(`DELETE FROM contactos WHERE id=$1`, [id]);

    if (ctCols.has("es_principal") && es_principal) {
      // Promueve un contacto estable (por nombre, luego id)
      const nxt = await client.query(
        `SELECT id
           FROM contactos
          WHERE cliente_id=$1
          ORDER BY ${ctCols.has("nombre") ? "nombre ASC NULLS LAST," : ""} id ASC
          LIMIT 1`,
        [cliente_id]
      );
      if (nxt.rowCount) {
        await client.query(
          `UPDATE contactos SET es_principal=TRUE${ctCols.has("updated_at") ? ", updated_at=NOW()" : ""} WHERE id=$1`,
          [nxt.rows[0].id]
        );
        await client.query(
          `UPDATE contactos SET es_principal=FALSE${ctCols.has("updated_at") ? ", updated_at=NOW()" : ""} WHERE cliente_id=$1 AND id<>$2`,
          [cliente_id, nxt.rows[0].id]
        );
      }
    }

    await client.query("COMMIT");
    return res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("[DELETE /contactos/:id]", e?.stack || e?.message || e);
    return res.status(500).json({ ok: false, error: "Error eliminando contacto" });
  } finally {
    client.release();
  }
});

export default router;

