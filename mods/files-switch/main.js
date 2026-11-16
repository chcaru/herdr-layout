// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { layout, run, theme } from "herdr";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class FilesSwitch extends View {
  render() {
    const t = theme(), root = layout();
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const collapsed = (find(root, "sidebar")?.size?.px ?? Infinity) < 160;
    return h_flex().size_full().px(8).gap(3).items_center().bg(t.chrome)
      .when(collapsed, el => el.px(0).gap(2).justify_center())
      .children([
        ["files", "Files", "mods/files/file.svg"],
        ["changes", "Changes", "mods/changes/changes.svg"],
      ].map(([id, label, icon]) => {
        const on = panel && !panel.hidden && body?.active === id;
        return h_flex().id(`panel-${id}`).h(24).px(7).gap(5).items_center().rounded(4)
          .when(collapsed, el => el.px(0).w(20).justify_center())
          .text_size(11).text_color(on ? t.foreground : t.muted)
          .when(on, el => el.bg(t.selected)).hover(el => el.bg(t.hover))
          .accessibility_label(`Show ${label}`).tooltip(on ? `Hide ${label}` : `Show ${label}`)
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (on) run("layout.hide", { id: "panel" });
            else {
              run("layout.select", { stack: "panel-body", child: id });
              run("layout.show", { id: "panel" });
            }
          })
          .child(svg(icon).size(13)).when(!collapsed, el => el.child(div().child(label)));
      }));
  }
}
