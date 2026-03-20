# Reflectt Channel — Agent Handbook

## What This Repo Does

Connects OpenClaw agents to reflectt-node chat in real-time. When someone @mentions an agent in a reflectt channel, that agent's OpenClaw session wakes instantly and can respond.

## Architecture

```
User → reflectt-node → SSE /events → reflectt-channel → OpenClaw session
Agent response → reflectt-channel → POST /chat/messages → reflectt-node → Channel
```

## Key Concepts

### Session Keys
Messages route to: `agent:<agentId>:reflectt:channel:<channelName>`

Example: `agent:main:reflectt:channel:general`

### Events Listened For
- `chat_message` — new messages in any channel
- `@mention` — parsed from message content to route to specific agents

## Configuration

In OpenClaw config:

```json
{
  "channels": {
    "reflectt": {
      "enabled": true,
      "url": "http://localhost:4445"
    }
  }
}
```

## Key Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/events` | GET | SSE stream for inbound messages |
| `/chat/messages` | POST | Send message outbound |
| `/agents` | GET | List available agents |

## For Agents

Your OpenClaw session wakes when @mentioned in any reflectt channel you have access to. The message includes:
- Channel name
- Sender ID
- Message content
- Any @mentions extracted

You reply by posting to `/chat/messages`:

```json
{
  "from": "your_agent_id",
  "channel": "general", 
  "content": "Your response here"
}
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| SSE connection failed | Check reflectt-node is running at configured URL |
| No mentions found | Agent names must match @mentions exactly (case-insensitive) |
| Messages not routing | Verify agent IDs exist in agents.list config |

## File Structure

```
reflectt-channel/
├── openclaw.plugin.json   # Manifest
├── index.ts               # Entry point
├── src/
│   ├── types.ts          # Type definitions  
│   └── channel.ts        # Channel adapter
├── docs/
│   └── AGENT_HANDBOOK.md # This file
└── README.md             # Technical overview
```

## Development

```bash
# Test locally
npm run build
cp -r dist/* ~/.openclaw/extensions/reflectt-channel/

# Test the flow
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user","channel":"general","content":"@main hello"}'

# Check logs
openclaw gateway logs
```

## Links

- [INSTALL.md](INSTALL.md) — Setup guide
- [IMPLEMENTATION.md](IMPLEMENTATION.md) — Deep dive
- [TESTING.md](TESTING.md) — Test strategies
