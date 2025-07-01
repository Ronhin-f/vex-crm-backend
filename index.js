// VEX CRM BACKEND FINAL - LISTO PARA PRODUCCIÓN (RAILWAY)
// CRUD de Clientes, Pedidos (con ítems), y Tareas. Todo multiusuario.

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import pkg from "pg";

dotenv.config();
const { Pool } = pkg;

const app = express();
const PORT = process.env.PORT || 3000;
const SECRET_KEY = process.env.JWT_SECRET || "vex-secreta";
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const ALLOWED_ORIGINS = [
  "https://vex-core-frontend.vercel.app",
  "https://vex-crm-frontend.vercel.app"
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("❌ CORS: Origin no permitido: " + origin));
    }
  },
  credentials: true,
  allowedHeaders: ["Authorization", "Content-Type"]
}));
app.use(express.json());

// --- AUTENTICACIÓN JWT ---
function authenticateToken(req, res, next) {
  const header = req.headers["authorization"];
  if (!header) return res.status(401).json({ message: "Token requerido" });
  const token = header.split(" ")[1];
  if (!token) return res.status(401).json({ message: "Token requerido" });
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.usuario_email = decoded.email;
    req.organizacion_id = decoded.organizacion_id;
    req.rol = decoded.rol;
    next();
  } catch {
    return res.status(403).json({ message: "Token inválido" });
  }
}

// --- CREACIÓN DE TABLAS ---
const initDB = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT,
      rol TEXT,
      organizacion_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      observacion TEXT,
      usuario_email TEXT,
      organizacion_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER,
      observacion TEXT,
      estado TEXT DEFAULT 'pendiente',
      fecha DATE DEFAULT CURRENT_DATE,
      usuario_email TEXT,
      organizacion_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS pedido_items (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER REFERENCES pedidos(id) ON DELETE CASCADE,
      producto TEXT NOT NULL,
      cantidad INTEGER,
      observacion TEXT
    );

    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      completada BOOLEAN DEFAULT false,
      usuario_email TEXT,
      organizacion_id INTEGER
    );
  `);
};
initDB();

// --- CRUD CLIENTES ---
// Listar clientes
app.get("/clientes", authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM clientes WHERE organizacion_id = $1 ORDER BY nombre",
      [req.organizacion_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /clientes]", err);
    res.status(500).json({ message: "Error al obtener clientes" });
  }
});

// Crear cliente
app.post("/clientes", authenticateToken, async (req, res) => {
  const { nombre, telefono, direccion, observacion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ message: "Nombre requerido" });

  try {
    await db.query(
      `INSERT INTO clientes (nombre, telefono, direccion, observacion, usuario_email, organizacion_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [nombre, telefono, direccion, observacion, req.usuario_email, req.organizacion_id]
    );
    res.sendStatus(201);
  } catch (err) {
    console.error("[POST /clientes]", err);
    res.status(500).json({ message: "Error al crear cliente" });
  }
});

// Editar cliente
app.put("/clientes/:id", authenticateToken, async (req, res) => {
  const { nombre, telefono, direccion, observacion } = req.body;
  if (!nombre?.trim()) return res.status(400).json({ message: "Nombre requerido" });

  try {
    await db.query(
      `UPDATE clientes SET nombre = $1, telefono = $2, direccion = $3, observacion = $4
       WHERE id = $5 AND organizacion_id = $6`,
      [nombre, telefono, direccion, observacion, req.params.id, req.organizacion_id]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error("[PUT /clientes/:id]", err);
    res.status(500).json({ message: "Error al editar cliente" });
  }
});

// Eliminar cliente
app.delete("/clientes/:id", authenticateToken, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM clientes WHERE id = $1 AND organizacion_id = $2",
      [req.params.id, req.organizacion_id]
    );
    res.sendStatus(204);
  } catch (err) {
    console.error("[DELETE /clientes/:id]", err);
    res.status(500).json({ message: "Error al eliminar cliente" });
  }
});

// --- CRUD PEDIDOS ---
// Listar pedidos (con items)
app.get("/pedidos", authenticateToken, async (req, res) => {
  try {
    // Trae pedidos y sus items
    const pedidosRes = await db.query(
      "SELECT * FROM pedidos WHERE organizacion_id = $1 ORDER BY fecha DESC",
      [req.organizacion_id]
    );
    const pedidos = pedidosRes.rows;

    // Si no hay pedidos, devolver vacío
    if (pedidos.length === 0) return res.json([]);

    // Obtener los IDs para traer los items
    const pedidoIds = pedidos.map(p => p.id);
    const itemsRes = await db.query(
      `SELECT * FROM pedido_items WHERE pedido_id = ANY($1)`,
      [pedidoIds]
    );
    const itemsPorPedido = {};
    for (const item of itemsRes.rows) {
      if (!itemsPorPedido[item.pedido_id]) itemsPorPedido[item.pedido_id] = [];
      itemsPorPedido[item.pedido_id].push(item);
    }
    // Unir pedidos con sus items
    const pedidosConItems = pedidos.map(p => ({
      ...p,
      items: itemsPorPedido[p.id] || []
    }));

    res.json(pedidosConItems);
  } catch (err) {
    console.error("[GET /pedidos]", err);
    res.status(500).json({ message: "Error al obtener pedidos" });
  }
});

// Crear pedido (con items)
app.post("/pedidos", authenticateToken, async (req, res) => {
  const { cliente_id, observacion, estado, items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: "Debe haber al menos un item" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const pedidoRes = await client.query(
      `INSERT INTO pedidos (cliente_id, observacion, estado, usuario_email, organizacion_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [cliente_id || null, observacion, estado || "pendiente", req.usuario_email, req.organizacion_id]
    );
    const pedido_id = pedidoRes.rows[0].id;
    for (const item of items) {
      await client.query(
        `INSERT INTO pedido_items (pedido_id, producto, cantidad, observacion)
         VALUES ($1, $2, $3, $4)`,
        [pedido_id, item.producto, item.cantidad, item.observacion || ""]
      );
    }
    await client.query("COMMIT");
    res.status(201).json({ pedido_id });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[POST /pedidos]", err);
    res.status(500).json({ message: "Error al crear pedido" });
  } finally {
    client.release();
  }
});

// Editar pedido (cabecera y reemplazo total de items)
app.put("/pedidos/:id", authenticateToken, async (req, res) => {
  const { cliente_id, observacion, estado, items } = req.body;
  if (!Array.isArray(items) || items.length === 0)
    return res.status(400).json({ message: "Debe haber al menos un item" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE pedidos SET cliente_id = $1, observacion = $2, estado = $3
       WHERE id = $4 AND organizacion_id = $5`,
      [cliente_id || null, observacion, estado || "pendiente", req.params.id, req.organizacion_id]
    );
    // Elimina todos los items previos y re-inserta los nuevos (más simple para MVP)
    await client.query("DELETE FROM pedido_items WHERE pedido_id = $1", [req.params.id]);
    for (const item of items) {
      await client.query(
        `INSERT INTO pedido_items (pedido_id, producto, cantidad, observacion)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, item.producto, item.cantidad, item.observacion || ""]
      );
    }
    await client.query("COMMIT");
    res.sendStatus(200);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[PUT /pedidos/:id]", err);
    res.status(500).json({ message: "Error al editar pedido" });
  } finally {
    client.release();
  }
});

// Eliminar pedido y sus items
app.delete("/pedidos/:id", authenticateToken, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM pedidos WHERE id = $1 AND organizacion_id = $2",
      [req.params.id, req.organizacion_id]
    );
    res.sendStatus(204);
  } catch (err) {
    console.error("[DELETE /pedidos/:id]", err);
    res.status(500).json({ message: "Error al eliminar pedido" });
  }
});

// --- CRUD TAREAS ---
// Listar tareas
app.get("/tareas", authenticateToken, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM tareas WHERE organizacion_id = $1 ORDER BY completada, id DESC",
      [req.organizacion_id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[GET /tareas]", err);
    res.status(500).json({ message: "Error al obtener tareas" });
  }
});

// Crear tarea
app.post("/tareas", authenticateToken, async (req, res) => {
  const { titulo, descripcion, completada } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ message: "Título requerido" });

  try {
    await db.query(
      `INSERT INTO tareas (titulo, descripcion, completada, usuario_email, organizacion_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [titulo, descripcion, !!completada, req.usuario_email, req.organizacion_id]
    );
    res.sendStatus(201);
  } catch (err) {
    console.error("[POST /tareas]", err);
    res.status(500).json({ message: "Error al crear tarea" });
  }
});

// Editar tarea
app.put("/tareas/:id", authenticateToken, async (req, res) => {
  const { titulo, descripcion, completada } = req.body;
  if (!titulo?.trim()) return res.status(400).json({ message: "Título requerido" });

  try {
    await db.query(
      `UPDATE tareas SET titulo = $1, descripcion = $2, completada = $3
       WHERE id = $4 AND organizacion_id = $5`,
      [titulo, descripcion, !!completada, req.params.id, req.organizacion_id]
    );
    res.sendStatus(200);
  } catch (err) {
    console.error("[PUT /tareas/:id]", err);
    res.status(500).json({ message: "Error al editar tarea" });
  }
});

// Eliminar tarea
app.delete("/tareas/:id", authenticateToken, async (req, res) => {
  try {
    await db.query(
      "DELETE FROM tareas WHERE id = $1 AND organizacion_id = $2",
      [req.params.id, req.organizacion_id]
    );
    res.sendStatus(204);
  } catch (err) {
    console.error("[DELETE /tareas/:id]", err);
    res.status(500).json({ message: "Error al eliminar tarea" });
  }
});
// --- DASHBOARD: métricas básicas
app.get("/dashboard", authenticateToken, async (req, res) => {
  try {
    const [clientes, pedidos, tareas] = await Promise.all([
      db.query("SELECT COUNT(*) FROM clientes WHERE organizacion_id = $1", [req.organizacion_id]),
      db.query("SELECT COUNT(*) FROM pedidos WHERE organizacion_id = $1", [req.organizacion_id]),
      db.query("SELECT COUNT(*) FROM tareas WHERE organizacion_id = $1", [req.organizacion_id])
    ]);
    res.json({
      total_clientes: parseInt(clientes.rows[0].count),
      total_pedidos: parseInt(pedidos.rows[0].count),
      total_tareas: parseInt(tareas.rows[0].count)
    });
  } catch (err) {
    console.error("[GET /dashboard]", err);
    res.status(500).json({ message: "Error al cargar dashboard" });
  }
});

// --- HEALTH ---
app.get("/health", (_, res) => res.send("✅ VEX CRM corriendo"));
