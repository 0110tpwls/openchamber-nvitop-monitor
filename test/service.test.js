import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseManifestJson } from "@openchamber/sdk/schemas";
import { createGpuService, createSampler } from "../service/main.js";

test("the SDK accepts the packaged manifest and its entry files exist", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const parsed = parseManifestJson(read("package.json"));
  assert.equal(parsed.ok, true, parsed.message);
  const { panel, service, page, statusSection } = parsed.manifest.contributes;
  assert.equal(page, true);
  for (const path of [panel.entry, statusSection.entry, service.entry, "panel/main.js", "service/collect.py"]) {
    assert.ok(read(path).length);
  }
});

test("parallel callers share samples and errors expire before recovery", async () => {
  let time = 0;
  let reads = 0;
  const sample = createSampler(async () => (++reads === 1 ? { error: "NVML" } : { sampledAt: time }), () => time);
  assert.deepEqual(await Promise.all([sample(), sample()]), [{ error: "NVML" }, { error: "NVML" }]);
  time = 4_999;
  assert.deepEqual(await sample(), { error: "NVML" });
  time = 5_000;
  assert.deepEqual(await sample(), { sampledAt: 5_000 });
  time = 6_799;
  assert.deepEqual(await sample(), { sampledAt: 5_000 });
  time = 6_800;
  assert.deepEqual(await sample(), { sampledAt: 6_800 });
  assert.equal(reads, 3);
});

test("service gates endpoints and keeps process details out of Work Status", async () => {
  const snapshot = {
    version: 1,
    devices: [{ id: "gpu", parentId: null }, { id: "mig", parentId: "gpu" }],
    processes: [{ pid: 123, deviceId: "mig" }],
    processCount: 1,
  };
  const server = createGpuService({ token: "test", sample: async () => snapshot });
  function request(url, method = "GET", authorization = "Bearer test") {
    return new Promise((resolve) => {
      let status;
      server.emit("request", { url, method, headers: { authorization } }, {
        writeHead: (code) => { status = code; },
        end: (body) => resolve({ status, data: JSON.parse(body) }),
      });
    });
  }

  assert.equal((await request("/health", "GET", "invalid")).status, 401);
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/snapshot", "POST")).status, 405);
  assert.equal((await request("/missing")).status, 404);
  assert.deepEqual((await request("/snapshot")).data, snapshot);
  assert.deepEqual((await request("/summary")).data, {
    version: 1, devices: [snapshot.devices[0]], processCount: 1,
  });
});
