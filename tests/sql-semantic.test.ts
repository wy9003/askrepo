import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTerms, semanticInstructions } from "../src/sql/semantic.ts";

test("semantic: grounded terms resolve with definitions", () => {
  const r = resolveTerms("What is the total revenue per country?");
  assert.ok(r.grounded.some((g) => g.term === "revenue"));
  assert.equal(r.ungrounded.length, 0);
  const note = semanticInstructions(r);
  assert.ok(note.includes("SUM(payments.amount_cents)"));
});

test("semantic: ungrounded business words are flagged, not silently passed", () => {
  const r = resolveTerms("How many inactive customers with high margin do we have?");
  assert.ok(r.ungrounded.includes("inactive"));
  assert.ok(r.ungrounded.includes("margin"));
  const note = semanticInstructions(r);
  assert.ok(note.includes("NOT_ANSWERABLE"));
  assert.ok(note.includes("Do NOT invent"));
});

test("semantic: churned is grounded via glossary (not flagged as ungrounded)", () => {
  const r = resolveTerms("List customers who churned last quarter");
  assert.ok(r.grounded.some((g) => g.term === "churned customer"));
  assert.equal(r.ungrounded.length, 0);
});

test("semantic: ordinary questions produce no semantic noise", () => {
  const r = resolveTerms("How many orders were placed yesterday?");
  assert.equal(r.grounded.length, 0);
  assert.equal(r.ungrounded.length, 0);
  assert.equal(semanticInstructions(r), "");
});
