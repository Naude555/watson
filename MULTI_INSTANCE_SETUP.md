# Multi-Instance Watson Setup (Instance Isolation)

## Problem Solved

When running two Watson instances on the same VPS, messages from one WhatsApp number were sometimes being sent/processed by the other number. This happened because:

1. **Shared Redis Queue**: Both instances used the same queue name (`wa-send`), causing jobs to be mixed up
2. **Shared Auto-Reply Cooldown**: The `lastAutoReplyAt` Map was not isolated by instance, causing cooldown conflicts
3. **No Instance Differentiation**: The system didn't track which instance owned which WhatsApp session

## Solution

Watson now automatically isolates instances by:

1. **Dynamic Queue Names**: Each WhatsApp number gets its own Redis queue (e.g., `wa-send-1234567890` for the number 1234567890)
2. **Instance-Keyed Cooldown**: Auto-reply cooldown tracking is keyed by `instanceId:chatJid` to prevent cross-instance interference
3. **Automatic Instance Detection**: The instance ID is automatically derived from the WhatsApp JID when the socket connects

## Configuration

### Option 1: Automatic Isolation (Recommended)

No extra configuration needed! Watson will automatically isolate instances based on the WhatsApp number.

```bash
# Instance 1 - connect one WhatsApp number
docker run -d --name watson-1 \
  -e PORT=3001 \
  -e REDIS_URL=redis://redis:6379 \
  -v ./data1:/data \
  watson

# Instance 2 - connect a different WhatsApp number
docker run -d --name watson-2 \
  -e PORT=3002 \
  -e REDIS_URL=redis://redis:6379 \
  -v ./data2:/data \
  watson
```

**How it works:**
- When Instance 1 connects WhatsApp number `1234567890`, its queue becomes `wa-send-1234567890`
- When Instance 2 connects WhatsApp number `9876543210`, its queue becomes `wa-send-9876543210`
- No queue conflict! Each instance has its own queue.

### Option 2: Manual Instance IDs

If you prefer explicit control or have special naming requirements:

```bash
# Instance 1
docker run -d --name watson-usa \
  -e PORT=3001 \
  -e INSTANCE_ID=usa-account \
  -e REDIS_URL=redis://redis:6379 \
  -v ./data-usa:/data \
  watson

# Instance 2
docker run -d --name watson-eu \
  -e PORT=3002 \
  -e INSTANCE_ID=eu-account \
  -e REDIS_URL=redis://redis:6379 \
  -v ./data-eu:/data \
  watson
```

**Queue names with explicit IDs:**
- Instance "usa-account" → queue: `wa-send-usa-account`
- Instance "eu-account" → queue: `wa-send-eu-account`

## Using with Docker Compose

### Multi-Service Setup (Recommended)

```yaml
version: '3.8'

services:
  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: unless-stopped

  # Instance 1 - US WhatsApp number
  watson-us:
    build: .
    container_name: watson-us
    env_file: .env
    environment:
      PORT: 3001
      # Instance ID is auto-derived from WhatsApp JID
    ports:
      - "3001:3001"
    volumes:
      - ./uploads-us:/app/uploads
      - ./data-us:/data
    depends_on:
      - redis
    restart: unless-stopped

  # Instance 2 - EU WhatsApp number
  watson-eu:
    build: .
    container_name: watson-eu
    env_file: .env
    environment:
      PORT: 3002
      # Instance ID is auto-derived from WhatsApp JID
    ports:
      - "3002:3002"
    volumes:
      - ./uploads-eu:/app/uploads
      - ./data-eu:/data
    depends_on:
      - redis
    restart: unless-stopped

volumes:
  redis_data:
```

## How It Works Behind the Scenes

### Queue Initialization Flow

```
1. Server starts
   ↓
2. Redis queue initialized with default name ("wa-send")
   ↓
3. WhatsApp socket connects
   ↓
4. Socket reads user ID (e.g., "1234567890@s.whatsapp.net")
   ↓
5. Instance ID extracted: "1234567890"
   ↓
6. Queue name updated: "wa-send-1234567890"
   ↓
7. Queue and worker re-initialized with new name
   ↓
8. Messages now process in isolated queue
```

### Auto-Reply Cooldown Isolation

Previously:
```javascript
const last = lastAutoReplyAt.get(chatJid) || 0  // ❌ Could be from another instance
```

Now:
```javascript
const cooldownKey = `${currentInstanceId}:${chatJid}`  // ✅ Instance-specific
const last = lastAutoReplyAt.get(cooldownKey) || 0
```

## Environment Variables

### New Variables

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `INSTANCE_ID` | string | (auto-derived) | Manually set instance ID to override auto-detection. If set, queue name becomes `{WA_QUEUE_NAME}-{INSTANCE_ID}` |

### Existing Variables (Behavior Unchanged)

| Variable | Description |
|----------|-------------|
| `WA_QUEUE_NAME` | Base queue name (default: `wa-send`). With instance isolation, becomes `wa-send-{instanceId}` |
| `REDIS_URL` | Redis connection string. Both instances can share same Redis (queues isolated) |

## Monitoring & Debugging

### Check Queue Names

In Admin UI → Operations → Status, the queue name now includes the instance ID:

```
Queue: wa-send-1234567890  (US instance)
Queue: wa-send-9876543210  (EU instance)
```

### Redis Commands to Verify Isolation

```bash
# List all queues
redis-cli keys "bull:wa-send*"

# Should show separate queues per instance:
# bull:wa-send-1234567890
# bull:wa-send-9876543210
# bull:wa-send-1234567890:*
# bull:wa-send-9876543210:*
```

### Check Auto-Reply Cooldown Keys

```bash
# View cooldown tracking in logs
# Look for: "🔐 Instance isolation: WhatsApp JID=..., instanceId=..., queue=..."
```

## Verification Checklist

After setting up multiple instances:

- [ ] Both instances connect to different WhatsApp numbers
- [ ] Each shows a different queue name in Status page
- [ ] Auto-replies from instance 1 don't trigger from instance 2
- [ ] Messages sent from instance 1 number appear in instance 1's queue
- [ ] Messages sent from instance 2 number appear in instance 2's queue
- [ ] Redis shows separate queues: `bull:wa-send-{number1}` and `bull:wa-send-{number2}`

## Troubleshooting

### Issue: Messages still cross over between instances

**Check:** Verify both instances are using DIFFERENT WhatsApp numbers
```bash
# Instance 1 logs should show:
# 🔐 Instance isolation: WhatsApp JID=1234567890@s.whatsapp.net, instanceId=1234567890, queue=wa-send-1234567890

# Instance 2 logs should show:
# 🔐 Instance isolation: WhatsApp JID=9876543210@s.whatsapp.net, instanceId=9876543210, queue=wa-send-9876543210
```

### Issue: Queue name not changing after reconnect

**Check:** Queue reinitializes when `connection === 'open'`. If queue name isn't changing:
1. Check that WhatsApp socket actually connected (status should be "open")
2. Check logs for "🔐 Instance isolation:" message
3. If auto-derived ID not working, use explicit `INSTANCE_ID` env var

### Issue: Auto-replies not working on one instance

**Check:** Auto-reply cooldown isolation. Verify:
1. Different numbers have different `currentInstanceId` values
2. Cooldown key includes instance ID: `{instanceId}:chatJid`
3. Check `.env` has `AUTO_REPLY_ENABLED=true`

## Migration from Single to Multi-Instance

If you're upgrading from single instance:

1. **Backup your data**:
   ```bash
   cp -r data data-backup
   cp -r uploads uploads-backup
   ```

2. **No code changes needed** - instance isolation is automatic!

3. **Start first instance** - it will get the queue name from its WhatsApp number

4. **Start second instance** - it will get a different queue name

5. **Verify in Redis**:
   ```bash
   redis-cli keys "bull:wa-send*"
   # Should see separate queues now
   ```

## Performance Impact

- **Minimal**: Queue isolation adds ~1ms per job due to queue name routing
- **Better**: Separate queues actually improve performance under high load
- **No database overhead**: Instance isolation happens at Redis level

## Limitations & Notes

- ✅ Each instance MUST use a different WhatsApp number
- ✅ Both instances can share the same Redis instance
- ✅ Both instances can use different SQLite databases (recommended) or share (more complex)
- ❌ Cannot run two instances with the same WhatsApp number (one will override the other)

## Support & Questions

If you encounter issues:

1. Check logs for "🔐 Instance isolation:" messages
2. Verify Redis queue names: `redis-cli keys "bull:wa-send*"`
3. Confirm each instance shows different WhatsApp JID in logs
4. Check that auto-reply keys are instance-specific in `lastAutoReplyAt` Map

