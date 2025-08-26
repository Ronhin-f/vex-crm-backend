// Backend/routes/dashboard.js
import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken } from "../middleware/auth.js";

const router = Router();

router.get("/", authenticateToken, async (req, res) => {
  try {
    const org = req.organizacion_id;

    const [{ rows: c }, { rows: t }, { rows: seg }] = await Promise.all([
      db.query("SELECT COUNT(*)::int AS total_clientes FROM clientes WHERE organizacion_id = $1", [org]),
      db.query("SELECT COUNT(*)::int AS total_tareas FROM tareas WHERE organizacion_id = $1", [org]),
      db.query(
        `SELECT COUNT(*)::int AS proximos_7d
           FROM tareas
          WHERE organizacion_id = $1
            AND completada = FALSE
            AND vence_en IS NOT NULL
            AND vence_en <= NOW() + INTERVAL '7 days'`,
        [org]
      ),
    ]);

    const { rows: topClientes } = await db.query(
      `SELECT id, nombre, email, telefono, created_at
         FROM clientes
        WHERE organizacion_id = $1
        ORDER BY created_at DESC
        LIMIT 5`,
      [org]
    );

    const { rows: proximosSeguimientos } = await db.query(
      `SELECT t.id, t.titulo, t.vence_en, c.id AS cliente_id, c.nombre AS cliente_nombre
         FROM tareas t
         LEFT JOIN clientes c ON c.id = t.cliente_id
        WHERE t.organizacion_id = $1
          AND t.completada = FALSE
          AND t.vence_en IS NOT NULL
          AND t.vence_en <= NOW() + INTERVAL '7 days'
        ORDER BY t.vence_en ASC
        LIMIT 20`,
      [org]
    );

    res.json({
      metrics: {
        total_clientes: c[0]?.total_clientes ?? 0,
        total_tareas: t[0]?.total_tareas ?? 0,
        proximos_7d: seg[0]?.proximos_7d ?? 0,
      },
      topClientes,
      proximosSeguimientos,
    });
  } catch (e) {
    console.error("[GET /dashboard]", e);
    res.status(500).json({ message: "Error al obtener dashboard" });
  }
});

export default router;
