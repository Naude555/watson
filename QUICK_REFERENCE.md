# Quick Reference Card

## Q1: Docker Compose Setup

```
Current Setup:
├── docker-compose-instance1.yml → watson-1 (port 3001)
└── docker-compose-instance2.yml → watson-2 (port 3002)

Question: Can I keep this?
Answer: ✅ YES - No changes needed!

Instance isolation works automatically on both approaches:
- Separate files (your current setup) ✅
- Single consolidated file (optional) ✅
```

**Three Options:**

| Option | Setup | Command | Effort | Recommended |
|--------|-------|---------|--------|------------|
| **Current** | Two files | `docker-compose -f docker-compose-1.yml up -d` + `docker-compose -f docker-compose-2.yml up -d` | 0 | ✅ YES |
| **Consolidated** | One file with both services | `docker-compose up -d` | Low | Optional |
| **Hybrid** | Shared Redis | Mix of above | Low | If Redis is duplicated |

**Recommendation:** Keep your current setup. No changes required.

---

## Q2: Contact Names (Multiple Pieters)

```
Problem: 5 Pieters with different JIDs → merged into 1 contact ❌

Solution: Fixed! Now they stay separate ✅

Before:
┌─────────────────────────┐
│ 1 Contact "Pieter"      │
│ - JID: 111...           │
│ - JID: 222... (alias)   │
│ - JID: 333... (alias)   │
│ - JID: 444... (alias)   │
│ - JID: 555... (alias)   │
└─────────────────────────┘
❌ Confusion!

After:
Contact 1 "Pieter"  │  Contact 2 "Pieter"  │  Contact 3 "Pieter"
JID: 111...         │  JID: 222...         │  JID: 333...
tags: [friend]      │  tags: [customer]    │  tags: [supplier]
✅ Clear!
```

**What Changed:** Line 3280 in server.js
- Removed: Name-based fallback matching
- Now: Only matches by JID/MSISDN

**Result:** Different JIDs, same name = separate contacts ✅

---

## For Old Data (Merged Pieters)

If you have old merged contacts:

```
OLD: 1 "Pieter" with 5 JIDs (merged)
NEW: Going forward, new Pieters stay separate

Options for old data:
A) Leave as-is (works fine going forward)
B) Delete and recreate (messages create new contacts)
C) Manual cleanup (edit and split)
```

---

## What Happens Now

### Docker Compose
✅ Keep running two separate docker-compose files
✅ No changes needed
✅ Instance isolation automatic

### Contact Names
✅ Multiple "Pieters" stay separate
✅ Each has their own JID
✅ No more merging by name alone

### Instance Isolation (Previous Fix)
✅ Each WhatsApp number gets its own Redis queue
✅ Auto-replies isolated per instance
✅ No message crosstalk

---

## Verification

### Test Docker Compose (No Changes)
```bash
# Keep running as-is
docker-compose -f docker-compose-1.yml up -d
docker-compose -f docker-compose-2.yml up -d

# Each gets its own queue automatically:
# Queue 1: wa-send-{number1}
# Queue 2: wa-send-{number2}
```

### Test Contact Names
```bash
1. Add two contacts named "Pieter" with different JIDs
2. Check Admin UI → Contacts
3. Should see TWO separate entries ✅
```

---

## TL;DR

| Item | Status | Action |
|------|--------|--------|
| **Keep two docker-compose files?** | ✅ YES | Do nothing |
| **Consolidate docker-compose?** | Optional | See COMPLETE_ANSWERS.md |
| **Multiple Pieter contacts?** | ✅ FIXED | No action needed |
| **Old merged Pieters?** | Optional cleanup | See COMPLETE_ANSWERS.md |
| **Deploy changes?** | ✅ Ready | Already in codebase |

---

## Files to Read

- **COMPLETE_ANSWERS.md** - Full detailed explanation
- **DOCKER_CONTACTS_FAQ.md** - FAQ format
- **FIXES_SUMMARY.md** - Quick summary
- **server.js:3280** - The actual fix

