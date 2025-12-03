// routes/area.js — perfil/vertical por organizacion
import { Router } from "express";
import { authenticateToken, requireRole } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q } from "../utils/db.js";
import { ALLOWED_AREAS, resolveProfile, sanitizeProfilePayload } from "../utils/area.profiles.js";

const router = Router();

const cleanArea = (a) => {
  if (!a) return null;
  const v = String(a).trim().toLowerCase();
  return ALLOWED_AREAS.includes(v) ? v : null;
};

async function fetchProfile(orgId) {
  const { rows } = await q(
    `SELECT area, vocab, features, forms, updated_at
       FROM org_profiles
      WHERE organizacion_id = $1
      LIMIT 1`,
    [orgId]
  );
  return resolveProfile(rows[0] || {});
}

router.get("/perfil", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const profile = await fetchProfile(orgId);
    res.json({ ...profile, organizacion_id: orgId });
  } catch (e) {
    console.error("[GET /area/perfil]", e?.message || e);
    res.status(500).json({ message: "No se pudo leer el perfil" });
  }
});

router.post("/sync", authenticateToken, async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
  const area = cleanArea(req.body?.area || req.body?.area_vertical);
  if (!area) return res.status(400).json({ message: "area_vertical requerida" });

  const features = {
    clinicalHistory:
      typeof req.body?.features?.clinicalHistory === "boolean"
        ? req.body.features.clinicalHistory
        : undefined,
    labResults:
      typeof req.body?.features?.labResults === "boolean"
        ? req.body.features.labResults
        : undefined,
  };

  const payload = sanitizeProfilePayload({ area, features });

    const { rows } = await q(
      `INSERT INTO org_profiles (organizacion_id, area, vocab, features, forms, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (organizacion_id)
       DO UPDATE SET area=$2, vocab=$3, features=$4, forms=$5, updated_at=NOW()
       RETURNING area, vocab, features, forms, updated_at`,
      [orgId, payload.area, payload.vocab, payload.features, payload.forms]
    );

    const perfil = resolveProfile(rows[0] || payload);
    res.json({ perfil, organizacion_id: orgId });
  } catch (e) {
    console.error("[POST /area/sync]", e?.message || e);
    res.status(500).json({ message: "No se pudo sincronizar el perfil de area" });
  }
});

router.put("/perfil", authenticateToken, requireRole("admin", "owner"), async (req, res) => {
  try {
    const orgId = getOrgText(req, { require: true });
    const clean = sanitizeProfilePayload(req.body || {});

    const { rows } = await q(
      `INSERT INTO org_profiles (organizacion_id, area, vocab, features, forms, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (organizacion_id)
       DO UPDATE SET area=$2, vocab=$3, features=$4, forms=$5, updated_at=NOW()
       RETURNING area, vocab, features, forms, updated_at`,
      [orgId, clean.area, clean.vocab, clean.features, clean.forms]
    );

    res.json({ ...resolveProfile(rows[0] || {}), organizacion_id: orgId });
  } catch (e) {
    console.error("[PUT /area/perfil]", e?.message || e);
    res.status(500).json({ message: "No se pudo guardar el perfil" });
  }
});

router.get("/presets", authenticateToken, (_req, res) => {
  res.json({ areas: ALLOWED_AREAS });
});

export default router;
