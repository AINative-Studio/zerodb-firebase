# zerodb-firebase SDK

Firebase Cloud Functions compatible SDK backed by ZeroDB.

## Package overview

- **Name:** `zerodb-firebase` (npm)
- **Purpose:** Drop-in replacement for `firebase-functions` — same trigger API, ZeroDB backend
- **Entry points:** `index.js` (ESM), `index.cjs` (CommonJS)

## Architecture

Firebase trigger decorators map to ZeroDB hook API calls:

| Firebase function | ZeroDB API call |
|---|---|
| `onDocumentCreated(path, handler)` | `POST /api/v1/hooks` with `event_type: "zerodb.table.row_inserted"` |
| `onDocumentUpdated(path, handler)` | `POST /api/v1/hooks` with `event_type: "zerodb.table.row_updated"` |
| `onDocumentDeleted(path, handler)` | `POST /api/v1/hooks` with `event_type: "zerodb.table.row_deleted"` |
| `onDocumentWritten(path, handler)` | `POST /api/v1/hooks` with `event_type: "zerodb.table.row_written"` |

## Key concepts

- **Path patterns** (`users/{userId}`) parsed into table name + wildcard params
- **Auto-provisioning** via `/api/v1/public/instant-db` when no API key set
- **processEvent()** routes incoming ZeroDB webhook payloads to registered handlers
- **deployTriggers()** registers all triggers as ZeroDB hooks

## Testing

```bash
node --test tests/triggers.test.js
```

Tests mock `globalThis.fetch` — no live API calls needed.

## Files

| File | Purpose |
|---|---|
| `index.js` | ESM entry point |
| `index.cjs` | CommonJS entry point (mirrors index.js) |
| `tests/triggers.test.js` | Full test suite |
| `package.json` | npm package config |
| `README.md` | Firebase migration guide + API docs |
