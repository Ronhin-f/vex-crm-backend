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

app.use(cors());
app.use(express.json());

// Middleware: verificar JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  const token = authHeader?.split(" ")[1];
  if (!token) return res.sendStatus(401);
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    req.usuario_email = decoded.email;
    req.organizacion_id = decoded.organizacion_id;
    req.rol = decoded.rol;
    next();
  } catch {
    res.sendStatus(403);
  }
}

// 🛠 Crear tablas si no existen
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
      nombre TEXT,
      telefono TEXT,
      direccion TEXT,
      usuario_email TEXT,
      organizacion_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      titulo TEXT,
      descripcion TEXT,
      completada BOOLEAN,
      usuario_email TEXT,
      organizacion_id INTEGER
    );

    CREATE TABLE IF NOT EXISTS compras (
      id SERIAL PRIMARY KEY,
      producto TEXT,
      cantidad INTEGER,
      precio_unitario REAL,
      fecha DATE,
      usuario_email TEXT,
      organizacion_id INTEGER
    );
  `);
};
initDB();

/* ----------- AUTH ----------- */

// Registro limitado (solo para test o entornos cerrados)
app.post("/usuarios", async (req, res) => {
  const { email, password, organizacion_id } = req.body;
  if (!email || !password || !organizacion_id) {
    return res.status(400).json({ message: "Faltan campos requeridos" });
  }

  try {
    const existe = await db.query("SELECT 1 FROM usuarios WHERE email = $1", [email]);
    if (existe.rows.length) return res.status(409).json({ error: "Usuario ya existe" });

    const hash = await bcrypt.hash(password, 10);
    await db.query(
      "INSERT INTO usuarios (email, password, rol, organizacion_id) VALUES ($1, $2, 'usuario', $3)",
      [email, hash, organizacion_id]
    );
    res.sendStatus(201);
  } catch (err) {
    console.error("[POST /usuarios] ", err);
    res.status(500).json({ error: "Error al crear usuario" });
  }
});

/* ----------- CLIENTES ----------- */
app.get("/clientes", authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM clientes WHERE usuario_email = $1 AND organizacion_id = $2",
    [req.usuario_email, req.organizacion_id]
  );
  res.json(rows);
});

app.post("/clientes", authenticateToken, async (req, res) => {
  const { nombre, telefono, direccion } = req.body;
  await db.query(
    `INSERT INTO clientes (nombre, telefono, direccion, usuario_email, organizacion_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [nombre, telefono, direccion, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(201);
});

app.delete("/clientes/:id", authenticateToken, async (req, res) => {
  const id = req.params.id;
  await db.query(
    "DELETE FROM clientes WHERE id = $1 AND usuario_email = $2 AND organizacion_id = $3",
    [id, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(204);
});

/* ----------- TAREAS ----------- */
app.get("/tareas", authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM tareas WHERE usuario_email = $1 AND organizacion_id = $2",
    [req.usuario_email, req.organizacion_id]
  );
  res.json(rows);
});

app.post("/tareas", authenticateToken, async (req, res) => {
  const { titulo, descripcion, completada } = req.body;
  await db.query(
    `INSERT INTO tareas (titulo, descripcion, completada, usuario_email, organizacion_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [titulo, descripcion, completada || false, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(201);
});

app.delete("/tareas/:id", authenticateToken, async (req, res) => {
  await db.query(
    "DELETE FROM tareas WHERE id = $1 AND usuario_email = $2 AND organizacion_id = $3",
    [req.params.id, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(204);
});

/* ----------- COMPRAS ----------- */
app.get("/compras", authenticateToken, async (req, res) => {
  const { rows } = await db.query(
    "SELECT * FROM compras WHERE usuario_email = $1 AND organizacion_id = $2",
    [req.usuario_email, req.organizacion_id]
  );
  res.json(rows);
});

app.post("/compras", authenticateToken, async (req, res) => {
  const { producto, cantidad, precio_unitario, fecha } = req.body;
  await db.query(
    `INSERT INTO compras (producto, cantidad, precio_unitario, fecha, usuario_email, organizacion_id)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [producto, cantidad, precio_unitario, fecha, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(201);
});

app.delete("/compras/:id", authenticateToken, async (req, res) => {
  await db.query(
    "DELETE FROM compras WHERE id = $1 AND usuario_email = $2 AND organizacion_id = $3",
    [req.params.id, req.usuario_email, req.organizacion_id]
  );
  res.sendStatus(204);
});

/* ----------- DASHBOARD ----------- */
app.get("/dashboard", authenticateToken, async (req, res) => {
  const [clientes, tareas, compras] = await Promise.all([
    db.query("SELECT COUNT(*) FROM clientes WHERE usuario_email = $1 AND organizacion_id = $2", [req.usuario_email, req.organizacion_id]),
    db.query("SELECT COUNT(*) FROM tareas WHERE usuario_email = $1 AND organizacion_id = $2", [req.usuario_email, req.organizacion_id]),
    db.query("SELECT COUNT(*) FROM compras WHERE usuario_email = $1 AND organizacion_id = $2", [req.usuario_email, req.organizacion_id])
  ]);
  res.json({
    total_clientes: parseInt(clientes.rows[0].count),
    total_tareas: parseInt(tareas.rows[0].count),
    total_compras: parseInt(compras.rows[0].count)
  });
});

app.get("/health", (_, res) => res.send("✅ VEX CRM corriendo"));

app.listen(PORT, () => console.log(`🚀 VEX CRM backend corriendo en puerto ${PORT}`));
