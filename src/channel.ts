import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedReflecttAccount, ReflecttConfig } from "./types.js";

const DEFAULT_REFLECTT_URL = "http://localhost:4445";

// ── GitHub mention remapping ───────────────────────────────────────────────
// Map GitHub usernames → agent names for incoming webhook messages.
// Configured per-host via channels.reflectt.githubMentionRemap in openclaw.json.
// No defaults — do not hardcode team-specific accounts here.
function remapGitHubMentions(text: string, remap: Record<string, string>): string {
  if (!text) return text;
  let result = text;
  for (const [githubUser, agentName] of Object.entries(remap)) {
    result = result.replace(new RegExp(`@${githubUser}\\b`, "gi"), `@${agentName}`);
  }
  return result;
}

// ── SSE singleton guard ────────────────────────────────────────────────────
// Ensures only one active SSE connection exists at a time.
// Without this, each startAccount call (config reload, server restart) stacks
// a new SSE listener on top of existing ones — causing N-times delivery.
let _activeSseController: AbortController | null = null;

function acquireSseSlot(): AbortController {
  if (_activeSseController) {
    _activeSseController.abort();
  }
  _activeSseController = new AbortController();
  return _activeSseController;
}

function releaseSseSlot(controller: AbortController): void {
  if (_activeSseController === controller) {
    _activeSseController = null;
  }
}
// ──────────────────────────────────────────────────────────────────────────

/** Fetch the current team roster from the node. Falls back to empty array on error. */
async function fetchWatchedAgents(url: string): Promise<string[]> {
  try {
    const res = await fetch(`${url}/team/roles`);
    if (!res.ok) return [];
    const data = await res.json() as { agents?: Array<{ name: string }> };
    return (data?.agents ?? []).map((a) => a.name).filter(Boolean);
  } catch {
    return [];
  }
}

const IDLE_NUDGE_WINDOW_MS = 15 * 60 * 1000; // 15m
const WATCHDOG_INTERVAL_MS = 60 * 1000; // 1m poll
const ESCALATION_COOLDOWN_MS = 20 * 60 * 1000; // anti-spam

type WatchdogState = {
  lastUpdateByAgent: Map<string, number>;
  lastEscalationAt: Map<string, number>;
};

function normalizeSenderId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const id = value.trim().toLowerCase();
  return id.length > 0 ? id : null;
}

function shouldEscalate(state: WatchdogState, key: string, now: number): boolean {
  const last = state.lastEscalationAt.get(key) ?? 0;
  if (now - last < ESCALATION_COOLDOWN_MS) return false;
  state.lastEscalationAt.set(key, now);
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

async function seedWatchdogState(url: string, state: WatchdogState, watchedAgents: string[]): Promise<void> {
  const now = Date.now();
  const watchedSet = new Set(watchedAgents);
  for (const agent of watchedAgents) {
    state.lastUpdateByAgent.set(agent, now);
  }

  const messages = await fetchRecentMessages(url);
  for (const msg of messages) {
    const channel = typeof msg.channel === "string" ? msg.channel : "";
    if (channel !== "general") continue;

    const senderId = normalizeSenderId(msg.from);
    if (!senderId || !watchedSet.has(senderId)) continue;

    const rawTs = msg.timestamp;
    const ts =
      typeof rawTs === "number" && Number.isFinite(rawTs)
        ? rawTs
        : typeof rawTs === "string" && Number.isFinite(Number(rawTs))
          ? Number(rawTs)
          : now;

    const current = state.lastUpdateByAgent.get(senderId) ?? 0;
    if (ts > current) state.lastUpdateByAgent.set(senderId, ts);
  }
}

async function postWatchdogNudge(url: string, agent: string): Promise<void> {
  await fetch(`${url}/chat/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "watchdog",
      channel: "general",
      content: `@${agent} idle nudge: no update in #general for 15m+. Post shipped / blocker / next+ETA now.`,
      timestamp: Date.now(),
    }),
  });
}

function resolveReflecttAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedReflecttAccount {
  const { cfg, accountId } = params;
  const effectiveAccountId = accountId || DEFAULT_ACCOUNT_ID;
  
  const channelConfig = (cfg.channels?.reflectt as ReflecttConfig) || {};
  const enabled = channelConfig.enabled !== false;
  const url = channelConfig.url || DEFAULT_REFLECTT_URL;

  return {
    accountId: effectiveAccountId,
    enabled,
    config: channelConfig,
    url,
  };
}

export const reflecttPlugin: ChannelPlugin<ResolvedReflecttAccount> = {
  id: "reflectt-channel",
  meta: {
    id: "reflectt-channel",
    label: "Reflectt Node",
    selectionLabel: "Reflectt Node (local)",
    docsPath: "/channels/reflectt",
    blurb: "Real-time messaging via reflectt-node event stream.",
    aliases: ["reflectt"],
  },
  capabilities: {
    chatTypes: ["direct", "channel"],
    media: false,
    reactions: false,
    threads: false,
    polls: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: {
    configPrefixes: ["channels.reflectt"],
  },
  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: (cfg, accountId) => resolveReflecttAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.url),
    isEnabled: (account) => account.enabled,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: "Reflectt Node",
      enabled: account.enabled,
      configured: Boolean(account.url),
    }),
  },
  outbound: {
    deliveryMode: "direct",
    sendText: async (ctx) => {
      const account = resolveReflecttAccount({ cfg: ctx.cfg, accountId: ctx.accountId });
      
      try {
        const response = await fetch(`${account.url}/chat/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            from: "openclaw_agent",
            channel: ctx.to || "general",
            content: ctx.text,
          }),
        });

        if (!response.ok) {
          return {
            ok: false,
            error: new Error(`Failed to send message: ${response.statusText}`),
          };
        }

        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error : new Error(String(error)),
        };
      }
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { cfg, account, runtime, abortSignal, log } = ctx;
      
      log?.info?.(`Starting reflectt channel monitor: ${account.url}`);

      // ── Acquire exclusive SSE slot ─────────────────────────────────────────
      // Cancels any previously-running SSE connection from a prior startAccount
      // invocation (config reload / server restart) before starting a new one.
      const sseController = acquireSseSlot();
      // Merge caller's abortSignal with our singleton controller
      const mergedSignal = AbortSignal.any
        ? AbortSignal.any([abortSignal, sseController.signal])
        : sseController.signal;

      abortSignal.addEventListener("abort", () => releaseSseSlot(sseController));
      // ─────────────────────────────────────────────────────────────────────

      const watchdogState: WatchdogState = {
        lastUpdateByAgent: new Map(),
        lastEscalationAt: new Map(),
      };

      // Fetch current team roster from node — no hardcoded agent names
      let watchedAgents: string[] = [];
      try {
        watchedAgents = await fetchWatchedAgents(account.url);
        await seedWatchdogState(account.url, watchdogState, watchedAgents);
      } catch (error) {
        log?.warn?.(`Failed to seed watchdog state: ${error}`);
      }
      let watchedSet = new Set(watchedAgents);

      const watchdogTimer = setInterval(async () => {
        const now = Date.now();
        // Refresh roster periodically so new agents added via PUT /config/team-roles are picked up
        if (now % (5 * 60 * 1000) < 60_000) {
          watchedAgents = await fetchWatchedAgents(account.url).catch(() => watchedAgents);
          watchedSet = new Set(watchedAgents);
        }

        for (const agent of watchedAgents) {
          const lastUpdateAt = watchdogState.lastUpdateByAgent.get(agent) ?? now;
          if (now - lastUpdateAt <= IDLE_NUDGE_WINDOW_MS) continue;

          const key = `idle:${agent}`;
          if (!shouldEscalate(watchdogState, key, now)) continue;

          try {
            await postWatchdogNudge(account.url, agent);
            log?.info?.(`[reflectt-channel] idle nudge fired for @${agent} (last=${lastUpdateAt})`);
          } catch (error) {
            log?.warn?.(`[reflectt-channel] idle nudge failed for @${agent}: ${error}`);
          }
        }
      }, WATCHDOG_INTERVAL_MS);

      mergedSignal.addEventListener("abort", () => {
        clearInterval(watchdogTimer);
      });

      // Connect to SSE event stream
      const connectSSE = async () => {
        try {
          const response = await fetch(`${account.url}/events`, {
            signal: mergedSignal,
          });

          if (!response.ok) {
            throw new Error(`SSE connection failed: ${response.statusText}`);
          }

          const reader = response.body?.getReader();
          const decoder = new TextDecoder();

          if (!reader) {
            throw new Error("No response body available");
          }

          let buffer = "";

          while (!mergedSignal.aborted) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.trim() || line.startsWith(":")) continue;

              if (line.startsWith("data: ")) {
                const data = line.slice(6);

                try {
                  const event = JSON.parse(data);
                  const message = event?.data ?? event?.message;

                  if ((event.type === "chat_message" || event.type === "message") && message) {
                    const senderId = normalizeSenderId(message.from);
                    if (senderId && watchedSet.has(senderId) && message.channel === "general") {
                      const rawTs = message.timestamp;
                      const ts =
                        typeof rawTs === "number" && Number.isFinite(rawTs)
                          ? rawTs
                          : typeof rawTs === "string" && Number.isFinite(Number(rawTs))
                            ? Number(rawTs)
                            : Date.now();
                      watchdogState.lastUpdateByAgent.set(senderId, ts);
                    }

                    await handleChatMessage(message, cfg, runtime, log);
                  }
                } catch (parseError) {
                  log?.warn?.(`Failed to parse SSE data: ${parseError}`);
                }
              }
            }
          }
        } catch (error) {
          if (mergedSignal.aborted) {
            log?.info?.("SSE connection closed (aborted)");
            return;
          }

          log?.error?.(`SSE connection error: ${error}`);

          // Retry after delay if not aborted
          if (!mergedSignal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (!mergedSignal.aborted) {
              log?.info?.("Reconnecting to reflectt SSE stream...");
              await connectSSE();
            }
          }
        }
      };

      await connectSSE();
    },
    stopAccount: async (ctx) => {
      ctx.log?.info?.("Stopping reflectt channel monitor");
      // Abort signal will handle cleanup
    },
  },
};

async function handleChatMessage(
  message: any,
  cfg: OpenClawConfig,
  runtime: any,
  log: any,
) {
  try {
    const { from, channel, content, timestamp, id } = message;
    const rawContent = typeof content === "string" ? content : "";
    // Remap GitHub account mentions using per-host config (channels.reflectt.githubMentionRemap)
    const mentionRemap = (cfg.channels?.reflectt as ReflecttConfig | undefined)?.githubMentionRemap ?? {};
    const safeContent = remapGitHubMentions(rawContent, mentionRemap);
    const safeChannel = typeof channel === "string" ? channel : "general";

    // Check if message mentions an agent
    const explicitMentions = extractAgentMentions(safeContent, cfg);
    let mentionedAgents = explicitMentions;
    let routedToDefault = false;

    if (mentionedAgents.length === 0) {
      // No mention → fall back to the configured default agent. Without this
      // the message drops on the floor, which is the bug agents hit when they
      // post status/updates without @-tagging anyone.
      const defaultAgent = resolveDefaultAgent(cfg);
      if (!defaultAgent) {
        log?.warn?.(`[reflectt-channel] dropping unaddressed message from ${from} in ${safeChannel} — no defaultAgent configured and no agents in cfg.agents.list`);
        return;
      }
      mentionedAgents = [defaultAgent];
      routedToDefault = true;
    }

    log?.info?.(`Processing reflectt message from ${from} in ${safeChannel} (${routedToDefault ? `default→${mentionedAgents[0]}` : `mentions: ${mentionedAgents.join(", ")}`})`);

    // Route to each mentioned agent
    for (const agentId of mentionedAgents) {
      try {
        // Resolve agent route — all reflectt rooms share one session per agent.
        // Room identity is preserved in To/OriginatingTo so replies route correctly.
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "reflectt",
          accountId: "default",
          peer: null,
        });

        // Build envelope-formatted body
        const body = runtime.channel.reply.formatInboundEnvelope({
          channel: "Reflectt",
          from: from,
          timestamp: new Date(timestamp || Date.now()),
          envelope: runtime.channel.reply.resolveEnvelopeFormatOptions({ cfg, channel: "reflectt" }),
          body: safeContent,
        });

        // Finalize inbound context
        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: safeContent,
          CommandBody: safeContent,
          From: from,
          To: safeChannel,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "channel",
          GroupSubject: safeChannel,
          SenderName: from,
          SenderId: from,
          Provider: "reflectt",
          Surface: "reflectt",
          MessageSid: id || String(timestamp || Date.now()),
          Timestamp: timestamp || Date.now(),
          WasMentioned: !routedToDefault,
          CommandAuthorized: true,
          OriginatingChannel: "reflectt",
          OriginatingTo: safeChannel,
        });

        // Create reply dispatcher
        const dispatcher = {
          deliver: async (payload: any) => {
            const account = resolveReflecttAccount({ cfg, accountId: route.accountId });
            
            // Send text messages back to reflectt-node
            if (payload.text) {
              await fetch(`${account.url}/chat/messages`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  from: agentId,
                  channel: safeChannel,
                  content: payload.text,
                }),
              });
            }
          },
          onError: (err: unknown) => {
            log?.error?.(`Reflectt reply error: ${err}`);
          },
        };

        // Dispatch reply
        await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: ctxPayload,
          cfg,
          dispatcherOptions: dispatcher,
        });

        log?.info?.(`Dispatched reflectt message to agent ${agentId}`);
      } catch (agentError) {
        log?.error?.(`Error dispatching to agent ${agentId}: ${agentError}`);
      }
    }
  } catch (error) {
    log?.error?.(`Error handling chat message: ${error}`);
  }
}

/** Resolve the default agent id used when an inbound message has no @-mention.
 *  Prefers `cfg.channels.reflectt.defaultAgent` (matched by id or name).
 *  Falls back to the first agent in `cfg.agents.list` so a fresh host with
 *  one agent still routes correctly without per-host config. */
function resolveDefaultAgent(cfg: OpenClawConfig): string | null {
  const agents = cfg.agents?.list ?? [];
  if (agents.length === 0) return null;

  const configured = (cfg.channels?.reflectt as ReflecttConfig | undefined)?.defaultAgent;
  if (configured) {
    const wanted = configured.toLowerCase();
    for (const agent of agents) {
      if (agent.id === configured || agent.name?.toLowerCase() === wanted) {
        return agent.id;
      }
    }
  }

  return agents[0]?.id ?? null;
}

function extractAgentMentions(content: string, cfg: OpenClawConfig): string[] {
  const mentions: string[] = [];
  const mentionPattern = /@(\w+)/g;
  
  let match;
  while ((match = mentionPattern.exec(content)) !== null) {
    const mentionedName = match[1];
    
    // Check if this matches an agent
    const agents = cfg.agents?.list || [];
    for (const agent of agents) {
      if (agent.id === mentionedName || agent.name?.toLowerCase() === mentionedName.toLowerCase()) {
        mentions.push(agent.id);
      }
    }
  }

  return [...new Set(mentions)]; // dedupe
}
