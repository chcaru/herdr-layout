// Modified from Herdr 0.1.15 for this custom layout.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, notify, spaces, shared, setShared } from "herdr";
import { forkPane } from "./fork.js";
import { leadPanes, title } from "./titles.js";

// Same label the Agents tree shows for this agent.
function agentLabel(p, all) {
  const tab = spaces().flatMap(s => s.tabs).find(x => x.id === p.tab);
  if (!tab) return null;
  const many = all.filter(q => q.tab === p.tab && q.terminal && q.program?.agent).length > 1;
  const label = title(many ? { ...tab, named: false } : tab, many ? p : leadPanes(all).get(p.tab));
  return label && !/^\d+$/.test(label) ? label : null;
}

function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; this.forking = false; }

  me(all = panes()) {
    return all.find((p) => p.pane === props()?.pane);
  }

  fork(cx) {
    if (this.forking) return;
    const p = this.me();
    if (!p?.terminal || (p.app !== "copilot" && p.program?.key !== "copilot")) {
      notify({ title: "Cannot fork conversation", body: "This pane is not a Copilot agent.", level: "error" });
      return;
    }
    if (p.status === "working") {
      notify({ title: "Cannot fork yet", body: "Wait for the current turn to finish before forking.", level: "error" });
      return;
    }
    this.forking = true;
    try {
      cx.notify();
      cx.spawn(async cx => {
        try { await forkPane(p.pane, p.terminal, p.title); }
        catch (error) { notify({ title: "Conversation fork failed", body: String(error), level: "error" }); }
        finally { this.forking = false; cx.notify(); }
      });
    } catch (error) {
      this.forking = false;
      notify({ title: "Conversation fork failed", body: String(error), level: "error" });
    }
  }

  button(t, id, icon, command, args) {
    return div().id(id).p(3).rounded(4).text_color(t.dim)
      .hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); run(command, args); })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  scheduleFork(pane, cx) {
    if (this.forkScheduled || shared("pane-fork.request")?.pane !== pane) return;
    this.forkScheduled = true;
    try {
      cx.timer.after(0, cx => {
        this.forkScheduled = false;
        if (shared("pane-fork.request")?.pane !== pane) return;
        setShared("pane-fork.request", null);
        if (this.forking) {
          notify({ title: "Fork already in progress", body: "Wait for the current fork to finish.", level: "error" });
          return;
        }
        this.fork(cx);
      });
    } catch (error) {
      this.forkScheduled = false;
      throw error;
    }
  }

  render(cx) {
    const t = theme();
    const all = panes();
    const p = this.me(all);
    if (!p) return div();
    this.scheduleFork(p.pane, cx);
    const name = (p.program?.agent && agentLabel(p, all))
      || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    const copilot = Boolean(p.terminal && (p.app === "copilot" || p.program?.key === "copilot"));
    return h_flex().id(`pane-head-${pane}`).size_full().px(10).gap(8).items_center().bg(t.background)
      .when(bottom, el => el.border_t(1)).when(!bottom, el => el.border_b(1))
      .border_color(t.border).text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), el => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(copilot, el => el.child(h_flex().id(`ph-fork-${pane}`).flex_none().h(24).px(5).gap(4).items_center()
        .rounded(4).text_color(t.accent).disabled(this.forking || st === "working")
        .accessibility_label("Fork Copilot conversation into a panel on the right")
        .tooltip(st === "working" ? "Wait for the current turn to finish before forking" : "Fork this conversation into a new Copilot panel on the right")
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => { cx.stop_propagation(); this.fork(cx); })
        .child(svg("mods/pane-fork/fork.svg").size(14)).child(this.forking ? "Forking..." : "Fork")))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
