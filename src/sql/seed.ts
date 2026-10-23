/**
 * Synthetic e-commerce seed database for the Text-to-SQL demo.
 * Deterministic (LCG) so the eval set and README numbers are reproducible.
 */
import { DatabaseSync } from "node:sqlite";

export const DEMO_DDL = `
CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  country TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE addresses (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  line1 TEXT NOT NULL,
  city TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES categories(id)
);
CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES categories(id),
  name TEXT NOT NULL,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  status TEXT NOT NULL, -- placed | shipped | delivered | cancelled
  placed_at TEXT NOT NULL
);
CREATE TABLE order_items (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  method TEXT NOT NULL, -- card | paypal | bank
  amount_cents INTEGER NOT NULL,
  paid_at TEXT NOT NULL
);
CREATE TABLE returns (
  id INTEGER PRIMARY KEY,
  order_item_id INTEGER NOT NULL REFERENCES order_items(id),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  type TEXT NOT NULL, -- view | add_to_cart | checkout
  occurred_at TEXT NOT NULL
);
`;

/** Tiny deterministic LCG — same data on every machine. */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function seedDemo(db: DatabaseSync): void {
  db.exec(DEMO_DDL);
  const rnd = lcg(20261024);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
  const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));

  const countries = ["US", "GB", "DE", "CN", "JP", "AU", "CA"];
  const statuses = ["placed", "shipped", "delivered", "delivered", "cancelled"];
  const methods = ["card", "card", "paypal", "bank"];
  const reasons = ["damaged", "wrong item", "changed mind", "late delivery"];

  const insC = db.prepare("INSERT INTO customers (id,name,email,country,created_at) VALUES (?,?,?,?,?)");
  const insA = db.prepare("INSERT INTO addresses (id,customer_id,line1,city,postal_code,is_default) VALUES (?,?,?,?,?,?)");
  const insCat = db.prepare("INSERT INTO categories (id,name,parent_id) VALUES (?,?,?)");
  const insP = db.prepare("INSERT INTO products (id,category_id,name,price_cents,stock) VALUES (?,?,?,?,?)");
  const insO = db.prepare("INSERT INTO orders (id,customer_id,status,placed_at) VALUES (?,?,?,?)");
  const insI = db.prepare("INSERT INTO order_items (id,order_id,product_id,qty,unit_price_cents) VALUES (?,?,?,?,?)");
  const insPay = db.prepare("INSERT INTO payments (id,order_id,method,amount_cents,paid_at) VALUES (?,?,?,?,?)");
  const insR = db.prepare("INSERT INTO returns (id,order_item_id,reason,created_at) VALUES (?,?,?,?)");
  const insE = db.prepare("INSERT INTO events (id,customer_id,type,occurred_at) VALUES (?,?,?,?)");

  const day = (n: number) => new Date(Date.UTC(2025, 0, 1) + n * 86400_000).toISOString().slice(0, 10);

  const cats = ["Electronics", "Home", "Apparel", "Books"];
  cats.forEach((name, i) => insCat.run(i + 1, name, null));
  const subcats = ["Phones", "Laptops", "Kitchen", "Furniture", "Men", "Women", "Fiction", "Non-fiction"];
  subcats.forEach((name, i) => insCat.run(100 + i + 1, name, 1 + (i % 4)));

  for (let i = 1; i <= 200; i++) {
    insC.run(i, `Customer ${String(i).padStart(3, "0")}`, `c${i}@example.com`, pick(countries), day(int(0, 700)));
    insA.run(i, i, `${int(1, 999)} Main St`, `City${int(1, 40)}`, String(10000 + int(0, 8999)), i === 1 ? 1 : int(0, 1));
  }
  for (let i = 1; i <= 120; i++) {
    insP.run(i, 100 + ((i - 1) % 8) + 1, `Product ${String(i).padStart(3, "0")}`, int(499, 129900), int(0, 500));
  }

  let itemId = 0, returnId = 0, eventId = 0;
  for (let orderId = 1; orderId <= 600; orderId++) {
    insO.run(orderId, int(1, 200), pick(statuses), day(int(0, 690)));
    let total = 0;
    for (let k = 0; k < int(1, 4); k++) {
      const pid = int(1, 120), qty = int(1, 3), price = int(499, 129900);
      insI.run(++itemId, orderId, pid, qty, price);
      total += qty * price;
      if (rnd() < 0.05) insR.run(++returnId, itemId, pick(reasons), day(int(0, 690)));
    }
    insPay.run(orderId, orderId, pick(methods), total, day(int(0, 690)));
    for (let k = 0; k < int(0, 5); k++) {
      insE.run(++eventId, int(1, 200), pick(["view", "add_to_cart", "checkout"]), day(int(0, 700)));
    }
  }
}
