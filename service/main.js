import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const collector = fileURLToPath(new URL("./collect.py", import.meta.url));

async function executable(path) {
  return access(path, constants.X_OK).then(() => true, () => false);
}

async function pythonIn(bin) {
  const python3 = join(bin, "python3");
  if (await executable(python3)) return python3;
  const python = join(bin, "python");
  if (await executable(python)) return python;
}

async function* pixiInterpreters(home, env, pathBins) {
  // The service keeps HOME and PATH even if OpenChamber strips PIXI_HOME.
  const roots = new Set([join(home, ".pixi")]);
  if (env.PIXI_HOME && isAbsolute(env.PIXI_HOME)) roots.add(env.PIXI_HOME);
  for (const bin of pathBins) {
    if (basename(bin) === "bin" && await executable(join(bin, "trampoline_configuration"))) {
      roots.add(dirname(bin));
    }
  }

  for (const root of roots) {
    const envs = join(root, "envs");
    const names = await readdir(envs).catch(() => []);
    for (const name of ["nvitop", ...names.filter((name) => name !== "nvitop").sort()]) {
      const bin = join(envs, name, "bin");
      if (!await executable(join(bin, "nvitop"))) continue;
      yield await pythonIn(bin);
    }
  }
}

async function* managedInterpreters(home, env) {
  const dataDirs = new Set([env.XDG_DATA_HOME, join(home, ".local/share")].filter((path) => path && isAbsolute(path)));
  const pipxHomes = [
    env.PIPX_HOME,
    join(home, ".local/pipx"),
    ...Array.from(dataDirs, (data) => join(data, "pipx")),
    env.PIPX_GLOBAL_HOME,
    "/opt/pipx",
  ];
  const toolDirs = [
    env.UV_TOOL_DIR,
    ...Array.from(dataDirs, (data) => join(data, "uv/tools")),
    ...pipxHomes.filter((path) => path && isAbsolute(path)).map((path) => join(path, "venvs")),
  ];
  for (const dir of new Set(toolDirs.filter((path) => path && isAbsolute(path)))) {
    yield await pythonIn(join(dir, "nvitop", "bin"));
  }
}

async function launcherPython(bin) {
  try {
    const launcher = await realpath(join(bin, "nvitop"));
    if (!(await stat(launcher)).isFile() || !await executable(launcher)) return;

    // Read the entry point without running it. Keep the Python path itself
    // unresolved so Python can detect its virtual environment.
    const file = await open(launcher, "r");
    const bytes = Buffer.alloc(512);
    let firstLine;
    try {
      const { bytesRead } = await file.read(bytes);
      firstLine = bytes.toString("utf8", 0, bytesRead).split("\n", 1)[0];
    } finally {
      await file.close();
    }
    const interpreter = firstLine.match(/^#![ \t]*(\/[^\s]+)[ \t]*\r?$/)?.[1];
    if (interpreter && /^(?:python|pypy)(?:\d+(?:\.\d+)?)?t?$/.test(basename(interpreter)) &&
        await executable(interpreter)) return interpreter;

    // pip may use a shell launcher when a venv path contains spaces.
    return pythonIn(dirname(launcher));
  } catch {
    // The entry point can disappear during an upgrade.
  }
}

async function* installedInterpreters(home, env, pathBins) {
  yield await pythonIn(join(home, ".local/share/openchamber-nvitop/venv/bin"));
  yield* pixiInterpreters(home, env, pathBins);
  yield* managedInterpreters(home, env);
  const appBins = [
    ...pathBins, env.UV_TOOL_BIN_DIR, env.PIPX_BIN_DIR, env.PIPX_GLOBAL_BIN_DIR, env.XDG_BIN_HOME,
    env.XDG_DATA_HOME && isAbsolute(env.XDG_DATA_HOME) ? join(env.XDG_DATA_HOME, "../bin") : undefined,
    join(home, ".local/bin"), "/usr/local/bin",
  ];
  for (const bin of new Set(appBins.filter((path) => path && isAbsolute(path)))) {
    yield await launcherPython(bin);
  }
  yield "python3";
}

export async function* pythonCandidates({ home = homedir(), env = process.env } = {}) {
  const pathBins = [...new Set((env.PATH ?? "").split(delimiter).filter(isAbsolute))];
  const seen = new Set();
  for await (const python of installedInterpreters(home, env, pathBins)) {
    if (!python || seen.has(python)) continue;
    seen.add(python);
    yield python;
  }
}

export async function collect() {
  if (process.platform !== "linux") {
    return { error: "UNSUPPORTED_OS", message: "Connect to an OpenChamber server running on a Linux NVIDIA host." };
  }

  return collectWithPython(pythonCandidates(), async (python) => {
    const { PATH, HOME, LANG, LC_ALL } = process.env;
    // Ignore PYTHON* variables while retaining the site directory used by pip --user.
    const { stdout } = await exec(python, ["-E", collector], {
      env: { PATH, HOME, LANG, LC_ALL },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 512 * 1024,
    });
    return JSON.parse(stdout);
  });
}

export async function collectWithPython(candidates, run) {
  let pythonFound = false;
  for await (const python of candidates) {
    try {
      const sample = await run(python);
      if (sample.error !== "NVITOP_MISSING") return sample;
      pythonFound = true;
    } catch (error) {
      if (error.code === "ENOENT") continue;
      if (error.killed) {
        return { error: "COLLECTOR_TIMEOUT", message: "GPU sampling timed out. Check nvidia-smi on the server." };
      }
      console.error("nvitop collector failed:", String(error.stderr || error.message).slice(0, 2000));
      return { error: "COLLECTOR_FAILED", message: "GPU sampling failed. Check the extension service log." };
    }
  }
  if (!pythonFound) {
    return { error: "PYTHON_MISSING", message: "Python 3 was not found on the OpenChamber server." };
  }
  return { error: "NVITOP_MISSING", message: "nvitop was not found. Check the server account's Pixi, uv tool, pipx or pip installation." };
}

export function createSampler(read, now = Date.now) {
  let cached;
  let expires = 0;
  let pending;
  return async () => {
    if (now() < expires) return cached;
    pending ??= Promise.resolve().then(read).then((sample) => {
      cached = sample;
      expires = now() + (sample.error ? 5_000 : 1_800);
      return sample;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

export function createGpuService({ token, sample = createSampler(collect) }) {
  if (!token) throw new Error("Missing OpenChamber service token");
  return createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "UNAUTHORIZED" });
    if (req.method !== "GET") return json(res, 405, { error: "METHOD_NOT_ALLOWED" });
    if (req.url === "/health") return json(res, 200, { ok: true });
    if (req.url !== "/snapshot" && req.url !== "/summary") return json(res, 404, { error: "NOT_FOUND" });

    try {
      const data = await sample();
      if (data.error) return json(res, 503, data);
      if (req.url === "/summary") {
        const { processes, ...summary } = data;
        summary.devices = data.devices.filter((device) => device.parentId === null);
        return json(res, 200, summary);
      }
      return json(res, 200, data);
    } catch (error) {
      console.error("nvitop service:", error);
      return json(res, 503, { error: "COLLECTOR_FAILED", message: "GPU sampling failed." });
    }
  });
}

if (process.env.OPENCHAMBER_SERVICE_PORT) {
  const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid OpenChamber service port");
  createGpuService({ token: process.env.OPENCHAMBER_SERVICE_TOKEN }).listen(port, "127.0.0.1");
}
