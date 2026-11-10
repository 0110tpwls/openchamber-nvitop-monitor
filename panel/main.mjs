import { connectHost } from "@openchamber/sdk";
import { applyHostReady, mountButton, mountSearchField } from "@openchamber/sdk/ui";

const WINDOW_MS = 120_000;
const number = Number.isFinite;
const byId = (id) => document.getElementById(id);
const root = byId("root");
const notice = byId("notice");
const devices = byId("devices");
const host = connectHost();

const element = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
};
const value = (n, unit) => number(n) ? `${Math.round(n)}${unit}` : "—";
const gib = (n) => number(n) ? `${(n / 2 ** 30).toFixed(1)} GiB` : "—";
const fraction = (device) => device.total > 0 && number(device.used) ? 100 * device.used / device.total : null;
const age = (seconds) => {
  if (!number(seconds)) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
};
const percent = (n) => Math.max(0, Math.min(100, n));

function bar(n, memory = false) {
  const track = element("div", memory ? "track memory" : "track");
  track.setAttribute("aria-hidden", "true");
  if (number(n)) {
    const fill = element("div", "fill");
    fill.style.width = `${percent(n)}%`;
    track.append(fill);
  }
  return track;
}

function metric(container, label, display, n, memory = false) {
  const row = element("div", "metric");
  row.append(element("span", "muted", label), element("strong", "", display));
  container.append(row, bar(n, memory));
}

function historyLine(samples, end) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 240 30");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(ns, "path");
  let last = null;
  let segments = "";
  for (const sample of samples) {
    if (!number(sample.util)) {
      last = null;
      continue;
    }
    const x = ((sample.time - end + WINDOW_MS) / WINDOW_MS * 239).toFixed(2);
    const y = (28 - percent(sample.util) * .26).toFixed(2);
    segments += last != null && sample.time - last <= 6_000 ? `L${x} ${y}` : `M${x} ${y}h.01`;
    last = sample.time;
  }
  path.setAttribute("d", segments);
  svg.append(path);
  const chart = element("div", "history");
  chart.append(svg, element("span", "", "GPU utilization · last 2 min"));
  return chart;
}

function gpuCard(device, children, samples, timestamp) {
  const card = element("section", "card");
  const heading = element("div", "card-heading");
  heading.append(element("h2", "device-label", device.label), element("p", "muted", device.name ?? "—"));
  card.append(heading);
  metric(card, "GPU utilization", value(device.util, "%"), device.util);
  metric(card, "VRAM", `${gib(device.used)} / ${gib(device.total)}`, fraction(device), true);
  card.append(element("p", "hardware",
    `Temp ${value(device.temperature, " °C")} · Power ${value(device.watts, " W")} · Fan ${value(device.fan, "%")}`));
  card.append(historyLine(samples, timestamp));

  for (const child of children) {
    const partition = element("section", "mig");
    partition.append(element("h3", "", child.label), element("p", "muted", child.name ?? "—"));
    metric(partition, "VRAM", `${gib(child.used)} / ${gib(child.total)}`, fraction(child), true);
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
  const history = new Map();

  function renderProcesses() {
    const search = query.trim().toLowerCase();
    const labels = new Map(latest.devices.map((device) => [device.id, device.label]));
    const matching = latest.processes.filter((process) =>
      [process.pid, process.name, process.user, labels.get(process.deviceId)].some((field) =>
        String(field ?? "").toLowerCase().includes(search)));
    const count = latest.processCount;
    const cap = count > latest.processes.length ? ` · top ${latest.processes.length} by VRAM` : "";
    byId("job-count").textContent = `${count} GPU contexts${cap}${search ? ` · ${matching.length} matching` : ""}`;
    byId("empty").textContent = matching.length ? "" : (search ? "No matches in the sampled rows." : "No GPU processes reported.");
    byId("processes").closest(".table-wrap").hidden = matching.length === 0;
    byId("processes").replaceChildren(...matching.map((process) => {
      const row = element("tr");
      const name = element("td", "", process.name ?? "—");
      const type = process.type ?? "—";
      const sm = value(process.sm, "%");
      const running = age(process.seconds);
      name.append(
        element("small", "", process.user ?? "—"),
        element("small", "compact-details", `Type ${type} · SM ${sm} · Age ${running}`),
      );
      row.append(
        element("td", "", process.pid), element("td", "", labels.get(process.deviceId) ?? "—"), name,
        element("td", "", type), element("td", "", gib(process.used)),
        element("td", "", sm), element("td", "", running),
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
      return;
    }

    byId("source").textContent = [sample.host, sample.driver && `Driver ${sample.driver}`].filter(Boolean).join(" · ");
    const physicalIds = new Set(physical.map((device) => device.id));
    for (const id of history.keys()) {
      if (!physicalIds.has(id)) history.delete(id);
    }
    devices.replaceChildren(...physical.map((device) => {
      const points = (history.get(device.id) ?? []).filter((point) => point.time >= timestamp - WINDOW_MS);
      if (points.at(-1)?.time !== timestamp) points.push({ time: timestamp, util: device.util });
      history.set(device.id, points);
      const children = sample.devices.filter((child) => child.parentId === device.id);
      return gpuCard(device, children, points, timestamp);
    }));
    byId("jobs").hidden = physical.length === 0;
    if (physical.length) renderProcesses();
  }

  async function refresh() {
    if (stopped || inFlight || paused || document.hidden) return;
    inFlight = true;
    clearTimeout(timer);
    try {
      const response = await host.serviceRequest({ method: "GET", path: compact ? "/summary" : "/snapshot" });
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
      if (!paused && !stopped && !document.hidden) timer = setTimeout(refresh, 2_000);
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
    const toggle = mountButton(byId("controls"), {
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
      value: "", placeholder: "PID, process, user, GPU",
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
