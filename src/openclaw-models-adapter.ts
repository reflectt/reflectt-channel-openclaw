/**
 * openclaw-models-adapter.ts
 *
 * Single isolated bridge to OpenClaw internals for the models-capability
 * publish-up seam. Runs in-process inside the gateway plugin (no subprocess,
 * no extra transport — kai's lock, msg-1777008934839).
 *
 * Resolution strategy (managed-host reality, learned 2026-04-24):
 *   - The managed-host openclaw is bundled (e.g. `/app/openclaw.mjs` +
 *     `/app/dist/...`); there is NO npm-style `node_modules/openclaw/dist/`
 *     to resolve from a plugin's perspective.
 *   - So locate the dist directory by walking up from `process.argv[1]`
 *     (the gateway entry mjs) and dynamic-import the runtime module via
 *     a file:// URL. Falls back to OPENCLAW_DIST_ROOT env, then to a
 *     classic `openclaw/dist/...` resolve (for non-bundled hosts).
 *
 * Auth/availability:
 *   - The per-agent auth-profiles store doesn't exist on this host (and
 *     the Pi SDK's discoverAuthStorage requires plumbing we don't want
 *     here). Instead, we read `~/.openclaw/openclaw.json` directly and
 *     mark a provider `authenticated` iff it has a non-empty apiKey.
 *
 * Failure semantics:
 *   - Any drift (missing dist, missing export, malformed config) throws
 *     AdapterError; the publisher converts it to a degraded ok:false
 *     envelope. Never silent, never subprocess fallback, never crash.
 */
import { createRequire } from "node:module";
import { promises as fsp } from "node:fs";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type {
  ModelsCatalog,
  ModelEntry,
  ProviderEntry,
  AuthState,
} from "./openclaw-models-types.js";

export class AdapterError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AdapterError";
  }
}

interface RawModel {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: string[];
}

interface RawProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  api?: string;
  models?: unknown[];
}

interface OpenClawConfig {
  models?: {
    providers?: Record<string, RawProviderConfig>;
  };
}

async function findOpenClawDistRoot(): Promise<string | null> {
  const candidates: string[] = [];

  if (process.env.OPENCLAW_DIST_ROOT) {
    candidates.push(path.resolve(process.env.OPENCLAW_DIST_ROOT));
  }

  // Walk up from the gateway entry (e.g. /app/openclaw.mjs → /app/dist).
  if (process.argv[1]) {
    let cur = path.dirname(path.resolve(process.argv[1]));
    for (let i = 0; i < 6; i++) {
      candidates.push(path.join(cur, "dist"));
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  // Classic npm-installed fallback (non-bundled hosts).
  try {
    const requireFn = createRequire(import.meta.url);
    const resolved = requireFn.resolve("openclaw/dist/agents/model-catalog.runtime.js");
    candidates.push(path.dirname(path.dirname(resolved)));
  } catch {
    // ignore — bundled hosts won't resolve this
  }

  for (const c of candidates) {
    try {
      await fsp.access(path.join(c, "agents", "model-catalog.runtime.js"));
      return c;
    } catch {
      // try next
    }
  }

  return null;
}

interface OpenClawInternals {
  loadModelCatalog: (params?: { useCache?: boolean }) => Promise<RawModel[]>;
  distRoot: string;
}

async function loadInternals(): Promise<OpenClawInternals> {
  const distRoot = await findOpenClawDistRoot();
  if (!distRoot) {
    throw new AdapterError(
      "openclaw_dist_not_found",
      `Could not locate openclaw dist (checked OPENCLAW_DIST_ROOT, parent of process.argv[1]=${process.argv[1] ?? "<unset>"}, and npm openclaw resolve)`,
    );
  }

  const modelCatalogPath = path.join(distRoot, "agents", "model-catalog.runtime.js");
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(modelCatalogPath).href);
  } catch (err) {
    throw new AdapterError(
      "openclaw_internals_unresolved",
      `Failed to import ${modelCatalogPath}: ${(err as Error).message}`,
    );
  }

  const loadModelCatalog = (mod as { loadModelCatalog?: unknown }).loadModelCatalog;
  if (typeof loadModelCatalog !== "function") {
    throw new AdapterError(
      "openclaw_internals_shape_drift",
      `${modelCatalogPath} missing loadModelCatalog export`,
    );
  }

  return {
    loadModelCatalog: loadModelCatalog as OpenClawInternals["loadModelCatalog"],
    distRoot,
  };
}

function readOpenClawConfig(): OpenClawConfig {
  const home = process.env.OPENCLAW_HOME || path.join(os.homedir(), ".openclaw");
  const cfgPath = path.join(home, "openclaw.json");
  try {
    const raw = fs.readFileSync(cfgPath, "utf8");
    return JSON.parse(raw) as OpenClawConfig;
  } catch {
    return {};
  }
}

function buildProviderAuthMap(cfg: OpenClawConfig): Map<string, AuthState> {
  const map = new Map<string, AuthState>();
  const providers = cfg.models?.providers ?? {};
  for (const [providerId, providerCfg] of Object.entries(providers)) {
    const apiKey = typeof providerCfg?.apiKey === "string" ? providerCfg.apiKey.trim() : "";
    map.set(providerId, apiKey.length > 0 ? "authenticated" : "missing");
  }
  return map;
}

function deriveCapabilities(raw: RawModel): string[] | undefined {
  const caps: string[] = [];
  if (raw.reasoning === true) caps.push("reasoning");
  if (Array.isArray(raw.input)) {
    for (const i of raw.input) {
      const s = String(i).trim();
      if (s) caps.push(`input:${s}`);
    }
  }
  return caps.length > 0 ? caps : undefined;
}

/**
 * Build the bounded ModelsCatalog from in-process OpenClaw truth.
 *
 * Throws AdapterError if internals are unavailable or have drifted —
 * caller (publisher) converts that into a degraded ok:false envelope.
 */
export async function buildCatalog(): Promise<{ catalog: ModelsCatalog; cliVersion: string | null }> {
  const internals = await loadInternals();
  const rawModels = await internals.loadModelCatalog({ useCache: false });
  const cfg = readOpenClawConfig();
  const providerAuth = buildProviderAuthMap(cfg);

  const providersById = new Map<string, ProviderEntry>();
  const models: ModelEntry[] = [];

  for (const raw of rawModels) {
    const provider = String(raw.provider ?? "").trim();
    const id = String(raw.id ?? "").trim();
    if (!provider || !id) continue;

    const authState = providerAuth.get(provider) ?? "missing";
    const available = authState === "authenticated";

    const entry: ModelEntry = {
      key: id,
      provider,
      displayName: typeof raw.name === "string" && raw.name.length > 0 ? raw.name : null,
      available,
    };
    if (typeof raw.contextWindow === "number" && raw.contextWindow > 0) {
      entry.contextWindow = raw.contextWindow;
    }
    const caps = deriveCapabilities(raw);
    if (caps) entry.capabilities = caps;
    if (!available) entry.reason = `provider ${provider} not authenticated`;

    models.push(entry);

    if (!providersById.has(provider)) {
      providersById.set(provider, { id: provider, authState });
    }
  }

  for (const [providerId, authState] of providerAuth.entries()) {
    if (!providersById.has(providerId)) {
      providersById.set(providerId, { id: providerId, authState });
    }
  }

  return {
    catalog: {
      models,
      providers: Array.from(providersById.values()),
    },
    cliVersion: readCliVersion(internals.distRoot),
  };
}

function readCliVersion(distRoot: string): string | null {
  const pkgPath = path.join(path.dirname(distRoot), "package.json");
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
