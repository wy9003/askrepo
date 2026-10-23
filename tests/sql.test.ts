import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { seedDemo } from "../src/sql/seed.ts";
import { introspect, tableDoc } from "../src/sql/introspect.ts";
import { closure } from "../src/sql/fkgraph.ts";
import { extractSQL } from "../src/sql/generate.ts";
import { askSql } from "../src/sql/index.ts";
import { MockEmbedder } from "../src/embed.ts";
import { ScriptedSqlProvider } from "../src/sql/offline.ts";

function demoDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  seedDemo(db);
  return db;
}

test("seed + introspect: 9 tables, FKs discovered from catalog", () => {
  const schema = introspect(demoDb());
  assert.equal(schema.tables.length, 9);
  const names = schema.tables.map((t) => t.name);
  for (const expected of ["customers", "orders", "order_items", "products", "payments", "returns", "events", "addresses", "categories"]) {
    assert.ok(names.includes(expected), `missing table ${expected}`);
  }
  // FK edges exist and point at real columns.
  const fk = schema.foreignKeys.find((f) => f.fromTable === "order_items" && f.toTable === "products");
  assert.ok(fk, "order_items → products FK missing");
  assert.equal(fk!.fromColumn, "product_id");
  const doc = tableDoc(schema.tables.find((t) => t.name === "order_items")!, schema.foreignKeys);
  assert.ok(doc.includes("order_id -> orders.id"));
  assert.ok(doc.includes("product_id -> products.id"));
});

test("FK closure connects disconnected tables through shortest path", () => {
  const { foreignKeys } = introspect(demoDb());
  // customers and products share no FK edge; closure must bridge them.
  const r = closure(["customers", "products"], foreignKeys);
  assert.ok(r.tables.includes("customers") && r.tables.includes("products"));
  assert.deepEqual(r.added.sort(), ["order_items", "orders"]);
  assert.ok(r.joins.some((j) => j.includes("orders.customer_id") || j.includes("customer_id = customers.id")));
  // The connected set must be join-complete: every added table has an FK to another table in the set.
  const joinsText = r.joins.join(" | ");
  assert.ok(joinsText.includes("order_items.order_id = orders.id"));
  assert.ok(joinsText.includes("order_items.product_id = products.id"));
});

test("FK closure adds nothing when the set is already connected", () => {
  const { foreignKeys } = introspect(demoDb());
  const r = closure(["orders", "customers"], foreignKeys);
  assert.deepEqual(r.added, []);
  const r2 = closure(["orders"], foreignKeys);
  assert.deepEqual(r2.added, []);
});

test("extractSQL handles fenced and bare replies", () => {
  assert.equal(extractSQL("Sure!\n```sql\nSELECT 1 AS one;\n```\nDone"), "SELECT 1 AS one");
  assert.equal(extractSQL("SELECT 2 AS two;"), "SELECT 2 AS two");
  assert.equal(extractSQL("with t as (select 3 as x) select * from t"), "with t as (select 3 as x) select * from t");
});

test("pipeline end-to-end offline: retrieve → closure → scripted SQL → execute", async () => {
  const db = demoDb();
  const res = await askSql(db, "how many orders", {
    provider: new ScriptedSqlProvider(),
    embedder: new MockEmbedder(),
  });
  assert.equal(res.rowCount, 1); // COUNT returns a single result row
  assert.equal(Number(res.rows[0]?.total_orders), 600);
  assert.ok(res.sql.toUpperCase().includes("COUNT"));
  assert.ok(res.tablesUsed.length >= 1);
});
