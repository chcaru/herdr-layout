// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
import { spaces, panes, focused, layout, shared, setShared, run, openOverlay } from "herdr";

const COPILOT_ARGS = ["copilot", "--disable-builtin-mcps"];
const SPLIT_REQUEST = "tabs-tiling.split-request";
const FORK_REQUEST = "pane-fork.request";
const DIRECTIONS = ["right", "left", "up", "down"];

export function customEntries() {
  const actions = [
    ["new-agent", "New Copilot agent", "agent copilot new tab"],
    ["fork", "Fork Copilot conversation right", "agent copy branch conversation fork"],
    ["new-space", "New space with an agent...", "workspace create copilot terminal"],
    ...[
      ["agent", "Split Copilot", "agent copilot new panel"],
      ["scratchpad", "Open Markdown scratchpad", "scratchpad notes markdown editor panel"],
      ["terminal", "Split terminal", "shell terminal new panel"],
    ].flatMap(([kind, title, words]) => DIRECTIONS.map(direction =>
      [`split-${kind}-${direction}`, `${title} ${direction}`, `${words} split ${direction}`])),
    ["files", "Toggle Files panel", "explorer files sidebar"],
    ["changes", "Toggle Changes panel", "git changes diff sidebar"],
  ];
  return actions.map(([action, title, words]) => ({
    id: `custom:${action}`, name: `custom-palette.${action}`, args: {},
    group: "Custom", title, words, custom: true, action,
  }));
}

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function location() {
  const space = spaces().find(s => s.active);
  const current = focused();
  const all = panes();
  const pane = all.find(p => p.pane === current?.pane) ?? all.find(p => p.focused);
  const folder = space && (all.find(p => p.cwd && space.tabs.some(tab => tab.id === p.tab))?.cwd || space.folder);
  return { space, pane, folder };
}

// Prepare before closing the palette, then dispatch to persistent views. A task
// owned by the palette would be cancelled as soon as the palette closes.
export function prepareCustom(entry) {
  const { space, pane, folder } = location();
  if (entry.action === "new-agent") {
    if (!space || !folder) throw new Error("The current space has no folder.");
    return () => run("tab.new", { name: "Copilot", space: space.id, folder, argv: COPILOT_ARGS });
  }
  if (entry.action === "new-space") return () => openOverlay({
    mod: "agents-titles", kind: "popup", width: 260, height: 360,
    props: { spaceMenu: true, newSpace: true, machine: space?.machine ?? null },
  });
  if (entry.action.startsWith("split-")) {
    const match = /^split-(agent|scratchpad|terminal)-(right|left|up|down)$/.exec(entry.action);
    if (!match) throw new Error("Unknown split action.");
    if (!pane) throw new Error("Focus a pane in the current tab first.");
    if (shared(SPLIT_REQUEST)) throw new Error("A split is already queued. Wait for it to finish.");
    const [, kind, direction] = match;
    if (kind === "scratchpad" && !folder) throw new Error("The current space has no folder for a scratchpad.");
    const request = { kind, direction, pane: pane.pane, ...(kind === "scratchpad" ? { folder } : {}) };
    return () => setShared(SPLIT_REQUEST, request);
  }
  if (entry.action === "fork") {
    if (!pane?.terminal || (pane.app !== "copilot" && pane.program?.key !== "copilot"))
      throw new Error("Focus a Copilot agent before forking.");
    if (pane.status === "working") throw new Error("Wait for the current turn to finish before forking.");
    if (shared(FORK_REQUEST)) throw new Error("A conversation fork is already queued.");
    return () => setShared(FORK_REQUEST, { pane: pane.pane });
  }
  if (entry.action === "files" || entry.action === "changes") {
    const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
    if (!panel || !body || !find(body, entry.action)) throw new Error("This layout has no Files/Changes panel.");
    const on = !panel.hidden && body.active === entry.action;
    return () => {
      if (on) run("layout.hide", { id: "panel" });
      else {
        run("layout.select", { stack: "panel-body", child: entry.action });
        run("layout.show", { id: "panel" });
      }
    };
  }
  throw new Error("Unknown custom action.");
}
