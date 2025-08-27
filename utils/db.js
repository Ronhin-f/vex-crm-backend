// utils/db.js
import pg from "pg";
const { Pool } = pg;

export const CANON_CATS = [
  "Incoming Leads",
  "Qualified",
  "Bid/Estimate Sent",
  "Won",
  "Lost",
];

function buildPoolConfig() {
  const cs = process.env.DATABASE_URL;
  const sslRequired =
    process.env.PGSSLMODE === "require" ||
    (cs && !/sslmode=disable|sslmode=off/i.test(cs || ""));
  return {
    connectionString: cs,
    ssl: sslRequired ? { rejectUnauthorized: false } : false,
    max: Number(process.env.PGPOOL_MAX || 10),
    idleTimeoutMillis: Number(process.env.PG_IDLE || 30000),
  };
}

export const db = new Pool(buildPoolConfig());

export async function q(text, params = []) {
  // console.log("[SQL]", text, params);
  return db.query(text, params);
}

async function ensureOrgText(table) {
  const r = await q(
    `SELECT data_type
       FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 AND column_name='organizacion_id'`,
    [table]
  );
  const t = r.rows?.[0]?.data_type;
  if (t && t !== "text") {
    await q(`ALTER TABLE ${table} ALTER COLUMN organizacion_id TYPE TEXT USING organizacion_id::text;`);
  }
}

export async function initDB() {
  // ===== Tablas base (no pisan existentes) =====
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

    CREATE TABLE IF NOT EXISTS categorias (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      organizacion_id TEXT
      -- columnas extra se agregan abajo con ALTER IF NOT EXISTS
    );
  `);

  // ===== Aseguro columnas que pueden faltar por instalaciones viejas =====
  // clientes
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS categoria TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  // tareas
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS completada BOOLEAN DEFAULT FALSE;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS vence_en TIMESTAMPTZ;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'todo';`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS orden INTEGER DEFAULT 0;`);

  // categorias
  await q(`ALTER TABLE categorias ADD COLUMN IF NOT EXISTS nombre_ci TEXT;`);
  await q(`ALTER TABLE categorias ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await q(`ALTER TABLE categorias ADD COLUMN IF NOT EXISTS orden INTEGER DEFAULT 0;`);
  await q(`UPDATE categorias SET nombre_ci = LOWER(nombre) WHERE nombre_ci IS NULL;`);
  await q(`CREATE UNIQUE INDEX IF NOT EXISTS categorias_org_nombre_ci_uniq ON categorias(organizacion_id, nombre_ci);`);

  // ===== Normalizo tipo de org =====
  for (const t of ["usuarios","clientes","pedidos","tareas","integraciones","recordatorios","categorias"]) {
    await ensureOrgText(t);
  }

  // ===== Índices =====
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_org     ON clientes(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_created ON clientes(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_cat     ON clientes(categoria);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_org       ON tareas(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_vence     ON tareas(vence_en);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_compl     ON tareas(completada);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_estado    ON tareas(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_orden     ON tareas(orden);`);

  // ===== Seed/Upsert del pipeline canónico (orden consistente) =====
  for (let i = 0; i < CANON_CATS.length; i++) {
    const name = CANON_CATS[i];
    // 1) actualizo orden si ya existía (case-insensitive)
    await q(
      `UPDATE categorias SET orden=$2, nombre_ci=LOWER(nombre)
         WHERE organizacion_id IS NULL AND LOWER(nombre)=LOWER($1)`,
      [name, i]
    );
    // 2) inserto si no existe
    await q(
      `INSERT INTO categorias (nombre, nombre_ci, organizacion_id, orden)
       SELECT $1, LOWER($1), NULL, $2
       WHERE NOT EXISTS (
         SELECT 1 FROM categorias WHERE organizacion_id IS NULL AND LOWER(nombre)=LOWER($1)
       )`,
      [name, i]
    );
  }
}
