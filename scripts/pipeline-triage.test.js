// Standalone self-test for pipeline-triage.js -- run directly:
// `node --test scripts/pipeline-triage.test.js`
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify } from "./pipeline-triage.js";

test("high risk always escalates", () => {
  const result = classify("high", ["client/App.tsx"]);
  assert.equal(result.decision, "full_pipeline");
});

test("medium risk always escalates", () => {
  const result = classify("medium", ["client/App.tsx"]);
  assert.equal(result.decision, "full_pipeline");
});

test("low risk multi-file escalates", () => {
  const result = classify("low", ["a.js", "b.js"]);
  assert.equal(result.decision, "full_pipeline");
});

test("low risk whatsapp path escalates", () => {
  const result = classify("low", ["server/whatsapp-session.js"]);
  assert.equal(result.decision, "full_pipeline");
});

test("low risk dispatcher path escalates", () => {
  const result = classify("low", ["scripts/dispatch-task.js"]);
  assert.equal(result.decision, "full_pipeline");
});

test("low risk single non-sensitive file is fast_path", () => {
  const result = classify("low", ["scripts/some-unrelated-util.js"]);
  assert.equal(result.decision, "fast_path");
});

test("no files never fast_path", () => {
  const result = classify("low", []);
  assert.equal(result.decision, "full_pipeline");
});
