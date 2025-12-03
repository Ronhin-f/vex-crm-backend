// utils/area.profiles.js — perfiles por vertical (vocabulario + forms)
export const ALLOWED_AREAS = ["general", "salud", "construccion", "veterinaria"];

/* ---------- Base ---------- */
const BASE_PROFILE = {
  area: "general",
  vocab: {
    clients: "Clientes",
    client: "Cliente",
    contacts: "Contactos",
    contact: "Contacto",
    projects: "Proyectos",
    providers: "Subcontratistas",
    tasks: "Tareas",
    billing: "Facturacion",
    clinicalHistory: "Historia clinica",
    clinicalHistoryList: "Historias clinicas",
  },
  features: { clinicalHistory: false, labResults: false },
  forms: {
    clinicalHistory: {
      fields: [
        { name: "motivo", label: "Motivo de consulta", type: "text" },
        { name: "diagnostico", label: "Diagnostico", type: "textarea" },
        { name: "tratamiento", label: "Plan / Tratamiento", type: "textarea" },
        { name: "indicaciones", label: "Indicaciones", type: "textarea" },
        { name: "notas", label: "Notas internas", type: "textarea" },
      ],
      vitalSigns: [],
    },
  },
};

/* ---------- Presets ---------- */
const PRESETS = {
  general: BASE_PROFILE,
  salud: {
    ...BASE_PROFILE,
    area: "salud",
    vocab: {
      ...BASE_PROFILE.vocab,
      clients: "Pacientes",
      client: "Paciente",
      projects: "Casos",
      providers: "Prestadores",
    },
    features: { clinicalHistory: true, labResults: false },
    forms: {
      clinicalHistory: {
        ...BASE_PROFILE.forms.clinicalHistory,
        vitalSigns: ["presion", "frecuencia_cardiaca", "temperatura", "saturacion"],
        fields: [
          ...BASE_PROFILE.forms.clinicalHistory.fields,
          { name: "antecedentes", label: "Antecedentes", type: "textarea" },
        ],
      },
    },
  },
  construccion: {
    ...BASE_PROFILE,
    area: "construccion",
    vocab: {
      ...BASE_PROFILE.vocab,
      projects: "Obras",
      providers: "Contratistas",
    },
    features: { clinicalHistory: false },
  },
  veterinaria: {
    ...BASE_PROFILE,
    area: "veterinaria",
    vocab: {
      ...BASE_PROFILE.vocab,
      clients: "Mascotas",
      client: "Mascota",
      contacts: "Duenos",
      contact: "Dueno",
      projects: "Casos",
      providers: "Proveedores",
    },
    features: { clinicalHistory: true, labResults: true },
    forms: {
      clinicalHistory: {
        ...BASE_PROFILE.forms.clinicalHistory,
        vitalSigns: ["peso", "temperatura"],
        fields: [
          { name: "animal", label: "Animal/Especie", type: "text" },
          { name: "motivo", label: "Motivo de consulta", type: "text" },
          { name: "sintomas", label: "Sintomas", type: "textarea" },
          { name: "diagnostico", label: "Diagnostico", type: "textarea" },
          { name: "tratamiento", label: "Plan / Tratamiento", type: "textarea" },
          { name: "vacunas", label: "Vacunas", type: "textarea" },
          { name: "notas", label: "Notas internas", type: "textarea" },
          { name: "hematocrito", label: "Hematocrito (%)", type: "number" },
          { name: "hemoglobina", label: "Hemoglobina (g/dL)", type: "number" },
          { name: "leucocitos", label: "Leucocitos (10^3/uL)", type: "number" },
          { name: "plaquetas", label: "Plaquetas (10^3/uL)", type: "number" },
          { name: "glucosa", label: "Glucosa (mg/dL)", type: "number" },
          { name: "urea", label: "Urea (mg/dL)", type: "number" },
          { name: "creatinina", label: "Creatinina (mg/dL)", type: "number" },
          { name: "alt", label: "ALT / TGP (U/L)", type: "number" },
          { name: "ast", label: "AST / TGO (U/L)", type: "number" },
          { name: "fosfatasa_alcalina", label: "Fosfatasa alcalina (U/L)", type: "number" },
          { name: "proteinas_totales", label: "Proteinas totales (g/dL)", type: "number" },
        ],
      },
    },
  },
};

/* ---------- Helpers ---------- */
function deepMerge(base, extra) {
  if (!extra || typeof extra !== "object") return base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    if (v && typeof v === "object" && !Array.isArray(v) && typeof out[k] === "object") {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const cleanStr = (v, max = 160) => {
  if (v == null) return undefined;
  const s = String(v).trim();
  if (!s) return undefined;
  return s.slice(0, max);
};

function cleanFields(raw, presetFields) {
  if (!Array.isArray(raw)) return presetFields;
  const allowedTypes = new Set(["text", "textarea", "number"]);
  const out = [];
  for (const f of raw.slice(0, 20)) {
    const name = cleanStr(f?.name, 64);
    const label = cleanStr(f?.label, 120);
    const type = allowedTypes.has(f?.type) ? f.type : "text";
    if (!name || !label) continue;
    out.push({ name, label, type });
  }
  return out.length ? out : presetFields;
}

function cleanVocab(raw, presetVocab) {
  if (!raw || typeof raw !== "object") return presetVocab;
  const out = { ...presetVocab };
  const allowedKeys = new Set(Object.keys(presetVocab));
  for (const [k, v] of Object.entries(raw)) {
    if (!allowedKeys.has(k)) continue;
    const s = cleanStr(v, 80);
    if (s) out[k] = s;
  }
  return out;
}

function cleanForms(raw, presetForms) {
  if (!raw || typeof raw !== "object") return presetForms;
  const out = { ...presetForms };
  if (raw.clinicalHistory) {
    const preset = presetForms?.clinicalHistory || {};
    out.clinicalHistory = {
      ...preset,
      fields: cleanFields(raw.clinicalHistory.fields, preset.fields || []),
      vitalSigns: Array.isArray(raw.clinicalHistory.vitalSigns)
        ? raw.clinicalHistory.vitalSigns.slice(0, 12).map((v) => cleanStr(v, 40)).filter(Boolean)
        : preset.vitalSigns || [],
    };
  }
  return out;
}

/* ---------- Exports ---------- */
export function resolveProfile(row = {}) {
  const area = ALLOWED_AREAS.includes(row.area) ? row.area : "general";
  const preset = PRESETS[area] || PRESETS.general;
  return {
    area,
    vocab: cleanVocab(row.vocab, preset.vocab),
    features: { ...preset.features, ...(row.features || {}) },
    forms: deepMerge(preset.forms, row.forms || {}),
    availableAreas: ALLOWED_AREAS,
  };
}

export function sanitizeProfilePayload(body = {}) {
  const area = ALLOWED_AREAS.includes(body.area) ? body.area : "general";
  const preset = PRESETS[area] || PRESETS.general;
  const vocab = cleanVocab(body.vocab, preset.vocab);
  const features = { ...preset.features };
  if (typeof body.features?.clinicalHistory === "boolean") {
    features.clinicalHistory = body.features.clinicalHistory;
  }
  if (typeof body.features?.labResults === "boolean") {
    features.labResults = body.features.labResults;
  }
  const forms = cleanForms(body.forms, preset.forms);
  return { area, vocab, features, forms };
}
