# Complete Answers: Docker Compose & Contact Names

## Q1: Docker Compose - Can I Keep Running Two Separate Files?

### TL;DR
**YES!** You can keep your current setup with two separate docker-compose files. No changes needed. The instance isolation I added works automatically.

---

### Long Answer

You currently have something like:
```
docker-compose-instance1.yml → Port 3001 → WhatsApp Number A
docker-compose-instance2.yml → Port 3002 → WhatsApp Number B
```

With the instance isolation fix I implemented, **you can keep this exact setup**. Here's why:

#### The Instance Isolation Works On Two Levels

1. **Redis Queue Isolation** - Each instance gets its own queue:
   - Instance with number `1234567890` → `wa-send-1234567890`
   - Instance with number `9876543210` → `wa-send-9876543210`

2. **Auto-Reply Cooldown Isolation** - Each instance tracks its own cooldowns:
   - Instance ID derived from WhatsApp number
   - Cooldowns keyed as `{instanceId}:{chatJid}`

Both of these work **whether you run two separate docker-compose files or one file with multiple services**.

#### Three Valid Approaches

**OPTION 1: Current Setup (Keep As-Is)**
```bash
# Terminal 1
docker-compose -f docker-compose-instance1.yml up -d

# Terminal 2
docker-compose -f docker-compose-instance2.yml up -d
```
✅ **Pros:**
- No changes needed
- Clearer separation  
- Easy to manage independently
- Can use different .env files

❌ **Cons:**
- Manage two files
- Two Redis services (you probably share one?)

**OPTION 2: Consolidate Into One File**
```yaml
version: '3.8'
services:
  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"
    restart: unless-stopped

  watson-instance-1:
    build: .
    container_name: watson-1
    ports:
      - "3001:3000"
    env_file: .env.instance1
    volumes:
      - ./data-1:/data
      - ./uploads-1:/app/uploads
    depends_on:
      - redis
    restart: unless-stopped

  watson-instance-2:
    build: .
    container_name: watson-2
    ports:
      - "3002:3000"
    env_file: .env.instance2
    volumes:
      - ./data-2:/data
      - ./uploads-2:/app/uploads
    depends_on:
      - redis
    restart: unless-stopped
```

```bash
docker-compose up -d
```

✅ **Pros:**
- Single command to manage both
- Shared Redis service
- Cleaner deployment

❌ **Cons:**
- One file to manage
- Both instances start together

**OPTION 3: Hybrid - Shared Redis**
If both your current docker-compose files use the same Redis, you're already doing this!
```bash
# docker-compose-instance1.yml
services:
  redis:
    image: redis:7-alpine
  watson: ...

# docker-compose-instance2.yml  
services:
  redis:
    image: redis:7-alpine
  watson: ...
```

⚠️ Problem: Two Redis instances (wasteful)

✅ Solution: Use a shared Redis or consolidate to Option 2

---

### My Recommendation

**Keep your current setup (Option 1)** if:
- You like the separation
- You manage them independently
- You're happy with the current workflow

**Move to Option 2** if:
- You want a single point of control
- You want to share Redis efficiently
- You prefer `docker-compose up -d` to manage everything

---

## Q2: Contact Names - Multiple "Pieter" Issue

### TL;DR
**FIXED!** Multiple contacts with the same name now stay separate instead of merging together.

---

### The Problem (Detailed)

You have 5 different Pieters:
```
Pieter (friend)      → JID: 27111111111@s.whatsapp.net
Pieter (customer)    → JID: 27222222222@s.whatsapp.net
Pieter (supplier)    → JID: 27333333333@s.whatsapp.net
Pieter (colleague)   → JID: 27444444444@s.whatsapp.net
Pieter (other)       → JID: 27555555555@s.whatsapp.net
```

### What Was Happening (Bug)

When you added them, they would mysteriously **merge into ONE contact**:

```javascript
// When adding Pieter #2
upsertContact(store, {
  jid: "27222222222@s.whatsapp.net",
  name: "Pieter"
})

// Code would:
// 1. Look for existing contact with JID 27222222222 → NOT FOUND
// 2. Fall back: Look for existing contact named "Pieter" → FOUND! (Pieter #1)
// 3. MERGE them → ONE contact with confused JIDs
```

Result: All 5 Pieters merged, with mixed JIDs and aliasJids. You couldn't tell which is which.

### Root Cause (Technical)

In the `upsertContact()` function at line 3280:

```javascript
// BAD: Falls back to name-based matching
if (idx < 0) idx = store.contacts.findIndex(c => norm(c.name) === key)
```

This line said: "If no contact found by JID, find one by name." This was wrong because:
- Multiple people can have the same name
- Different JIDs should never merge just because names match
- You can't have 2 JIDs in one contact with the same name (confusion!)

### The Fix

I removed the name-based fallback:

```javascript
// GOOD: Only matches by JID/MSISDN
if (incomingJid || incomingMsisdnCanonical) {
  idx = (store.contacts || []).findIndex(c => {
    const cJid = normalizeJid(c?.jid)
    const cMsisdnCanonical = canonicalMsisdn(c?.msisdn || '') || msisdnFromJid(c?.jid || '')
    if (incomingJid && cJid === incomingJid) return true
    if (incomingMsisdnCanonical && cMsisdnCanonical === incomingMsisdnCanonical) return true
    return false
  })
}
// NO NAME-BASED FALLBACK!
```

Now:
1. Try to find by JID ✅
2. Try to find by MSISDN ✅
3. If still not found, **create a new contact** ✅
4. **Never merge by name alone** ✅

### What Happens Now

Each Pieter is a separate contact:

```json
{
  "contacts": [
    {
      "jid": "27111111111@s.whatsapp.net",
      "name": "Pieter",
      "msisdn": "27111111111",
      "tags": ["friend"],
      "aliasJids": []
    },
    {
      "jid": "27222222222@s.whatsapp.net",
      "name": "Pieter",
      "msisdn": "27222222222",
      "tags": ["customer"],
      "aliasJids": []
    },
    // ... 3, 4, 5 ...
  ]
}
```

✅ 5 separate contacts
✅ Each with their own JID
✅ Each with their own tags
✅ No confusion

---

### When Does Merging Still Happen? (Correctly)

Contacts STILL merge when they should:

#### ✅ These Merge (Correct)

1. **Same JID** - Updating a contact with the same JID:
   ```javascript
   // Contact 1: JID=123, name="Pieter", tags=["friend"]
   // Update same contact:
   // Contact 1: JID=123, name="Pieter", tags=["friend", "customer"]
   // ✅ Merged (same JID)
   ```

2. **Same MSISDN** - Updating a contact with the same phone number:
   ```javascript
   // Contact 1: MSISDN=27111111111, name="Pieter"
   // Update with same MSISDN:
   // ✅ Merged (same phone)
   ```

3. **LID ↔ Phone Equivalence** - Only in normalizeContactsStore:
   ```javascript
   // Contact 1: "Pieter" (LID: 123@lid)
   // Contact 2: "Pieter" (Phone: 27111111111@s.whatsapp.net)
   // System knows they're the same person (LID lookup table)
   // ✅ Merged (verified as same person)
   ```

#### ❌ These NO Longer Merge (Bug Fixed)

1. **Same Name, Different JID:**
   ```javascript
   // Contact 1: JID=111, name="Pieter"
   // Contact 2: JID=222, name="Pieter"
   // ❌ NO longer merged (different JID!)
   ```

2. **Same Name, Different MSISDN:**
   ```javascript
   // Contact 1: MSISDN=27111111111, name="Pieter"
   // Contact 2: MSISDN=27222222222, name="Pieter"
   // ❌ NO longer merged (different phone!)
   ```

---

### Handling Old Data (Merged Pieters)

If you have old data with 5 Pieters merged into 1 contact, you have options:

#### Option A: Leave As-Is
- Old merged contacts stay merged
- New contacts don't merge
- Going forward, no issues

#### Option B: Delete and Let Recreate
```bash
# Delete the merged "Pieter" contact
# Then when Pieters send messages, each creates their own contact
```

#### Option C: Manual Split
```javascript
// Export contacts.json
// Manually split the merged contact
// Re-import
```

#### Option D: Auto Script
```bash
node scripts/split-merged-contacts-by-name.js
```
(This script doesn't exist yet, but could be created)

---

### Testing the Fix

Add two contacts with the same name:

```bash
# Add Pieter #1
curl -X POST http://localhost:3000/api/contacts \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "27111111111@s.whatsapp.net",
    "name": "Pieter",
    "tags": ["friend"]
  }'

# Add Pieter #2 (different JID)
curl -X POST http://localhost:3000/api/contacts \
  -H "x-api-key: YOUR_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "jid": "27222222222@s.whatsapp.net",
    "name": "Pieter",
    "tags": ["customer"]
  }'

# List contacts
curl http://localhost:3000/api/contacts \
  -H "x-api-key: YOUR_KEY"

# Result: TWO separate contacts with same name ✅
```

---

## Summary

| Question | Answer |
|----------|--------|
| **Can I keep two docker-compose files?** | ✅ YES - no changes needed |
| **Do I need to consolidate?** | ❌ NO - optional only |
| **What if I want to consolidate?** | Option 2 above shows how |
| **Is the Pieter bug fixed?** | ✅ YES - multiple people with same name stay separate |
| **Will old merged Pieters split?** | ❌ NO - only new additions won't merge |
| **What about future Pieters?** | ✅ They'll be separate contacts |

---

## Files Changed

1. **server.js** - Line 3280: Removed name-based fallback
2. **DOCKER_CONTACTS_FAQ.md** - Comprehensive guide
3. **FIXES_SUMMARY.md** - Quick reference
4. **This file** - Complete detailed explanation

All changes are live. No further action needed unless you want to:
- Consolidate docker-compose (optional)
- Clean up old merged contacts (optional)

