// utils/db.js ƒ?" VEX CRM (Railway/Postgres, ESM)
import pg from "pg";
const { Pool, types } = pg;

/* ===========================
 *  Parsers & defaults
 * =========================== */
// NUMERIC -> Number (evita strings en totales/amounts)
types.setTypeParser(1700, (v) => (v == null ? null : parseFloat(v)));
// INT8 -> Number (si lo usaramos para counts)
types.setTypeParser(20, (v) => (v == null ? null : parseInt(v, 10)));

/* ===========================
 *  Constantes / helpers
 * =========================== */
const DEFAULT_PIPELINE = [
  "Unqualified",
  "Incoming Leads",
  "Qualified",
  "Follow-up Missed",
  "Bid/Estimate Sent",
  "Won",
  "Lost",
];

const VET_PIPELINE = [
  "Turno fijado",
  "Pre quirurgico",
  "Completado",
  "Turno perdido",
  "Lost",
];

export const CANON_CATS = DEFAULT_PIPELINE;
export const PIPELINES = { default: DEFAULT_PIPELINE, veterinaria: VET_PIPELINE };
const PIPELINE_CACHE = new Map(); // orgId -> { ts, pipeline }

export const resolvePipeline = (area) => {
  const a = (area || "").toLowerCase();
  if (a === "veterinaria") return PIPELINES.veterinaria;
  return PIPELINES.default;
};

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
  return v == null || v === "" ? def : String(v);
}

function buildPoolConfig() {
  let cs = process.env.DATABASE_URL;
  if (!cs) throw new Error("DATABASE_URL no esta definido");

  // Detecta sslmode desde la cadena o desde env
  const m = /sslmode=([^&]+)/i.exec(cs || "");
  const urlSslMode = (m?.[1] || "").toLowerCase();
  const envSslMode = (process.env.PGSSLMODE || "").toLowerCase();
  const dbSslFlag = envBool("DB_SSL", process.env.NODE_ENV === "production" ? "true" : "false");

  // En produccion, por defecto 'require'
  const defaultSslMode = process.env.NODE_ENV === "production" ? "require" : "disable";
  const sslMode = urlSslMode || envSslMode || (dbSslFlag ? "require" : defaultSslMode);

  const sslRequired = !["disable", "off", "allow"].includes(sslMode);

  // Compat con entornos donde hay certificados self-signed
  // Prioridad: PGSSL_REJECT_UNAUTHORIZED (explicito) > DB_SSL_NO_VERIFY > NODE_ENV
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
    statement_timeout: envNum("PG_STMT_TIMEOUT", 0),
    query_timeout: envNum("PG_QUERY_TIMEOUT", 0),
    allowExitOnIdle: envBool("PG_ALLOW_EXIT_ON_IDLE", "false"),
  };
}

export const db = new Pool(buildPoolConfig());
export const pool = db;

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

/* Pipeline por organizacion (cache 10m) */
export async function pipelineForOrg(orgId) {
  const key = orgId == null ? "__default__" : String(orgId);
  const now = Date.now();
  const cached = PIPELINE_CACHE.get(key);
  if (cached && now - cached.ts < 10 * 60 * 1000) return cached.pipeline;

  let area = null;
  try {
    if (orgId != null) {
      const r = await q(
        `SELECT area FROM org_profiles WHERE organizacion_id = $1 LIMIT 1`,
        [String(orgId)]
      );
      area = r.rows?.[0]?.area ?? null;
    }
  } catch {
    area = null;
  }

  const pipeline = resolvePipeline(area);
  PIPELINE_CACHE.set(key, { ts: now, pipeline });
  return pipeline;
}

/* ===========================
 *  Helpers de migracion
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
    console.warn(`[ensureOrgText] skip ${table}: ${e?.message || e}`);
  }
}

/* ===========================
 *  Migraciones / bootstrap
 * =========================== */
export async function initDB() {
  await q(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
  await q(`CREATE EXTENSION IF NOT EXISTS "pgcrypto";`);

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
      stage TEXT,
      categoria TEXT,
      assignee TEXT,
      source TEXT,
      due_date TIMESTAMPTZ,
      contacto_nombre TEXT,
      estimate_url TEXT,
      estimate_file TEXT,
      estimate_uploaded_at TIMESTAMPTZ,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contactos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
      nombre TEXT,
      email TEXT,
      telefono TEXT,
      cargo TEXT,
      rol TEXT,
      notas TEXT,
      es_principal BOOLEAN DEFAULT FALSE,
      obra_social TEXT,
      plan TEXT,
      numero_afiliado TEXT,
      preguntas JSONB DEFAULT '{}'::jsonb,
      motivo_consulta TEXT,
      ultima_consulta TEXT,
      cepillados_diarios TEXT,
      sangrado TEXT,
      momentos_azucar TEXT,
      dolor TEXT,
      golpe TEXT,
      dificultad TEXT,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
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

    CREATE TABLE IF NOT EXISTS cajas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organizacion_id TEXT NOT NULL,
      almacen_id INTEGER NOT NULL,
      usuario_email TEXT,
      estado TEXT DEFAULT 'abierta',
      apertura_monto NUMERIC(14,2) NOT NULL DEFAULT 0,
      apertura_at TIMESTAMPTZ DEFAULT NOW(),
      cierre_monto NUMERIC(14,2),
      cierre_total_esperado NUMERIC(14,2),
      cierre_diferencia NUMERIC(14,2),
      cierre_at TIMESTAMPTZ,
      arqueo_detalle JSONB DEFAULT '{}'::jsonb,
      arqueo_total NUMERIC(14,2),
      notas TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS cobros (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organizacion_id TEXT NOT NULL,
      cliente_id INTEGER,
      almacen_id INTEGER,
      caja_id UUID,

      moneda TEXT DEFAULT 'ARS',
      total NUMERIC(14,2) NOT NULL DEFAULT 0,
      descuento_total NUMERIC(14,2) NOT NULL DEFAULT 0,
      medio_pago TEXT,
      notas TEXT,
      estado TEXT DEFAULT 'pendiente',
      usuario_email TEXT,
      stock_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cobro_items (
      id SERIAL PRIMARY KEY,
      cobro_id UUID REFERENCES cobros(id) ON DELETE CASCADE,
      producto_id INTEGER,
      producto_nombre TEXT,
      codigo_qr TEXT,
      cantidad NUMERIC(14,3) NOT NULL DEFAULT 1,
      precio_unitario NUMERIC(14,2) NOT NULL DEFAULT 0,
      subtotal NUMERIC(14,2) NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS tareas (
      id SERIAL PRIMARY KEY,
      titulo TEXT NOT NULL,
      descripcion TEXT,
      cliente_id INTEGER,
      estado TEXT DEFAULT 'todo',
      prioridad TEXT DEFAULT 'media',
      vence_en TIMESTAMPTZ,
      completada BOOLEAN DEFAULT FALSE,
      orden INTEGER DEFAULT 0,
      usuario_email TEXT,
      organizacion_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

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

    CREATE TABLE IF NOT EXISTS slack_users (
      id SERIAL PRIMARY KEY,
      organizacion_id TEXT,
      email TEXT,
      slack_user_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS org_profiles (
      organizacion_id TEXT PRIMARY KEY,
      area TEXT NOT NULL DEFAULT 'general',
      vocab JSONB DEFAULT '{}'::jsonb,
      features JSONB DEFAULT '{}'::jsonb,
      forms JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS historias_clinicas (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      cliente_id INTEGER NOT NULL,
      organizacion_id TEXT NOT NULL,
      tipo TEXT,
      motivo TEXT,
      diagnostico TEXT,
      tratamiento TEXT,
      indicaciones TEXT,
      notas TEXT,
      signos_vitales JSONB DEFAULT '{}'::jsonb,
      antecedentes JSONB DEFAULT '{}'::jsonb,
      extras JSONB DEFAULT '{}'::jsonb,
      creado_por TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  await q(`
    ALTER TABLE public.cobros
      ADD COLUMN IF NOT EXISTS caja_id UUID;
  `);

  await q(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cobros_caja_fk') THEN
        ALTER TABLE public.cobros
          ADD CONSTRAINT cobros_caja_fk
          FOREIGN KEY (caja_id) REFERENCES public.cajas(id) ON DELETE SET NULL;
      END IF;
    END$$;
  `);
  await q(`
    ALTER TABLE public.contactos
      ADD COLUMN IF NOT EXISTS obra_social TEXT,
      ADD COLUMN IF NOT EXISTS plan TEXT,
      ADD COLUMN IF NOT EXISTS numero_afiliado TEXT,
      ADD COLUMN IF NOT EXISTS preguntas JSONB DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS motivo_consulta TEXT,
      ADD COLUMN IF NOT EXISTS ultima_consulta TEXT,
      ADD COLUMN IF NOT EXISTS cepillados_diarios TEXT,
      ADD COLUMN IF NOT EXISTS sangrado TEXT,
      ADD COLUMN IF NOT EXISTS momentos_azucar TEXT,
      ADD COLUMN IF NOT EXISTS dolor TEXT,
      ADD COLUMN IF NOT EXISTS golpe TEXT,
      ADD COLUMN IF NOT EXISTS dificultad TEXT,
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT NOW(),
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
  `);

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

  await q(`
    ALTER TABLE public.tareas
      ADD COLUMN IF NOT EXISTS prioridad TEXT DEFAULT 'media',
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();
  `);

  await q(`
    CREATE OR REPLACE FUNCTION proyectos_on_close() RETURNS trigger AS $$
    BEGIN
      IF NEW.stage IN ('Won','Lost')
         AND (OLD.stage IS DISTINCT FROM NEW.stage OR OLD.stage IS NULL) THEN
        IF NEW.closed_at IS NULL THEN NEW.closed_at := NOW(); END IF;
        NEW.result := lower(NEW.stage);
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

  await q(`
    CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at := NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
  `);

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
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cobros' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_cobros_touch') THEN
        CREATE TRIGGER tr_cobros_touch BEFORE UPDATE ON public.cobros
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='cajas' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_cajas_touch') THEN
        CREATE TRIGGER tr_cajas_touch BEFORE UPDATE ON public.cajas
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
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='org_profiles' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_org_profiles_touch') THEN
        CREATE TRIGGER tr_org_profiles_touch BEFORE UPDATE ON public.org_profiles
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='historias_clinicas' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_historias_touch') THEN
        CREATE TRIGGER tr_historias_touch BEFORE UPDATE ON public.historias_clinicas
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='contactos' AND column_name='updated_at')
         AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='tr_contactos_touch') THEN
        CREATE TRIGGER tr_contactos_touch BEFORE UPDATE ON public.contactos
        FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
      END IF;
    END$$;
  `);

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

  const ORG_TABLES = [
    "usuarios","clientes","contactos","pedidos","tareas","integraciones","recordatorios",
    "categorias","compras","compra_items","cobros","cajas","pedido_items","proyectos","proveedores","slack_users",
    "org_profiles","historias_clinicas"
  ];
  for (const t of ORG_TABLES) {
    await ensureOrgText(t).catch(() => {});
  }

  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_org         ON clientes(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_created     ON clientes(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_updated     ON clientes(updated_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_stage       ON clientes(stage);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_categoria   ON clientes(categoria);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_assignee    ON clientes(assignee);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_due         ON clientes(due_date);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_clientes_source      ON clientes(source);`);

  await q(`CREATE INDEX IF NOT EXISTS idx_contactos_cliente    ON contactos(cliente_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_contactos_org        ON contactos(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_contactos_principal  ON contactos(cliente_id) WHERE COALESCE(es_principal, FALSE) = TRUE;`);

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

  await q(`CREATE INDEX IF NOT EXISTS idx_cobros_org           ON cobros(organizacion_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cobros_created       ON cobros(created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cobros_estado        ON cobros(estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cobro_items_cobro    ON cobro_items(cobro_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cobros_caja          ON cobros(caja_id);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cajas_org_estado     ON cajas(organizacion_id, estado);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cajas_created        ON cajas(organizacion_id, created_at);`);
  await q(`CREATE INDEX IF NOT EXISTS idx_cajas_almacen        ON cajas(organizacion_id, almacen_id);`);

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

  await q(`
    CREATE INDEX IF NOT EXISTS idx_historias_org_cli
      ON historias_clinicas (organizacion_id, cliente_id);
  `);
  await q(`
    CREATE INDEX IF NOT EXISTS idx_historias_org_created
      ON historias_clinicas (organizacion_id, created_at);
  `);

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

  await q(`
    CREATE INDEX IF NOT EXISTS idx_recordatorios_pend
      ON recordatorios(enviar_en)
      WHERE estado = 'pendiente';
  `);

  for (let i = 0; i < CANON_CATS.length; i++) {
    const name = CANON_CATS[i];
    await q(
      `UPDATE categorias SET orden=$2
         WHERE organizacion_id IS NULL AND lower(nombre)=lower($1)` ,
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

  await q(`UPDATE clientes  SET stage = categoria WHERE stage IS NULL AND categoria IS NOT NULL;`);
  await q(`UPDATE clientes  SET categoria = stage WHERE categoria IS NULL AND stage IS NOT NULL;`);
  await q(`UPDATE proyectos SET stage = COALESCE(stage, 'Incoming Leads');`);
  await q(`UPDATE proyectos SET categoria = COALESCE(categoria, stage);`);
  await q(`
    UPDATE tareas
       SET estado = COALESCE(NULLIF(TRIM(estado), ''), 'todo')
     WHERE estado IS NULL OR TRIM(estado) = '';
  `);
  await q(`
    UPDATE tareas
       SET prioridad = COALESCE(NULLIF(TRIM(prioridad), ''), 'media')
     WHERE prioridad IS NULL OR TRIM(prioridad) = '';
  `);
  await q(`UPDATE tareas SET completada = COALESCE(completada, FALSE) WHERE completada IS NULL;`);
  await q(`UPDATE tareas SET orden = COALESCE(orden, 0) WHERE orden IS NULL;`);
  await q(`UPDATE tareas SET updated_at = COALESCE(updated_at, created_at, NOW()) WHERE updated_at IS NULL;`);
}

export async function closeDB() {
  try {
    await db.end();
  } catch {}
}


