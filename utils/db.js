// utils/db.js — VEX CRM (Railway/Postgres, ESM)
import pg from "pg";
const { Pool, types } = pg;

/* ===========================
 *  Parsers & defaults
 * =========================== */
// NUMERIC → Number (evita strings en totales/amounts)
types.setTypeParser(1700, (v) => (v == null ? null : parseFloat(v))); // NUMERIC
// INT8 → Number (si lo usáramos para counts)
types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

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

function envBool(name, def = "false") {
  const v = (process.env[name] ?? def).toString().trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}
function envNum(name, def = 0) {
  const v = (process.env[name] ?? "").toString().trim();
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function envStr(name, def = "") {
  const v = process.env[name];
  return (v == null || v === "") ? def : String(v);
}

function buildPoolConfig() {
  let cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL no está definido");

  // Detecta sslmode desde la cadena o desde env
  const m = /sslmode=([^&]+)/i.exec(cs || "");
  const urlSslMode = (m?.[1] || "").toLowerCase();
  const envSslMode = (process.env.PGSSLMODE || "").toLowerCase();
  const dbSslFlag = envBool("DB_SSL", process.env.NODE_ENV === "production" ? "true" : "false");

  // En producción, por defecto 'require'
  const defaultSslMode = process.env.NODE_ENV === "production" ? "require" : "disable";
  const sslMode = urlSslMode || envSslMode || (dbSslFlag ? "require" : defaultSslMode);

  const sslRequired = !["disable", "off", "allow"].includes(sslMode);

  // Compat con entornos donde hay certificados self-signed
  // Prioridad: PGSSL_REJECT_UNAUTHORIZED (explícito) > DB_SSL_NO_VERIFY > NODE_ENV
  const rejectUnauthorized = !envBool(
    "PGSSL_REJECT_UNAUTHORIZED",
    envBool("DB_SSL_NO_VERIFY", process.env.NODE_ENV === "production" ? "false" : "true") ? "false" : "true"
  );

  return {
    connectionString: cs,
    ssl: sslRequired ? { rejectUnauthorized } : false,
    application_name: envStr("PG_APP_NAME", "vex-crm"),
    max: envNum("PGPOOL_MAX", 10),
    idleTimeoutMillis: envNum("PG_IDLE", 30_000),
    connectionTimeoutMillis: envNum("PG_CONNECT_TIMEOUT", 10_000),
    keepAlive: true,
    keepAliveInitialDelayMillis: envNum("PG_KEEPALIVE_DELAY", 10_000),
    statement_timeout: envNum("PG_STMT_TIMEOUT", 0), // 0 = sin timeout
    query_timeout: envNum("PG_QUERY_TIMEOUT", 0),
    allowExitOnIdle: envBool("PG_ALLOW_EXIT_ON_IDLE", "false"),
  };
}

export const db = new Pool(buildPoolConfig());
// compat para módulos que esperan { pool }
export const pool = db;

// Log minimal si el pool reporta error asíncrono
db.on("error", (err) => {
  console.error("[pg:pool error]", err?.message || err);
});

export async function q(text, params = []) {
  try {
    return await db.query(text, params);
  } catch (e) {
    console.error("[pg:q]", e?.message || e, { text });
    throw e;
  }
}

/* ===========================
 *  Helpers de migración
 * =========================== */
async function ensureOrgText(table) {
  try {
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
  } catch (e) {
    // Si hay vistas/reglas dependientes, no frenamos el boot; logueamos y seguimos.
    console.warn(`[ensureOrgText] skip ${table}: ${e?.message || e}`);
  }
}

/* ===========================
 *  Migraciones / bootstrap
 * =========================== */
export async function initDB() {
  /* ---- Extensiones ---- */
  await q(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
  await q(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

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

    -- Compras (transitoria)
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

    /* ===== SLACK USERS (mínimo util) ===== */
    CREATE TABLE IF NOT EXISTS slack_users (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT,
      email TEXT,
      slack_user_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

  /* ====== Compatibilidad con KPIs: closed_at & result ====== */
  await q(`
    ALTER TABLE public.proyectos
      ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS result TEXT,
      ADD COLUMN IF NOT EXISTS source           TEXT,
      ADD COLUMN IF NOT EXISTS assignee         TEXT,
      ADD COLUMN IF NOT EXISTS due_date         TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS estimate_url     TEXT,
      ADD COLUMN IF NOT EXISTS estimate_file    TEXT,
      ADD COLUMN IF NOT EXISTS contacto_nombre  TEXT;
  `);

  // Trigger: setea closed_at/result cuando stage pasa a Won/Lost
  await q(`
    CREATE OR REPLACE FUNCTION proyectos_on_close() RETURNS trigger AS $$
    BEGIN
      IF NEW.stage IN ('Won','Lost')
         AND (OLD.stage IS DISTINCT FROM NEW.stage OR OLD.stage IS NULL) THEN
        IF NEW.closed_at IS NULL THEN NEW.closed_at := NOW(); END IF;
        NEW.result := lower(NEW.stage); -- 'won' | 'lost'
      END IF;
      RETURN NEW;
    END; $$ LANGUAGE plpgsql;
  `);

  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'tr_proyectos_on_close') THEN
        CREATE TRIGGER tr_proyectos_on_close
        BEFORE UPDATE ON public.proyectos
        FOR EACH ROW EXECUTE FUNCTION proyectos_on_close();
      END IF;
    END$$;
  `);

  // Trigger genérico para updated_at
  await q(`
    CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  `);

  // Aplica touch a tablas con updated_at
  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_proyectos_touch') THEN
        CREATE TRIGGER tr_proyectos_touch BEFORE UPDATE ON public.proyectos
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='clientes' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_clientes_touch') THEN
        CREATE TRIGGER tr_clientes_touch BEFORE UPDATE ON public.clientes
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='compras' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_compras_touch') THEN
        CREATE TRIGGER tr_compras_touch BEFORE UPDATE ON public.compras
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='proveedores' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_proveedores_touch') THEN
        CREATE TRIGGER tr_proveedores_touch BEFORE UPDATE ON public.proveedores
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='slack_users' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_slack_users_touch') THEN
        CREATE TRIGGER tr_slack_users_touch BEFORE UPDATE ON public.slack_users
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
    END$$;
  `);

  /* ===== Backfill suave (incluye casos ya "Won") ===== */
  await q(`
    UPDATE public.proyectos
       SET result = lower(stage)
     WHERE stage IN ('Won','Lost') AND (result IS NULL OR result NOT IN ('won','lost'));
  `);

  await q(`
    UPDATE public.proyectos
       SET closed_at = COALESCE(updated_at, created_at, NOW())
     WHERE stage IN ('Won','Lost') AND closed_at IS NULL;
  `);

  /* ===== Vista de compatibilidad "projects" (inglés) ===== */
  await q(`
    CREATE OR REPLACE VIEW public.projects AS
    SELECT
      id,
      organizacion_id AS org_id,
      stage,
      result,
      closed_at,
      created_at,
      updated_at
    FROM public.proyectos;
  `);

  /* ---- Normalización organizacion_id a TEXT ---- */
  const ORG_TABLES = [
    "usuarios","clientes","pedidos","tareas","integraciones","recordatorios",
    "categorias","compras","compra_items","pedido_items","proyectos","proveedores","slack_users"
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
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_result     ON proyectos(result);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_proyectos_closed_at  ON proyectos(closed_at);`);

  await q(`
    CREATE UNIQUE INDEX IF NOT EXISTS categorias_org_nombre_lower_uniq
      ON categorias (organizacion_id, lower(nombre));
  `);

  // Integraciones: 1 fila por org (idempotente)
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
  await q(`
    UPDATE tareas
       SET estado = COALESCE(NULLIF(TRIM(estado), ''), 'todo')
     WHERE estado IS NULL OR TRIM(estado) = '';
  `);
  await q(`UPDATE tareas SET completada = COALESCE(completada, FALSE) WHERE completada IS NULL;`);
  await q(`UPDATE tareas SET orden = COALESCE(orden, 0) WHERE orden IS NULL;`);
}

/* ===========================
 *  Shutdown limpio (opcional)
 * =========================== */
export async function closeDB() {
  try { await db.end(); } catch {}
}
