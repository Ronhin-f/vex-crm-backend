// utils/db.js
import pkg from "pg";
const { Pool } = pkg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE || 30000),
});

// Helper por si querés loguear SQL en debug
export async function q(text, params = []) {
  // console.log("[SQL]", text, params);
  return db.query(text, params);
}

/**
 * Migración mínima y segura:
 * - No reemplaza tus tablas existentes.
 * - Agrega columnas faltantes que el dashboard necesita:
 *   clientes.email, clientes.created_at, tareas.created_at
 * - Crea índices razonables.
 */
export async function initDB() {
  // Tablas base (como ya tenías)
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
      -- OJO: email y created_at los agregamos abajo con ALTER IF NOT EXISTS
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
      vence_en TIMESTAMPTZ,
      cliente_id INTEGER,
      usuario_email TEXT,
      organizacion_id INTEGER
      -- created_at lo agregamos abajo si falta
    );

    CREATE TABLE IF NOT EXISTS integraciones (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER UNIQUE,
      slack_webhook_url TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recordatorios (
      id SERIAL PRIMARY KEY,
      organizacion_id INTEGER NOT NULL,
      titulo TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      enviar_en TIMESTAMPTZ NOT NULL,
      cliente_id INTEGER,
      tarea_id INTEGER,
      estado TEXT DEFAULT 'pendiente',
      intento_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );
  `);

  // --- Columnas faltantes necesarias para el dashboard ---
  await db.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email TEXT;`);
  await db.query(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await db.query(`ALTER TABLE tareas   ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // --- Índices útiles ---
  await db.query(`CREATE INDEX IF NOT EXISTS idx_clientes_org ON clientes(organizacion_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_clientes_created ON clientes(created_at);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tareas_org ON tareas(organizacion_id);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tareas_vence ON tareas(vence_en);`);
  await db.query(`CREATE INDEX IF NOT EXISTS idx_tareas_completada ON tareas(completada);`);
}
