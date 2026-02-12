/**
 * reflectt-channel — OpenClaw channel plugin
 * 
 * Connects to reflectt-node SSE. When a message @mentions an agent,
 * it routes through OpenClaw's inbound pipeline. Agent responses are
 * POSTed back to reflectt-node automatically.
 */
import type { OpenClawPluginApi, ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, buildChannelConfigSchema } from "openclaw/plugin-sdk";
import http from "node:http";

const DEFAULT_URL = "http://127.0.0.1:4445";

// --- Config helpers ---

interface ReflecttAccount {
  accountId: string;
  url: string;
  enabled: boolean;
  configured: boolean;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ReflecttAccount {
  const ch = (cfg as any)?.channels?.reflectt ?? {};
  return {
    accountId: accountId || DEFAULT_ACCOUNT_ID,
    url: ch.url || DEFAULT_URL,
    enabled: ch.enabled !== false,
    configured: true,
  };
}

// --- HTTP helpers ---

function postMessage(url: string, from: string, channel: string, content: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ from, channel, content });
    const parsed = new URL(`${url}/chat/messages`);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => { res.resume(); resolve(); });
    req.on("error", reject);
    req.end(body);
  });
}

// --- Dedup ---
const seen = new Set<string>();
function dedup(id: string): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (seen.size > 500) { const f = seen.values().next().value; if (f) seen.delete(f); }
  return true;
}

// --- SSE connection ---

let sseRequest: http.ClientRequest | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let pluginRuntime: any = null;

function connectSSE(url: string, account: ReflecttAccount, ctx: any) {
  if (stopped || sseRequest) return;

  ctx.log?.info(`[reflectt] Connecting SSE: ${url}/events/subscribe`);

  const req = http.get(`${url}/events/subscribe`, (res) => {
    if (res.statusCode !== 200) {
      ctx.log?.error(`[reflectt] SSE ${res.statusCode}`);
      res.resume();
      scheduleReconnect(url, account, ctx);
      return;
    }
    ctx.log?.info("[reflectt] SSE connected ✓");

    let buffer = "";
    res.setEncoding("utf8");

    res.on("data", (chunk: string) => {
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

    res.on("end", () => { sseRequest = null; scheduleReconnect(url, account, ctx); });
    res.on("error", () => { sseRequest = null; scheduleReconnect(url, account, ctx); });
  });

  req.on("error", (err) => {
    ctx.log?.error(`[reflectt] SSE error: ${err.message}`);
    sseRequest = null;
    scheduleReconnect(url, account, ctx);
  });

  sseRequest = req;
}

function scheduleReconnect(url: string, account: ReflecttAccount, ctx: any) {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connectSSE(url, account, ctx); }, 5000);
}

function handleInbound(data: string, url: string, account: ReflecttAccount, ctx: any) {
  try {
    const msg = JSON.parse(data);
    const content: string = msg.content || "";
    const msgId: string = msg.id || "";
    const from: string = msg.from || "unknown";
    const channel: string = msg.channel || "general";

    if (!msgId || !dedup(msgId)) return;

    // Extract @mentions
    const mentions: string[] = [];
    const regex = /@(\w+)/g;
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
    for (const mention of mentions) {
      let agentId: string | undefined;
      for (const a of agentList) {
        if (a.id === mention) { agentId = a.id; break; }
        if (a.identity?.name?.toLowerCase() === mention) { agentId = a.id; break; }
      }
      if (!agentId && mention === "kai") agentId = "main";
      if (!agentId) {
        ctx.log?.debug(`[reflectt] Mention @${mention} did not match any agent`);
        continue;
      }

      // Skip routing to yourself (avoid self-loops)
      if (senderAgentId && agentId === senderAgentId) {
        ctx.log?.debug(`[reflectt] Skipping self-mention: @${agentId}`);
        continue;
      }

      ctx.log?.info(`[reflectt] ${from} → @${agentId}: ${content.slice(0, 60)}...`);

      // Build inbound message context
      const runtime = pluginRuntime;
      if (!runtime?.channel?.reply) continue;

      const sessionKey = `agent:${agentId}:reflectt:channel:${channel}`;
      
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

      // Create reply dispatcher
      const agentName = agentId === "main" ? "kai" : agentId;
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
      runtime.channel.reply.dispatchReplyFromConfig({
        ctx: finalizedCtx,
        cfg,
        dispatcher: dispatcher.dispatcher,
        replyOptions: dispatcher.replyOptions,
      }).catch((err: unknown) => {
        ctx.log?.error(`[reflectt] dispatchReplyFromConfig error: ${err}`);
      });
    }
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
  reload: { configPrefixes: ["channels.reflectt"] },

  config: {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
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
      const agentName = "kai"; // TODO: resolve from session context
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

      connectSSE(account.url, account, ctx);

      return {
        stop: () => {
          stopped = true;
          if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
          if (sseRequest) { sseRequest.destroy(); sseRequest = null; }
          ctx.log?.info("[reflectt] Stopped");
        },
      };
    },
  },
};

// --- Plugin entry ---

const plugin = {
  id: "reflectt-channel",
  name: "Reflectt Channel",
  description: "Real-time agent collaboration via reflectt-node SSE",

  register(api: OpenClawPluginApi) {
    pluginRuntime = api.runtime;
    api.logger.info("[reflectt] Registering channel plugin");
    api.registerChannel({ plugin: reflecttPlugin });
  },
};

export default plugin;
