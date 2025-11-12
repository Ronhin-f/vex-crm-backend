// workers/outbox.dispatch.js  — stub seguro (ESM)
import { setTimeout as sleep } from "node:timers/promises";

const enabled = /^(1|true|on|yes)$/i.test(String(process.env.OUTBOX_WORKER ?? "off"));

if (!enabled) {
  console.log("[worker] outbox.dispatch stub cargado (deshabilitado)");
} else {
  console.log("[worker] outbox.dispatch habilitado (stub en loop)");
  (async () => {
    while (true) {
      // acá iría el dispatch real (leer outbox y despachar)
      await sleep(60_000);
    }
  })().catch((e) => console.error("[worker] error en stub:", e));
}

export {};
