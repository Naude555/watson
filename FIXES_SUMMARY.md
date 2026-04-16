# Summary: Docker Compose & Contact Deduplication Fixes

## Docker Compose Question: Keep or Consolidate?

**Answer: Keep your current setup!** ✅

You can keep running two separate docker-compose files:
```bash
# Terminal 1
docker-compose -f docker-compose-instance1.yml up -d

# Terminal 2
docker-compose -f docker-compose-instance2.yml up -d
```

The instance isolation I added works automatically **regardless** of how you manage the containers. No changes needed to your setup.

If you want to consolidate later, you can, but it's optional. The instance isolation works either way.

---

## Contact Deduplication Bug: FIXED

### What Was Wrong

When you added 5 different Pieters with 5 different JIDs:
- `1111111111@s.whatsapp.net` → Pieter
- `2222222222@s.whatsapp.net` → Pieter  
- `3333333333@s.whatsapp.net` → Pieter
- `4444444444@s.whatsapp.net` → Pieter
- `5555555555@s.whatsapp.net` → Pieter

They would all **merge into ONE contact** with jumbled JIDs. ❌

### Why It Happened

The contact storage code had a fallback:
```javascript
// If no contact found by JID/MSISDN, look for one by name
if (idx < 0) idx = store.contacts.findIndex(c => norm(c.name) === key)
```

So the 5th Pieter would match the 1st Pieter by name and merge.

### The Fix

I removed that dangerous fallback. Now:
- ✅ Contacts only merge if they have the **same JID or MSISDN**
- ✅ Multiple people named "Pieter" stay separate
- ✅ Each Pieter is a unique contact with their own JID

### Result

Now you get 5 separate contacts:
```
Contact 1: JID=1111..., Name=Pieter
Contact 2: JID=2222..., Name=Pieter
Contact 3: JID=3333..., Name=Pieter
Contact 4: JID=4444..., Name=Pieter
Contact 5: JID=5555..., Name=Pieter
```

Each is properly isolated. ✅

---

## Changes Made

| Change | Status |
|--------|--------|
| **Instance Isolation** (from previous request) | ✅ Implemented |
| **Docker Compose** | ✅ Works as-is, no changes needed |
| **Contact Deduplication Bug** | ✅ Fixed in server.js line 3280 |

---

## What You Need To Do

### For Docker Compose
**Nothing!** Keep running your two separate docker-compose files exactly as you do now.

### For Existing Merged Contacts
If you have old data with merged "Pieter" contacts, they won't automatically split. You can:

1. **Ignore** - They won't merge anymore going forward
2. **Delete and recreate** - Remove the merged contact, let it be recreated naturally
3. **Manual cleanup** - Edit the contacts store to separate them

---

## Testing the Fix

After deploying:

1. Add a new contact named "Pieter" with JID 1
2. Add another contact named "Pieter" with JID 2
3. Verify they show as **2 separate contacts** in Admin → Contacts
4. Not merged! ✅

---

## Files Changed

- `server.js` line 3280 - Removed name-based fallback in `upsertContact()`
- `DOCKER_CONTACTS_FAQ.md` - Comprehensive explanation (new file)

Both fixes are now live in your codebase!

