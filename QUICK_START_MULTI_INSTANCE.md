# Quick Start: Running Multiple Watson Instances

## TL;DR - What Changed

Your Watson instances are now automatically isolated by WhatsApp number. No configuration changes needed!

## The Problem (Fixed)
When running two instances with different numbers, messages could cross over and be sent by the wrong number.

## The Solution
Each instance now gets its own Redis queue automatically:
- Instance with number `1234567890` → queue `wa-send-1234567890`
- Instance with number `9876543210` → queue `wa-send-9876543210`

## No Changes Required
Just run your instances normally. They will auto-detect and isolate.

```bash
# Both instances can use the same Redis
REDIS_URL=redis://redis:6379

# Instance 1 - any number
docker run watson

# Instance 2 - different number  
docker run watson
```

## Optional: Manual Instance IDs
If you prefer explicit names:

```bash
# Instance 1
INSTANCE_ID=account-usa

# Instance 2
INSTANCE_ID=account-eu
```

This creates queues: `wa-send-account-usa` and `wa-send-account-eu`

## Verify It's Working

Check logs after connecting:
```
🔐 Instance isolation: WhatsApp JID=1234567890@s.whatsapp.net, instanceId=1234567890, queue=wa-send-1234567890
```

Check Redis has separate queues:
```bash
redis-cli keys "bull:wa-send*"
# Shows separate queues per instance
```

## What Was Fixed

1. ✅ **Separate Redis queues** - No more message mixing
2. ✅ **Auto-reply isolation** - Cooldowns per instance
3. ✅ **Automatic detection** - Queue names auto-update when socket connects

## That's It!

No code changes. No database migrations. Just works.

The fix handles:
- Startup with default queue name
- Socket connects with WhatsApp JID
- Queue and worker automatically re-initialize with instance-specific names
- Auto-replies properly isolated by instance

See `MULTI_INSTANCE_SETUP.md` for detailed documentation.

