/**
 * openclaw-models-adapter.ts
 *
 * Single isolated bridge to OpenClaw internals for the models capability
 * publish-up seam. Built per #general msg-1777008934839 (kai's call):
 *
 *   - In-process imports only — no child_process, no extra transport
 *   - One small adapter module (this file) so all internal coupling is here
 *   - Runtime assertion on the imported surface — fail loud on drift
 *   - On import-surface failure, return AdapterError so the publisher can
 *     post a degraded `ok:false` envelope. Never silent, never subprocess
 *     fallback, never crash.
 *
 * Shape returned matches the bounded envelope schema enforced by
 * reflectt-node `POST /openclaw/models/publish` — only normalized fields
 * the panel actually needs. NO raw `status`/`configured` blobs.
 */
import { createRequire } from "node:module";
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

interface RawAuthProfile {
  provider?: string;
  type?: string;
}

interface RawAuthStore {
  profiles?: Record<string, RawAuthProfile>;
}

interface OpenClawInternals {
  loadGatewayModelCatalog: () => Promise<RawModel[]>;
  ensureAuthProfileStore: (agentDir: string) => RawAuthStore;
  resolveOpenClawAgentDir: () => string;
}

async function loadInternals(): Promise<OpenClawInternals> {
  let modelCatalogMod: unknown;
  let authProfilesMod: unknown;
  let agentPathsMod: unknown;
  try {
    modelCatalogMod = await import("openclaw/dist/gateway/server-model-catalog.js");
    authProfilesMod = await import("openclaw/dist/agents/auth-profiles.js");
    agentPathsMod = await import("openclaw/dist/agents/agent-paths.js");
  } catch (err) {
    throw new AdapterError(
      "openclaw_internals_unresolved",
      `Failed to import OpenClaw internals (managed-host pin drift?): ${(err as Error).message}`,
    );
  }

  const loadGatewayModelCatalog = (modelCatalogMod as { loadGatewayModelCatalog?: unknown })
    .loadGatewayModelCatalog;
  const ensureAuthProfileStore = (authProfilesMod as { ensureAuthProfileStore?: unknown })
    .ensureAuthProfileStore;
  const resolveOpenClawAgentDir = (agentPathsMod as { resolveOpenClawAgentDir?: unknown })
    .resolveOpenClawAgentDir;

  if (typeof loadGatewayModelCatalog !== "function") {
    throw new AdapterError(
      "openclaw_internals_shape_drift",
      "openclaw/dist/gateway/server-model-catalog.js missing loadGatewayModelCatalog export",
    );
  }
  if (typeof ensureAuthProfileStore !== "function") {
    throw new AdapterError(
      "openclaw_internals_shape_drift",
      "openclaw/dist/agents/auth-profiles.js missing ensureAuthProfileStore export",
    );
  }
  if (typeof resolveOpenClawAgentDir !== "function") {
    throw new AdapterError(
      "openclaw_internals_shape_drift",
      "openclaw/dist/agents/agent-paths.js missing resolveOpenClawAgentDir export",
    );
  }

  return {
    loadGatewayModelCatalog: loadGatewayModelCatalog as OpenClawInternals["loadGatewayModelCatalog"],
    ensureAuthProfileStore: ensureAuthProfileStore as OpenClawInternals["ensureAuthProfileStore"],
    resolveOpenClawAgentDir: resolveOpenClawAgentDir as OpenClawInternals["resolveOpenClawAgentDir"],
  };
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

function buildProviderAuthMap(store: RawAuthStore): Map<string, { authState: AuthState; profile?: string }> {
  const map = new Map<string, { authState: AuthState; profile?: string }>();
  const profiles = store.profiles ?? {};
  for (const [profileId, cred] of Object.entries(profiles)) {
    const provider = String(cred?.provider ?? "").trim();
    if (!provider) continue;
    if (!map.has(provider)) {
      map.set(provider, { authState: "authenticated", profile: profileId });
    }
  }
  return map;
}

/**
 * Build the bounded ModelsCatalog from in-process OpenClaw truth.
 *
 * Throws AdapterError if internals are unavailable or have drifted —
 * caller (publisher) converts that into a degraded ok:false envelope.
 */
export async function buildCatalog(): Promise<{ catalog: ModelsCatalog; cliVersion: string | null }> {
  const internals = await loadInternals();

  const agentDir = internals.resolveOpenClawAgentDir();
  const rawModels = await internals.loadGatewayModelCatalog();
  const authStore = internals.ensureAuthProfileStore(agentDir);
  const providerAuth = buildProviderAuthMap(authStore);

  const providersById = new Map<string, ProviderEntry>();
  const models: ModelEntry[] = [];

  for (const raw of rawModels) {
    const provider = String(raw.provider ?? "").trim();
    const id = String(raw.id ?? "").trim();
    if (!provider || !id) continue;

    const authInfo = providerAuth.get(provider);
    const available = authInfo?.authState === "authenticated";

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
      providersById.set(provider, {
        id: provider,
        authState: authInfo?.authState ?? "missing",
        ...(authInfo?.profile ? { authProfile: authInfo.profile } : {}),
      });
    }
  }

  for (const [providerId, info] of providerAuth.entries()) {
    if (!providersById.has(providerId)) {
      providersById.set(providerId, {
        id: providerId,
        authState: info.authState,
        ...(info.profile ? { authProfile: info.profile } : {}),
      });
    }
  }

  const cliVersion = readCliVersion();

  return {
    catalog: {
      models,
      providers: Array.from(providersById.values()),
    },
    cliVersion,
  };
}

function readCliVersion(): string | null {
  try {
    const requireFn = createRequire(import.meta.url);
    const pkg = requireFn("openclaw/package.json") as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
