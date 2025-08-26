import { Router } from "express";
import { db } from "../utils/db.js";
import { authenticateToken, requireRole } from "../middleware/auth.js";

const router = Router();

router.get("/", authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      `SELECT slack_webhook_url FROM integraciones WHERE organizacion_id = $1`,
      [req.organizacion_id]
    );
    res.json(rows[0] || {});
  } catch (e) {
    console.error("[GET /integraciones]", e);
    res.status(500).json({ message: "Error al obtener integraciones" });
  }
});

router.put("/slack", authenticateToken, requireRole(["owner","admin","superadmin"]), async (req, res) => {
  const { slack_webhook_url } = req.body;
  if (!slack_webhook_url?.startsWith("https://hooks.slack.com/"))
    return res.status(400).json({ message: "Slack webhook inválido" });

  try {
    await db.query(
      `INSERT INTO integraciones (organizacion_id, slack_webhook_url)
       VALUES ($1,$2)
       ON CONFLICT (organizacion_id) DO UPDATE SET slack_webhook_url = EXCLUDED.slack_webhook_url, updated_at = NOW()`,
      [req.organizacion_id, slack_webhook_url]
    );
    res.sendStatus(200);
  } catch (e) {
    console.error("[PUT /integraciones/slack]", e);
    res.status(500).json({ message: "Error al guardar Slack" });
  }
});

export default router;
