import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";
import { parseManifestJson } from "@openchamber/sdk/schemas";
import { collectWithPython, createCpuTracker, createGpuService, createSampler, pythonCandidates } from "../service/main.js";

async function temporaryHome(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "nvitop-monitor-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

async function addExecutable(path, contents = "") {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, { mode: 0o755 });
  return path;
}

async function candidatesInHome(home, env) {
  const candidates = await Array.fromAsync(pythonCandidates({ home, env }));
  assert.equal(candidates.at(-1), "python3");
  return candidates.filter((path) => path.startsWith(home + "/"));
}

test("the SDK accepts the packaged manifest and its entry files exist", () => {
  const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const parsed = parseManifestJson(read("package.json"));
  assert.equal(parsed.ok, true, parsed.message);
  const { panel, service, page, statusSection } = parsed.manifest.contributes;
  assert.equal(panel.id, "openchamber-nvitop");
  assert.equal(panel.name, "nvitop GPU Monitor");
  assert.equal(page, true);
  for (const path of [panel.entry, statusSection.entry, service.entry, "panel/main.js", "service/collect.py"]) {
    assert.ok(read(path).length);
  }
});

test("finds default and named Pixi environments even with no PIXI_HOME", async (t) => {
  const home = await temporaryHome(t);
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

  assert.deepEqual(await candidatesInHome(home, {}), [defaultPython]);
  assert.deepEqual(await candidatesInHome(home, { PATH: ["/usr/bin", customBin].join(delimiter) }),
    [defaultPython, customPython]);
  assert.deepEqual(await candidatesInHome(home, { PIXI_HOME: customRoot }), [defaultPython, customPython]);
});

test("finds default, legacy and custom uv and pipx installs without launchers on PATH", async (t) => {
  const home = await temporaryHome(t);
  const defaultUv = await addExecutable(join(home, ".local/share/uv/tools/nvitop/bin/python3"));
  const legacyPipx = await addExecutable(join(home, ".local/pipx/venvs/nvitop/bin/python3"));
  const defaultPipx = await addExecutable(join(home, ".local/share/pipx/venvs/nvitop/bin/python"));
  const data = join(home, "xdg data");
  const xdgUv = await addExecutable(join(data, "uv/tools/nvitop/bin/python"));
  const xdgPipx = await addExecutable(join(data, "pipx/venvs/nvitop/bin/python"));
  const uv = join(home, "custom uv");
  const pipx = join(home, "custom pipx");
  const globalPipx = join(home, "global pipx");
  const customUv = await addExecutable(join(uv, "nvitop/bin/python"));
  const customPipx = await addExecutable(join(pipx, "venvs/nvitop/bin/python3"));
  const customGlobalPipx = await addExecutable(join(globalPipx, "venvs/nvitop/bin/python3"));

  assert.deepEqual(await candidatesInHome(home, { PATH: "/usr/bin" }), [defaultUv, legacyPipx, defaultPipx]);
  assert.deepEqual(await candidatesInHome(home, {
    PATH: "/usr/bin", XDG_DATA_HOME: data, UV_TOOL_DIR: uv, PIPX_HOME: pipx, PIPX_GLOBAL_HOME: globalPipx,
  }), [customUv, xdgUv, defaultUv, customPipx, legacyPipx, xdgPipx, defaultPipx, customGlobalPipx]);
});

test("recovers custom virtualenvs and user installs from launchers", async (t) => {
  const home = await temporaryHome(t);
  const systemPython = await addExecutable(join(home, "system/bin/python3.12"));
  const venvBin = join(home, "tool env/bin");
  const launcher = await addExecutable(join(venvBin, "nvitop"), "#!/bin/sh\n");
  const venvPython = join(venvBin, "python3");
  await symlink(systemPython, venvPython);
  const pathBin = join(home, "custom bin");
  await mkdir(pathBin);
  await symlink(launcher, join(pathBin, "nvitop"));
  await addExecutable(join(home, ".local/bin/nvitop"), `#!${systemPython}\n`);

  assert.deepEqual(await candidatesInHome(home, { PATH: pathBin }), [venvPython, systemPython]);
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
  time = 6_999;
  assert.deepEqual(await sample(), { sampledAt: 5_000 });
  time = 7_000;
  assert.deepEqual(await sample(), { sampledAt: 7_000 });
  assert.equal(reads, 3);
});

test("the shared sampler uses the requested interval for an existing sample", async () => {
  let time = 0;
  const sample = createSampler(async () => ({ sampledAt: time }), () => time);
  assert.deepEqual(await sample(10), { sampledAt: 0 });
  time = 9_999;
  assert.deepEqual(await sample(10), { sampledAt: 0 });
  assert.deepEqual(await sample(5), { sampledAt: 9_999 });
  time = 10_998;
  assert.deepEqual(await sample(1), { sampledAt: 9_999 });
  time = 10_999;
  assert.deepEqual(await sample(1), { sampledAt: 10_999 });
});

test("CPU uses consecutive times for the same PID and process start", () => {
  let time = 0;
  const track = createCpuTracker(() => time);
  const context = (startedAt, cpuTime, deviceId = "gpu") => ({ pid: 123, deviceId, startedAt, cpuTime });
  assert.deepEqual(track({ processes: [context(1, 4)] }).processes, [
    { pid: 123, deviceId: "gpu", startedAt: 1, cpu: null },
  ]);

  time = 2_000;
  assert.deepEqual(track({ processes: [context(1, 7), context(1, 7, "mig")] }).processes, [
    { pid: 123, deviceId: "gpu", startedAt: 1, cpu: 150 },
    { pid: 123, deviceId: "mig", startedAt: 1, cpu: 150 },
  ]);

  time = 4_000;
  assert.equal(track({ processes: [context(2, 0.5)] }).processes[0].cpu, null);
  time = 6_000;
  assert.equal(track({ processes: [context(2, 0.5)] }).processes[0].cpu, 0);
  time = 8_000;
  assert.equal(track({ processes: [context(2, null)] }).processes[0].cpu, null);
  time = 10_000;
  assert.equal(track({ processes: [context(2, 4)] }).processes[0].cpu, null);
});

test("service gates endpoints and keeps process details out of Work Status", async () => {
  const snapshot = {
    version: 1,
    devices: [{ id: "gpu", parentId: null }, { id: "mig", parentId: "gpu" }],
    processes: [{ pid: 123, deviceId: "mig" }],
    processCount: 1,
  };
  const intervals = [];
  const commandQueries = [];
  const server = createGpuService({
    token: "test",
    readCommand: async (pid, startedAt) => {
      commandQueries.push({ pid, startedAt });
      return { command: "python train.py --data 'a b'" };
    },
    sample: async (seconds) => {
      intervals.push(seconds);
      return snapshot;
    },
  });
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
  assert.deepEqual((await request("/summary?interval=15")).data, {
    version: 1, devices: [snapshot.devices[0]], processCount: 1,
  });
  assert.equal((await request("/snapshot?interval=61")).status, 200);
  assert.equal((await request("/snapshot?interval=2.5")).status, 200);
  assert.deepEqual(intervals, [2, 15, 2, 2]);
  assert.equal((await request("/command?pid=123")).status, 400);
  assert.equal((await request("/command?pid=0&startedAt=42")).status, 400);
  assert.equal((await request("/command?pid=123&startedAt=NaN")).status, 400);
  assert.deepEqual((await request("/command?pid=123&startedAt=42.5")).data,
    { command: "python train.py --data 'a b'" });
  assert.deepEqual(commandQueries, [{ pid: 123, startedAt: 42.5 }]);
});
