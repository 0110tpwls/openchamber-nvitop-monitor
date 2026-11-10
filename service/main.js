import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const collector = fileURLToPath(new URL("./collect.py", import.meta.url));
const venvPython = join(homedir(), ".local/share/openchamber-nvitop/venv/bin/python3");

export async function collect() {
  if (process.platform !== "linux") {
    return { error: "UNSUPPORTED_OS", message: "Connect to an OpenChamber server running on a Linux NVIDIA host." };
  }

  const python = await access(venvPython).then(() => venvPython, () => "python3");
  try {
    // Pass only the locale, home and executable search path to the collector.
    const { PATH, HOME, LANG, LC_ALL } = process.env;
    const { stdout } = await exec(python, ["-I", collector], {
      env: { PATH, HOME, LANG, LC_ALL },
      encoding: "utf8",
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 512 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { error: "PYTHON_MISSING", message: "Install Python 3 on the OpenChamber server." };
    }
    if (error.killed) {
      return { error: "COLLECTOR_TIMEOUT", message: "GPU sampling timed out. Check nvidia-smi on the server." };
    }
    console.error("nvitop collector failed:", String(error.stderr || error.message).slice(0, 2000));
    return { error: "COLLECTOR_FAILED", message: "GPU sampling failed. Check the extension service log." };
  }
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
