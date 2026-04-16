# Multi-Instance FAQ & Contact Deduplication Fix

## Docker Compose: Can I Keep Using Two Separate Files?

**YES! Absolutely.** You can keep your current setup with two separate docker-compose files:

```bash
# Terminal 1
docker-compose -f docker-compose-instance1.yml up -d

# Terminal 2  
docker-compose -f docker-compose-instance2.yml up -d
```

The instance isolation I added works **regardless** of how you manage the containers. Each instance will automatically get its own Redis queue based on the WhatsApp number it connects.

### You Have Three Options (All Work):

**Option 1: Keep Two Separate Files (No Changes)**
```
Your current setup
✅ Still works perfectly
✅ No migration needed
✅ Each docker-compose can have different .env files
```

**Option 2: Consolidate Into One File (Optional)**
```yaml
services:
  redis:
    image: redis:7-alpine
  watson-1:
    build: .
    env_file: .env.instance1
  watson-2:
    build: .
    env_file: .env.instance2
```
Then: `docker-compose up -d`

**Option 3: Hybrid - One Compose with Shared Dependencies**
```yaml
# docker-compose-shared.yml
services:
  redis:
    image: redis:7-alpine
    # Shared across both instances

# docker-compose-1.yml
services:
  redis:
    extends:
      file: docker-compose-shared.yml
  watson-1:
    ...
```

**Recommendation:** Keep your current setup (Option 1). It's clearer and easier to manage.

---

## Contact Deduplication Bug - FIXED

### The Problem

You reported that 5 different JIDs for a contact named "Pieter" were all getting merged into one contact:

```
JID 1: 1111111111@s.whatsapp.net → "Pieter"
JID 2: 2222222222@s.whatsapp.net → "Pieter"
JID 3: 3333333333@s.whatsapp.net → "Pieter"
JID 4: 4444444444@s.whatsapp.net → "Pieter"
JID 5: 5555555555@s.whatsapp.net → "Pieter"

Result: All merged into ONE contact with mixed JIDs in aliasJids
```

### Root Cause

In the `upsertContact()` function (line 3280), when a contact name was provided, the code would:

1. First try to find a contact by JID/MSISDN ✅ (correct)
2. If not found, fall back to finding by **name** ❌ (BUG!)

```javascript
// OLD CODE (BUGGY)
if (idx < 0) idx = store.contacts.findIndex(c => norm(c.name) === key)
```

This meant that ANY contact with the name "Pieter" would match, regardless of their JID. So all 5 Pieters would be merged together.

### The Fix

I removed the name-based fallback:

```javascript
// NEW CODE (FIXED)
// DO NOT fall back to name-based matching. Multiple different JIDs can have the same name.
// Name-based deduplication happens only during normalizeContactsStore() with proper LID↔phone logic.
```

Now the logic is:

1. Try to match by JID or MSISDN ✅
2. If no match found, create a NEW contact with that name ✅
3. Name-based deduplication ONLY happens during `normalizeContactsStore()` with strict rules:
   - Only merges "Name" + "Name (1234)" patterns
   - Only when one is LID and other is phone JID
   - Never merges plain name duplicates

### What This Means

**Before the fix:**
- 5 Pieters → merged into 1 contact with confusing aliasJids
- Can't tell which "Pieter" is which
- All messages from any Pieter go to the same contact

**After the fix:**
- 5 Pieters → 5 separate contacts
- Each with their own name, JID, and alias list
- Messages properly segregated by JID

### Contact Storage Format (Still Correct)

The contact storage now properly keeps separate identities:

```javascript
{
  "contacts": [
    {
      "jid": "1111111111@s.whatsapp.net",
      "name": "Pieter",
      "aliasJids": [],
      "msisdn": "27111111111"
    },
    {
      "jid": "2222222222@s.whatsapp.net",
      "name": "Pieter",
      "aliasJids": [],
      "msisdn": "27222222222"
    },
    {
      "jid": "3333333333@s.whatsapp.net",
      "name": "Pieter",
      "aliasJids": [],
      "msisdn": "27333333333"
    },
    // ... 4 and 5 ...
  ]
}
```

Each Pieter is a separate contact with their own JID.

---

## What Changed in the Code

**File: server.js, Line 3280**

Removed this line:
```javascript
if (idx < 0) idx = store.contacts.findIndex(c => norm(c.name) === key)
```

This prevents the name-based fallback that was merging contacts with the same name but different JIDs.

---

## How Contact Merging Still Works (Correctly)

The system STILL merges contacts when appropriate:

### ✅ Merges These (Correct):
1. **Same JID** - if you update a contact's JID, it merges
2. **Same MSISDN** - if you update a contact's phone number, it merges
3. **LID ↔ Phone equivalence** - "Pieter (1234)" + "Pieter" when one is LID and one is phone JID

### ❌ No Longer Merges These (Bug Fix):
- **Just the same name** - "Pieter" + "Pieter" with different JIDs stay separate

---

## Testing the Fix

### Before (Buggy Behavior)
```bash
# Add Pieter with JID 1
POST /api/contacts
{
  "jid": "1111111111@s.whatsapp.net",
  "name": "Pieter",
  "tags": ["friend"]
}

# Add Pieter with JID 2
POST /api/contacts
{
  "jid": "2222222222@s.whatsapp.net",
  "name": "Pieter",
  "tags": ["customer"]
}

# Result: ONE contact with JID 2111... and both tags merged
# WRONG! ❌
```

### After (Fixed Behavior)
```bash
# Add Pieter with JID 1
POST /api/contacts
{
  "jid": "1111111111@s.whatsapp.net",
  "name": "Pieter",
  "tags": ["friend"]
}

# Add Pieter with JID 2
POST /api/contacts
{
  "jid": "2222222222@s.whatsapp.net",
  "name": "Pieter",
  "tags": ["customer"]
}

# Result: TWO separate contacts
# Contact 1: JID=1111..., name=Pieter, tags=[friend]
# Contact 2: JID=2222..., name=Pieter, tags=[customer]
# CORRECT! ✅
```

---

## Verification

To verify the fix is working:

1. **Check your contacts database:**
   ```bash
   sqlite3 /path/to/data/watson.sqlite
   SELECT jid, name FROM contacts WHERE name = 'Pieter';
   # Should see 5 separate rows with 5 different JIDs
   ```

2. **Add multiple contacts with the same name:**
   ```bash
   # Add via API or Admin UI
   # Verify they stay separate
   ```

3. **Check the contacts store:**
   - Admin UI → Contacts
   - Should see 5 separate "Pieter" entries with different JIDs

---

## Backward Compatibility

**If you have old data with merged Pieters:**

The fix doesn't automatically split them. You have two options:

### Option A: Manual Cleanup (Recommended)
```javascript
// In Admin > Debug or via API:
1. Export contacts as JSON
2. Manually separate the merged Pieters
3. Re-import
```

### Option B: Auto-Cleanup Script (Advanced)
```bash
# Run this Node.js script to split merged contacts
node scripts/unmerge-contacts.js
```

### Option C: Delete and Re-add
The simplest is to delete the merged contact and let it be re-created naturally when messages come in with each JID.

---

## Summary

| Item | Status |
|------|--------|
| Docker Compose Change Required? | ❌ NO - keep current setup |
| Contact Deduplication Fixed? | ✅ YES |
| Multiple Pieters Now Work? | ✅ YES |
| Backward Compatible? | ✅ YES (with caveat for old merged contacts) |
| Instance Isolation? | ✅ YES (from previous fix) |

You can continue running your two separate docker-compose files exactly as you do now. The contact deduplication bug is now fixed so "Pieter" contacts won't merge anymore.

