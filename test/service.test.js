import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { parseManifestJson } from "@openchamber/sdk/schemas";
import { collectWithPython, createGpuService, createSampler, pythonCandidates } from "../service/main.js";

test("the SDK accepts the packaged manifest and its entry files exist", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const parsed = parseManifestJson(read("package.json"));
  assert.equal(parsed.ok, true, parsed.message);
  const { panel, service, page, statusSection } = parsed.manifest.contributes;
  assert.equal(panel.id, "openchamber-nvitop");
  assert.equal(panel.name, "onvitop");
  assert.equal(page, true);
  for (const path of [panel.entry, statusSection.entry, service.entry, "panel/main.js", "service/collect.py"]) {
    assert.ok(read(path).length);
  }
});

test("finds default and named Pixi environments even with no PIXI_HOME", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "onvitop-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  async function addExecutable(path) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "", { mode: 0o755 });
    return path;
  }
  const defaultPixi = join(home, ".pixi", "envs", "nvitop", "bin");
  const customRoot = join(home, "custom-pixi");
  const customPixi = join(customRoot, "envs", "gpu-tools", "bin");
  const defaultPython = await addExecutable(join(defaultPixi, "python3"));
  const customPython = await addExecutable(join(customPixi, "python"));
  await addExecutable(join(defaultPixi, "nvitop"));
  await addExecutable(join(customPixi, "nvitop"));
  await addExecutable(join(home, ".pixi", "envs", "unrelated", "bin", "python3"));
  const customBin = join(customRoot, "bin");
  await mkdir(join(customBin, "trampoline_configuration"), { recursive: true });

  assert.deepEqual(await Array.fromAsync(pythonCandidates({ home, env: {} })),
    [defaultPython, "python3"]);
  assert.deepEqual(await Array.fromAsync(pythonCandidates({
    home, env: { PATH: ["/usr/bin", customBin].join(delimiter) },
  })), [defaultPython, customPython, "python3"]);
  assert.deepEqual(await Array.fromAsync(pythonCandidates({ home, env: { PIXI_HOME: customRoot } })),
    [defaultPython, customPython, "python3"]);
});

test("a stale venv does not mask Pixi and an NVML error does not fall back", async () => {
  const attempted = [];
  const failure = { error: "NVML_UNAVAILABLE" };
  const result = await collectWithPython(["venv", "pixi", "system"], async (python) => {
    attempted.push(python);
    return python === "venv" ? { error: "NVITOP_MISSING" } : failure;
  });
  assert.deepEqual(attempted, ["venv", "pixi"]);
  assert.equal(result, failure);
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
