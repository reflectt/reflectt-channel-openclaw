# Testing Guide: Reflectt-Node OpenClaw Channel Plugin

## Prerequisites

1. **reflectt-node running** on `http://localhost:4445`
2. **OpenClaw Gateway** installed and configured
3. **At least one agent** configured in `agents.list`

## Step 1: Enable the Plugin

Add to your OpenClaw config (`~/.openclaw/config.json`):

```json
{
  "channels": {
    "reflectt": {
      "enabled": true,
      "url": "http://localhost:4445"
    }
  },
  "agents": {
    "list": [
      {
        "id": "main",
        "name": "Main Agent",
        "default": true
      }
    ]
  }
}
```

## Step 2: Restart the Gateway

```bash
openclaw gateway restart
```

Check the logs to verify the plugin loaded:

```bash
openclaw gateway logs | grep reflectt
```

Expected output:
```
Registering reflectt-node channel plugin
Starting reflectt channel monitor: http://localhost:4445
Reflectt-node channel plugin registered successfully
```

## Step 3: Send a Test Message

### Via curl:

```bash
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{
    "from": "test_user",
    "channel": "general",
    "content": "@main Hello! Can you hear me?"
  }'
```

### Via reflectt-node web UI:

1. Navigate to `http://localhost:3000` (or your chat UI)
2. Type: `@main Hello! Can you hear me?`
3. Send

## Step 4: Verify Processing

Check the gateway logs for the mention routing:

```bash
openclaw gateway logs --follow
```

Expected log entries:
```
Processing reflectt message from test_user in general (mentions: main)
Dispatched reflectt message to agent main
```

## Step 5: Check for Response

The agent's response should appear in reflectt-node chat:

```bash
curl http://localhost:4445/chat/messages?channel=general&limit=10
```

You should see the agent's reply in the response list.

## Test Cases

### TC1: Single Agent Mention
```bash
# Send message
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main what is 2+2?"}'

# Expected: Agent responds with answer
```

### TC2: Multiple Agent Mentions
```bash
# Configure two agents first
# Then send:
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main @link tell me about yourselves"}'

# Expected: Both agents respond
```

### TC3: No Mention (Should Be Ignored)
```bash
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"Hello everyone!"}'

# Expected: No agent response (no mention)
```

### TC4: Wrong Agent Name
```bash
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@nonexistent hello"}'

# Expected: No agent response (agent doesn't exist)
```

### TC5: Different Channels
```bash
# Send to channel "team-chat"
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"team-chat","content":"@main status update?"}'

# Expected: Agent responds in team-chat channel
# Session key: agent:main:reflectt:channel:team-chat
```

### TC6: SSE Reconnection Test
```bash
# 1. Start gateway with plugin
openclaw gateway restart

# 2. Send a message (should work)
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main test 1"}'

# 3. Restart reflectt-node
# Gateway should reconnect automatically after 5 seconds

# 4. Send another message (should still work)
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main test 2"}'

# Expected: Both messages get responses
# Logs show "Reconnecting to reflectt SSE stream..."
```

## Debugging

### Plugin Not Loading

```bash
# Check if plugin is discovered
openclaw plugins list | grep reflectt

# Check plugin info
openclaw plugins info reflectt

# Check for errors
openclaw gateway logs | grep -i error
```

### Messages Not Routing

```bash
# Enable verbose logging (if available)
export OPENCLAW_LOG_LEVEL=debug

# Restart gateway
openclaw gateway restart

# Check routing logic
openclaw gateway logs | grep -E "Processing reflectt|Dispatched"
```

### Agent Not Responding

```bash
# Check agent configuration
openclaw config get agents.list

# Check session keys
openclaw gateway logs | grep "SessionKey"

# Verify agent is enabled
openclaw config get agents.list[0].enabled
```

### SSE Connection Issues

```bash
# Test SSE endpoint manually
curl -N http://localhost:4445/events

# Should stream events (keep connection open)
# Press Ctrl+C to stop

# If this fails, reflectt-node SSE endpoint is not working
```

## Performance Testing

### Load Test: Multiple Messages
```bash
for i in {1..10}; do
  curl -X POST http://localhost:4445/chat/messages \
    -H "Content-Type: application/json" \
    -d "{\"from\":\"user$i\",\"channel\":\"general\",\"content\":\"@main test $i\"}" &
done
wait

# Expected: All messages processed, all agents respond
```

### Session Isolation Test
```bash
# Send to different channels
curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main remember: general channel"}'

curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"team","content":"@main remember: team channel"}'

curl -X POST http://localhost:4445/chat/messages \
  -H "Content-Type: application/json" \
  -d '{"from":"user1","channel":"general","content":"@main what did I tell you to remember?"}'

# Expected: Agent only remembers "general channel" (session isolation works)
```

## Success Criteria

✅ Plugin loads without errors  
✅ SSE connection established to reflectt-node  
✅ Messages with @mentions route to correct agents  
✅ Agent responses appear in reflectt-node chat  
✅ Different channels maintain separate sessions  
✅ Reconnection works after reflectt-node restart  
✅ No memory leaks or connection leaks  

## Troubleshooting Checklist

- [ ] reflectt-node is running on the configured URL
- [ ] OpenClaw config has `channels.reflectt.enabled: true`
- [ ] At least one agent is configured in `agents.list`
- [ ] Agent ID matches the @mention (case-sensitive)
- [ ] Gateway has been restarted after config changes
- [ ] SSE endpoint is accessible: `curl http://localhost:4445/events`
- [ ] No firewall blocking localhost:4445
- [ ] Node.js version supports fetch API (18+)

## Next Steps

Once basic functionality is verified:
1. Test with chat.reflectt.ai web UI
2. Configure multiple agents
3. Test long-running sessions
4. Monitor memory usage over time
5. Add custom agent behaviors for reflectt channel
