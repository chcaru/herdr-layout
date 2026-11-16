// Modified from Herdr 0.1.15 for this custom layout.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, closeOverlay, props, theme, window, shared, setShared, layout, settings, notify } from "herdr";
import { COPILOT_ARGS, splitCopilot, splitPane } from "./splits.js";
import { leadPanes, title } from "./titles.js";
import { balanceTab } from "./balance.js";

const SPLIT_REQUEST = "tabs-tiling.split-request";
const SPLIT_KINDS = {
  agent: { label: "Copilot agent", icon: "icons/copilot.svg" },
  scratchpad: { label: "Scratchpad", icon: "mods/files/file.svg" },
  terminal: { label: "Terminal", icon: "mods/pane/split-right.svg" },
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

function currentSpaceLocation() {
  const space = spaces().find(s => s.active);
  const first = panes().find(p => p.cwd && space?.tabs.some(tab => tab.id === p.tab));
  return { space, folder: first?.cwd || space?.folder };
}

export default class Tabs extends View {
  init(_props, cx) {
    this.splitting = false;
    if (props()?.splitMenu) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      return;
    }
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  newAgent() {
    const { space, folder } = currentSpaceLocation();
    if (!space || !folder) {
      notify({ title: "Cannot start agent", body: "The current space has no folder.", level: "error" });
      return;
    }
    run("tab.new", { name: "Copilot", space: space.id, folder, argv: COPILOT_ARGS });
  }

  captureSplit(kind, target, capturedFolder) {
    const spec = SPLIT_KINDS[kind];
    if (!spec) {
      notify({ title: "Cannot split pane", body: "Unknown split type.", level: "error" });
      return null;
    }
    const pane = target ?? panes().find(p => p.focused)?.pane;
    if (!pane) {
      notify({ title: `Cannot split ${spec.label}`, body: "Focus a pane in the current tab first.", level: "error" });
      return null;
    }
    const folder = kind === "scratchpad" ? capturedFolder ?? currentSpaceLocation().folder : undefined;
    if (kind === "scratchpad" && !folder) {
      notify({ title: "Cannot open scratchpad", body: "The current space has no folder.", level: "error" });
      return null;
    }
    return { kind, pane, folder };
  }

  startSplit(kind, direction, cx, target, capturedFolder) {
    if (this.splitting) return;
    const location = this.captureSplit(kind, target, capturedFolder);
    if (!location) return;
    const { pane, folder } = location;
    this.splitting = true;
    try {
      cx.notify();
      cx.spawn(async cx => {
        try {
          if (kind === "agent") await splitCopilot(direction, pane);
          else {
            const options = kind === "scratchpad" ? { mod: "scratchpad-markdown", props: { folder } } : {};
            await splitPane(direction, pane, options, SPLIT_KINDS[kind].label);
          }
        } catch (error) {
          notify({ title: `${SPLIT_KINDS[kind].label} split failed`, body: String(error), level: "error" });
        } finally {
          this.splitting = false;
          cx.notify();
        }
      });
    } catch (error) {
      this.splitting = false;
      throw error;
    }
  }

  dispatchSplit(cx) {
    const request = shared(SPLIT_REQUEST);
    if (!request) return;
    setShared(SPLIT_REQUEST, null);
    if (this.splitting) {
      notify({ title: "Split already in progress", body: "Wait for the current split to finish.", level: "error" });
      return;
    }
    this.startSplit(request.kind, request.direction, cx, request.pane, request.folder);
  }

  scheduleSplit(cx) {
    if (this.splitScheduled || this.splitting || !shared(SPLIT_REQUEST)) return;
    this.splitScheduled = true;
    try {
      cx.timer.after(0, cx => {
        this.splitScheduled = false;
        try { this.dispatchSplit(cx); }
        catch (error) { notify({ title: "Split dispatch failed", body: String(error), level: "error" }); }
      });
    } catch (error) {
      this.splitScheduled = false;
      throw error;
    }
  }

  openSplitMenu(kind) {
    if (this.splitting || shared(SPLIT_REQUEST)) return;
    const location = this.captureSplit(kind);
    if (!location) return;
    openOverlay({ mod: "tabs-tiling", kind: "popup", width: 180, height: 138, props: { splitMenu: true, ...location } });
  }

  splitMenu(t) {
    const { kind, pane, folder } = props();
    const spec = SPLIT_KINDS[kind];
    if (!spec) {
      notify({ title: "Cannot split pane", body: "Unknown split type.", level: "error" });
      return div();
    }
    return v_flex().id(`${kind}-split-menu`).track_focus(this.handle).w_full().p(5)
      .bg(t.popover).text_size(12)
      .children(["right", "left", "up", "down"].map(direction =>
        h_flex().id(`${kind}-menu-${direction}`).h(32).px(9).gap(8).items_center().rounded(2)
          .disabled(this.splitting).text_color(t.foreground).hover(s => s.bg(t.hover))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (shared(SPLIT_REQUEST)) return;
            setShared(SPLIT_REQUEST, { kind, direction, pane, folder });
            closeOverlay(props().overlay);
          })
          .child(svg(spec.icon).size(14).text_color(kind === "agent" ? t.accent : t.muted))
          .child(direction[0].toUpperCase() + direction.slice(1))));
  }

  splitButton(kind, t) {
    const spec = SPLIT_KINDS[kind];
    const busy = this.splitting || Boolean(shared(SPLIT_REQUEST));
    const stop = (_e, cx) => cx.stop_propagation();
    return h_flex().id(`${kind}-split`).flex_none().items_center().rounded(2)
      .border(1).border_color(t.input).text_color(kind === "agent" ? t.accent : t.muted).text_size(12)
      .child(h_flex().id(`${kind}-split-right`).size(26).items_center().justify_center()
        .disabled(busy).accessibility_label(`${spec.label}: split right`)
        .tooltip(kind === "agent" ? `Split right: ${COPILOT_ARGS.join(" ")}` : `${spec.label}: split the focused pane right`)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.startSplit(kind, "right", cx); })
        .child(svg(spec.icon).size(14)))
      .child(div().id(`${kind}-split-directions`).w(16).h(26).flex().items_center().justify_center()
        .border_l(1).border_color(t.input).disabled(busy)
        .accessibility_label(`Choose ${spec.label} split direction`).tooltip("Right, Left, Up, Down")
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.openSplitMenu(kind); })
        .child(svg("mods/tabs-tiling/chevron-down.svg").size(10)));
  }

  balanceSplits(cx) {
    const next = new Map();
    for (const pane of panes()) {
      if (!next.has(pane.tab)) next.set(pane.tab, new Set());
      next.get(pane.tab).add(pane.pane);
    }
    if (!this.paneSets) { this.paneSets = next; return; }
    this.balanceQueue ??= new Map();
    const machines = new Map(spaces().flatMap(space => space.tabs.map(tab => [tab.id, space.machine])));
    for (const [tab, ids] of next) {
      const previous = this.paneSets.get(tab);
      const added = previous ? [...ids].filter(id => !previous.has(id)) : [];
      const removed = previous ? [...previous].filter(id => !ids.has(id)) : [];
      if ((added.length || removed.length) && machines.has(tab)) {
        const queued = this.balanceQueue.get(tab);
        const pendingAdded = new Set([...(queued?.added ?? []), ...added]);
        const pendingRemoved = new Set([...(queued?.removed ?? []), ...removed]);
        for (const id of added) pendingRemoved.delete(id);
        for (const id of removed) pendingAdded.delete(id);
        this.balanceQueue.set(tab, { machine: machines.get(tab), added: [...pendingAdded], removed: [...pendingRemoved] });
      }
    }
    for (const tab of this.balanceQueue.keys()) if (!next.has(tab)) this.balanceQueue.delete(tab);
    this.paneSets = next;
    if (this.balancing || !this.balanceQueue.size) return;
    this.balancing = true;
    cx.spawn(async cx => {
      try {
        while (this.balanceQueue.size) {
          const [tab, { machine, added, removed }] = this.balanceQueue.entries().next().value;
          this.balanceQueue.delete(tab);
          try { await balanceTab(tab, machine, added, removed); }
          catch (error) {
            if (this.paneSets.has(tab) && !this.balanceQueue.has(tab)) {
              notify({ title: "Could not balance tiles", body: String(error), level: "error" });
            }
          }
        }
      } finally {
        this.balancing = false;
        cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    if (props()?.splitMenu) return this.splitMenu(t);
    this.balanceSplits(cx);
    this.scheduleSplit(cx);
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    const leads = leadPanes(panes());
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(2).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const lead = leads.get(c.id);
      const program = lead?.program;
      const name = program?.agent ? title(c, lead) : /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      return h_flex().id(`tab-${c.id}`).h(36).px(13).gap(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border_b(2).border_color(c.active ? t.accent : t.chrome).bg(c.active ? t.background : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }); })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().text_size(12).tooltip(name).child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(0).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .child(h_flex().id("agent-new").size(26).flex_none().items_center().justify_center().rounded(2)
        .accessibility_label("New Copilot agent").tooltip(COPILOT_ARGS.join(" "))
        .text_size(12).text_color(t.accent).hover(s => s.bg(t.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { cx.stop_propagation(); this.newAgent(); })
        .child(svg("icons/copilot.svg").size(14)))
      .child(this.splitButton("agent", t))
      .child(this.splitButton("scratchpad", t))
      .child(this.splitButton("terminal", t))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tabs-tiling/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tabs-tiling/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tabs-tiling/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
