import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  onDocumentCreated,
  onDocumentUpdated,
  onDocumentDeleted,
  onDocumentWritten,
  processEvent,
  deployTriggers,
  initializeApp,
  clearTriggers,
  getRegisteredTriggers,
  DocumentSnapshot,
  Change,
  FirestoreEvent,
  ZeroDBClient,
  parsePath,
  extractParams,
} from "../index.js";

// ---------------------------------------------------------------------------
// Mock fetch globally
// ---------------------------------------------------------------------------

let fetchCalls = [];
let fetchResponses = [];

function pushResponse(status, body) {
  fetchResponses.push({ status, body });
}

function mockFetch(url, opts) {
  const resp = fetchResponses.shift() || { status: 200, body: {} };
  fetchCalls.push({ url, opts });
  return Promise.resolve({
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    text: () => Promise.resolve(typeof resp.body === "string" ? resp.body : JSON.stringify(resp.body)),
    json: () => Promise.resolve(resp.body),
  });
}

globalThis.fetch = mockFetch;

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  clearTriggers();
});

// ---------------------------------------------------------------------------
// parsePath tests
// ---------------------------------------------------------------------------

describe("parsePath", () => {
  it("should parse simple path", () => {
    const result = parsePath("users/{userId}");
    assert.equal(result.table, "users");
    assert.deepEqual(result.params, ["userId"]);
  });

  it("should parse nested path", () => {
    const result = parsePath("orders/{orderId}/items/{itemId}");
    assert.equal(result.table, "orders");
    assert.deepEqual(result.params, ["orderId", "itemId"]);
  });

  it("should parse path with no params", () => {
    const result = parsePath("logs");
    assert.equal(result.table, "logs");
    assert.deepEqual(result.params, []);
  });
});

// ---------------------------------------------------------------------------
// extractParams tests
// ---------------------------------------------------------------------------

describe("extractParams", () => {
  it("should extract single param", () => {
    const result = extractParams("users/{userId}", "users/abc123");
    assert.deepEqual(result, { userId: "abc123" });
  });

  it("should extract multiple params", () => {
    const result = extractParams("orders/{orderId}/items/{itemId}", "orders/ord1/items/item2");
    assert.deepEqual(result, { orderId: "ord1", itemId: "item2" });
  });

  it("should return empty for no params", () => {
    const result = extractParams("logs", "logs");
    assert.deepEqual(result, {});
  });
});

// ---------------------------------------------------------------------------
// DocumentSnapshot tests
// ---------------------------------------------------------------------------

describe("DocumentSnapshot", () => {
  it("should return data via data()", () => {
    const snap = new DocumentSnapshot({ name: "Alice" }, "id1", "users/id1");
    assert.deepEqual(snap.data(), { name: "Alice" });
  });

  it("should have exists property", () => {
    const snap = new DocumentSnapshot({ name: "Alice" }, "id1", "users/id1");
    assert.equal(snap.exists, true);
  });

  it("should return false for exists when data is null", () => {
    const snap = new DocumentSnapshot(null, "id1", "users/id1");
    assert.equal(snap.exists, false);
  });

  it("should get nested field", () => {
    const snap = new DocumentSnapshot({ address: { city: "Berlin" } }, "id1", "users/id1");
    assert.equal(snap.get("address.city"), "Berlin");
  });

  it("should return undefined for missing field", () => {
    const snap = new DocumentSnapshot({ name: "Alice" }, "id1", "users/id1");
    assert.equal(snap.get("missing.field"), undefined);
  });

  it("should have correct ref", () => {
    const snap = new DocumentSnapshot({}, "id1", "users/id1");
    assert.equal(snap.ref.path, "users/id1");
    assert.equal(snap.ref.id, "id1");
    assert.equal(snap.id, "id1");
  });
});

// ---------------------------------------------------------------------------
// onDocumentCreated tests
// ---------------------------------------------------------------------------

describe("onDocumentCreated", () => {
  it("should register a created trigger with string path", () => {
    const trigger = onDocumentCreated("users/{userId}", () => {});
    assert.equal(trigger.type, "document.created");
    assert.equal(trigger.zerodbEventType, "zerodb.table.row_inserted");
    assert.equal(trigger.table, "users");
    assert.deepEqual(trigger.params, ["userId"]);
  });

  it("should register with options object", () => {
    const trigger = onDocumentCreated({ document: "orders/{orderId}" }, () => {});
    assert.equal(trigger.table, "orders");
    assert.deepEqual(trigger.params, ["orderId"]);
  });

  it("should throw without path", () => {
    assert.throws(() => onDocumentCreated({}, () => {}), /Path pattern is required/);
  });

  it("should throw without handler", () => {
    assert.throws(() => onDocumentCreated("users/{userId}", "not a function"), /Handler must be a function/);
  });

  it("should add trigger to registry", () => {
    onDocumentCreated("users/{userId}", () => {});
    assert.equal(getRegisteredTriggers().length, 1);
  });
});

// ---------------------------------------------------------------------------
// onDocumentUpdated tests
// ---------------------------------------------------------------------------

describe("onDocumentUpdated", () => {
  it("should register an updated trigger", () => {
    const trigger = onDocumentUpdated("users/{userId}", () => {});
    assert.equal(trigger.type, "document.updated");
    assert.equal(trigger.zerodbEventType, "zerodb.table.row_updated");
  });
});

// ---------------------------------------------------------------------------
// onDocumentDeleted tests
// ---------------------------------------------------------------------------

describe("onDocumentDeleted", () => {
  it("should register a deleted trigger", () => {
    const trigger = onDocumentDeleted("users/{userId}", () => {});
    assert.equal(trigger.type, "document.deleted");
    assert.equal(trigger.zerodbEventType, "zerodb.table.row_deleted");
  });
});

// ---------------------------------------------------------------------------
// onDocumentWritten tests
// ---------------------------------------------------------------------------

describe("onDocumentWritten", () => {
  it("should register a written trigger", () => {
    const trigger = onDocumentWritten("users/{userId}", () => {});
    assert.equal(trigger.type, "document.written");
    assert.equal(trigger.zerodbEventType, "zerodb.table.row_written");
  });
});

// ---------------------------------------------------------------------------
// processEvent tests
// ---------------------------------------------------------------------------

describe("processEvent", () => {
  it("should invoke handler for matching created event", async () => {
    let receivedEvent = null;
    onDocumentCreated("users/{userId}", (event) => {
      receivedEvent = event;
    });

    const results = await processEvent({
      event_type: "zerodb.table.row_inserted",
      table_name: "users",
      data: { name: "Alice", email: "alice@test.com" },
      row_id: "user_123",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "ok");
    assert.ok(receivedEvent);
    assert.equal(receivedEvent.type, "document.created");
    assert.equal(receivedEvent.params.userId, "user_123");
    assert.equal(receivedEvent.data.data().name, "Alice");
  });

  it("should provide Change object for updated events", async () => {
    let receivedEvent = null;
    onDocumentUpdated("users/{userId}", (event) => {
      receivedEvent = event;
    });

    await processEvent({
      event_type: "zerodb.table.row_updated",
      table_name: "users",
      data: { name: "Alice Updated" },
      old_data: { name: "Alice" },
      row_id: "user_123",
    });

    assert.ok(receivedEvent);
    assert.ok(receivedEvent.data instanceof Change);
    assert.equal(receivedEvent.data.before.data().name, "Alice");
    assert.equal(receivedEvent.data.after.data().name, "Alice Updated");
  });

  it("should provide Change object for written events", async () => {
    let receivedEvent = null;
    onDocumentWritten("users/{userId}", (event) => {
      receivedEvent = event;
    });

    await processEvent({
      event_type: "zerodb.table.row_written",
      table_name: "users",
      data: { name: "Bob" },
      old_data: null,
      row_id: "user_456",
    });

    assert.ok(receivedEvent);
    assert.ok(receivedEvent.data instanceof Change);
    assert.equal(receivedEvent.data.before.exists, false);
    assert.equal(receivedEvent.data.after.data().name, "Bob");
  });

  it("should provide snapshot for deleted events", async () => {
    let receivedEvent = null;
    onDocumentDeleted("users/{userId}", (event) => {
      receivedEvent = event;
    });

    await processEvent({
      event_type: "zerodb.table.row_deleted",
      table_name: "users",
      old_data: { name: "DeletedUser" },
      row_id: "user_789",
    });

    assert.ok(receivedEvent);
    assert.ok(receivedEvent.data instanceof DocumentSnapshot);
    assert.equal(receivedEvent.data.data().name, "DeletedUser");
  });

  it("should not invoke handler for non-matching table", async () => {
    let called = false;
    onDocumentCreated("users/{userId}", () => {
      called = true;
    });

    await processEvent({
      event_type: "zerodb.table.row_inserted",
      table_name: "orders",
      data: { total: 100 },
      row_id: "ord_1",
    });

    assert.equal(called, false);
  });

  it("should not invoke handler for non-matching event type", async () => {
    let called = false;
    onDocumentCreated("users/{userId}", () => {
      called = true;
    });

    await processEvent({
      event_type: "zerodb.table.row_deleted",
      table_name: "users",
      data: {},
      row_id: "user_1",
    });

    assert.equal(called, false);
  });

  it("should handle handler errors gracefully", async () => {
    onDocumentCreated("users/{userId}", () => {
      throw new Error("Handler boom");
    });

    const results = await processEvent({
      event_type: "zerodb.table.row_inserted",
      table_name: "users",
      data: {},
      row_id: "user_1",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "error");
    assert.ok(results[0].error.includes("Handler boom"));
  });

  it("should invoke multiple matching triggers", async () => {
    let count = 0;
    onDocumentCreated("users/{userId}", () => { count++; });
    onDocumentCreated("users/{userId}", () => { count++; });

    await processEvent({
      event_type: "zerodb.table.row_inserted",
      table_name: "users",
      data: {},
      row_id: "user_1",
    });

    assert.equal(count, 2);
  });

  it("should handle handler returning a value", async () => {
    onDocumentCreated("users/{userId}", () => {
      return { sent: true };
    });

    const results = await processEvent({
      event_type: "zerodb.table.row_inserted",
      table_name: "users",
      data: { name: "Test" },
      row_id: "user_1",
    });

    assert.equal(results[0].status, "ok");
    assert.deepEqual(results[0].result, { sent: true });
  });
});

// ---------------------------------------------------------------------------
// deployTriggers tests
// ---------------------------------------------------------------------------

describe("deployTriggers", () => {
  it("should deploy registered triggers to ZeroDB", async () => {
    onDocumentCreated("users/{userId}", () => {});
    onDocumentUpdated("orders/{orderId}", () => {});

    // Mock two hook registration responses
    pushResponse(200, { hook_id: "h1", status: "active" });
    pushResponse(200, { hook_id: "h2", status: "active" });

    const results = await deployTriggers({
      apiKey: "zdb_test_key",
      projectId: "proj-test",
      baseUrl: "https://mock.test",
    });

    assert.equal(results.length, 2);
    assert.equal(results[0].status, "deployed");
    assert.equal(results[1].status, "deployed");
    assert.equal(fetchCalls.length, 2);

    // Verify hook registration payload
    const body1 = JSON.parse(fetchCalls[0].opts.body);
    assert.equal(body1.event_type, "zerodb.table.row_inserted");
    assert.equal(body1.table_name, "users");
    assert.equal(body1.project_id, "proj-test");

    const body2 = JSON.parse(fetchCalls[1].opts.body);
    assert.equal(body2.event_type, "zerodb.table.row_updated");
    assert.equal(body2.table_name, "orders");
  });

  it("should handle deploy errors per trigger", async () => {
    onDocumentCreated("users/{userId}", () => {});

    pushResponse(500, "Internal Server Error");

    const results = await deployTriggers({
      apiKey: "zdb_test_key",
      projectId: "proj-test",
      baseUrl: "https://mock.test",
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "error");
    assert.ok(results[0].error.includes("500"));
  });
});

// ---------------------------------------------------------------------------
// initializeApp tests
// ---------------------------------------------------------------------------

describe("initializeApp", () => {
  it("should create a ZeroDBClient with config", () => {
    const client = initializeApp({
      apiKey: "zdb_test",
      projectId: "proj-123",
      baseUrl: "https://test.example.com",
    });
    assert.ok(client instanceof ZeroDBClient);
    assert.equal(client._apiKey, "zdb_test");
    assert.equal(client._projectId, "proj-123");
  });

  it("should strip trailing slash", () => {
    const client = initializeApp({ apiKey: "k", projectId: "p", baseUrl: "https://a.com/" });
    assert.equal(client._baseUrl, "https://a.com");
  });
});

// ---------------------------------------------------------------------------
// clearTriggers / getRegisteredTriggers tests
// ---------------------------------------------------------------------------

describe("clearTriggers", () => {
  it("should clear all registered triggers", () => {
    onDocumentCreated("users/{userId}", () => {});
    onDocumentDeleted("orders/{orderId}", () => {});
    assert.equal(getRegisteredTriggers().length, 2);

    clearTriggers();
    assert.equal(getRegisteredTriggers().length, 0);
  });
});

// ---------------------------------------------------------------------------
// FirestoreEvent tests
// ---------------------------------------------------------------------------

describe("FirestoreEvent", () => {
  it("should have time, type, id, path, params", () => {
    const event = new FirestoreEvent({
      data: new DocumentSnapshot({}, "id1", "users/id1"),
      params: { userId: "id1" },
      type: "document.created",
      id: "id1",
      path: "users/id1",
    });

    assert.equal(event.type, "document.created");
    assert.equal(event.id, "id1");
    assert.equal(event.path, "users/id1");
    assert.deepEqual(event.params, { userId: "id1" });
    assert.ok(event.time);
  });
});

// ---------------------------------------------------------------------------
// Auto-provisioning tests
// ---------------------------------------------------------------------------

describe("Auto-provisioning", () => {
  it("should auto-provision when deploying without credentials", async () => {
    onDocumentCreated("users/{userId}", () => {});

    // instant-db response
    pushResponse(200, {
      api_key: "zdb_temp_abc",
      project_id: "proj-auto-456",
      claim_token: "tok_xyz",
    });
    // hook registration response
    pushResponse(200, { hook_id: "h1", status: "active" });

    const results = await deployTriggers({ baseUrl: "https://mock.test" });

    assert.equal(results.length, 1);
    assert.equal(results[0].status, "deployed");
    // First call should be instant-db, second should be hook registration
    assert.ok(fetchCalls[0].url.includes("/instant-db"));
    assert.ok(fetchCalls[1].url.includes("/hooks"));
  });

  it("should not auto-provision when credentials are provided", async () => {
    onDocumentCreated("users/{userId}", () => {});

    pushResponse(200, { hook_id: "h1", status: "active" });

    await deployTriggers({
      apiKey: "zdb_existing",
      projectId: "proj-existing",
      baseUrl: "https://mock.test",
    });

    // Only hook registration call, no instant-db
    assert.equal(fetchCalls.length, 1);
    assert.ok(fetchCalls[0].url.includes("/hooks"));
  });
});
