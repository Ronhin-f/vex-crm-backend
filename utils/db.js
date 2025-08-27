// utils/db.js
import pkg from "pg";
const { Pool } = pkg;

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PG_IDLE || 30000),
});

export async function q(text, params = []) {
  // console.log("[SQL]", text, params);
  return db.query(text, params);
}

async function ensureOrgText(table) {
  const info = await q(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name='organizacion_id'`,
    [table]
  );
  const type = info.rows?.[0]?.data_type;
  if (type && type !== "text") {
    await q(`ALTER TABLE ${table} ALTER COLUMN organizacion_id TYPE TEXT USING organizacion_id::text;`);
  }
}

export async function initDB() {
  // ===== Tablas base (no pisa nada existente) =====
  await q(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE,
      password TEXT,
      rol TEXT,
      organizacion_id TEXT
    );

    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      telefono TEXT,
      direccion TEXT,
      observacion TEXT,
      usuario_email TEXT,
      organizacion_id TEXT
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER,
      observacion TEXT,
      estado TEXT DEFAULT 'pendiente',
      fecha DATE DEFAULT CURRENT_DATE,
      usuario_email TEXT,
      organizacion_id TEXT
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
      -- OJO: muchas instalaciones viejas no tienen estas columnas:
      -- completada, vence_en, created_at; las agrego luego con ALTER IF NOT EXISTS
      cliente_id INTEGER,
      usuario_email TEXT,
      organizacion_id TEXT
    );

    CREATE TABLE IF NOT EXISTS integraciones (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT UNIQUE,
      slack_webhook_url TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS recordatorios (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT NOT NULL,
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

  // ===== Catálogo de categorías (por organización) =====
  await q(`
    CREATE TABLE IF NOT EXISTS categorias (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      nombre_ci TEXT GENERATED ALWAYS AS (LOWER(nombre)) STORED,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (organizacion_id, nombre_ci)
    );
  `);

  // ===== Columnas que pueden faltar por instalaciones previas =====
  // clientes
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS categoria TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // tareas
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS completada BOOLEAN DEFAULT FALSE;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS vence_en TIMESTAMPTZ;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // ===== Normalizo organizacion_id a TEXT (si venías con INTEGER) =====
  for (const t of ["usuarios", "clientes", "pedidos", "tareas", "integraciones", "recordatorios", "categorias"]) {
    await ensureOrgText(t);
  }

  // ===== Índices (después de asegurar columnas) =====
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_org     ON clientes(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_created ON clientes(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_cat     ON clientes(categoria);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_org       ON tareas(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_vence     ON tareas(vence_en);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_compl     ON tareas(completada);`);

  // ===== Semillas suaves de categorías =====
  await q(`
    INSERT INTO categorias (nombre, organizacion_id)
    VALUES ('Lead', NULL), ('Opportunity', NULL), ('Customer', NULL), ('Partner', NULL), ('Dormant', NULL)
    ON CONFLICT (organizacion_id, nombre_ci) DO NOTHING;
  `);
}
