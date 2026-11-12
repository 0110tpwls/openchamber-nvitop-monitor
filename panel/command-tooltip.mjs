export function mountCommandTooltip(rows, host) {
  const tooltip = document.getElementById("command-tooltip");
  let active;

  function position() {
    if (!active) return;
    const anchor = active.anchor.getBoundingClientRect();
    const width = tooltip.offsetWidth;
    const height = tooltip.offsetHeight;
    tooltip.style.left = `${Math.max(8, Math.min(anchor.left, innerWidth - width - 8))}px`;
    const below = anchor.bottom + 6;
    tooltip.style.top = `${below + height <= innerHeight - 8 ? below : Math.max(8, anchor.top - height - 6)}px`;
  }

  function hide() {
    active?.anchor.removeAttribute("aria-describedby");
    active = undefined;
    tooltip.hidden = true;
  }

  async function show(anchor, mode) {
    if (!anchor) return;
    if (active?.key === anchor.dataset.commandKey) {
      if (mode === "focus") active.mode = mode;
      return;
    }
    hide();
    const current = { key: anchor.dataset.commandKey, anchor, mode };
    active = current;
    anchor.setAttribute("aria-describedby", tooltip.id);
    tooltip.textContent = anchor.textContent;
    tooltip.hidden = false;
    position();

    const pid = Number(anchor.dataset.pid);
    const startedAt = Number(anchor.dataset.startedAt);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || startedAt <= 0) return;
    tooltip.textContent += "\n\nLoading full command…";
    position();
    try {
      const response = await host.serviceRequest({
        method: "GET", path: "/command",
        query: { pid: String(pid), startedAt: String(startedAt) },
      });
      if (active !== current) return;
      const data = JSON.parse(response.body);
      tooltip.textContent = response.status === 200 && typeof data.command === "string" ?
        data.command : (data.message ?? "Unable to read the full command.");
    } catch {
      if (active !== current) return;
      tooltip.textContent = "Unable to read the full command.";
    }
    position();
  }

  rows.addEventListener("pointerover", (event) => {
    void show(event.target.closest(".command-name"), "hover");
  });
  rows.addEventListener("focusin", (event) => {
    void show(event.target.closest(".command-name"), "focus");
  });
  rows.addEventListener("focusout", (event) => {
    if (active?.mode === "focus" && event.target.isConnected) hide();
  });
  document.addEventListener("pointermove", (event) => {
    if (active?.mode !== "hover" || tooltip.contains(event.target)) return;
    if (event.target.closest(".command-name")?.dataset.commandKey !== active.key) hide();
  });
  document.addEventListener("pointerdown", (event) => {
    if (!tooltip.contains(event.target) && !event.target.closest(".command-name")) hide();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") hide();
  });
  document.addEventListener("pointerleave", hide);
  window.addEventListener("resize", position);
  window.addEventListener("scroll", position, true);

  return () => {
    if (!active) return;
    const anchor = Array.from(rows.querySelectorAll(".command-name"))
      .find((node) => node.dataset.commandKey === active.key);
    if (!anchor) return hide();
    active.anchor = anchor;
    anchor.setAttribute("aria-describedby", tooltip.id);
    if (active.mode === "focus") anchor.focus({ preventScroll: true });
    position();
  };
}
