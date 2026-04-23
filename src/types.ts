/**
 * Types for reflectt-node integration
 */

export type ReflecttConfig = {
  enabled?: boolean;
  url?: string;
  /** Optional GitHub username → agent name remapping (e.g. { "myorg-bot": "lead" }).
   *  No defaults — configure per-host as needed. */
  githubMentionRemap?: Record<string, string>;
  /** Agent id or name that receives messages with no @-mention. Without this,
   *  unaddressed messages would silently drop on the floor. Falls back to the
   *  first agent in cfg.agents.list when unset. */
  defaultAgent?: string;
};

export type ResolvedReflecttAccount = {
  accountId: string;
  enabled: boolean;
  config: ReflecttConfig;
  url: string;
};

export type ReflecttChatMessage = {
  id: string;
  from: string;
  channel: string;
  content: string;
  timestamp: number;
  mentions?: string[];
};

export type ReflecttEvent = {
  type: "chat_message" | "system" | "agent_status";
  data: ReflecttChatMessage | Record<string, unknown>;
};
