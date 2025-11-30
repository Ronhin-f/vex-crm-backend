// routes/historias.js — historias clinicas / casos
import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q } from "../utils/db.js";
import { resolveProfile } from "../utils/area.profiles.js";

const router = Router();

const T = (v, max = 2000) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.slice(0, max);
};

async function loadProfile(orgId) {
  const { rows } = await q(
    `SELECT area, vocab, features, forms FROM org_profiles WHERE organizacion_id=$1 LIMIT 1`,
    [orgId]
  );
  return resolveProfile(rows[0] || {});
}

async function ensureCliente(orgId, clienteId) {
  const r = await q(
    `SELECT 1 FROM clientes WHERE id = $1 AND organizacion_id = $2 LIMIT 1`,
    [clienteId, orgId]
  );
  return r.rowCount > 0;
}

function sanitizeVitals(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = T(k, 64);
    const val = T(v, 120);
    if (key && val != null) out[key] = val;
  }
  return Object.keys(out).length ? out : null;
}

function sanitizeExtras(raw) {
  if (!raw || typeof raw !== "object") return {};
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    const key = T(k, 64);
    const val = T(v, 400);
    if (key && val != null) out[key] = val;
  }
  return out;
}

router.get("/", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const profile = await loadProfile(orgId);
    if (!profile.features?.clinicalHistory) {
      return res.status(403).json({ message: "Historias clinicas no habilitadas para esta organizacion" });
    }

    const clienteId = req.query?.cliente_id ? Number(req.query.cliente_id) : null;
    const params = [orgId];
    const where = ["organizacion_id = $1"];
    if (Number.isInteger(clienteId)) {
      params.push(clienteId);
      where.push(`cliente_id = $${params.length}`);
    }

    const { rows } = await q(
      `
      SELECT id, cliente_id, tipo, motivo, diagnostico, tratamiento, indicaciones, notas,
             signos_vitales, antecedentes, extras, creado_por, organizacion_id,
             created_at, updated_at
        FROM historias_clinicas
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT 500
      `,
      params
    );
    res.json(rows || []);
  } catch (e) {
    console.error("[GET /historias]", e?.message || e);
    res.status(500).json({ message: "No se pudieron leer las historias clinicas" });
  }
});

router.post("/", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const profile = await loadProfile(orgId);
    if (!profile.features?.clinicalHistory) {
      return res.status(403).json({ message: "Historias clinicas no habilitadas para esta organizacion" });
    }

    const clienteId = Number(req.body?.cliente_id);
    if (!Number.isInteger(clienteId)) {
      return res.status(400).json({ message: "cliente_id invalido" });
    }
    const belongs = await ensureCliente(orgId, clienteId);
    if (!belongs) return res.status(404).json({ message: "Paciente/cliente no encontrado" });

    const payload = {
      tipo: T(req.body?.tipo, 50) || profile.area,
      motivo: T(req.body?.motivo),
      diagnostico: T(req.body?.diagnostico),
      tratamiento: T(req.body?.tratamiento),
      indicaciones: T(req.body?.indicaciones),
      notas: T(req.body?.notas),
      signos_vitales: sanitizeVitals(req.body?.signos_vitales),
      antecedentes: sanitizeExtras(req.body?.antecedentes),
      extras: sanitizeExtras(req.body?.extras),
      creado_por: T(req.usuario?.email || req.usuario_email, 180),
    };

    const { rows } = await q(
      `
      INSERT INTO historias_clinicas
        (id, cliente_id, organizacion_id, tipo, motivo, diagnostico, tratamiento,
         indicaciones, notas, signos_vitales, antecedentes, extras, creado_por)
      VALUES
        (gen_random_uuid(), $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING id, cliente_id, tipo, motivo, diagnostico, tratamiento, indicaciones, notas,
                signos_vitales, antecedentes, extras, creado_por, organizacion_id,
                created_at, updated_at
      `,
      [
        clienteId,
        orgId,
        payload.tipo,
        payload.motivo,
        payload.diagnostico,
        payload.tratamiento,
        payload.indicaciones,
        payload.notas,
        payload.signos_vitales,
        payload.antecedentes,
        payload.extras,
        payload.creado_por,
      ]
    );

    res.status(201).json(rows[0]);
  } catch (e) {
    console.error("[POST /historias]", e?.message || e);
    res.status(500).json({ message: "No se pudo guardar la historia clinica" });
  }
});

router.patch("/:id", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const profile = await loadProfile(orgId);
    if (!profile.features?.clinicalHistory) {
      return res.status(403).json({ message: "Historias clinicas no habilitadas para esta organizacion" });
    }

    const id = req.params.id;
    if (!id) return res.status(400).json({ message: "ID requerido" });

    const sets = [];
    const vals = [];
    let i = 1;

    const fields = ["motivo", "diagnostico", "tratamiento", "indicaciones", "notas"];
    for (const f of fields) {
      if (f in (req.body || {})) {
        sets.push(`${f} = $${i++}`);
        vals.push(T(req.body[f]));
      }
    }
    if ("signos_vitales" in (req.body || {})) {
      sets.push(`signos_vitales = $${i++}`);
      vals.push(sanitizeVitals(req.body.signos_vitales));
    }
    if ("antecedentes" in (req.body || {})) {
      sets.push(`antecedentes = $${i++}`);
      vals.push(sanitizeExtras(req.body.antecedentes));
    }
    if ("extras" in (req.body || {})) {
      sets.push(`extras = $${i++}`);
      vals.push(sanitizeExtras(req.body.extras));
    }

    if (!sets.length) return res.status(400).json({ message: "Nada para actualizar" });

    vals.push(id, orgId);
    const { rows } = await q(
      `
      UPDATE historias_clinicas
         SET ${sets.join(", ")}, updated_at = NOW()
       WHERE id = $${i} AND organizacion_id = $${i + 1}
      RETURNING id, cliente_id, tipo, motivo, diagnostico, tratamiento, indicaciones, notas,
                signos_vitales, antecedentes, extras, creado_por, organizacion_id,
                created_at, updated_at
      `,
      vals
    );
    if (!rows.length) return res.status(404).json({ message: "Historia no encontrada" });
    res.json(rows[0]);
  } catch (e) {
    console.error("[PATCH /historias/:id]", e?.message || e);
    res.status(500).json({ message: "No se pudo actualizar la historia" });
  }
});

export default router;
