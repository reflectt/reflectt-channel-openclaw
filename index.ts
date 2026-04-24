/**
 * reflectt-channel — OpenClaw channel plugin
 * 
 * Connects to reflectt-node SSE. When a message @mentions an agent,
 * it routes through OpenClaw's inbound pipeline. Agent responses are
 * POSTed back to reflectt-node automatically.
 */
import type { OpenClawPluginApi, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema, onDiagnosticEvent } from "openclaw/plugin-sdk";
import http from "node:http";
import https from "node:https";

function httpModule(url: string): typeof http | typeof https {
  return url.startsWith("https") ? https : http;
}
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishModelsCatalog } from "./src/publish-models-catalog.js";

const DEFAULT_URL = "http://127.0.0.1:4445";

/** Extract agent ID from OpenClaw session key (e.g., "agent:link:reflectt:main" → "link") */
function extractAgentFromSessionKey(key: string): string | null {
  if (!key) return null;
  const parts = key.split(":");
  // Format: "agent:<agentId>:<channel>:<room>" or "agent:<agentId>:<room>"
  if (parts[0] === "agent" && parts.length >= 2 && parts[1]) {
    return parts[1];
  }
  return null;
}

// No fallback agents — roster is always populated dynamically from /team/roles.
// Hardcoding names here would leak the developer team's roster into every provisioned team.
const IDLE_NUDGE_WINDOW_MS = 15 * 60 * 1000; // 15m
const WATCHDOG_INTERVAL_MS = 60 * 1000; // 1m
const ESCALATION_COOLDOWN_MS = 20 * 60 * 1000;
const AGENT_REFRESH_INTERVAL_MS = 5 * 60 * 1000; // refresh team roles every 5m

// Dynamic agent roster — populated from /team/roles on connect
const discoveredAgents = new Set<string>();
const agentAliases = new Map<string, string>(); // first agent in TEAM-ROLES.yaml = founding agent letter identity
let teamLeadAgent: string | null = null;
let lastAgentRefreshAt = 0;
let agentRefreshTimer: ReturnType<typeof setInterval> | null = null;
let usageHookActive = false; // global guard — onDiagnosticEvent is process-wide, subscribe once
const usageSeenSeqs = new Set<number>(); // dedup: diagnostic events can fire multiple times per seq
let usageSeenCleanupTimer: ReturnType<typeof setInterval> | null = null;

async function refreshAgentRoster(url: string, log?: any): Promise<void> {
  try {
    const response = await fetch(`${url}/team/roles`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      log?.warn?.(`[reflectt][roster] /team/roles returned ${response.status}`);
      return;
    }
    const data = await response.json() as any;
    const agents: Array<{ name?: string; agent?: string; aliases?: string[] }> =
      data?.agents ?? data?.roles ?? (Array.isArray(data) ? data : []);

    if (agents.length === 0) return;

    const newNames = new Set<string>();
    const newAliases = new Map<string, string>();

    for (const a of agents) {
      const name = (a.name || a.agent || "").toLowerCase().trim();
      if (!name) continue;
      newNames.add(name);
      // Register aliases
      if (Array.isArray(a.aliases)) {
        for (const alias of a.aliases) {
          const normalized = String(alias).toLowerCase().trim();
          if (normalized && normalized !== name) {
            newAliases.set(normalized, name);
          }
        }
      }
    }

    // Merge — never remove agents mid-session, only add
    for (const name of newNames) discoveredAgents.add(name);

    // First agent in TEAM-ROLES.yaml is the team lead — the founding "main" agent letter identity
    const firstName = agents[0]?.name?.toLowerCase().trim() ?? agents[0]?.agent?.toLowerCase().trim();
    if (firstName && firstName !== "main") {
      teamLeadAgent = firstName;
    }
    for (const [alias, canonical] of newAliases) agentAliases.set(alias, canonical);

    lastAgentRefreshAt = Date.now();
    log?.info?.(`[reflectt][roster] refreshed: ${newNames.size} agents from /team/roles (total tracked: ${discoveredAgents.size})`);
  } catch (err) {
    log?.warn?.(`[reflectt][roster] refresh failed: ${err}`);
  }
}

function startAgentRefresh(url: string, log?: any) {
  if (agentRefreshTimer) return;
  agentRefreshTimer = setInterval(() => {
    refreshAgentRoster(url, log).catch(() => {});
  }, AGENT_REFRESH_INTERVAL_MS);
}

function stopAgentRefresh() {
  if (agentRefreshTimer) {
    clearInterval(agentRefreshTimer);
    agentRefreshTimer = null;
  }
}

// SSE reconnect config
const SSE_INITIAL_RETRY_MS = 1000;      // start at 1s
const SSE_MAX_RETRY_MS = 30_000;        // cap at 30s
const SSE_SOCKET_TIMEOUT_MS = 30_000;   // detect dead TCP after 30s silence
const SSE_HEALTH_INTERVAL_MS = 15_000;  // health-check ping every 15s

const lastUpdateByAgent = new Map<string, number>();
const lastEscalationAt = new Map<string, number>();
const hasActiveTaskByAgent = new Map<string, { value: boolean; checkedAt: number }>();
const TASK_CACHE_TTL_MS = 2 * 60 * 1000;

// --- Config helpers ---

interface ReflecttAccount {
  accountId: string;
  url: string;
  enabled: boolean;
  configured: boolean;
}

function purgeSessionIndexEntry(agentId: string, sessionKey: string, ctx: any): boolean {
  try {
    const storePath = path.join(os.homedir(), ".openclaw", "agents", agentId, "sessions", "sessions.json");
    if (!fs.existsSync(storePath)) return false;

    const raw = fs.readFileSync(storePath, "utf8");
    const data = JSON.parse(raw || "{}");
    const keyExact = sessionKey;
    const keyLower = sessionKey.toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(data, keyExact) && !Object.prototype.hasOwnProperty.call(data, keyLower)) {
      return false;
    }

    delete data[keyExact];
    delete data[keyLower];
    fs.writeFileSync(storePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    ctx.log?.warn(`[reflectt] Purged stale session index entry for ${sessionKey} at ${storePath}`);
    return true;
  } catch (err) {
    ctx.log?.error(`[reflectt] Failed to purge session entry for ${sessionKey}: ${err}`);
    return false;
  }
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ReflecttAccount {
  const ch = (cfg as any)?.channels?.reflectt ?? {};

  // Support multi-host via accounts map: { "default": { url: "..." }, "backoffice": { url: "..." } }
  const accounts = ch.accounts as Record<string, { url?: string; enabled?: boolean }> | undefined;
  if (accounts && accountId && accounts[accountId]) {
    const acct = accounts[accountId];
    return {
      accountId,
      url: acct.url || DEFAULT_URL,
      enabled: acct.enabled !== false,
      configured: true,
    };
  }

  return {
    accountId: accountId || DEFAULT_ACCOUNT_ID,
    url: ch.url || DEFAULT_URL,
    enabled: ch.enabled !== false,
    configured: true,
  };
}

function listAllAccountIds(cfg: OpenClawConfig): string[] {
  const ch = (cfg as any)?.channels?.reflectt ?? {};
  const accounts = ch.accounts as Record<string, any> | undefined;
  if (accounts) {
    return Object.keys(accounts);
  }
  return [DEFAULT_ACCOUNT_ID];
}

// --- HTTP helpers ---

function postMessage(url: string, from: string, channel: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, channel, content });
    const parsed = new URL(`${url}/chat/messages`);
    const req = httpModule(url).request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === "https:" ? 443 : undefined),
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(); });
    req.on("error", reject);
    req.end(body);
  });
}

function normalizeSenderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase().replace(/^@+/, "");
  return id.length > 0 ? id : null;
}

function markAgentActivity(from: unknown, channel: unknown, timestamp: unknown) {
  if (channel !== "general") return;
  const id = normalizeSenderId(from);
  if (!id || !discoveredAgents.has(id)) return;
  const ts =
    typeof timestamp === "number" && Number.isFinite(timestamp)
      ? timestamp
      : typeof timestamp === "string" && Number.isFinite(Number(timestamp))
        ? Number(timestamp)
        : Date.now();
  const cur = lastUpdateByAgent.get(id) ?? 0;
  if (ts > cur) lastUpdateByAgent.set(id, ts);
}

function shouldEscalate(key: string, now: number): boolean {
  const last = lastEscalationAt.get(key) ?? 0;
  if (now - last < ESCALATION_COOLDOWN_MS) return false;
  lastEscalationAt.set(key, now);
  return true;
}

async function fetchRecentMessages(url: string): Promise<Array<Record<string, unknown>>> {
  const endpoints = ["/chat/messages?limit=500", "/chat/messages", "/messages"];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(`${url}${endpoint}`);
      if (!response.ok) continue;
      const data = await response.json();
      const messages = Array.isArray(data)
        ? data
        : data && typeof data === "object" && Array.isArray((data as { messages?: unknown[] }).messages)
          ? (data as { messages: unknown[] }).messages
          : [];
      return messages.filter((m): m is Record<string, unknown> => Boolean(m) && typeof m === "object");
    } catch {
      // best effort
    }
  }
  return [];
}

async function seedAgentActivity(url: string, log?: any) {
  // Refresh roster before seeding so we track all known agents
  await refreshAgentRoster(url, log).catch(() => {});

  const now = Date.now();
  for (const agent of discoveredAgents) {
    lastUpdateByAgent.set(agent, now);
  }

  const messages = await fetchRecentMessages(url);
  for (const msg of messages) {
    markAgentActivity(msg.from, msg.channel, msg.timestamp);
  }

  log?.info?.(`[reflectt][watchdog] seeded activity from ${messages.length} recent message(s)`);
}

async function hasActiveTask(url: string, agent: string, now = Date.now()): Promise<boolean> {
  const cached = hasActiveTaskByAgent.get(agent);
  if (cached && now - cached.checkedAt < TASK_CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const response = await fetch(`${url}/tasks?assignee=${encodeURIComponent(agent)}&status=todo&limit=1`);
    if (!response.ok) {
      hasActiveTaskByAgent.set(agent, { value: true, checkedAt: now });
      return true;
    }

    const data = await response.json() as { tasks?: unknown[]; total?: number };
    const value = (data?.total ?? data?.tasks?.length ?? 0) > 0;
    hasActiveTaskByAgent.set(agent, { value, checkedAt: now });
    return value;
  } catch {
    // fail-open so task API hiccups do not suppress legitimate nudges
    hasActiveTaskByAgent.set(agent, { value: true, checkedAt: now });
    return true;
  }
}

// --- Dedup ---
const seen = new Set<string>();
function dedup(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 500) { const f = seen.values().next().value; if (f) seen.delete(f); }
  return true;
}

// --- Runtime dispatch telemetry ---
const dispatchCountByMessageId = new Map<string, number>();
function incrementDispatchCount(messageId: string): number {
  const next = (dispatchCountByMessageId.get(messageId) ?? 0) + 1;
  dispatchCountByMessageId.set(messageId, next);
  if (dispatchCountByMessageId.size > 1000) {
    const oldest = dispatchCountByMessageId.keys().next().value;
    if (oldest) dispatchCountByMessageId.delete(oldest);
  }
  return next;
}

// --- SSE connection ---

let sseRequest: http.ClientRequest | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let stopped = false;
let pluginRuntime: any = null;
let currentRetryMs = SSE_INITIAL_RETRY_MS;
let lastSSEDataAt = 0;
let sseConnected = false;

function destroySSE(ctx: any, reason: string) {
  if (sseRequest) {
    ctx.log?.info(`[reflectt] Destroying SSE connection: ${reason}`);
    try { sseRequest.destroy(); } catch {}
    sseRequest = null;
  }
  sseConnected = false;
}

function connectSSE(url: string, account: ReflecttAccount, ctx: any) {
  if (stopped) return;

  // Clean up any lingering connection
  if (sseRequest) {
    destroySSE(ctx, "new connection attempt");
  }

  ctx.log?.info(`[reflectt] Connecting SSE: ${url}/events/subscribe (retry backoff: ${currentRetryMs}ms)`);

  const req = httpModule(url).get(`${url}/events/subscribe`, (res) => {
    if (res.statusCode !== 200) {
      ctx.log?.error(`[reflectt] SSE status ${res.statusCode}`);
      res.resume();
      sseRequest = null;
      scheduleReconnect(url, account, ctx);
      return;
    }

    // Connection succeeded — reset backoff and cancel any stale reconnect timer.
    // A stale timer can fire ~1s after startAccount restarts the channel,
    // destroying the newly-established connection and causing a reconnect loop.
    currentRetryMs = SSE_INITIAL_RETRY_MS;
    sseConnected = true;
    lastSSEDataAt = Date.now();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    ctx.log?.info("[reflectt] SSE connected ✓");

    // Re-seed agent activity after reconnect
    seedAgentActivity(url, ctx.log).catch((err) => {
      ctx.log?.warn?.(`[reflectt] post-reconnect seed failed: ${err}`);
    });

    // NOTE: No socket timeout here — SSE streams are idle by nature.
    // Staleness is detected by the periodic health-check pinger instead.

    let buffer = "";
    res.setEncoding("utf8");

    res.on("data", (chunk: string) => {
      lastSSEDataAt = Date.now();
      buffer += chunk;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";

      for (const frame of frames) {
        if (!frame.trim()) continue;
        let eventType = "", eventData = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) eventType = line.slice(7).trim();
          else if (line.startsWith("data: ")) eventData = line.slice(6);
        }
        if (eventType === "message_posted" && eventData) {
          handleInbound(eventData, url, account, ctx);
        } else if (eventType === "batch" && eventData) {
          try {
            const events = JSON.parse(eventData);
            for (const evt of events) {
              if (evt.type === "message_posted" && evt.data) {
                handleInbound(JSON.stringify(evt.data), url, account, ctx);
              }
            }
          } catch (e) {
            ctx.log?.error(`[reflectt] batch parse error: ${e}`);
          }
        }
      }
    });

    res.on("end", () => {
      ctx.log?.warn("[reflectt] SSE stream ended by server");
      sseRequest = null;
      sseConnected = false;
      scheduleReconnect(url, account, ctx);
    });
    res.on("error", (err) => {
      ctx.log?.error(`[reflectt] SSE response error: ${err.message}`);
      sseRequest = null;
      sseConnected = false;
      scheduleReconnect(url, account, ctx);
    });
  });

  req.on("error", (err) => {
    ctx.log?.error(`[reflectt] SSE connect error: ${err.message}`);
    sseRequest = null;
    sseConnected = false;
    scheduleReconnect(url, account, ctx);
  });

  sseRequest = req;
}

function scheduleReconnect(url: string, account: ReflecttAccount, ctx: any) {
  if (stopped || reconnectTimer) return;

  // Exponential backoff with jitter
  const jitter = Math.random() * currentRetryMs * 0.3;
  const delay = Math.min(currentRetryMs + jitter, SSE_MAX_RETRY_MS);
  ctx.log?.info(`[reflectt] Reconnecting in ${Math.round(delay)}ms`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectSSE(url, account, ctx);
  }, delay);

  // Increase backoff for next attempt
  currentRetryMs = Math.min(currentRetryMs * 2, SSE_MAX_RETRY_MS);
}

/**
 * Periodic health-check: ping /health to detect server availability
 * even when the SSE socket hasn't timed out yet. If the server is up
 * but we're not connected, force a reconnect.
 */
function startHealthCheck(url: string, account: ReflecttAccount, ctx: any) {
  if (healthCheckTimer) return;

  healthCheckTimer = setInterval(async () => {
    if (stopped) return;

    try {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        // Server is alive
        if (!sseConnected && !reconnectTimer) {
          ctx.log?.warn("[reflectt] Health OK but SSE not connected — forcing reconnect");
          currentRetryMs = SSE_INITIAL_RETRY_MS; // reset backoff since server is up
          connectSSE(url, account, ctx);
        }
      }
    } catch {
      // Server unreachable — SSE reconnect loop will handle it
      if (sseConnected) {
        ctx.log?.warn("[reflectt] Health check failed while SSE appears connected — destroying stale connection");
        destroySSE(ctx, "health check failed");
        scheduleReconnect(url, account, ctx);
      }
    }
  }, SSE_HEALTH_INTERVAL_MS);
}

function stopHealthCheck() {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function startWatchdog(url: string, ctx: any) {
  if (watchdogTimer) return;

  watchdogTimer = setInterval(async () => {
    const now = Date.now();
    for (const agent of discoveredAgents) {
      const lastUpdateAt = lastUpdateByAgent.get(agent) ?? now;
      if (now - lastUpdateAt <= IDLE_NUDGE_WINDOW_MS) continue;

      const activeTask = await hasActiveTask(url, agent, now);
      if (!activeTask) {
        ctx.log?.info?.(`[reflectt][watchdog] idle nudge suppressed for @${agent}: no active task`);
        continue;
      }

      const key = `idle:${agent}`;
      if (!shouldEscalate(key, now)) continue;

      const content = `@${agent} idle nudge: no update in #general for 15m+. Post shipped / blocker / next+ETA now.`;
      try {
        await postMessage(url, "watchdog", "general", content);
        ctx.log?.info?.(`[reflectt][watchdog] idle nudge fired for @${agent} (last=${lastUpdateAt})`);
      } catch (err) {
        ctx.log?.warn?.(`[reflectt][watchdog] idle nudge failed for @${agent}: ${err}`);
      }
    }
  }, WATCHDOG_INTERVAL_MS);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
}

function handleInbound(data: string, url: string, account: ReflecttAccount, ctx: any) {
  try {
    const msg = JSON.parse(data);
    const content: string = msg.content || "";
    const msgId: string = msg.id || "";
    const from: string = msg.from || "unknown";
    const channel: string = msg.channel || "general";

    // Re-enabled by operator request: system/watchdog messages should be dispatch-eligible.
    // Keep activity tracking consistent for all senders.
    markAgentActivity(from, channel, msg.timestamp);

    if (!msgId) return;
    if (!dedup(msgId)) {
      ctx.log?.debug(`[reflectt][dispatch-telemetry] duplicate inbound ignored message_id=${msgId}`);
      return;
    }

    // Extract @mentions
    const mentions: string[] = [];
    const regex = /@([\w-]+)/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) mentions.push(match[1].toLowerCase());
    if (mentions.length === 0) return;

    // Build agent ID map
    const cfg = pluginRuntime?.config?.loadConfig?.() ?? {};
    const agentList: Array<{ id: string; identity?: { name?: string } }> = cfg?.agents?.list || [];
    const agentIds = new Set<string>();
    const agentNameToId = new Map<string, string>();
    for (const a of agentList) {
      agentIds.add(a.id);
      agentNameToId.set(a.id, a.id);
      if (a.identity?.name) {
        const name = a.identity.name.toLowerCase();
        agentIds.add(name);
        agentNameToId.set(name, a.id);
      }
    }

    // Determine sender's agent ID (if message is from an agent)
    const senderAgentId = agentNameToId.get(from.toLowerCase());

    // Find mentioned agent
    ctx.log?.debug(`[reflectt] Processing mentions: ${mentions.join(", ")}`);
    let matchedMentions = 0;
    let skippedSelfMentions = 0;
    let unmatchedMentions = 0;
    const dispatchedTargets: string[] = [];
    const dispatchedSet = new Set<string>();

    for (const mention of mentions) {
      let agentId: string | undefined;
      for (const a of agentList) {
        if (a.id === mention) { agentId = a.id; break; }
        if (a.identity?.name?.toLowerCase() === mention) { agentId = a.id; break; }
      }
      // Route @mentions of the team lead to the founding "main" session
      if (!agentId && teamLeadAgent && mention === teamLeadAgent) agentId = "main";
      // Check discovered agents from /team/roles if not in openclaw config
      if (!agentId && discoveredAgents.has(mention)) agentId = mention;
      // Check aliases
      if (!agentId && agentAliases.has(mention)) agentId = agentAliases.get(mention)!;
      if (!agentId) {
        unmatchedMentions += 1;
        ctx.log?.debug(`[reflectt] Mention @${mention} did not match any agent`);
        continue;
      }

      // Skip routing to yourself (avoid self-loops)
      if (senderAgentId && agentId === senderAgentId) {
        skippedSelfMentions += 1;
        ctx.log?.debug(`[reflectt] Skipping self-mention: @${agentId}`);
        continue;
      }

      if (dispatchedSet.has(agentId)) {
        ctx.log?.debug(`[reflectt] Skipping duplicate mention target: @${agentId}`);
        continue;
      }

      matchedMentions += 1;
      dispatchedSet.add(agentId);
      ctx.log?.info(`[reflectt] ${from} → @${agentId}: ${content.slice(0, 60)}...`);

      // Build inbound message context
      const runtime = pluginRuntime;
      if (!runtime?.channel?.reply) continue;

      // All reflectt rooms share one session per agent (peer: null).
      // Room identity is preserved in OriginatingTo so replies route correctly.
      const sessionKey = `agent:${agentId}:reflectt:main`;
      
      // Create message context
      const msgContext = {
        Body: content,
        BodyForAgent: content,
        CommandBody: content,
        BodyForCommands: content,
        From: `reflectt:${channel}`,
        To: channel,
        SessionKey: sessionKey,
        AccountId: account.accountId,
        MessageSid: msgId,
        ChatType: "group",
        ConversationLabel: `reflectt-node #${channel}`,
        SenderName: from,
        SenderId: from,
        Timestamp: msg.timestamp || Date.now(),
        Provider: "reflectt",
        Surface: "reflectt",
        OriginatingChannel: "reflectt" as const,
        OriginatingTo: channel,
        WasMentioned: true,
        CommandAuthorized: false,
      };

      // Finalize context
      const finalizedCtx = runtime.channel.reply.finalizeInboundContext(msgContext);

      // Guard against stale/unsafe session path metadata leaking from prior context.
      // OpenClaw now enforces that any session file path must be under the agent sessions dir.
      const safeCtx: any = { ...finalizedCtx };
      delete safeCtx.SessionFilePath;
      delete safeCtx.sessionFilePath;
      delete safeCtx.SessionPath;
      delete safeCtx.sessionPath;
      delete safeCtx.TranscriptPath;
      delete safeCtx.transcriptPath;
      delete safeCtx.SessionFile;
      delete safeCtx.sessionFile;

      // Create reply dispatcher
      const agentName = agentId === "main" ? (teamLeadAgent ?? agentId) : agentId;
      const dispatcher = runtime.channel.reply.createReplyDispatcherWithTyping({
        deliver: async (payload: any) => {
          const text = payload.text || payload.content || "";
          if (text) {
            ctx.log?.info(`[reflectt] Reply → ${channel}: ${text.slice(0, 60)}...`);
            await postMessage(url, agentName!, channel, text);
          }
        },
        onError: (err: unknown) => {
          ctx.log?.error(`[reflectt] Dispatch error: ${err}`);
        },
      });

      // Dispatch reply using OpenClaw's pipeline
      const dispatchCount = incrementDispatchCount(msgId);
      dispatchedTargets.push(agentId);
      ctx.log?.info(
        `[reflectt][dispatch-telemetry] message_id=${msgId} dispatch_count=${dispatchCount} target=${agentId} mentions_total=${mentions.length}`,
      );

      runtime.channel.reply.dispatchReplyFromConfig({
        ctx: safeCtx,
        cfg,
        dispatcher: dispatcher.dispatcher,
        replyOptions: dispatcher.replyOptions,
      }).catch((err: unknown) => {
        const errText = String(err ?? "");
        if (errText.includes("Session file path must be within sessions directory")) {
          const healed = purgeSessionIndexEntry(agentId!, sessionKey, ctx);
          if (healed) {
            ctx.log?.warn(`[reflectt] Retrying dispatch after purging stale session entry: ${sessionKey}`);
            runtime.channel.reply.dispatchReplyFromConfig({
              ctx: safeCtx,
              cfg,
              dispatcher: dispatcher.dispatcher,
              replyOptions: dispatcher.replyOptions,
            }).catch((retryErr: unknown) => {
              ctx.log?.error(`[reflectt] dispatch retry failed: ${retryErr}`);
            });
            return;
          }
        }
        ctx.log?.error(`[reflectt] dispatchReplyFromConfig error: ${err}`);
      });
    }

    ctx.log?.info(
      `[reflectt][dispatch-telemetry] summary message_id=${msgId} mentions_total=${mentions.length} matched=${matchedMentions} unmatched=${unmatchedMentions} skipped_self=${skippedSelfMentions} dispatched=${dispatchedTargets.length} targets=${dispatchedTargets.join(",") || "none"}`,
    );
  } catch (err) {
    ctx.log?.error(`[reflectt] Parse error: ${err}`);
  }
}

// --- Channel Plugin ---

const reflecttPlugin: ChannelPlugin<ReflecttAccount> = {
  id: "reflectt",
  meta: {
    id: "reflectt",
    label: "Reflectt",
    selectionLabel: "Reflectt (Local)",
    docsPath: "/channels/reflectt",
    docsLabel: "reflectt",
    blurb: "Real-time agent collaboration via reflectt-node",
    order: 110,
  },
  capabilities: {
    chatTypes: ["group"],
    media: false,
  },
  // configPrefixes drive gateway.startAccount re-invocation:
  //  - "channels.reflectt": channel config edits restart SSE/watchdog
  //  - "models" / "providers" / "auth": model-truth changes (provider auth,
  //    registry, defaults) re-publish the bounded ModelsEnvelope to the node
  reload: { configPrefixes: ["channels.reflectt", "models", "providers", "auth"] },

  config: {
    listAccountIds: () => {
      const cfg = pluginRuntime?.config?.loadConfig?.() ?? {};
      return listAllAccountIds(cfg);
    },
    resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: "Reflectt",
      enabled: account.enabled,
      configured: account.configured,
    }),
  },

  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }) => {
      const cfg = pluginRuntime?.config?.loadConfig?.() ?? {};
      const account = resolveAccount(cfg, accountId);
      // Determine agent name for "from" field
      const agentName = teamLeadAgent ?? "main";
      await postMessage(account.url, agentName, "general", text ?? "");
      return { channel: "reflectt" as const, to, messageId: `rn-${Date.now()}` };
    },
  },

  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.enabled) return;

      stopped = false;
      ctx.setStatus({
        accountId: account.accountId,
        name: "Reflectt",
        enabled: true,
        configured: true,
      });

      // Connect to all configured accounts (multi-host support)
      const cfg = pluginRuntime?.config?.loadConfig?.() ?? {};
      const allIds = listAllAccountIds(cfg);
      const allAccounts = allIds.map(id => resolveAccount(cfg, id)).filter(a => a.enabled);

      for (const acct of allAccounts) {
        ctx.log?.info(`[reflectt] Connecting to ${acct.accountId} at ${acct.url}`);
        seedAgentActivity(acct.url, ctx.log).catch((err) => {
          ctx.log?.warn?.(`[reflectt][watchdog] seed failed for ${acct.accountId}: ${err}`);
        });
      }
      // Primary account gets watchdog, agent refresh, health check
      startAgentRefresh(account.url, ctx.log);
      startWatchdog(account.url, ctx);
      startHealthCheck(account.url, account, ctx);

      // Connect SSE to all accounts
      for (const acct of allAccounts) {
        connectSSE(acct.url, acct, ctx);
      }

      // ── Models capability publish-up ─────────────────────────────────────────
      // Build the bounded ModelsEnvelope from in-process OpenClaw truth and
      // POST to each account's /openclaw/models/publish. Re-fires on every
      // startAccount, including reload.configPrefixes triggers (models,
      // providers, auth). Adapter failure publishes a degraded ok:false
      // envelope — never silent, never subprocess fallback.
      //
      // Kill switch: REFLECTT_DISABLE_MODELS_PUBLISH=1 skips the publish-up
      // path entirely. Temporary staging-only diagnostic (task-gk6wyuwkg /
      // task-1777061555422-f0odgq5wh) — used to confirm or discard the
      // hypothesis that the plugin's in-process adapter load is implicated
      // in the managed-host embedded/tool-call crash. Do NOT treat this
      // flag as a permanent fix without kai's sign-off on the verdict.
      if (process.env.REFLECTT_DISABLE_MODELS_PUBLISH === "1") {
        ctx.log?.warn?.(
          "[reflectt][models] publish-up SKIPPED — REFLECTT_DISABLE_MODELS_PUBLISH=1 set (diagnostic kill switch)",
        );
      } else {
        for (const acct of allAccounts) {
          publishModelsCatalog({ url: acct.url, log: ctx.log }).catch((err) => {
            ctx.log?.warn?.(`[reflectt][models] publish threw for ${acct.accountId}: ${err}`);
          });
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      // ── Usage reporting: forward model.usage diagnostic events to reflectt-node ──
      // onDiagnosticEvent is global (not per-account), so only subscribe once.
      let unsubUsage: (() => void) | null = null;
      if (!usageHookActive && typeof onDiagnosticEvent === "function") {
        const primaryUrl = account.url;
        ctx.log?.info(`[reflectt] Usage reporting: hooking onDiagnosticEvent → ${primaryUrl}/usage/report`);
        // Track last seen cumulative totals per session to compute per-call deltas
        const lastSeen = new Map<string, { input: number; output: number }>();
        usageHookActive = true;
        // Periodic cleanup of seen seqs (keep last 5 minutes)
        usageSeenCleanupTimer = setInterval(() => {
          if (usageSeenSeqs.size > 10000) usageSeenSeqs.clear();
        }, 300_000);
        unsubUsage = onDiagnosticEvent((evt: any) => {
          if (evt.type !== "model.usage") return;
          // Dedup by seq number — same event can fire multiple times
          if (typeof evt.seq === "number") {
            if (usageSeenSeqs.has(evt.seq)) return;
            usageSeenSeqs.add(evt.seq);
          }
          const agentId = extractAgentFromSessionKey(evt.sessionKey || "");
          if (!agentId) return;

          const cumulative = evt.usage || {};
          const lastCall = evt.lastCallUsage;
          const sessionKey = evt.sessionKey || "unknown";

          let inputTokens: number;
          let outputTokens: number;

          // Use lastCallUsage when available (per-call), else delta from cumulative
          const src = lastCall || cumulative;
          if (lastCall) {
            inputTokens = (lastCall.input || 0) + (lastCall.cacheRead || 0) + (lastCall.cacheWrite || 0);
            outputTokens = lastCall.output || 0;
          } else {
            const prev = lastSeen.get(sessionKey) || { input: 0, output: 0 };
            const curInput = (cumulative.input || 0) + (cumulative.cacheRead || 0) + (cumulative.cacheWrite || 0);
            const curOutput = cumulative.output || 0;
            inputTokens = Math.max(0, curInput - prev.input);
            outputTokens = Math.max(0, curOutput - prev.output);
          }

          // Update cumulative tracker (include cache in input total)
          lastSeen.set(sessionKey, {
            input: (cumulative.input || 0) + (cumulative.cacheRead || 0) + (cumulative.cacheWrite || 0),
            output: cumulative.output || 0,
          });

          if (inputTokens === 0 && outputTokens === 0) return;

          const cacheRead = src.cacheRead || 0;
          const cacheWrite = src.cacheWrite || 0;

          const body = JSON.stringify({
            agent: agentId,
            model: evt.model || "unknown",
            provider: evt.provider || "unknown",
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            estimated_cost_usd: evt.costUsd ?? undefined,
            category: "chat",
            timestamp: evt.ts || Date.now(),
            metadata: {
              source: "reflectt-channel-plugin",
              session_key: sessionKey,
              cache_read: cacheRead,
              cache_write: cacheWrite,
              cache_read_tokens: cacheRead,
              cache_write_tokens: cacheWrite,
              raw_input_tokens: src.input || 0,
              duration_ms: evt.durationMs,
            },
          });

          const req = httpModule(primaryUrl).request(
            `${primaryUrl}/usage/report`,
            { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: 5000 },
            (res) => { res.resume(); },
          );
          req.on("error", () => {});
          req.end(body);
        });
      }

      return {
        stop: () => {
          stopped = true;
          stopAgentRefresh();
          stopWatchdog();
          stopHealthCheck();
          if (unsubUsage) { unsubUsage(); unsubUsage = null; usageHookActive = false; usageSeenSeqs.clear(); }
          if (usageSeenCleanupTimer) { clearInterval(usageSeenCleanupTimer); usageSeenCleanupTimer = null; }
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          destroySSE(ctx, "plugin stopped");
          ctx.log?.info("[reflectt] Stopped");
        },
      };
    },
  },
};

// ── Cloud → channel → node identity write bridge ───────────────────────────
//
// Per kai's lock 2026-04-22 (write_seam_decision_2026_04_22_2324 on
// task-1776815665086-ebfbj898x): cloud sends agent-identity edits to this
// plugin HTTP route on the OpenClaw gateway listener. The handler bridges
// to reflectt-node `PATCH /agents/:name/identity` so reads and writes stay
// on one source of truth.
//
// The route lives under `/api/channels/...` so the gateway's
// `isProtectedPluginRoutePath` predicate auto-enforces gateway-token auth
// (no per-handler auth code needed).

const IDENTITY_ROUTE_PREFIX = "/api/channels/reflectt/agents/";
const IDENTITY_ROUTE_SUFFIX = "/identity";

function parseAgentNameFromIdentityPath(pathname: string): string | null {
  if (!pathname.startsWith(IDENTITY_ROUTE_PREFIX)) return null;
  if (!pathname.endsWith(IDENTITY_ROUTE_SUFFIX)) return null;
  const middle = pathname.slice(IDENTITY_ROUTE_PREFIX.length, -IDENTITY_ROUTE_SUFFIX.length);
  if (!middle || middle.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(middle);
    if (!decoded || /[\s/?#]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 256 * 1024; // 256KB cap — identity payloads are tiny
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > MAX) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleIdentityWrite(params: {
  api: OpenClawPluginApi;
  req: http.IncomingMessage;
  res: http.ServerResponse;
  agentName: string;
}): Promise<void> {
  const { api, req, res, agentName } = params;
  const acct = resolveAccount(api.config);
  const nodeUrl = acct.url;

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    res.statusCode = 413;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, error: String((err as Error).message ?? err) }));
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": req.headers["content-type"] || "application/json",
  };
  const ifMatch = req.headers["if-match"];
  if (typeof ifMatch === "string" && ifMatch) headers["If-Match"] = ifMatch;

  let upstream: Response;
  try {
    upstream = await fetch(`${nodeUrl}/agents/${encodeURIComponent(agentName)}/identity`, {
      method: "PATCH",
      headers,
      body: body || "{}",
    });
  } catch (err) {
    api.logger.warn(`[reflectt] identity write bridge: node unreachable at ${nodeUrl}: ${String(err)}`);
    res.statusCode = 502;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      success: false,
      error: "reflectt-node unreachable",
      detail: String((err as Error).message ?? err),
    }));
    return;
  }

  const upstreamBody = await upstream.text();
  res.statusCode = upstream.status;
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("Content-Type", ct);
  res.end(upstreamBody);
}

async function dispatchIdentityRequest(
  api: OpenClawPluginApi,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "PUT" && method !== "PATCH") {
    res.statusCode = 405;
    res.setHeader("Allow", "PUT, PATCH");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, error: `method ${method} not allowed on identity bridge` }));
    return;
  }
  await handleIdentityWrite({ api, req, res, agentName });
}

// ── Cloud → channel agent-detail read bridges (Phase 1) ───────────────────
//
// Per kai's lane lock 2026-04-23 (msg-1776931994885): node stays runtime-only,
// workspace files belong to OpenClaw. These two routes surface the workspace
// files needed by the agent-detail panel — `SOUL.md`, `HEARTBEAT.md`, `USER.md`
// for the editable/displayable file fields, and a metadata-only memory index
// for the memory axis.
//
// Both routes live under `/api/channels/...` so the gateway's
// `isProtectedPluginRoutePath` predicate auto-enforces gateway-token Bearer
// auth (no per-handler auth needed).

const FILES_ROUTE_SUFFIX = "/files";
const MEMORY_ROUTE_SUFFIX = "/memory";
const READ_FILE_MAX_BYTES = 400 * 1024; // 400KB per file — well above realistic SOUL/HEARTBEAT/USER sizes
const MEMORY_INDEX_MAX_ENTRIES = 500; // generous; pane lazy-loads

/** Names of files we expose under `/files`. Any new file requires an explicit allowlist update. */
const ALLOWED_FILE_NAMES = ["SOUL.md", "HEARTBEAT.md", "USER.md"] as const;
type AllowedFileName = (typeof ALLOWED_FILE_NAMES)[number];

function parseAgentNameFromSuffixedPath(pathname: string, suffix: string): string | null {
  if (!pathname.startsWith(IDENTITY_ROUTE_PREFIX)) return null;
  if (!pathname.endsWith(suffix)) return null;
  const middle = pathname.slice(IDENTITY_ROUTE_PREFIX.length, -suffix.length);
  if (!middle || middle.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(middle);
    if (!decoded || /[\s/?#]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function agentWorkspaceRoot(agentName: string): string {
  return path.join(os.homedir(), ".openclaw", "agents", agentName);
}

/** Resolve a path, then verify the realpath is contained inside `root`. Returns null if outside. */
function resolveContained(root: string, candidate: string): string | null {
  try {
    const realRoot = fs.realpathSync(root);
    const resolved = path.resolve(realRoot, candidate);
    let realResolved: string;
    try {
      realResolved = fs.realpathSync(resolved);
    } catch {
      // File may not exist yet — fall back to the lexical resolution as the boundary check.
      realResolved = resolved;
    }
    const rel = path.relative(realRoot, realResolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
    return realResolved;
  } catch {
    return null;
  }
}

interface FileFieldValue {
  found: boolean;
  bytes: number;
  truncated: boolean;
  content: string | null;
  modifiedAt: number | null;
  hint?: string;
}

function readAllowedFile(root: string, name: AllowedFileName): FileFieldValue {
  const resolved = resolveContained(root, name);
  if (!resolved) return { found: false, bytes: 0, truncated: false, content: null, modifiedAt: null, hint: "path resolution failed" };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch (err: any) {
    if (err?.code === "ENOENT") return { found: false, bytes: 0, truncated: false, content: null, modifiedAt: null };
    return { found: false, bytes: 0, truncated: false, content: null, modifiedAt: null, hint: String(err?.code ?? err) };
  }
  if (!stat.isFile()) return { found: false, bytes: 0, truncated: false, content: null, modifiedAt: null, hint: "not a regular file" };
  const truncated = stat.size > READ_FILE_MAX_BYTES;
  let content: string | null = null;
  try {
    if (truncated) {
      const fd = fs.openSync(resolved, "r");
      try {
        const buf = Buffer.alloc(READ_FILE_MAX_BYTES);
        const n = fs.readSync(fd, buf, 0, READ_FILE_MAX_BYTES, 0);
        content = buf.subarray(0, n).toString("utf8");
      } finally {
        fs.closeSync(fd);
      }
    } else {
      content = fs.readFileSync(resolved, "utf8");
    }
  } catch (err: any) {
    return { found: true, bytes: stat.size, truncated, content: null, modifiedAt: stat.mtimeMs, hint: String(err?.code ?? err) };
  }
  return { found: true, bytes: stat.size, truncated, content, modifiedAt: stat.mtimeMs };
}

async function handleAgentFilesRead(params: {
  res: http.ServerResponse;
  agentName: string;
}): Promise<void> {
  const { res, agentName } = params;
  const root = agentWorkspaceRoot(agentName);
  let workspaceExists = true;
  try {
    fs.statSync(root);
  } catch (err: any) {
    if (err?.code === "ENOENT") workspaceExists = false;
  }

  const fields: Record<AllowedFileName, FileFieldValue> = {
    "SOUL.md": readAllowedFile(root, "SOUL.md"),
    "HEARTBEAT.md": readAllowedFile(root, "HEARTBEAT.md"),
    "USER.md": readAllowedFile(root, "USER.md"),
  };

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    success: true,
    agent: agentName,
    workspaceExists,
    source: "openclaw",
    maxBytes: READ_FILE_MAX_BYTES,
    fields,
  }));
}

interface MemoryEntry {
  name: string;
  bytes: number;
  modifiedAt: number;
}

async function handleAgentMemoryRead(params: {
  res: http.ServerResponse;
  agentName: string;
}): Promise<void> {
  const { res, agentName } = params;
  const root = agentWorkspaceRoot(agentName);
  const memDir = path.join(root, "memory");
  const resolved = resolveContained(root, "memory");
  if (!resolved) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, agent: agentName, source: "openclaw", entries: [], hint: "memory dir path resolution failed" }));
    return;
  }
  let dirExists = true;
  try {
    const st = fs.statSync(resolved);
    if (!st.isDirectory()) dirExists = false;
  } catch (err: any) {
    if (err?.code === "ENOENT") dirExists = false;
    else {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, agent: agentName, source: "openclaw", entries: [], hint: String(err?.code ?? err) }));
      return;
    }
  }
  if (!dirExists) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, agent: agentName, source: "openclaw", memoryDir: memDir, entries: [] }));
    return;
  }

  let names: string[] = [];
  try {
    names = fs.readdirSync(resolved);
  } catch (err: any) {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: true, agent: agentName, source: "openclaw", entries: [], hint: String(err?.code ?? err) }));
    return;
  }

  const entries: MemoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    if (name.startsWith(".")) continue;
    const full = resolveContained(resolved, name);
    if (!full) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    entries.push({ name, bytes: st.size, modifiedAt: st.mtimeMs });
  }
  entries.sort((a, b) => b.modifiedAt - a.modifiedAt);
  const trimmed = entries.slice(0, MEMORY_INDEX_MAX_ENTRIES);

  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({
    success: true,
    agent: agentName,
    source: "openclaw",
    memoryDir: memDir,
    entries: trimmed,
    truncated: entries.length > trimmed.length,
    totalCount: entries.length,
  }));
}

async function dispatchFilesRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, error: `method ${method} not allowed on files read bridge` }));
    return;
  }
  await handleAgentFilesRead({ res, agentName });
}

async function dispatchMemoryRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ success: false, error: `method ${method} not allowed on memory read bridge` }));
    return;
  }
  await handleAgentMemoryRead({ res, agentName });
}

// ── Cloud → channel agent-config bridge (Phase 2 write seam) ──────────────
//
// Per kai's lane lock 2026-04-23 (msg-1776941258132): OpenClaw config IS the
// truth source for agent optimization surfaces (primary model, fallbacks,
// thinking level). Defaults live in `agents.defaults.{model, thinkingDefault}`,
// per-agent overrides live in `agents.list[id].model`. No node SQLite, no env
// var defaults — read/write the real config through the supported plugin SDK
// surface (`runtime.config.loadConfig` + `writeConfigFile`).
//
// Per-agent thinkingLevel is currently NOT supported by AgentEntrySchema in
// OpenClaw config (strict zod schema). We expose it as readonly per-agent
// with an honest hint, rather than inventing a side-channel.
//
// Protected by the gateway's `isProtectedPluginRoutePath` predicate so the
// gateway-token Bearer is enforced upstream of the handler.

const CONFIG_ROUTE_PREFIX = "/api/channels/reflectt/agent-configs/";

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
type FieldSource = "override" | "default" | "unset";
type FieldSupport = "editable" | "readonly";

interface SupportedField<T> {
  value?: T;
  effective: T | null;
  support: FieldSupport;
  source: FieldSource;
  hint?: string;
}

interface ResolvedAgentConfig {
  agentId: string;
  revision: string;
  fields: {
    model: SupportedField<string>;
    fallbackModels: SupportedField<string[]>;
    thinkingLevel: SupportedField<ThinkingLevel>;
  };
}

const THINKING_LEVELS = new Set<ThinkingLevel>([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

const PER_AGENT_THINKING_HINT =
  "thinkingLevel per-agent override is not supported by the OpenClaw AgentEntrySchema; update agents.defaults.thinkingDefault to change the global default";

function parseAgentNameFromConfigPath(pathname: string): string | null {
  if (!pathname.startsWith(CONFIG_ROUTE_PREFIX)) return null;
  const tail = pathname.slice(CONFIG_ROUTE_PREFIX.length);
  if (!tail || tail.includes("/")) return null;
  try {
    const decoded = decodeURIComponent(tail);
    if (!decoded || /[\s/?#]/.test(decoded)) return null;
    return decoded;
  } catch {
    return null;
  }
}

function modelPrimary(m: unknown): string | undefined {
  if (typeof m === "string") return m;
  if (m && typeof m === "object" && "primary" in m) {
    const p = (m as { primary?: unknown }).primary;
    return typeof p === "string" ? p : undefined;
  }
  return undefined;
}

function modelFallbacks(m: unknown): string[] | undefined {
  if (m && typeof m === "object" && !Array.isArray(m) && "fallbacks" in m) {
    const f = (m as { fallbacks?: unknown }).fallbacks;
    if (Array.isArray(f) && f.every((s) => typeof s === "string")) return f as string[];
  }
  return undefined;
}

function findEntry(cfg: OpenClawConfig, agentId: string): { model?: unknown } | undefined {
  const list = (cfg as any)?.agents?.list;
  if (!Array.isArray(list)) return undefined;
  return list.find((a: any) => a && a.id === agentId);
}

function field<T>(params: {
  override?: T;
  defaultValue?: T;
  support: FieldSupport;
  hint?: string;
}): SupportedField<T> {
  const { override, defaultValue, support, hint } = params;
  let source: FieldSource;
  if (override !== undefined) source = "override";
  else if (defaultValue !== undefined) source = "default";
  else source = "unset";
  const effective = (override ?? defaultValue ?? null) as T | null;
  const out: SupportedField<T> = { effective, support, source };
  if (override !== undefined) out.value = override;
  if (hint) out.hint = hint;
  return out;
}

function configRevision(slice: unknown): string {
  // sha1 is plenty for revision (collision-resistant enough for optimistic concurrency on a small slice)
  // Lazy require so we don't pay for crypto unless this code path runs.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHash } = require("node:crypto");
  return createHash("sha1").update(JSON.stringify(slice)).digest("hex").slice(0, 16);
}

function buildResolvedAgentConfig(cfg: OpenClawConfig, agentId: string): ResolvedAgentConfig {
  const defaults = (cfg as any)?.agents?.defaults ?? {};
  const entry = findEntry(cfg, agentId);

  const overrideModel = modelPrimary(entry?.model);
  const defaultModel = modelPrimary(defaults.model);
  const overrideFallbacks = modelFallbacks(entry?.model);
  const defaultFallbacks = modelFallbacks(defaults.model);
  const defaultThinking =
    typeof defaults.thinkingDefault === "string" && THINKING_LEVELS.has(defaults.thinkingDefault as ThinkingLevel)
      ? (defaults.thinkingDefault as ThinkingLevel)
      : undefined;

  // Slice only the bytes the API actually exposes — revision rotates only on observable changes.
  const slice = {
    defaults: {
      model: defaults.model ?? null,
      thinkingDefault: defaults.thinkingDefault ?? null,
    },
    entry: { model: entry?.model ?? null },
  };

  return {
    agentId,
    revision: configRevision(slice),
    fields: {
      model: field<string>({ override: overrideModel, defaultValue: defaultModel, support: "editable" }),
      fallbackModels: field<string[]>({
        override: overrideFallbacks,
        defaultValue: defaultFallbacks,
        support: "editable",
      }),
      thinkingLevel: field<ThinkingLevel>({
        override: undefined,
        defaultValue: defaultThinking,
        support: "readonly",
        hint: PER_AGENT_THINKING_HINT,
      }),
    },
  };
}

function jsonResponse(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function handleConfigGet(api: OpenClawPluginApi, res: http.ServerResponse, agentName: string): Promise<void> {
  let cfg: OpenClawConfig;
  try {
    cfg = api.runtime.config.loadConfig();
  } catch (err) {
    api.logger.warn(`[reflectt] config read failed: ${String((err as Error).message ?? err)}`);
    jsonResponse(res, 500, { success: false, error: "config_read_failed", detail: String((err as Error).message ?? err) });
    return;
  }
  const resolved = buildResolvedAgentConfig(cfg, agentName);
  jsonResponse(res, 200, { success: true, resolved });
}

async function handleConfigPatch(
  api: OpenClawPluginApi,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): Promise<void> {
  let body: string;
  try {
    body = await readRequestBody(req);
  } catch (err) {
    jsonResponse(res, 413, { success: false, error: String((err as Error).message ?? err) });
    return;
  }

  let parsed: { ifMatch?: unknown; updates?: unknown };
  try {
    parsed = body ? JSON.parse(body) : {};
  } catch {
    jsonResponse(res, 400, { success: false, error: "invalid_json" });
    return;
  }

  const ifMatch = parsed.ifMatch;
  if (typeof ifMatch !== "string" || !ifMatch) {
    jsonResponse(res, 400, { success: false, error: "ifMatch_required" });
    return;
  }
  const updates = (parsed.updates ?? {}) as Record<string, unknown>;
  if (typeof updates !== "object" || updates === null || Array.isArray(updates)) {
    jsonResponse(res, 400, { success: false, error: "updates_must_be_object" });
    return;
  }

  let cfg: OpenClawConfig;
  try {
    cfg = api.runtime.config.loadConfig();
  } catch (err) {
    jsonResponse(res, 500, { success: false, error: "config_read_failed", detail: String((err as Error).message ?? err) });
    return;
  }

  const current = buildResolvedAgentConfig(cfg, agentName);
  if (current.revision !== ifMatch) {
    jsonResponse(res, 412, { success: false, error: "precondition_failed", current });
    return;
  }

  if ("thinkingLevel" in updates) {
    jsonResponse(res, 422, {
      success: false,
      error: "unsupported_field",
      field: "thinkingLevel",
      hint: PER_AGENT_THINKING_HINT,
    });
    return;
  }

  // Validate proposed update shapes before mutating
  if ("model" in updates) {
    const v = updates.model;
    if (v !== null && v !== undefined && typeof v !== "string") {
      jsonResponse(res, 400, { success: false, error: "model_must_be_string_or_null" });
      return;
    }
  }
  if ("fallbackModels" in updates) {
    const v = updates.fallbackModels;
    if (v !== null && v !== undefined) {
      if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
        jsonResponse(res, 400, { success: false, error: "fallbackModels_must_be_string_array_or_null" });
        return;
      }
    }
  }

  // Deep-clone via JSON round-trip so we don't mutate the cached config object
  const next = JSON.parse(JSON.stringify(cfg)) as OpenClawConfig;
  const nextAny = next as any;
  if (!nextAny.agents) nextAny.agents = {};
  if (!Array.isArray(nextAny.agents.list)) nextAny.agents.list = [];
  let entry = nextAny.agents.list.find((a: any) => a && a.id === agentName);
  if (!entry) {
    entry = { id: agentName };
    nextAny.agents.list.push(entry);
  }

  // Normalize current per-agent model into object form for in-place edits
  let nextModel: { primary?: string; fallbacks?: string[] } | undefined;
  if (typeof entry.model === "string") nextModel = { primary: entry.model };
  else if (entry.model && typeof entry.model === "object") nextModel = { ...entry.model };
  else nextModel = undefined;

  if ("model" in updates) {
    const v = updates.model;
    if (v === null || v === undefined) {
      if (nextModel) delete nextModel.primary;
    } else {
      nextModel = { ...(nextModel ?? {}), primary: v as string };
    }
  }
  if ("fallbackModels" in updates) {
    const v = updates.fallbackModels;
    if (v === null || v === undefined) {
      if (nextModel) delete nextModel.fallbacks;
    } else {
      nextModel = { ...(nextModel ?? {}), fallbacks: v as string[] };
    }
  }

  const hasPrimary = nextModel?.primary !== undefined;
  const hasFallbacks = !!nextModel?.fallbacks && nextModel.fallbacks.length > 0;
  if (nextModel && (hasPrimary || hasFallbacks)) {
    entry.model = nextModel;
  } else {
    delete entry.model;
  }

  try {
    await api.runtime.config.writeConfigFile(next);
  } catch (err) {
    api.logger.warn(`[reflectt] config write failed for ${agentName}: ${String((err as Error).message ?? err)}`);
    jsonResponse(res, 500, {
      success: false,
      error: "config_write_failed",
      detail: String((err as Error).message ?? err),
    });
    return;
  }

  // writeConfigFile clears the config cache, so loadConfig returns fresh state
  let updatedCfg: OpenClawConfig;
  try {
    updatedCfg = api.runtime.config.loadConfig();
  } catch (err) {
    jsonResponse(res, 500, { success: false, error: "config_reread_failed", detail: String((err as Error).message ?? err) });
    return;
  }
  const updated = buildResolvedAgentConfig(updatedCfg, agentName);
  jsonResponse(res, 200, { success: true, resolved: updated });
}

async function dispatchConfigRequest(
  api: OpenClawPluginApi,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agentName: string,
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET") {
    await handleConfigGet(api, res, agentName);
    return;
  }
  if (method === "PATCH") {
    await handleConfigPatch(api, req, res, agentName);
    return;
  }
  res.statusCode = 405;
  res.setHeader("Allow", "GET, PATCH");
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ success: false, error: `method ${method} not allowed on agent-config bridge` }));
}

function registerAgentConfigHttpBridge(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: CONFIG_ROUTE_PREFIX,
    auth: "gateway",
    match: "prefix",
    replaceExisting: true,
    handler: async (req, res) => {
      if (!req.url) {
        jsonResponse(res, 400, { success: false, error: "missing request url" });
        return;
      }
      const url = new URL(req.url, "http://localhost");
      const agentName = parseAgentNameFromConfigPath(url.pathname);
      if (!agentName) {
        jsonResponse(res, 404, { success: false, error: "not found" });
        return;
      }
      await dispatchConfigRequest(api, req, res, agentName);
    },
  });
}

// Single registration covering all three agent-detail bridges (identity write,
// files read, memory index read) under the shared `/api/channels/reflectt/agents/`
// prefix. Migrated from the removed `api.registerHttpHandler(...)` chain pattern
// to `api.registerHttpRoute({ match: "prefix" })` per OpenClaw 2026.4.x SDK.
// Auth `gateway` so the OpenClaw gateway-token Bearer is enforced upstream of
// the handler.
function registerAgentDetailHttpBridges(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: IDENTITY_ROUTE_PREFIX,
    auth: "gateway",
    match: "prefix",
    replaceExisting: true,
    handler: async (req, res) => {
      if (!req.url) {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, error: "missing request url" }));
        return;
      }
      const url = new URL(req.url, "http://localhost");

      const identityAgent = parseAgentNameFromIdentityPath(url.pathname);
      if (identityAgent) {
        await dispatchIdentityRequest(api, req, res, identityAgent);
        return;
      }

      const filesAgent = parseAgentNameFromSuffixedPath(url.pathname, FILES_ROUTE_SUFFIX);
      if (filesAgent) {
        await dispatchFilesRequest(req, res, filesAgent);
        return;
      }

      const memoryAgent = parseAgentNameFromSuffixedPath(url.pathname, MEMORY_ROUTE_SUFFIX);
      if (memoryAgent) {
        await dispatchMemoryRequest(req, res, memoryAgent);
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, error: "not found" }));
    },
  });
}

// --- Plugin entry ---

const plugin = {
  id: "reflectt-channel",
  name: "Reflectt Channel",
  description: "Real-time agent collaboration via reflectt-node SSE",

  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    api.logger.info("[reflectt] Registering channel plugin");
    api.registerChannel({ plugin: reflecttPlugin });
    registerAgentDetailHttpBridges(api);
    api.logger.info(`[reflectt] Registered agent-detail bridges at ${IDENTITY_ROUTE_PREFIX} (suffixes: ${IDENTITY_ROUTE_SUFFIX}, ${FILES_ROUTE_SUFFIX}, ${MEMORY_ROUTE_SUFFIX})`);
    registerAgentConfigHttpBridge(api);
    api.logger.info(`[reflectt] Registered agent-config bridge at ${CONFIG_ROUTE_PREFIX}`);
  },
};

export default plugin;
