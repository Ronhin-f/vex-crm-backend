// utils/db.js — VEX CRM
import pg from "pg";
const { Pool } = pg;

/* ===========================
 *  Constantes / helpers
 * =========================== */
export const CANON_CATS = [
  "Unqualified",
  "Incoming Leads",
  "Qualified",
  "Follow-up Missed",
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
// 👇 compat para módulos que esperan `{ pool }`
export const pool = db;

export async function q(text, params = []) {
  // console.log("[SQL]", text, params);
  return db.query(text, params);
}

/* ===========================
 *  Migraciones / bootstrap
 * =========================== */
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
      `ALTER TABLE public.${table}
         ALTER COLUMN organizacion_id TYPE TEXT
         USING organizacion_id::text;`
    );
  }
}

export async function initDB() {
  /* ---- Extensiones ---- */
  await q(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);

  /* ---- Tablas base ---- */
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
      stage TEXT,
      categoria TEXT,
      assignee TEXT,
      source TEXT,
      due_date TIMESTAMPTZ,
      contacto_nombre TEXT,
      -- estimate
      estimate_url TEXT,
      estimate_file TEXT,
      estimate_uploaded_at TIMESTAMPTZ,
      -- tracking
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Comercial legacy
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

    -- Compras
    CREATE TABLE IF NOT EXISTS compras (
      id SERIAL PRIMARY KEY,
      proveedor TEXT,
      cliente_id INTEGER,
      numero TEXT,
      estado TEXT DEFAULT 'draft',
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

    /* ===== TAREAS ===== */
    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      cliente_id INTEGER,
      estado TEXT DEFAULT 'todo',     -- todo | doing | waiting | done
      vence_en TIMESTAMPTZ,
      completada BOOLEAN DEFAULT FALSE,
      orden INTEGER DEFAULT 0,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    /* ===== INTEGRACIONES (1 x org) ===== */
    CREATE TABLE IF NOT EXISTS integraciones (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT UNIQUE,
      slack_webhook_url TEXT,
      slack_default_channel TEXT,
      whatsapp_meta_token TEXT,
      whatsapp_phone_id TEXT,
      ios_push_key_id TEXT,
      ios_team_id TEXT,
      ios_bundle_id TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    /* ===== RECORDATORIOS ===== */
    CREATE TABLE IF NOT EXISTS recordatorios (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT NOT NULL,
      titulo TEXT NOT NULL,
      mensaje TEXT NOT NULL,
      enviar_en TIMESTAMPTZ NOT NULL,
      cliente_id INTEGER,
      tarea_id INTEGER,
      estado TEXT DEFAULT 'pendiente',     -- pendiente | enviado | error
      intento_count INTEGER DEFAULT 0,
      last_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      sent_at TIMESTAMPTZ
    );

    /* ===== CATEGORIAS ===== */
    CREATE TABLE IF NOT EXISTS categorias (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      orden INTEGER DEFAULT 0
    );
  `);

  /* ---- Proyectos & Proveedores ---- */
  await q(`
    CREATE TABLE IF NOT EXISTS proyectos (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      descripcion TEXT,
      cliente_id INTEGER,
      stage TEXT DEFAULT 'Incoming Leads',
      categoria TEXT,
      estimate_amount NUMERIC(14,2),
      estimate_currency TEXT,
      prob_win NUMERIC(5,2),
      fecha_cierre_estimada DATE,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS proveedores (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      contacto TEXT,
      telefono TEXT,
      email TEXT,
      rubro TEXT,
      notas TEXT,
      activo BOOLEAN DEFAULT TRUE,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  /* ====== 🔧 Backfill de columnas faltantes en proyectos (alinear con rutas) ====== */
  await q(`
    ALTER TABLE public.proyectos
      ADD COLUMN IF NOT EXISTS source           TEXT,
      ADD COLUMN IF NOT EXISTS assignee         TEXT,
      ADD COLUMN IF NOT EXISTS due_date         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS estimate_url     TEXT,
      ADD COLUMN IF NOT EXISTS estimate_file    TEXT,
      ADD COLUMN IF NOT EXISTS contacto_nombre  TEXT;
  `);

  /* =========================================================
   *  Migraciones idempotentes (columnas que podrían faltar)
   * ========================================================= */
  await q(`ALTER TABLE public.tareas
    ADD COLUMN IF NOT EXISTS cliente_id      INTEGER,
    ADD COLUMN IF NOT EXISTS estado          TEXT        DEFAULT 'todo',
    ADD COLUMN IF NOT EXISTS orden           INTEGER     DEFAULT 0,
    ADD COLUMN IF NOT EXISTS completada      BOOLEAN     DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS vence_en        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS usuario_email   TEXT,
    ADD COLUMN IF NOT EXISTS organizacion_id TEXT;`);

  // FK a clientes (si faltara)
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'tareas_cliente_fk'
      ) THEN
        ALTER TABLE public.tareas
          ADD CONSTRAINT tareas_cliente_fk
          FOREIGN KEY (cliente_id) REFERENCES public.clientes(id)
          ON DELETE SET NULL;
      END IF;
    END$$;
  `);

  // INTEGRACIONES columnas por si faltan
  await q(`ALTER TABLE public.integraciones
    ADD COLUMN IF NOT EXISTS organizacion_id       TEXT,
    ADD COLUMN IF NOT EXISTS slack_webhook_url     TEXT,
    ADD COLUMN IF NOT EXISTS slack_default_channel TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_meta_token   TEXT,
    ADD COLUMN IF NOT EXISTS whatsapp_phone_id     TEXT,
    ADD COLUMN IF NOT EXISTS updated_at            TIMESTAMPTZ DEFAULT NOW();`);

  // Mapeo email → slack_user_id
  await q(`
    CREATE TABLE IF NOT EXISTS slack_users (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT NOT NULL,
      email TEXT NOT NULL,
      slack_user_id TEXT NOT NULL,
      UNIQUE (organizacion_id, email)
    );
  `);

  /* ---- Normalización organizacion_id a TEXT ---- */
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
    "pedido_items",
    "proyectos",
    "proveedores",
    "slack_users",
  ];
  for (const t of ORG_TABLES) {
    await ensureOrgText(t).catch(() => {});
  }

  /* ---- Índices útiles ---- */
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_org         ON clientes(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_created     ON clientes(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_updated     ON clientes(updated_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_stage       ON clientes(stage);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_categoria   ON clientes(categoria);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_assignee    ON clientes(assignee);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_due         ON clientes(due_date);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_source      ON clientes(source);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_org           ON tareas(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_estado        ON tareas(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_orden         ON tareas(orden);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_vence         ON tareas(vence_en);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_compl         ON tareas(completada);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_cliente       ON tareas(cliente_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_tareas_user_due      ON tareas(usuario_email, vence_en);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_compras_org          ON compras(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compras_fecha        ON compras(fecha);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compras_estado       ON compras(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_compra_items_cid     ON compra_items(compra_id);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_org        ON proyectos(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_updated    ON proyectos(updated_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_stage      ON proyectos(stage);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_cliente    ON proyectos(cliente_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_assignee   ON proyectos(assignee);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_source     ON proyectos(source);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_due        ON proyectos(due_date);`);

  await q(`
    CREATE INDEX IF NOT EXISTS idx_proveedores_org      ON proveedores(organizacion_id);
  `);
  await q(`
    CREATE INDEX IF NOT EXISTS idx_proveedores_activo   ON proveedores(activo);
  `);
  await q(`
    CREATE INDEX IF NOT EXISTS idx_proveedores_updated  ON proveedores(updated_at);
  `);

  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS categorias_org_nombre_lower_uniq
      ON categorias (organizacion_id, lower(nombre));
  `);

  // Integraciones: 1 fila por org (idempotente, soporta distintos nombres de índice)
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes 
         WHERE schemaname='public' AND tablename='integraciones'
           AND (indexname='integraciones_org_unique' OR indexname='integraciones_organizacion_id_key')
      ) THEN
        CREATE UNIQUE INDEX integraciones_org_unique ON integraciones(organizacion_id);
      END IF;
    END$$;
  `);

  // Recordatorios: índice parcial para el cron
  await q(`
    CREATE INDEX IF NOT EXISTS idx_recordatorios_pend
      ON recordatorios(enviar_en)
      WHERE estado = 'pendiente';
  `);

  /* ---- Seed del pipeline canónico global (org NULL) ---- */
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

  /* ---- Backfills suaves ---- */
  await q(`UPDATE clientes  SET stage = categoria WHERE stage IS NULL AND categoria IS NOT NULL;`);
  await q(`UPDATE clientes  SET categoria = stage WHERE categoria IS NULL AND stage IS NOT NULL;`);
  await q(`UPDATE proyectos SET stage = COALESCE(stage, 'Incoming Leads');`);
  await q(`UPDATE proyectos SET categoria = COALESCE(categoria, stage);`);
  await q(`UPDATE tareas    SET estado = COALESCE(NULLIF(TRIM(estado), ''), 'todo')
           WHERE estado IS NULL OR TRIM(estado) = '';`);
  await q(`UPDATE tareas    SET completada = COALESCE(completada, FALSE) WHERE completada IS NULL;`);
  await q(`UPDATE tareas    SET orden = COALESCE(orden, 0) WHERE orden IS NULL;`);
}
