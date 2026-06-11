# zerodb-firebase

Firebase Cloud Functions compatible SDK backed by ZeroDB. Same trigger syntax you already know, zero vendor lock-in, instant setup.

```
npm install zerodb-firebase
```

## Why migrate?

| | Firebase | zerodb-firebase |
|---|---|---|
| Setup time | Project + billing + deploy | `npm install` and go |
| Vendor lock-in | Full Google ecosystem | Open API, swap anytime |
| Auto-provisioning | No | Yes, instant (no signup) |
| Cold starts | 1-10s | Sub-100ms (edge hooks) |
| Pricing | Pay per invocation + storage | Free tier, then usage-based |
| Firestore required | Yes | No, any ZeroDB table |

## Quick start

```javascript
import { onDocumentCreated, onDocumentUpdated, deployTriggers } from 'zerodb-firebase';

// Same Firebase syntax, ZeroDB backend
export const onUserCreated = onDocumentCreated('users/{userId}', (event) => {
  const snapshot = event.data;
  const userData = snapshot.data();
  console.log('New user:', userData.name);
  console.log('User ID:', event.params.userId);
});

export const onProfileUpdated = onDocumentUpdated('users/{userId}', (event) => {
  const before = event.data.before.data();
  const after = event.data.after.data();
  console.log('Name changed:', before.name, '->', after.name);
});

// Deploy all triggers to ZeroDB
await deployTriggers();
```

That's it. If you don't set `ZERODB_API_KEY` and `ZERODB_PROJECT_ID`, a free project is auto-provisioned on first deploy.

## Firebase migration guide

### Step 1: Replace imports

```diff
- import { onDocumentCreated } from 'firebase-functions/v2/firestore';
+ import { onDocumentCreated } from 'zerodb-firebase';
```

### Step 2: Keep your handlers exactly the same

```javascript
// This code works with BOTH firebase-functions and zerodb-firebase
export const onOrderPlaced = onDocumentCreated('orders/{orderId}', async (event) => {
  const order = event.data.data();
  const orderId = event.params.orderId;

  // Send confirmation email
  await sendEmail(order.customerEmail, `Order ${orderId} confirmed!`);

  // Update inventory
  for (const item of order.items) {
    await updateInventory(item.sku, -item.quantity);
  }
});
```

### Step 3: Deploy

```javascript
import { deployTriggers } from 'zerodb-firebase';

// Deploy all registered triggers to ZeroDB hooks
await deployTriggers({
  apiKey: process.env.ZERODB_API_KEY,      // optional: auto-provisions if missing
  projectId: process.env.ZERODB_PROJECT_ID, // optional: auto-provisions if missing
});
```

### Step 4: Process incoming events

When ZeroDB fires a hook, route the webhook payload to `processEvent`:

```javascript
import { processEvent } from 'zerodb-firebase';
import express from 'express';

const app = express();
app.use(express.json());

app.post('/webhooks/zerodb', async (req, res) => {
  const results = await processEvent(req.body);
  res.json({ results });
});

app.listen(3000);
```

## API reference

### Trigger builders

All trigger builders follow the same signature as `firebase-functions/v2/firestore`:

```javascript
import {
  onDocumentCreated,   // Fires on new row insert
  onDocumentUpdated,   // Fires on row update (provides before/after)
  onDocumentDeleted,   // Fires on row delete
  onDocumentWritten,   // Fires on any write (create, update, delete)
} from 'zerodb-firebase';
```

**Path patterns** use Firebase-style wildcards:

```javascript
onDocumentCreated('users/{userId}', handler);
onDocumentCreated('orders/{orderId}/items/{itemId}', handler);
onDocumentCreated('logs', handler); // No wildcards
```

**Options object** (alternative to string path):

```javascript
onDocumentCreated({
  document: 'users/{userId}',
  callbackUrl: 'https://myapp.com/webhooks/zerodb',
}, handler);
```

### Event object

Handlers receive a `FirestoreEvent`:

```javascript
onDocumentCreated('users/{userId}', (event) => {
  event.data;       // DocumentSnapshot (created/deleted) or Change (updated/written)
  event.params;     // { userId: 'abc123' }
  event.type;       // 'document.created'
  event.id;         // Row ID
  event.path;       // 'users/abc123'
  event.time;       // ISO timestamp
});
```

### DocumentSnapshot

```javascript
const snapshot = event.data;
snapshot.data();         // Full document data
snapshot.exists;         // true if data is not null
snapshot.id;             // Document ID
snapshot.ref.path;       // Full path
snapshot.get('name');    // Get field by path (supports dot notation)
snapshot.get('addr.city'); // Nested field access
```

### Change (for update/write triggers)

```javascript
onDocumentUpdated('users/{userId}', (event) => {
  const change = event.data;
  change.before;   // DocumentSnapshot of old data
  change.after;    // DocumentSnapshot of new data

  const oldName = change.before.data().name;
  const newName = change.after.data().name;
});
```

### Runtime functions

```javascript
import {
  deployTriggers,         // Deploy all triggers to ZeroDB hooks
  processEvent,           // Route a webhook event to matching handlers
  initializeApp,          // Initialize with explicit config
  clearTriggers,          // Clear all registered triggers
  getRegisteredTriggers,  // List all registered triggers
} from 'zerodb-firebase';
```

### initializeApp

```javascript
import { initializeApp } from 'zerodb-firebase';

// Mirrors firebase-admin.initializeApp()
initializeApp({
  apiKey: 'zdb_your_key',
  projectId: 'your-project-id',
  baseUrl: 'https://api.ainative.studio', // optional
});
```

## Event type mapping

| Firebase event | ZeroDB hook event |
|---|---|
| `document.created` | `zerodb.table.row_inserted` |
| `document.updated` | `zerodb.table.row_updated` |
| `document.deleted` | `zerodb.table.row_deleted` |
| `document.written` | `zerodb.table.row_written` |

## Environment variables

| Variable | Description | Required |
|---|---|---|
| `ZERODB_API_KEY` | ZeroDB API key | No (auto-provisions) |
| `ZERODB_PROJECT_ID` | ZeroDB project ID | No (auto-provisions) |
| `ZERODB_BASE_URL` | API base URL | No (defaults to `https://api.ainative.studio`) |

## CommonJS support

```javascript
const { onDocumentCreated, deployTriggers } = require('zerodb-firebase');
```

## Powered by ZeroDB + AINative

| Feature | Details |
|---|---|
| Auto-provisioning | No signup needed. First deploy creates a free project. |
| Free tier | 10K events/month, 1GB storage |
| Edge hooks | Sub-100ms trigger execution |
| Zero vendor lock-in | Standard HTTP webhooks, export anytime |
| MCP compatible | Works with Claude Code, Cursor, Windsurf |

**Get started free:** [ainative.studio](https://ainative.studio)

Built by [AINative Studio](https://ainative.studio) -- the database for AI agents.
