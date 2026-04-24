/**
 * publish-models-catalog.ts
 *
 * Builds the bounded ModelsEnvelope from the in-process adapter and POSTs
 * it to reflectt-node's `/openclaw/models/publish` ingest endpoint.
 *
 * Failure semantics (per #general msg-1777008934839 — kai's call):
 *   - adapter throws → publish ok:false envelope with explicit error
 *   - HTTP failure → log + return; the next reload/boot will retry
 *   - never silent, never crash the gateway, never subprocess fallback
 */
import { buildCatalog, AdapterError } from "./openclaw-models-adapter.js";
import type { ModelsEnvelope } from "./openclaw-models-types.js";

interface PublishOptions {
  url: string;
  log?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  /** Optional override for testing the HTTP call. */
  fetchImpl?: typeof fetch;
  /** Optional clock override for deterministic tests. */
  now?: () => number;
}

export interface PublishResult {
  posted: boolean;
  envelope: ModelsEnvelope;
  httpStatus?: number;
  httpError?: string;
}

const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

export async function publishModelsCatalog(opts: PublishOptions): Promise<PublishResult> {
  const fetchFn = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const evaluatedAt = now();

  let envelope: ModelsEnvelope;

  try {
    const { catalog, cliVersion } = await buildCatalog();
    envelope = {
      evaluatedAt,
      publishedAt: now(),
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      ok: true,
      errors: [],
      cliVersion,
      catalog,
    };
  } catch (err) {
    const code = err instanceof AdapterError ? err.code : "adapter_unknown_error";
    const message = err instanceof Error ? err.message : String(err);
    opts.log?.warn?.(`[reflectt-channel:models] adapter failed (${code}): ${message}`);
    envelope = {
      evaluatedAt,
      publishedAt: now(),
      maxAgeMs: DEFAULT_MAX_AGE_MS,
      ok: false,
      errors: [`${code}: ${message}`],
      cliVersion: null,
      catalog: null,
    };
  }

  const target = `${opts.url}/openclaw/models/publish`;
  try {
    const res = await fetchFn(target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(envelope),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      opts.log?.warn?.(
        `[reflectt-channel:models] POST ${target} → ${res.status} ${res.statusText} ${body.slice(0, 200)}`,
      );
      return { posted: false, envelope, httpStatus: res.status, httpError: res.statusText };
    }
    opts.log?.info?.(
      `[reflectt-channel:models] published ${envelope.ok ? "ok" : "degraded"} envelope (` +
        `models=${envelope.catalog?.models.length ?? 0}, providers=${envelope.catalog?.providers.length ?? 0}` +
        `${envelope.ok ? "" : `, errors=${envelope.errors.length}`})`,
    );
    return { posted: true, envelope, httpStatus: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    opts.log?.warn?.(`[reflectt-channel:models] POST ${target} threw: ${message}`);
    return { posted: false, envelope, httpError: message };
  }
}
