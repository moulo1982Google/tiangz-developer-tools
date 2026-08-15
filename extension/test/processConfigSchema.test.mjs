import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testRoot = path.dirname(fileURLToPath(import.meta.url));
const schemaPath = path.resolve(testRoot, "../schemas/process-config.schema.json");

test("exposes the Rust-owned NativeData observability contract", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const processProperties = schema.properties.process.properties;
  const nativeData = processProperties.observability.properties.nativeData;

  assert.equal(processProperties.nativeData, false);
  assert.equal(nativeData.additionalProperties, false);
  assert.equal(nativeData.properties.debugScalarAccess.type, "boolean");
  assert.equal(nativeData.properties.scalarAccessWarnThreshold.minimum, 1);
  assert.equal(nativeData.properties.scalarAccessWarnThreshold.default, 10_000);
});

test("exposes ordered DBProxy failover endpoints", async () => {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));
  const dbProxy = schema.properties.process.properties.persistence.properties.dbProxy;
  const failoverEndpoints = dbProxy.properties.failoverEndpoints;

  assert.equal(failoverEndpoints.type, "array");
  assert.equal(failoverEndpoints.maxItems, 7);
  assert.equal(failoverEndpoints.items.type, "string");
  assert.equal(failoverEndpoints.items.maxLength, 512);
});
