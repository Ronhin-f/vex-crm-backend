import { Router } from "express";
import { authenticateToken } from "../middleware/auth.js";
import { getOrgText } from "../utils/org.js";
import { q } from "../utils/db.js";

const router = Router();

function requireOrg(req, res) {
  const org = getOrgText(req, { require: false });
  if (!org) {
    res.status(400).json({ error: "organizacion_id requerido" });
    return null;
  }
  return String(org);
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeArqueoDetalle(raw) {
  if (!raw) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    return Object.entries(raw).map(([denominacion, cantidad]) => ({
      denominacion,
      cantidad,
    }));
  }
  return null;
}

function calcArqueoTotal(detalle) {
  if (!detalle) return null;
  if (!Array.isArray(detalle)) return null;
  let total = 0;
  for (const row of detalle) {
    const denom = toNum(row?.denominacion, NaN);
    const cant = toNum(row?.cantidad, NaN);
    if (Number.isFinite(denom) && Number.isFinite(cant)) {
      total += denom * cant;
    }
  }
  return Number.isFinite(total) ? total : null;
}

async function ensureCajaInfra() {
  const r1 = await q(`SELECT to_regclass('public.cajas') IS NOT NULL AS ok`);
  const r2 = await q(`SELECT to_regclass('public.cobros') IS NOT NULL AS ok`);
  return r1.rows?.[0]?.ok && r2.rows?.[0]?.ok;
}

router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const okInfra = await ensureCajaInfra();
    if (!okInfra) return res.status(501).json({ error: "caja_no_instalado" });

    const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query?.pageSize, 10) || 50, 1), 200);
    const estado = (req.query?.estado || "").toString().trim() || null;
    const almacenId = Number.isFinite(Number(req.query?.almacen_id))
      ? Number(req.query?.almacen_id)
      : null;
    const usuarioEmail = (req.query?.usuario_email || "").toString().trim() || null;
    const desde = (req.query?.desde || "").toString().trim() || null;
    const hasta = (req.query?.hasta || "").toString().trim() || null;

    const where = ["organizacion_id = $1"];
    const params = [org];

    if (estado) {
      params.push(estado);
      where.push(`estado = $${params.length}`);
    }
    if (almacenId) {
      params.push(almacenId);
      where.push(`almacen_id = $${params.length}`);
    }
    if (usuarioEmail) {
      params.push(usuarioEmail);
      where.push(`usuario_email = $${params.length}`);
    }
    if (desde) {
      params.push(desde);
      where.push(`created_at >= $${params.length}`);
    }
    if (hasta) {
      params.push(hasta);
      where.push(`created_at <= $${params.length}`);
    }

    const total = (await q(
      `SELECT COUNT(*)::int AS total FROM cajas WHERE ${where.join(" AND ")}`,
      params
    )).rows?.[0]?.total || 0;

    const list = await q(
      `SELECT * FROM cajas
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    return res.json({ rows: list.rows || [], total, page, pageSize });
  } catch (e) {
    console.error("[GET /caja] error:", e?.message || e);
    return res.status(500).json({ error: "caja_list_error" });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const okInfra = await ensureCajaInfra();
    if (!okInfra) return res.status(501).json({ error: "caja_no_instalado" });

    const id = req.params.id;
    const r = await q(
      `SELECT * FROM cajas WHERE id = $1 AND organizacion_id = $2 LIMIT 1`,
      [id, org]
    );
    if (!r.rowCount) return res.status(404).json({ error: "caja_no_encontrada" });

    const caja = r.rows[0];
    const resumen = await q(
      `SELECT COUNT(*)::int AS count, COALESCE(SUM(total),0) AS total
         FROM cobros
        WHERE caja_id = $1 AND organizacion_id = $2 AND estado = 'confirmado'`,
      [id, org]
    );
    const cobrosTotal = Number(resumen.rows?.[0]?.total ?? 0);
    const cobrosCount = resumen.rows?.[0]?.count ?? 0;
    const apertura = Number(caja.apertura_monto ?? 0);
    const esperado = caja.cierre_total_esperado != null
      ? Number(caja.cierre_total_esperado)
      : apertura + cobrosTotal;
    const diff = caja.cierre_diferencia != null
      ? Number(caja.cierre_diferencia)
      : (caja.cierre_monto != null ? Number(caja.cierre_monto) - esperado : null);

    const cobros = await q(
      `SELECT id, total, medio_pago, estado, created_at, cliente_id
         FROM cobros
        WHERE caja_id = $1 AND organizacion_id = $2
        ORDER BY created_at DESC
        LIMIT 200`,
      [id, org]
    );

    return res.json({
      ...caja,
      cobros_total: cobrosTotal,
      cobros_count: cobrosCount,
      cierre_total_esperado: esperado,
      cierre_diferencia: diff,
      cobros: cobros.rows || [],
    });
  } catch (e) {
    console.error("[GET /caja/:id] error:", e?.message || e);
    return res.status(500).json({ error: "caja_get_error" });
  }
});

router.post("/", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const okInfra = await ensureCajaInfra();
    if (!okInfra) return res.status(501).json({ error: "caja_no_instalado" });

    const body = req.body || {};
    const almacen_id = Number(body.almacen_id ?? body.almacenId ?? body.almacen);
    if (!Number.isFinite(almacen_id)) {
      return res.status(400).json({ error: "almacen_id requerido" });
    }

    const apertura_monto = toNum(body.apertura_monto ?? body.apertura ?? 0, 0);
    const notas = (body.notas ?? body.observacion ?? "").toString().trim() || null;
    const usuario_email = req.usuario?.email || null;

    const abierta = await q(
      `SELECT id FROM cajas WHERE organizacion_id = $1 AND almacen_id = $2 AND estado = 'abierta' LIMIT 1`,
      [org, almacen_id]
    );
    if (abierta.rowCount) {
      return res.status(409).json({ error: "caja_ya_abierta", caja_id: abierta.rows[0].id });
    }

    const r = await q(
      `INSERT INTO cajas
        (id, organizacion_id, almacen_id, usuario_email, estado, apertura_monto, notas)
       VALUES
        (gen_random_uuid(), $1, $2, $3, 'abierta', $4, $5)
       RETURNING *`,
      [org, almacen_id, usuario_email, apertura_monto, notas]
    );

    return res.status(201).json(r.rows[0]);
  } catch (e) {
    console.error("[POST /caja] error:", e?.message || e);
    return res.status(500).json({ error: "caja_create_error" });
  }
});

router.post("/:id/cerrar", authenticateToken, async (req, res) => {
  try {
    const org = requireOrg(req, res);
    if (!org) return;

    const okInfra = await ensureCajaInfra();
    if (!okInfra) return res.status(501).json({ error: "caja_no_instalado" });

    const { id } = req.params;
    const body = req.body || {};
    const cierreRaw = body.cierre_monto ?? body.cierre ?? body.monto_cierre;
    const detalle = normalizeArqueoDetalle(body.arqueo_detalle ?? body.arqueo ?? null);
    const arqueoTotal = calcArqueoTotal(detalle);

    let cierre_monto = toNum(cierreRaw, NaN);
    if (!Number.isFinite(cierre_monto) && Number.isFinite(arqueoTotal)) {
      cierre_monto = arqueoTotal;
    }
    if (!Number.isFinite(cierre_monto)) {
      return res.status(400).json({ error: "cierre_monto requerido" });
    }

    const notas = (body.notas ?? body.observacion ?? "").toString().trim() || null;

    const rCaja = await q(
      `SELECT * FROM cajas WHERE id = $1 AND organizacion_id = $2 LIMIT 1`,
      [id, org]
    );
    if (!rCaja.rowCount) return res.status(404).json({ error: "caja_no_encontrada" });
    const caja = rCaja.rows[0];
    if (String(caja.estado || "").toLowerCase() !== "abierta") {
      return res.status(409).json({ error: "caja_no_abierta" });
    }

    const resumen = await q(
      `SELECT COALESCE(SUM(total),0) AS total
         FROM cobros
        WHERE caja_id = $1 AND organizacion_id = $2 AND estado = 'confirmado'`,
      [id, org]
    );
    const cobrosTotal = Number(resumen.rows?.[0]?.total ?? 0);
    const apertura = Number(caja.apertura_monto ?? 0);
    const esperado = apertura + cobrosTotal;
    const diff = cierre_monto - esperado;

    const r = await q(
      `UPDATE cajas
          SET estado = 'cerrada',
              cierre_monto = $3,
              cierre_total_esperado = $4,
              cierre_diferencia = $5,
              cierre_at = NOW(),
              arqueo_detalle = $6,
              arqueo_total = $7,
              notas = COALESCE($8, notas),
              updated_at = NOW()
        WHERE id = $1 AND organizacion_id = $2
        RETURNING *`,
      [
        id,
        org,
        cierre_monto,
        esperado,
        diff,
        detalle != null ? JSON.stringify(detalle) : JSON.stringify({}),
        Number.isFinite(arqueoTotal) ? arqueoTotal : null,
        notas,
      ]
    );

    return res.json({
      ...r.rows[0],
      cobros_total: cobrosTotal,
      cierre_total_esperado: esperado,
      cierre_diferencia: diff,
    });
  } catch (e) {
    console.error("[POST /caja/:id/cerrar] error:", e?.message || e);
    return res.status(500).json({ error: "caja_close_error" });
  }
});

export default router;
