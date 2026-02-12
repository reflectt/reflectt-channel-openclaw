import type { ChannelPlugin, OpenClawConfig } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { ResolvedReflecttAccount, ReflecttConfig } from "./types.js";

const DEFAULT_REFLECTT_URL = "http://localhost:4445";

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

      // Connect to SSE event stream
      const connectSSE = async () => {
        try {
          const response = await fetch(`${account.url}/events`, {
            signal: abortSignal,
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

          while (!abortSignal.aborted) {
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
                  
                  if (event.type === "chat_message") {
                    await handleChatMessage(event.data, cfg, runtime, log);
                  }
                } catch (parseError) {
                  log?.warn?.(`Failed to parse SSE data: ${parseError}`);
                }
              }
            }
          }
        } catch (error) {
          if (abortSignal.aborted) {
            log?.info?.("SSE connection closed (aborted)");
            return;
          }
          
          log?.error?.(`SSE connection error: ${error}`);
          
          // Retry after delay if not aborted
          if (!abortSignal.aborted) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            if (!abortSignal.aborted) {
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

    // Check if message mentions an agent
    const mentionedAgents = extractAgentMentions(content, cfg);
    
    if (mentionedAgents.length === 0) {
      // No mentions, ignore
      return;
    }

    log?.info?.(`Processing reflectt message from ${from} in ${channel} (mentions: ${mentionedAgents.join(", ")})`);

    // Route to each mentioned agent
    for (const agentId of mentionedAgents) {
      try {
        // Resolve agent route
        const route = runtime.channel.routing.resolveAgentRoute({
          cfg,
          channel: "reflectt",
          accountId: "default",
          peer: { kind: "channel", id: channel },
        });

        // Build envelope-formatted body
        const body = runtime.channel.reply.formatInboundEnvelope({
          channel: "Reflectt",
          from: from,
          timestamp: new Date(timestamp || Date.now()),
          envelope: runtime.channel.reply.resolveEnvelopeFormatOptions({ cfg, channel: "reflectt" }),
          body: content,
        });

        // Finalize inbound context
        const ctxPayload = runtime.channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: content,
          CommandBody: content,
          From: from,
          To: channel,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: "channel",
          GroupSubject: channel,
          SenderName: from,
          SenderId: from,
          Provider: "reflectt",
          Surface: "reflectt",
          MessageSid: id || String(timestamp || Date.now()),
          Timestamp: timestamp || Date.now(),
          WasMentioned: true,
          CommandAuthorized: true,
          OriginatingChannel: "reflectt",
          OriginatingTo: channel,
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
                  channel: channel,
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
