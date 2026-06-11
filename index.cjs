/**
 * zerodb-firebase — CommonJS entry point.
 * Firebase Cloud Functions compatible SDK backed by ZeroDB.
 */

"use strict";

const DEFAULT_BASE_URL = "https://api.ainative.studio";
const INSTANT_DB_PATH = "/api/v1/public/instant-db";
const HOOKS_PATH = "/api/v1/hooks";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _env(name) {
  try {
    return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
  } catch {
    return undefined;
  }
}

function generateHookId() {
  return "hook_" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

async function request(baseUrl, path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ZeroDB API error ${res.status}: ${body}`);
  }
  const text = await res.text();
  if (!text) return null;
  return JSON.parse(text);
}

function authHeaders(apiKey) {
  if (!apiKey) return {};
  return { Authorization: `Bearer ${apiKey}` };
}

function parsePath(pathPattern) {
  const segments = pathPattern.split("/").filter(Boolean);
  const table = segments[0];
  const params = [];

  for (const seg of segments) {
    const match = seg.match(/^\{(\w+)\}$/);
    if (match) {
      params.push(match[1]);
    }
  }

  return { table, params, fullPath: pathPattern };
}

function extractParams(pattern, concretePath) {
  const patternSegs = pattern.split("/").filter(Boolean);
  const pathSegs = concretePath.split("/").filter(Boolean);
  const params = {};

  for (let i = 0; i < patternSegs.length && i < pathSegs.length; i++) {
    const match = patternSegs[i].match(/^\{(\w+)\}$/);
    if (match) {
      params[match[1]] = pathSegs[i];
    }
  }

  return params;
}

// ---------------------------------------------------------------------------
// Event classes
// ---------------------------------------------------------------------------

class DocumentSnapshot {
  constructor(data, id, path) {
    this._data = data;
    this.id = id;
    this.ref = { path, id };
  }

  data() {
    return this._data;
  }

  get exists() {
    return this._data != null;
  }

  get(field) {
    if (!this._data) return undefined;
    return field.split(".").reduce((obj, key) => obj?.[key], this._data);
  }
}

class Change {
  constructor(before, after) {
    this.before = before;
    this.after = after;
  }
}

class FirestoreEvent {
  constructor({ data, params, type, id, path }) {
    this.data = data;
    this.params = params || {};
    this.type = type;
    this.id = id;
    this.path = path;
    this.time = new Date().toISOString();
  }
}

// ---------------------------------------------------------------------------
// ZeroDB Client
// ---------------------------------------------------------------------------

class ZeroDBClient {
  constructor(config = {}) {
    this._apiKey = config.apiKey || _env("ZERODB_API_KEY") || null;
    this._projectId = config.projectId || _env("ZERODB_PROJECT_ID") || null;
    this._baseUrl = (config.baseUrl || _env("ZERODB_BASE_URL") || DEFAULT_BASE_URL).replace(/\/$/, "");
    this._provisioned = false;
  }

  async ensureProvisioned() {
    if (this._apiKey && this._projectId) return;
    if (this._provisioned) return;

    const data = await request(this._baseUrl, INSTANT_DB_PATH, {
      method: "POST",
      body: JSON.stringify({ agree_terms: true }),
    });

    this._apiKey = data.api_key;
    this._projectId = data.project_id;
    this._provisioned = true;

    const claimUrl = data.claim_url || `${this._baseUrl}/claim/${data.claim_token}`;

    console.log("\n  ╔═══════════════════════════════════════════════════════╗");
    console.log("  ║  ZeroDB project auto-provisioned (free, 72h trial)  ║");
    console.log("  ╠═══════════════════════════════════════════════════════╣");
    console.log(`  ║  Project:  ${this._projectId.slice(0, 36).padEnd(42)}║`);
    console.log(`  ║  API Key:  ${(this._apiKey || "").slice(0, 12)}...${"".padEnd(29)}║`);
    console.log("  ║                                                       ║");
    console.log("  ║  Claim your project to keep it permanently:           ║");
    console.log(`  ║  ${claimUrl.slice(0, 53).padEnd(53)}  ║`);
    console.log("  ╚═══════════════════════════════════════════════════════╝\n");
  }

  async registerHook(hookDef) {
    await this.ensureProvisioned();
    return request(this._baseUrl, HOOKS_PATH, {
      method: "POST",
      headers: authHeaders(this._apiKey),
      body: JSON.stringify({
        project_id: this._projectId,
        ...hookDef,
      }),
    });
  }

  async listHooks() {
    await this.ensureProvisioned();
    const params = new URLSearchParams({ project_id: this._projectId });
    return request(this._baseUrl, `${HOOKS_PATH}?${params}`, {
      method: "GET",
      headers: authHeaders(this._apiKey),
    });
  }

  async deleteHook(hookId) {
    await this.ensureProvisioned();
    return request(this._baseUrl, `${HOOKS_PATH}/${hookId}`, {
      method: "DELETE",
      headers: authHeaders(this._apiKey),
    });
  }
}

// ---------------------------------------------------------------------------
// Shared client singleton
// ---------------------------------------------------------------------------

let _sharedClient = null;

function getClient(config) {
  if (config) return new ZeroDBClient(config);
  if (!_sharedClient) _sharedClient = new ZeroDBClient();
  return _sharedClient;
}

// ---------------------------------------------------------------------------
// Trigger registry
// ---------------------------------------------------------------------------

const _registeredTriggers = new Map();

const EVENT_TYPE_MAP = {
  "document.created": "zerodb.table.row_inserted",
  "document.updated": "zerodb.table.row_updated",
  "document.deleted": "zerodb.table.row_deleted",
  "document.written": "zerodb.table.row_written",
};

// ---------------------------------------------------------------------------
// Trigger builders
// ---------------------------------------------------------------------------

function onDocumentCreated(pathOrOpts, handler) {
  return _buildTrigger("document.created", pathOrOpts, handler);
}

function onDocumentUpdated(pathOrOpts, handler) {
  return _buildTrigger("document.updated", pathOrOpts, handler);
}

function onDocumentDeleted(pathOrOpts, handler) {
  return _buildTrigger("document.deleted", pathOrOpts, handler);
}

function onDocumentWritten(pathOrOpts, handler) {
  return _buildTrigger("document.written", pathOrOpts, handler);
}

function _buildTrigger(firebaseEventType, pathOrOpts, handler) {
  let pathPattern, opts;

  if (typeof pathOrOpts === "string") {
    pathPattern = pathOrOpts;
    opts = {};
  } else {
    pathPattern = pathOrOpts.document || pathOrOpts.path;
    opts = pathOrOpts;
  }

  if (!pathPattern) {
    throw new Error("Path pattern is required (e.g. 'users/{userId}')");
  }

  if (typeof handler !== "function") {
    throw new Error("Handler must be a function");
  }

  const parsed = parsePath(pathPattern);
  const hookId = generateHookId();
  const zerodbEventType = EVENT_TYPE_MAP[firebaseEventType];

  const trigger = {
    id: hookId,
    type: firebaseEventType,
    zerodbEventType,
    pathPattern,
    table: parsed.table,
    params: parsed.params,
    handler,
    opts,
  };

  _registeredTriggers.set(hookId, trigger);

  return trigger;
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

async function deployTriggers(config) {
  const client = getClient(config);
  const results = [];

  for (const [id, trigger] of _registeredTriggers) {
    const hookDef = {
      hook_id: id,
      event_type: trigger.zerodbEventType,
      table_name: trigger.table,
      path_pattern: trigger.pathPattern,
      callback_url: trigger.opts.callbackUrl || null,
      metadata: {
        firebase_event_type: trigger.type,
        params: trigger.params,
      },
    };

    try {
      const result = await client.registerHook(hookDef);
      results.push({ id, status: "deployed", result });
    } catch (err) {
      results.push({ id, status: "error", error: err.message });
    }
  }

  return results;
}

async function processEvent(event) {
  const results = [];
  const eventType = event.event_type || event.type;
  const table = event.table_name || event.table;
  const rowData = event.data || event.row;
  const oldData = event.old_data || event.previous;
  const rowId = event.row_id || event.id || rowData?.id;
  const path = event.path || `${table}/${rowId}`;

  for (const [, trigger] of _registeredTriggers) {
    if (trigger.zerodbEventType !== eventType) continue;
    if (trigger.table !== table) continue;

    const params = extractParams(trigger.pathPattern, path);

    let eventData;
    if (trigger.type === "document.updated" || trigger.type === "document.written") {
      const beforeSnap = new DocumentSnapshot(oldData || null, rowId, path);
      const afterSnap = new DocumentSnapshot(rowData, rowId, path);
      eventData = new Change(beforeSnap, afterSnap);
    } else if (trigger.type === "document.deleted") {
      eventData = new DocumentSnapshot(oldData || rowData, rowId, path);
    } else {
      eventData = new DocumentSnapshot(rowData, rowId, path);
    }

    const firestoreEvent = new FirestoreEvent({
      data: eventData,
      params,
      type: trigger.type,
      id: rowId,
      path,
    });

    try {
      const result = await trigger.handler(firestoreEvent);
      results.push({ triggerId: trigger.id, status: "ok", result });
    } catch (err) {
      results.push({ triggerId: trigger.id, status: "error", error: err.message });
    }
  }

  return results;
}

function clearTriggers() {
  _registeredTriggers.clear();
}

function getRegisteredTriggers() {
  return Array.from(_registeredTriggers.values());
}

function initializeApp(config) {
  _sharedClient = new ZeroDBClient(config);
  return _sharedClient;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  onDocumentWritten,
  deployTriggers,
  processEvent,
  initializeApp,
  clearTriggers,
  getRegisteredTriggers,
  DocumentSnapshot,
  Change,
  FirestoreEvent,
  ZeroDBClient,
  parsePath,
  extractParams,
};

module.exports.default = module.exports;
