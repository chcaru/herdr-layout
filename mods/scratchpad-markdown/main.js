// Modified from the recorded scratchpad-space 0.1.15 clone for this layout.
import { View, div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, Input, InputState, TextView } from "gpui-base";
import { props, readTextFile, settings, theme, writeTextFile } from "herdr";

export default class Scratchpad extends View {
  init() {
    this.mode = "edit";
    this.editor = EditorState.new({
      language: "markdown",
      value: "",
      readonly: false,
      font_family: settings().font_family,
      font_size: 14,
      line_numbers: true,
      folding: false,
      soft_wrap: true
    });
    const folder = props()?.folder;
    this.pathInput = InputState.new({ value: folder ? folder.replace(/[\\/]+$/, "") + "\\Untitled.md" : "" });
    this.path = null;
    this.savedText = null;
    this.pending = null;
    this.saving = false;
    this.error = folder ? "" : "This scratchpad has no space folder. Enter an absolute save path.";
    this.editor.on("change", (_e, cx) => cx.notify());
    this.pathInput.on("change", (_e, cx) => {
      this.pending = null;
      this.error = "";
      cx.notify();
    });
  }

  close() {
    this.editor.release();
  }

  save(cx, replace = false) {
    if (this.saving) return;
    const path = this.pathInput.value().trim();
    if (!/^(?:[a-z]:[\\/]|\\\\[^\\]+\\[^\\]+[\\/])/i.test(path) || path.includes("\0")) {
      this.error = "Enter an absolute file path, such as C:\\Users\\you\\notes.md.";
      cx.notify();
      return;
    }
    const pending = this.pending;
    if (replace && pending?.path !== path) {
      this.error = "The save path changed. Click Save again.";
      cx.notify();
      return;
    }
    const text = this.editor.value();
    this.saving = true;
    this.error = "";
    cx.notify();
    cx.spawn(async cx => {
      try {
        let expected;
        if (replace) expected = pending.expected;
        else if (path === this.path) expected = this.savedText;
        else {
          expected = await readTextFile(path);
          if (expected !== null) {
            if (this.pathInput.value().trim() !== path) {
              this.error = "The save path changed. Click Save again.";
              return;
            }
            this.pending = { path, expected };
            return;
          }
        }
        await writeTextFile(path, text, expected);
        this.path = path;
        this.savedText = text;
        this.pending = null;
      } catch (error) {
        this.pending = null;
        this.error = `Save failed: ${String(error)}. Check the path and permissions; if the file changed elsewhere, save to another path.`;
      } finally {
        this.saving = false;
        cx.notify();
      }
    });
  }

  button(t, id, label, action) {
    return div().id(id).h(28).px(10).flex_none().flex().items_center().rounded(2)
      .border(1).border_color(t.input).text_color(t.foreground).text_size(11)
      .disabled(this.saving).hover(s => s.bg(t.hover))
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); }).child(label);
  }

  render() {
    const t = theme();
    const status = this.path
      ? (this.editor.value() === this.savedText ? "Saved" : "Unsaved changes")
      : "Not saved";
    return v_flex().size_full().bg(t.background)
      .child(h_flex().h(30).flex_none().px(12).gap(12).items_center()
        .bg(t.chrome).border_b(1).border_color(t.border).text_size(11)
        .child(div().text_color(t.accent).truncate().child(this.path ?? "Untitled.md"))
        .child(div().text_color(t.muted).child(`${status} - save before closing`))
        .child(div().flex_1())
        .children(["edit", "preview"].map(mode =>
          this.button(t, `scratchpad-${mode}`, mode === "edit" ? "Edit" : "Preview", cx => { this.mode = mode; cx.notify(); })
            .bg(this.mode === mode ? t.selected : t.chrome).text_color(this.mode === mode ? t.accent : t.muted))))
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().bg(t.chrome)
        .child(Input.new(this.pathInput).flex_1().min_w(0).h(28).px(8).rounded(2)
          .accessibility_label("Save file path").bg(t.background).border(1).border_color(t.input)
          .text_size(11).text_color(t.foreground))
        .child(this.button(t, "scratchpad-save", this.saving ? "Saving..." : "Save", cx => this.save(cx))))
      .when(Boolean(this.pending), el => el.child(v_flex().flex_none().px(12).py(8).gap(6)
        .child(div().text_size(11).text_color(t.ansi3).child(`File already exists: ${this.pending.path}. Replace it?`))
        .child(h_flex().gap(8)
          .child(this.button(t, "scratchpad-replace", "Replace file", cx => this.save(cx, true)))
          .child(this.button(t, "scratchpad-cancel", "Cancel", cx => { this.pending = null; cx.notify(); })))))
      .when(Boolean(this.error), el => el.child(div().flex_none().px(12).py(8).text_size(11).text_color(t.ansi1).child(this.error)))
      .child(this.mode === "preview"
        ? div().id("scratchpad-markdown-preview").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(14)
          .child(TextView.markdown("scratchpad-markdown", this.editor.value()))
        : Editor.new(this.editor).flex_1().min_h(0).w_full());
  }
}
