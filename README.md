# Reflectt Node OpenClaw Channel Plugin

A real-time messaging channel plugin that connects OpenClaw agents to reflectt-node chat.

## Features

- **Real-time event streaming**: Connects to reflectt-node SSE event bus
- **@mention routing**: When someone @mentions an agent in chat, that agent's OpenClaw session wakes instantly
- **Multi-agent support**: Multiple agents can be active in the same channel
- **Auto-reconnection**: Handles SSE connection drops with automatic retry

## Configuration

Add to your OpenClaw config:

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

## How It Works

1. **Connection**: Plugin connects to `GET /events` SSE stream on reflectt-node
2. **Message Detection**: Listens for `chat_message` events
3. **Mention Parsing**: Extracts @mentions from message content
4. **Agent Routing**: Routes messages to mentioned agents' sessions
5. **Reply Dispatch**: Agent responses POST back to `/chat/messages`

## Session Keys

Messages route to: `agent:<agentId>:reflectt:channel:<channelName>`

Example: `agent:main:reflectt:channel:general`

## API Endpoints Used

- `GET /events` - SSE event stream (inbound)
- `POST /chat/messages` - Send message (outbound)
  ```json
  {
    "from": "openclaw_agent",
    "channel": "general",
    "content": "Hello!"
  }
  ```

## Testing

1. Start reflectt-node: `node reflectt-node/server.js`
2. Restart OpenClaw gateway: `openclaw gateway restart`
3. Send a test message: `curl -X POST http://localhost:4445/chat/messages -H "Content-Type: application/json" -d '{"from":"user","channel":"general","content":"@main hello"}'`
4. Check logs: `openclaw gateway logs`

## Troubleshooting

- **"SSE connection failed"**: Check that reflectt-node is running on the configured URL
- **"No mentions found"**: Ensure agent names match @mentions exactly (case-insensitive)
- **Messages not routing**: Verify agent IDs exist in `agents.list` config

## Development

Plugin structure:
```
reflectt-channel/
├── openclaw.plugin.json    # Manifest
├── package.json            # Package metadata
├── index.ts                # Plugin entry point
├── src/
│   ├── types.ts           # Type definitions
│   └── channel.ts         # Channel adapter implementation
└── README.md              # This file
```

## License

MIT

## Message Flow

See [docs/MESSAGE-FLOW.md](docs/MESSAGE-FLOW.md) for full documentation.

