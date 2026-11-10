import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir } from "node:fs/promises";
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

export async function* pythonCandidates({ home = homedir(), env = process.env } = {}) {
  const venvPython = join(home, ".local/share/openchamber-nvitop/venv/bin/python3");
  if (await executable(venvPython)) yield venvPython;

  // The service keeps HOME and PATH even if OpenChamber strips PIXI_HOME.
  const roots = new Set([join(home, ".pixi")]);
  if (env.PIXI_HOME && isAbsolute(env.PIXI_HOME)) roots.add(env.PIXI_HOME);
  for (const bin of (env.PATH ?? "").split(delimiter)) {
    if (isAbsolute(bin) && basename(bin) === "bin" &&
        await executable(join(bin, "trampoline_configuration"))) {
      roots.add(dirname(bin));
    }
  }

  for (const root of roots) {
    const envs = join(root, "envs");
    const names = await readdir(envs).catch(() => []);
    for (const name of ["nvitop", ...names.filter((name) => name !== "nvitop").sort()]) {
      const bin = join(envs, name, "bin");
      if (!await executable(join(bin, "nvitop"))) continue;
      const python = join(bin, "python3");
      if (await executable(python)) yield python;
      else if (await executable(join(bin, "python"))) yield join(bin, "python");
    }
  }
  yield "python3";
}

export async function collect() {
  if (process.platform !== "linux") {
    return { error: "UNSUPPORTED_OS", message: "Connect to an OpenChamber server running on a Linux NVIDIA host." };
  }

  return collectWithPython(pythonCandidates(), async (python) => {
    const { PATH, HOME, LANG, LC_ALL } = process.env;
    const { stdout } = await exec(python, ["-I", collector], {
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
  return { error: "NVITOP_MISSING", message: "nvitop was not found in Pixi global, the extension venv, or system Python. Check the OpenChamber server account." };
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
