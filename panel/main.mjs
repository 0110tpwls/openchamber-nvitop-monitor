import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountButton, mountSearchField } from "@openchamber/sdk/ui";
import { DEFAULT_SAMPLING_SECONDS, isSamplingInterval } from "../sampling.mjs";

const WINDOW_MS = 120_000;
const SETTINGS_KEY = "gpu-metric-display";
const SAMPLING_KEY = "gpu-sampling-seconds";
const number = Number.isFinite;
const byId = (id) => document.getElementById(id);
const root = byId("root");
const notice = byId("notice");
const devices = byId("devices");
const systemCard = byId("system");
const host = connectHost();

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const value = (n, unit) => number(n) ? `${Math.round(n)}${unit}` : "—";
const precisePercent = (n) => number(n) ? `${n.toFixed(1)}%` : "—";
const gib = (n) => number(n) ? `${(n / 2 ** 30).toFixed(1)} GiB` : "—";
const fraction = (device) => device.total > 0 && number(device.used) ? 100 * device.used / device.total : null;
const duration = (seconds) => {
  if (!number(seconds)) return "—";
  return [seconds / 3600, seconds / 60 % 60, seconds % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0")).join(":");
};
const percent = (n) => Math.max(0, Math.min(100, n));

const GPU_METRICS = {
  util: { label: "GPU utilization", unit: "%", read: (gpu) => gpu.util },
  vram: {
    label: "VRAM", unit: "%", read: fraction,
    display: (gpu) => `${gib(gpu.used)} / ${gib(gpu.total)}`,
  },
  mbw: { label: "MBW", description: "Memory bandwidth utilization", unit: "%", read: (gpu) => gpu.mbw },
  temperature: { label: "Temperature", unit: " °C", read: (gpu) => gpu.temperature },
  power: {
    label: "Power (PWR)", unit: " W", read: (gpu) => gpu.watts,
    display: (gpu) => gpu.wattLimit > 0 ? `${value(gpu.watts, " W")} / ${value(gpu.wattLimit, " W")}` : value(gpu.watts, " W"),
    bar: (gpu) => gpu.wattLimit > 0 && number(gpu.watts) ? 100 * gpu.watts / gpu.wattLimit : null,
    ceiling: (gpu, samples) => Math.ceil(Math.max(10, gpu.wattLimit ?? 0, ...samples.map((s) => s.values.power ?? 0)) / 10) * 10,
  },
  fan: { label: "Fan", unit: "%", read: (gpu) => gpu.fan },
};
const SYSTEM_METRICS = {
  cpu: { label: "Host CPU", unit: "%", read: (system) => system.cpu },
  ram: {
    label: "System RAM", unit: "%", read: (system) => system.memoryPercent,
    display: (system) => `${gib(system.memoryUsed)} / ${gib(system.memoryTotal)} · ${value(system.memoryPercent, "%")}`,
  },
};
const METRICS = { ...GPU_METRICS, ...SYSTEM_METRICS };
const SYSTEM_IDS = Object.keys(SYSTEM_METRICS);
const SYSTEM_HISTORY = Symbol("system");
const DEFAULT_METRICS = {
  bars: ["util", "vram", "mbw", "temperature", "power", ...SYSTEM_IDS],
  graphs: ["util", ...SYSTEM_IDS],
};

function bar(n) {
  const track = element("div", "track");
  track.setAttribute("aria-hidden", "true");
  if (number(n)) {
    const fill = element("div", "fill");
    fill.style.width = `${percent(n)}%`;
    track.append(fill);
  }
  return track;
}

function metricBar(id, gpu) {
  const metric = METRICS[id];
  const current = metric.read(gpu);
  const node = element("div", "metric");
  node.dataset.metric = id;
  const row = element("div", "metric-label");
  const label = element("span", "muted", metric.label);
  if (metric.description) label.title = metric.description;
  row.append(label, element("strong", "", metric.display ? metric.display(gpu) : value(current, metric.unit)));
  node.append(row, bar(metric.bar ? metric.bar(gpu) : current));
  return node;
}

function historyLine(id, gpu, samples, end) {
  const metric = METRICS[id];
  const ceiling = metric.ceiling?.(gpu, samples) ?? 100;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 240 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  let last = null;
  let segments = "";
  for (const sample of samples) {
    const n = sample.values[id];
    if (!number(n)) {
      last = null;
      continue;
    }
    const x = ((sample.time - end + WINDOW_MS) / WINDOW_MS * 239).toFixed(2);
    const y = (28 - percent(100 * n / ceiling) * .26).toFixed(2);
    segments += last != null && sample.time - last <= sample.maxGapMs ? `L${x} ${y}` : `M${x} ${y}h.01`;
    last = sample.time;
  }
  path.setAttribute("d", segments);
  svg.append(path);
  const chart = element("div", "history");
  chart.dataset.metric = id;
  const caption = element("div", "chart-label");
  caption.append(element("span", "", metric.label), element("span", "", `0–${ceiling}${metric.unit}`));
  chart.append(caption, svg);
  return chart;
}

function appendMetrics(card, data, samples, timestamp, selected, scope) {
  const bars = selected.bars.filter((id) => Object.hasOwn(scope, id));
  const graphIds = selected.graphs.filter((id) => Object.hasOwn(scope, id));
  card.append(...bars.map((id) => metricBar(id, data)));
  if (graphIds.length) {
    const graphs = element("div", "graphs");
    graphs.append(element("p", "muted", "Last 2 min"),
      ...graphIds.map((id) => historyLine(id, data, samples, timestamp)));
    card.append(graphs);
  }
  return bars.length > 0 || graphIds.length > 0;
}

function gpuCard(device, children, samples, timestamp, selected) {
  const card = element("section", "card");
  const heading = element("div", "card-heading");
  heading.append(element("h2", "device-label", device.label), element("p", "muted", device.name ?? "—"));
  card.append(heading);
  appendMetrics(card, device, samples, timestamp, selected, GPU_METRICS);

  for (const child of children) {
    const partition = element("section", "mig");
    partition.append(element("h3", "", child.label), element("p", "muted", child.name ?? "—"));
    partition.append(...selected.bars.filter((id) => ["util", "vram", "mbw"].includes(id))
      .map((id) => metricBar(id, child)));
    card.append(partition);
  }
  return card;
}

function start(context) {
  const compact = context.surface === "status";
  let latest;
  let query = "";
  let paused = false;
  let inFlight = false;
  let timer;
  let stopped = false;
  let selected = DEFAULT_METRICS;
  let samplingSeconds = DEFAULT_SAMPLING_SECONDS;
  let intervalRevision = 0;
  let intervalWrite = Promise.resolve();
  const intervalInput = byId("sampling-interval");
  const history = new Map();

  function mountMetricSettings() {
    const button = byId("metric-toggle");
    const settings = byId("metric-settings");
    button.addEventListener("click", () => {
      settings.hidden = !settings.hidden;
      button.setAttribute("aria-expanded", String(!settings.hidden));
    });

    intervalInput.value = String(samplingSeconds);
    intervalInput.addEventListener("change", () => {
      const seconds = intervalInput.valueAsNumber;
      if (!isSamplingInterval(seconds)) {
        intervalInput.value = String(samplingSeconds);
        return;
      }
      if (seconds === samplingSeconds) return;
      samplingSeconds = seconds;
      intervalRevision++;
      intervalWrite = intervalWrite.then(() => host.storage.set(SAMPLING_KEY, seconds)).catch(() => {});
      scheduleRefresh();
    });

    let changed = false;
    const inputs = [];
    for (const [id, metric] of Object.entries(METRICS)) {
      const row = element("tr");
      const label = element("th", "", metric.label);
      label.scope = "row";
      if (metric.description) label.title = metric.description;
      row.append(label);
      for (const [kind, name] of [["bars", "Bar"], ["graphs", "Graph"]]) {
        const input = element("input");
        input.type = "checkbox";
        input.setAttribute("aria-label", `${metric.label} ${name}`);
        input.checked = selected[kind].includes(id);
        inputs.push({ input, kind, id });
        input.addEventListener("change", () => {
          changed = true;
          selected = { bars: [], graphs: [] };
          for (const item of inputs) {
            if (item.input.checked) selected[item.kind].push(item.id);
          }
          if (latest) renderCards(latest);
          void host.storage.set(SETTINGS_KEY, { ...selected, systemMetrics: true }).catch(() => {});
        });
        const cell = element("td");
        cell.append(input);
        row.append(cell);
      }
      byId("metric-options").append(row);
    }

    void host.storage.get(SETTINGS_KEY).then((saved) => {
      if (stopped || changed || !Array.isArray(saved?.bars) || !Array.isArray(saved?.graphs)) return;
      selected = { bars: [], graphs: [] };
      for (const { input, kind, id } of inputs) {
        input.checked = saved[kind].includes(id) || (!saved.systemMetrics && SYSTEM_IDS.includes(id));
        if (input.checked) selected[kind].push(id);
      }
      if (latest) renderCards(latest);
    }).catch(() => {});
  }

  function renderProcesses() {
    const search = query.trim().toLowerCase();
    const labels = new Map(latest.devices.map((device) => [device.id, device.label]));
    const matching = latest.processes.filter((process) =>
      [process.pid, process.command, process.name, process.user, labels.get(process.deviceId)].some((field) =>
        String(field ?? "").toLowerCase().includes(search)));
    const count = latest.processCount;
    const cap = count > latest.processes.length ? ` · top ${latest.processes.length} by VRAM` : "";
    byId("job-count").textContent = `${count} GPU contexts${cap}${search ? ` · ${matching.length} matching` : ""}`;
    byId("empty").textContent = matching.length ? "" : (search ? "No matches in the sampled rows." : "No GPU processes reported.");
    byId("processes").closest(".table-wrap").hidden = matching.length === 0;
    byId("processes").replaceChildren(...matching.map((process) => {
      const row = element("tr");
      const name = element("td", "command-cell");
      const command = process.command ?? process.name ?? "—";
      const commandLabel = element("span", "command-name", command);
      commandLabel.title = command;
      const gpu = labels.get(process.deviceId) ?? "—";
      const type = process.type ?? "—";
      const sm = value(process.sm, "%");
      const mbw = value(process.mbw, "%");
      const cpu = precisePercent(process.cpu);
      const mem = precisePercent(process.hostMemory);
      const running = duration(process.seconds);
      name.append(
        commandLabel,
        element("small", "", process.user ?? "—"),
        element("small", "compact-gpu", gpu),
        element("small", "compact-details", `CPU ${cpu} · TIME ${running}`),
        element("small", "compact-details", `${type} · SM ${sm} · GMBW ${mbw} · MEM ${mem}`),
      );
      row.append(
        element("td", "pid-col", process.pid), element("td", "gpu-col", gpu), name,
        element("td", "vram-col", gib(process.used)),
        ...[type, sm, mbw, cpu, mem, running].map((field) => element("td", "wide", field)),
      );
      return row;
    }));
  }

  function render(sample) {
    const physical = sample.devices.filter((device) => device.parentId === null);
    const timestamp = sample.sampledAt;
    notice.dataset.error = "false";
    root.dataset.stale = "false";
    notice.textContent = physical.length ? (compact ? `${physical.length} GPU${physical.length === 1 ? "" : "s"} · ${sample.processCount} contexts` : `Sampled ${new Date(timestamp).toLocaleTimeString()}`) : "No NVIDIA GPUs reported by NVML.";
    if (compact) {
      const ranked = physical.slice().sort((a, b) => (b.util ?? -1) - (a.util ?? -1) || (fraction(b) ?? -1) - (fraction(a) ?? -1));
      devices.replaceChildren(...ranked.slice(0, 3).map((device) => {
        const row = element("div", "status-row");
        row.append(element("strong", "", device.label), bar(device.util),
          element("span", "", `${value(device.util, "%")} · VRAM ${value(fraction(device), "%")}`));
        return row;
      }));
      if (ranked.length > 3) devices.append(element("p", "muted", `Top 3 of ${ranked.length} GPUs by utilization`));
      systemCard.hidden = !sample.system;
      if (sample.system) {
        systemCard.textContent = `Host CPU ${value(sample.system.cpu, "%")} · System RAM ${value(sample.system.memoryPercent, "%")}`;
      }
      return;
    }

    byId("source").textContent = [sample.host, sample.driver && `Driver ${sample.driver}`].filter(Boolean).join(" · ");
    renderCards(sample, physical);
    byId("jobs").hidden = physical.length === 0;
    if (physical.length) renderProcesses();
  }

  function renderCards(sample, physical = sample.devices.filter((device) => device.parentId === null)) {
    const timestamp = sample.sampledAt;
    const physicalIds = new Set(physical.map((device) => device.id));
    if (sample.system) physicalIds.add(SYSTEM_HISTORY);
    for (const id of history.keys()) {
      if (!physicalIds.has(id)) history.delete(id);
    }
    function record(id, data, scope) {
      const points = (history.get(id) ?? [])
        .filter((point) => point.time >= timestamp - WINDOW_MS && point.time <= timestamp).slice(-120);
      if (points.at(-1)?.time !== timestamp) {
        const values = Object.fromEntries(Object.entries(scope).map(([key, metric]) => [key, metric.read(data)]));
        const maxGapMs = Math.max(6_000, samplingSeconds * 2_000 + 1_000);
        points.push({ time: timestamp, values, maxGapMs });
      }
      history.set(id, points);
      return points;
    }
    if (sample.system) {
      const points = record(SYSTEM_HISTORY, sample.system, SYSTEM_METRICS);
      systemCard.replaceChildren(element("h2", "", "System"));
      systemCard.hidden = !appendMetrics(systemCard, sample.system, points, timestamp, selected, SYSTEM_METRICS);
    } else {
      systemCard.hidden = true;
    }
    devices.replaceChildren(...physical.map((device) => {
      const points = record(device.id, device, GPU_METRICS);
      const children = sample.devices.filter((child) => child.parentId === device.id);
      return gpuCard(device, children, points, timestamp, selected);
    }));
  }

  function scheduleRefresh() {
    clearTimeout(timer);
    if (!inFlight && !paused && !stopped && !document.hidden) {
      timer = setTimeout(refresh, samplingSeconds * 1_000);
    }
  }

  async function refresh() {
    if (stopped || inFlight || paused || document.hidden) return;
    inFlight = true;
    clearTimeout(timer);
    try {
      // Read the shared preference so an already-open Work Status follows changes too.
      const revision = intervalRevision;
      await intervalWrite;
      const saved = await host.storage.get(SAMPLING_KEY).catch(() => undefined);
      if (stopped || paused || document.hidden) return;
      if (revision === intervalRevision && isSamplingInterval(saved) && saved !== samplingSeconds) {
        samplingSeconds = saved;
        intervalInput.value = String(saved);
      }
      const response = await host.serviceRequest({
        method: "GET", path: compact ? "/summary" : "/snapshot",
        query: { interval: String(samplingSeconds) },
      });
      if (stopped || paused) return;
      const sample = JSON.parse(response.body);
      if (response.status !== 200) throw new Error(sample.message ?? `Service returned HTTP ${response.status}`);
      if (sample.version !== 1 || !number(sample.sampledAt) || !Array.isArray(sample.devices) ||
          (!compact && !Array.isArray(sample.processes))) throw new Error("Unexpected nvitop response.");
      latest = sample;
      render(sample);
    } catch (error) {
      if (stopped || paused) return;
      notice.dataset.error = "true";
      root.dataset.stale = "true";
      const message = error.code === "NO_SERVICE" ? "Approve the local service in Settings → Extensions." : error.message;
      const stale = latest ? `Last sample ${new Date(latest.sampledAt).toLocaleTimeString()} · ` : "";
      notice.textContent = stale + message;
    } finally {
      inFlight = false;
      scheduleRefresh();
    }
  }

  if (compact) {
    let lastHeight;
    new ResizeObserver(() => {
      const height = Math.ceil(root.getBoundingClientRect().height);
      if (height === lastHeight) return;
      lastHeight = height;
      host.setHeight(height);
    }).observe(root);
  } else {
    mountMetricSettings();
    const toggle = mountButton(byId("pause"), {
      label: "Pause", variant: "outline", size: "sm",
      onClick: () => {
        paused = !paused;
        toggle.update({ label: paused ? "Resume" : "Pause" });
        if (paused) {
          clearTimeout(timer);
          const time = latest ? ` · last sample ${new Date(latest.sampledAt).toLocaleTimeString()}` : "";
          notice.textContent = `Paused${time}`;
          notice.dataset.error = "false";
          root.dataset.stale = "true";
        } else {
          void refresh();
        }
      },
    });
    const search = mountSearchField(byId("search"), {
      value: "", placeholder: "PID, command, user, GPU",
      onChange: (next) => {
        query = next;
        search.update({ value: next });
        if (latest) renderProcesses();
      },
    });
  }

  document.addEventListener("visibilitychange", () => {
    clearTimeout(timer);
    if (!document.hidden) void refresh();
  });
  window.addEventListener("pagehide", () => {
    stopped = true;
    clearTimeout(timer);
  }, { once: true });
  void refresh();
}

let mounted = false;
host.onReady((context) => {
  applyHostReady(context, document.documentElement);
  document.documentElement.dataset.surface = context.surface;
  if (mounted) return;
  mounted = true;
  start(context);
});
