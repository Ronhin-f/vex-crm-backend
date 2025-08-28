// utils/db.js — VEX CRM
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
    await q(
      `ALTER TABLE ${table}
         ALTER COLUMN organizacion_id TYPE TEXT
         USING organizacion_id::text;`
    );
  }
}

export async function initDB() {
  // ===== Tablas base (no pisa existentes) =====
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
      email TEXT,
      direccion TEXT,
      observacion TEXT,
      -- pipeline / ownership
      stage TEXT,                -- preferido por Kanban/Pipeline (mantengo categoria por compat)
      categoria TEXT,
      assignee TEXT,             -- responsable
      source TEXT,               -- origen del lead (web, referral, etc.)
      due_date TIMESTAMPTZ,      -- fecha de seguimiento
      contacto_nombre TEXT,      -- persona de contacto principal
      -- estimate (URL o archivo subido)
      estimate_url TEXT,
      estimate_file TEXT,
      estimate_uploaded_at TIMESTAMPTZ,
      -- tracking
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Legacy comercial (dejamos para compat, pero el MVP usará /compras)
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

    -- Compras (para el módulo /compras del MVP)
    CREATE TABLE IF NOT EXISTS compras (
      id SERIAL PRIMARY KEY,
      proveedor TEXT,            -- o usar cliente_id si compras a clientes; lo dejo simple para MVP
      cliente_id INTEGER,        -- opcional si la compra está asociada a un cliente
      numero TEXT,               -- nro de orden / factura
      estado TEXT DEFAULT 'draft', -- draft | submitted | received | cancelled
      total NUMERIC(14,2),
      moneda TEXT DEFAULT 'ARS',
      notas TEXT,
      fecha TIMESTAMPTZ DEFAULT NOW(),
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS compra_items (
      id SERIAL PRIMARY KEY,
      compra_id INTEGER REFERENCES compras(id) ON DELETE CASCADE,
      producto TEXT NOT NULL,
      cantidad NUMERIC(14,3) DEFAULT 1,
      precio_unitario NUMERIC(14,2) DEFAULT 0,
      impuesto NUMERIC(14,2) DEFAULT 0,
      observacion TEXT
    );

    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      cliente_id INTEGER,
      estado TEXT DEFAULT 'todo',    -- todo | doing | waiting | done
      vence_en TIMESTAMPTZ,
      completada BOOLEAN DEFAULT FALSE,
      orden INTEGER DEFAULT 0,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS integraciones (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT UNIQUE,
      slack_webhook_url TEXT,
      whatsapp_meta_token TEXT,
      whatsapp_phone_id TEXT,
      ios_push_key_id TEXT,
      ios_team_id TEXT,
      ios_bundle_id TEXT,
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
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      orden INTEGER DEFAULT 0
    );
  `);

  // ===== Columnas que pueden faltar (migraciones idempotentes) =====
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS email TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS categoria TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS stage TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS assignee TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS source TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS contacto_nombre TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estimate_url TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estimate_file TEXT;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS estimate_uploaded_at TIMESTAMPTZ;`);
  await q(`ALTER TABLE clientes ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);

  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS completada BOOLEAN DEFAULT FALSE;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS vence_en TIMESTAMPTZ;`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'todo';`);
  await q(`ALTER TABLE tareas ADD COLUMN IF NOT EXISTS orden INTEGER DEFAULT 0;`);

  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS proveedor TEXT;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS cliente_id INTEGER;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS numero TEXT;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS estado TEXT DEFAULT 'draft';`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS total NUMERIC(14,2);`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS moneda TEXT DEFAULT 'ARS';`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS notas TEXT;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS fecha TIMESTAMPTZ DEFAULT NOW();`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS usuario_email TEXT;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS organizacion_id TEXT;`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW();`);
  await q(`ALTER TABLE compras ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();`);

  // ===== Normalizo tipo de org a TEXT =====
  const ORG_TABLES = [
    "usuarios",
    "clientes",
    "pedidos",
    "tareas",
    "integraciones",
    "recordatorios",
    "categorias",
    "compras",
    "compra_items",
    "pedido_items"
  ];
  for (const t of ORG_TABLES) {
    await ensureOrgText(t).catch(() => {});
  }

  // ===== Índices =====
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_org       ON clientes(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_created   ON clientes(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_stage     ON clientes(stage);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_categoria ON clientes(categoria);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_assignee  ON clientes(assignee);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_due       ON clientes(due_date);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_source    ON clientes(source);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_org         ON tareas(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_vence       ON tareas(vence_en);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_compl       ON tareas(completada);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_estado      ON tareas(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_orden       ON tareas(orden);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_compras_org        ON compras(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compras_fecha      ON compras(fecha);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compras_estado     ON compras(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compra_items_cid   ON compra_items(compra_id);`);

  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS categorias_org_nombre_lower_uniq
      ON categorias (organizacion_id, lower(nombre));
  `);

  // ===== Seed/Upsert del pipeline canónico (case-insensitive, global NULL) =====
  for (let i = 0; i < CANON_CATS.length; i++) {
    const name = CANON_CATS[i];
    await q(
      `UPDATE categorias SET orden=$2
         WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)`,
      [name, i]
    );
    await q(
      `INSERT INTO categorias (nombre, organizacion_id, orden)
       SELECT $1, NULL, $2
        WHERE NOT EXISTS (
          SELECT 1 FROM categorias
           WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)
        )`,
      [name, i]
    );
  }

  // ===== Backfill de coherencia stage/categoria (para instalaciones viejas) =====
  await q(`UPDATE clientes SET stage = categoria WHERE stage IS NULL AND categoria IS NOT NULL;`);
  await q(`UPDATE clientes SET categoria = stage WHERE categoria IS NULL AND stage IS NOT NULL;`);
}
