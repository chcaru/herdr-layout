// Modified from Herdr 0.1.15 for this custom layout.
// Spaces contain priority-sorted agents; state tracking stays in this existing mod.

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, terminals, panes, focused, spaces, run, theme, shared, setShared, setAgentOrder, openOverlay, closeOverlay, props, window, layout, knownAgents } from "herdr";
import { leadPanes, title } from "./titles.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// To the rail (on macOS wide enough for the traffic lights), or back to the width it had.
function toggleSidebar() {
  const width = find(layout(), "sidebar")?.size?.px;
  if (!narrow()) setShared("sidebar.width", width);
  // Mods edited before the rail went by width still read the flag.
  setShared("sidebar.collapsed", !narrow());
  run("layout.resize", { id: "sidebar", px: narrow() ? (shared("sidebar.width") ?? 268) : window()?.platform === "macos" ? 76 : 44 });
}

const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };
// A sub-agent without a pane isn't in agents(): its raw word, error counting as
// blocked. It's never done: it reports to its parent, and the parent's done is the news.
const kidStatus = (k, listed) => {
  const s = listed.get(k.address) ?? k.status;
  return s === "error" ? "blocked" : s === "done" ? "idle" : s;
};
const STATUS_LABEL = { blocked: "Needs you", done: "Done", working: "Working", idle: "Idle" };
// Mods cannot import across directories; match tabs-tiling's personal Copilot launch options.
const COPILOT_ARGS = ["copilot", "--disable-builtin-mcps"];

function duration(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
}

// The agent's icon from the app's program table: a one-color glyph or a picture.
function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

export default class Agents extends View {
  init(_props, cx) {
    if (props()?.spaceMenu) {
      this.handle = cx.focus_handle();
      this.handle.focus();
      this.choices = [];
      this.loading = true;
      const p = props();
      const space = spaces().find(s => s.id === p.space);
      if (!p.newSpace && !space) {
        this.failed = "This space is no longer available.";
        this.loading = false;
        return;
      }
      cx.spawn(async cx => {
        try {
          this.choices = (await knownAgents({ on: p.newSpace ? p.machine : space.machine }))
            .filter(a => a.installed).map(a => a.key === "copilot" ? { ...a, run: COPILOT_ARGS } : a);
        } catch (e) {
          this.failed = String(e.message ?? e);
        }
        this.loading = false;
        cx.notify();
      });
      return;
    }
    this.folded = new Set(JSON.parse(localStorage.getItem("folded") ?? "[]"));
    // Each agent's last state and when it changed (ms), kept across restarts.
    this.changed = JSON.parse(localStorage.getItem("changed") ?? "{}");
    this.pendingPins = JSON.parse(localStorage.getItem("pins") ?? "[]");
    if (!this.pendingPins.length) localStorage.removeItem("pins");
    this.migratingPins = new Set();
    cx.timer.every(30000, (cx) => cx.notify());
  }

  // Stamps agents whose state changed. Done and idle count as one: looking at a
  // finished agent turns done into idle, and looking isn't the agent doing anything.
  track(list, now) {
    let dirty = false;
    for (const a of list) {
      const s = a.status === "done" ? "idle" : a.status;
      if (this.changed[a.address]?.s === s) continue;
      this.changed[a.address] = { s, at: now };
      dirty = true;
    }
    if (!dirty) return;
    // Gone and old: the list alone is empty right after a start.
    const listed = new Set(list.map((a) => a.address));
    for (const [k, c] of Object.entries(this.changed)) if (!listed.has(k) && now - c.at > 30 * 86400000) delete this.changed[k];
    localStorage.setItem("changed", JSON.stringify(this.changed));
  }

  // Keep offline pins until their terminal returns, and keep each pending until
  // core echoes the label so a failed write doesn't erase the old pin.
  migratePins(all) {
    const listed = new Map(all.filter((t) => t.state === "live").map((t) => [t.address, t]));
    const pending = this.pendingPins.filter((address) => {
      const terminal = listed.get(address);
      if (!terminal) return true;
      if (terminal.labels?.["herdr.pinned"]) return false;
      if (!this.migratingPins.has(address)) {
        this.migratingPins.add(address);
        run("terminal.pin", { terminal: address, pinned: true });
      }
      return true;
    });
    if (pending.length === this.pendingPins.length) return;
    this.pendingPins = pending;
    if (pending.length) localStorage.setItem("pins", JSON.stringify(pending));
    else localStorage.removeItem("pins");
  }

  since(a) {
    return this.changed[a.address]?.at ?? 0;
  }

  rank(a) {
    return RANK[a.status] ?? 0;
  }

  toggleFold(id, cx) {
    this.folded.has(id) ? this.folded.delete(id) : this.folded.add(id);
    localStorage.setItem("folded", JSON.stringify([...this.folded]));
    cx.notify();
  }

  addMenu(space = null) {
    const current = space ?? spaces().find(s => s.active);
    openOverlay({
      mod: "agents-titles", kind: "popup", width: 260, height: 360,
      props: space ? { spaceMenu: true, space: space.id }
        : { spaceMenu: true, newSpace: true, machine: current?.machine ?? null },
    });
  }

  start(argv = null, name = null) {
    const p = props();
    const space = spaces().find(s => s.id === p.space);
    if (!p.newSpace && !space) {
      this.failed = "This space is no longer available.";
      return;
    }
    const current = space ?? spaces().find(s => s.active && (s.machine ?? null) === (p.machine ?? null))
      ?? spaces().find(s => (s.machine ?? null) === (p.machine ?? null));
    const tabIds = new Set(current?.tabs.map(tab => tab.id) ?? []);
    const inSpace = panes().filter(pane => tabIds.has(pane.tab) && pane.cwd);
    const folder = inSpace.find(pane => pane.focused)?.cwd ?? inSpace[0]?.cwd ?? current?.folder;
    closeOverlay(p.overlay);
    if (p.newSpace) run("space.new", { machine: p.machine ?? "", folder, ...(argv ? { argv, tab: name } : {}) });
    else run("tab.new", { space: space.id, folder, ...(argv ? { argv, name } : {}) });
  }

  creationMenu(t) {
    const p = props();
    const space = spaces().find(s => s.id === p.space);
    const valid = p.newSpace || Boolean(space);
    const row = (id, pic, name, action, hint = "") => h_flex().id(id).h(31).px(9).gap(9)
      .rounded(6).items_center().flex_none().text_color(t.foreground)
      .hover(el => el.bg(t.hover))
      .on_click((_e, cx) => { action(); cx.notify(); })
      .when(Boolean(pic), el => el.child(pic))
      .child(div().flex_1().truncate().child(name))
      .when(Boolean(hint), el => el.child(div().text_size(11).text_color(t.dim).child(hint)));
    return v_flex().id("space-agent-menu").track_focus(this.handle).w_full()
      .h(Math.min(360, 95 + this.choices.length * 31 + (this.loading || this.failed || !this.choices.length ? 40 : 0)))
      .min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "escape") { closeOverlay(p.overlay); return; }
        if (!valid || e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        const choice = /^[1-9]$/.test(e.key) ? this.choices[Number(e.key) - 1] : null;
        if (choice) { this.start(choice.run, choice.name); cx.notify(); }
      })
      .child(div().px(9).py(7).truncate().text_size(11).text_color(t.dim)
        .child(p.newSpace ? "New space" : `Add to ${space?.name ?? "closed space"}`))
      .when(valid, el => el.child(row("new-terminal", svg("icons/shell.svg").size(14), "Terminal", () => this.start())))
      .child(div().px(9).pt(7).pb(5).text_size(11).text_color(t.dim).child("Start an agent"))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .when(valid, el => el.children(this.choices.map((a, i) => row(`new-${a.key}`, icon(a, 14, t.foreground),
          a.name, () => this.start(a.run, a.name), i < 9 ? String(i + 1) : ""))))
        .when(this.loading || this.failed || !valid || !this.choices.length, el => el.child(
          div().px(9).py(5).text_size(11).text_color(this.failed || !valid ? t.blocked : t.dim)
            .child(!valid ? "This space is no longer available." : this.failed ? `Could not check agents: ${this.failed}`
              : this.loading ? "Checking installed agents..." : "No installed agents found."))));
  }

  peek(addr) {
    run("terminal.peek", { terminal: addr });
  }

  // Live sub-agents of `addr`, depth first, each with the tree lines in front of it.
  tree(all, addr, lead = []) {
    const kids = all.filter((k) => k.parent === addr && k.state === "live");
    return kids.flatMap((k, i) => {
      const last = i === kids.length - 1;
      return [
        { t: k, lines: [...lead, last ? "└" : "├"] },
        ...this.tree(all, k.address, [...lead, last ? "" : "│"]),
      ];
    });
  }

  subRow(t, s, shown) {
    const k = s.t;
    const st = kidStatus(k, this.listed);
    const pic = st === "working"
      ? svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.working).spin(900)
      : icon(k.program, 14, t.foreground);
    const on = k.address === shown;
    return h_flex()
      .id(`sub-${k.address}`)
      .pl(57)
      .pr(8)
      .rounded(8)
      .h(26)
      .flex_none()
      .gap(0)
      .items_center()
      .text_size(12)
      .when(on, (el) => el.bg(t.raised))
      .hover((s) => s.bg(t.hover))
      .on_click(() => (this.listed.has(k.address) ? run("pane.focus", { terminal: k.address }) : this.peek(k.address)))
      .children(s.lines.map(l => div().self_start().mt(-4).w(9).h(17).mr(4).flex_none()
        .when(Boolean(l), el => el.border_l(1.5).border_color(t.input))
        .when(l === "└" || l === "├", el => el.border_b(1.5).rounded_bl(6))))
      .when(Boolean(pic), el => el.child(div().mr(8).child(pic)))
      .child(div().flex_1().truncate().text_color(t[st] ?? t.dim).tooltip(STATUS_LABEL[st] ?? st ?? "Unknown")
        .child(k.name || k.template || k.program?.name || k.address));
  }

  render(cx) {
    const t = theme();
    if (props()?.spaceMenu) return this.creationMenu(t);
    const collapsed = narrow();
    const sp = spaces();
    let list = agents();
    this.listed = new Map(list.map((a) => [a.address, a.status]));
    const all = terminals();
    this.migratePins(all);
    const shown = focused()?.agent;
    const now = Date.now();
    this.track(list, now);
    // A kept sub-agent (one with a pane) is in agents() too: where a tree shows
    // it, it gets no row of its own, unless it's pinned.
    const nested = new Set(collapsed ? [] : list.flatMap((a) => this.tree(all, a.address).map((s) => s.t.address)));
    list = list.filter((a) => a.pinned || !nested.has(a.address));
    const tabCounts = new Map();
    for (const a of list) tabCounts.set(a.tab, (tabCounts.get(a.tab) ?? 0) + 1);
    const urgency = new Map(list.map((a) => [a.address, Math.max(this.rank(a), ...this.tree(all, a.address).map((s) => RANK[kidStatus(s.t, this.listed)] ?? 0))]));
    const rankOf = (a) => urgency.get(a.address);
    list = [...list].sort((x, y) => Number(y.pinned) - Number(x.pinned)
      || rankOf(y) - rankOf(x) || this.since(y) - this.since(x) || y.seq - x.seq);
    const groups = sp.map(space => ({ space, members: list.filter(a => a.space === space.id) }));
    list = groups.flatMap(g => g.members);
    setAgentOrder(list.map((a) => a.address));

    const withKids = (a, i) => {
      const subs = collapsed ? [] : this.tree(all, a.address);
      const r = row(a, i, subs);
      if (this.folded.has(a.address)) return [r];
      return [r, ...subs.map((s) => this.subRow(t, s, shown))];
    };

    // The fold chevron; folded, the count too, colored by the most urgent one.
    const fold = (a, subs) => {
      const sts = subs.map((s) => kidStatus(s.t, this.listed));
      const top = sts.reduce((m, s) => ((RANK[s] ?? 0) > (RANK[m] ?? 0) ? s : m), null);
      const open = !this.folded.has(a.address);
      return div()
        .id(`fold-${a.address}`)
        .h(18)
        .px(3)
        .gap(3)
        .flex()
        .items_center()
        .rounded(4)
        .text_size(11)
        .text_color(open ? t.dim : (t[top] ?? t.dim))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          this.toggleFold(a.address, cx);
        })
        .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11).flex_none())
        .when(!open, (el) => el.child(String(subs.length)));
    };

    // Read the pane snapshot once: every host read copies the whole list into JS.
    const leads = leadPanes(panes());
    const tabs = new Map(sp.flatMap(s => s.tabs).map(tab => [tab.id, tab]));
    const labels = new Map(list.map(a => {
      const tab = tabs.get(a.tab);
      const many = tabCounts.get(a.tab) > 1;
      return [a.address, tab ? title(many ? { ...tab, named: false } : tab, many ? a : leads.get(a.tab)) : (a.title || a.program?.name || "")];
    }));
    const label = (a) => labels.get(a.address);

    const row = (a, i, subs = []) => {
      const pic = a.status === "working"
        ? svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.working).spin(900)
        : icon(a.program, 16, t.foreground);
      // An agent on another machine (`vps/t7`) says which.
      const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
      if (collapsed) {
        return h_flex()
          .id(`ag-${a.address}`)
          .h(26)
          .px(8)
          .flex_none()
          .items_center()
          .gap(4)
          .hover((s) => s.bg(t.hover))
          .on_click(() => run("pane.focus", { pane: a.pane }))
          .tooltip(`${label(a)}: ${STATUS_LABEL[a.status]}`)
          .child(div().flex_1().min_w(0).whitespace_nowrap().text_right().text_color(t[a.status] ?? t.dim).child(String(i + 1)));
      }
      const when = this.since(a);
      const isPinned = a.pinned;
      const pin = div()
        .id(`pin-${a.address}`)
        .flex_none()
        .p(2)
        .rounded(4)
        .text_color(t.dim)
        .cursor_pointer()
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(isPinned ? "Unpin" : "Pin to the top")
        .on_click((_e, cx) => {
          cx.stop_propagation();
          run("terminal.pin", { terminal: a.address, pinned: !isPinned });
          // The row moves away from under the pointer, and no hover-out comes.
          this.hovered = null;
          cx.notify();
        })
        .child(svg(`mods/workspace-chrome/${isPinned ? "pin-off" : "pin"}.svg`).size(13));
      const name = /^\d+$/.test(label(a)) ? a.program?.name || label(a) : label(a);
      return h_flex()
        .id(`ag-${a.address}`)
        .pl(26)
        .pr(8)
        .h(30)
        .flex_none()
        .rounded(8)
        .items_center()
        .gap(9)
        .when(a.focused, (el) => el.bg(t.selected))
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_hover((on, cx) => {
          if (on) this.hovered = a.address;
          else if (this.hovered === a.address) this.hovered = null;
          cx.notify();
        })
        .on_click(() => run("pane.focus", { pane: a.pane }))
        .on_mouse_down("right", () => openOverlay({
          mod: "menu", kind: "popup", width: 220, height: 260,
          props: { tab: "pane", target: { pane: a.pane, terminal: a.address } },
        }))
        .when(Boolean(pic), el => el.child(div().id(`agent-fold-${a.address}`)
          .when(subs.length > 0, el => el.on_click((_e, cx) => {
            cx.stop_propagation();
            this.toggleFold(a.address, cx);
          })).child(pic)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t[a.status] ?? t.dim)
          .tooltip(`${name}: ${STATUS_LABEL[a.status]}`).child(name))
        .when(Boolean(machine), el => el.child(div().text_size(10).text_color(t.dim).child(machine)))
        .when(subs.length > 0, el => el.child(fold(a, subs)))
        .when(this.hovered === a.address, el => el.child(pin))
        .when(this.hovered !== a.address && Boolean(when), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(duration(now - when))));
    };

    const header = (g) => {
      const space = g.space;
      const id = `sp-${space.id}`;
      const open = !this.folded.has(id);
      return h_flex()
        .id(`space-${space.id}`)
        .px(collapsed ? 0 : 8)
        .h(32)
        .flex_none()
        .rounded(6)
        .gap(6)
        .items_center()
        .text_size(12)
        .font_semibold()
        .cursor_pointer()
        .when(space.active, el => el.bg(t.selected))
        .hover(el => el.bg(t.hover))
        .on_click(() => run("space.select", { id: space.id }))
        .on_mouse_down("right", () => openOverlay({
          mod: "menu", kind: "popup", width: 200, height: 260,
          props: { tab: "space", target: { id: space.id } },
        }))
        .when(collapsed, el => el.justify_center().tooltip(space.name)
          .child(div().text_color(t[space.status] ?? t.muted).child(String(space.index))))
        .when(!collapsed, el => el
          .child(div().id(`space-fold-${space.id}`).size(18).flex_none().flex().items_center().justify_center()
            .text_color(t.dim).rounded(4).hover(el => el.bg(t.raised).text_color(t.foreground))
            .tooltip(open ? "Collapse space" : "Expand space")
            .on_click((_e, cx) => { cx.stop_propagation(); this.toggleFold(id, cx); })
            .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(11)))
          .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).tooltip(space.name).child(space.name))
          .when(Boolean(space.machine), el => el.child(div().text_size(10).text_color(t.dim).child(space.machine)))
          .child(div().text_size(10.5).text_color(!open ? t[space.status] ?? t.dim : t.dim).child(String(g.members.length)))
          .child(div().id(`space-add-${space.id}`).size(22).flex_none().flex().items_center().justify_center()
            .text_color(t.dim).rounded(4).hover(el => el.bg(t.raised).text_color(t.foreground))
            .tooltip(`Add an agent to ${space.name}`)
            .on_click((_e, cx) => { cx.stop_propagation(); this.addMenu(space); })
            .child(svg("mods/workspace-chrome/plus.svg").size(12))));
    };
    const rows = groups.flatMap(g => [header(g), ...(this.folded.has(`sp-${g.space.id}`) ? []
      : g.members.length ? g.members.flatMap(a => withKids(a, list.indexOf(a)))
        : collapsed ? [] : [div().pl(32).h(26).flex_none().text_size(11).text_color(t.dim).child("No agents yet")])]);

    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_t(1)
      .border_color(t.border)
      .text_size(13)
      .when(!collapsed, (el) =>
        el.child(
          h_flex()
            .px(16)
            .h(41)
            .pt(14)
            .pb(5)
            .flex_none()
            .items_center()
            .justify_between()
            .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Spaces & agents"))
            .child(
              div()
                .id("space-new")
                .size(24).flex().items_center().justify_center().rounded(4)
                .text_size(11)
                .text_color(t.dim)
                .hover((s) => s.bg(t.hover).text_color(t.foreground))
                .on_click(() => this.addMenu())
                .tooltip("New space (choose an agent or terminal)")
                .child(svg("mods/workspace-chrome/plus.svg").size(14)),
            ),
        ),
      )
      .when(sp.length === 0 && !collapsed, (el) =>
        el.child(div().px(16).text_size(12).text_color(t.dim).child("Create a space with + to get started.")),
      )
      .child(v_flex().id("ag-list").flex_1().min_h(0).px(collapsed ? 0 : 8).overflow_y_scrollbar().mode("always").children(rows))
      .when(collapsed, (el) =>
        el.child(
          h_flex()
            .h(28)
            .items_center()
            .justify_center()
            .child(div().id("rail-space-new").size(20).flex().items_center().justify_center()
              .text_color(t.dim).tooltip("New space")
              .on_click(() => this.addMenu())
              .child(svg("mods/workspace-chrome/plus.svg").size(12)))
            .child(
              div()
                .id("collapse")
                .text_size(13)
                .text_color(t.dim)
                .hover((s) => s.text_color(t.foreground))
                .on_click(toggleSidebar)
                .child("»"),
            ),
        ),
      );
  }
}
