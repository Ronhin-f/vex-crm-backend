// routes/contactos.js
import { Router } from "express";
import { q } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

/** Lista los contactos de un cliente */
router.get("/clientes/:clienteId/contactos", authenticateToken, async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  if (!clienteId) return res.status(400).json({ ok: false, error: "clienteId inválido" });

  const r = await q(
    `SELECT id, cliente_id, nombre, email, telefono, cargo, rol, es_principal, notas,
            usuario_email, organizacion_id, created_at, updated_at
       FROM contactos
      WHERE cliente_id=$1
      ORDER BY es_principal DESC, nombre ASC`,
    [clienteId]
  );
  res.json({ ok: true, items: r.rows });
});

/** Crea un contacto bajo un cliente (si no hay principal, este pasa a serlo) */
router.post("/clientes/:clienteId/contactos", authenticateToken, async (req, res) => {
  const clienteId = Number(req.params.clienteId);
  if (!clienteId) return res.status(400).json({ ok: false, error: "clienteId inválido" });
  const { nombre, email, telefono, cargo, rol, es_principal = false, notas } = req.body || {};
  if (!nombre || !String(nombre).trim()) return res.status(400).json({ ok: false, error: "nombre requerido" });

  // Traer org del cliente
  const c = await q(`SELECT organizacion_id FROM clientes WHERE id=$1`, [clienteId]);
  if (!c.rowCount) return res.status(404).json({ ok: false, error: "cliente no encontrado" });
  const organizacion_id = c.rows[0].organizacion_id || null;
  const usuario_email = (req.usuario && (req.usuario.email || req.usuario.usuario_email)) || null;

  // ¿Existe algún principal?
  const hasPrincipal = await q(`SELECT 1 FROM contactos WHERE cliente_id=$1 AND es_principal=TRUE LIMIT 1`, [clienteId]);

  // Insert
  const ins = await q(
    `INSERT INTO contactos (cliente_id, nombre, email, telefono, cargo, rol, es_principal, notas, usuario_email, organizacion_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING *`,
    [clienteId, nombre?.trim(), email?.trim() || null, telefono?.trim() || null, cargo || null, rol || null,
     hasPrincipal.rowCount ? !!es_principal : true, notas || null, usuario_email, organizacion_id]
  );
  const contacto = ins.rows[0];

  // Si marcamos principal, apagar los demás
  if (contacto.es_principal) {
    await q(`UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`, [clienteId, contacto.id]);
  }

  res.status(201).json({ ok: true, item: contacto });
});

/** Edita un contacto (si es_principal=true, apaga al resto) */
router.patch("/contactos/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "id inválido" });

  const allowed = ["nombre","email","telefono","cargo","rol","es_principal","notas"];
  const sets = [];
  const vals = [];
  let i = 1;
  for (const k of allowed) {
    if (k in (req.body || {})) {
      sets.push(`${k} = $${i++}`);
      vals.push(req.body[k] ?? null);
    }
  }
  if (!sets.length) return res.status(400).json({ ok: false, error: "nada para actualizar" });

  sets.push(`updated_at = NOW()`);
  vals.push(id);

  const r = await q(`UPDATE contactos SET ${sets.join(", ")} WHERE id=$${i} RETURNING *`, vals);
  if (!r.rowCount) return res.status(404).json({ ok: false, error: "no encontrado" });

  const contacto = r.rows[0];
  if (contacto.es_principal) {
    await q(`UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`, [contacto.cliente_id, contacto.id]);
  }
  res.json({ ok: true, item: contacto });
});

/** Borra contacto. Si era principal y hay otros, promueve el primero por nombre */
router.delete("/contactos/:id", authenticateToken, async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ ok: false, error: "id inválido" });

  const cur = await q(`SELECT cliente_id, es_principal FROM contactos WHERE id=$1`, [id]);
  if (!cur.rowCount) return res.status(404).json({ ok: false, error: "no encontrado" });
  const { cliente_id, es_principal } = cur.rows[0];

  await q(`DELETE FROM contactos WHERE id=$1`, [id]);

  if (es_principal) {
    const nxt = await q(
      `SELECT id FROM contactos WHERE cliente_id=$1 ORDER BY nombre ASC LIMIT 1`,
      [cliente_id]
    );
    if (nxt.rowCount) {
      await q(`UPDATE contactos SET es_principal=TRUE WHERE id=$1`, [nxt.rows[0].id]);
      await q(`UPDATE contactos SET es_principal=FALSE WHERE cliente_id=$1 AND id<>$2`, [cliente_id, nxt.rows[0].id]);
    }
  }
  res.json({ ok: true });
});

export default router;
