// Modified from Herdr 0.1.15 for this custom layout.
// A lazy file browser for the focused pane's folder, with bounded read-only previews.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView, v_virtual_list, Scrollbar } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, window, props, run, notify } from "herdr";

function location(remembered) {
  const space = spaces().find(s => s.active), f = focused();
  const all = panes();
  const pane = f?.pane ? all.find(p => p.pane === f.pane) : null;
  const tab = pane?.tab ?? space?.tabs.find(t => t.active)?.id;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  const saved = remembered?.get(tab);
  const fallback = all.find(p => p.tab === tab && p.cwd);
  return { cwd: pane?.cwd || f?.cwd || (saved?.on === on ? saved.cwd : null) || fallback?.cwd || space?.folder, on, space: space?.id, tab };
}
const key = remembered => JSON.stringify(location(remembered));
function filePath(root, path) {
  const windows = /^[A-Za-z]:[\\/]|^\\\\/.test(root);
  return root.replace(/[\\/]+$/, "") + (windows ? "\\" + path.replace(/\//g, "\\") : "/" + path);
}
const LANG = { md: "markdown", markdown: "markdown", mdx: "markdown", ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const PER_FOLDER = 500, TOTAL = 5000;
const NODE_DIRECTORY = String.raw`
const fs = require("node:fs"), path = require("node:path");
(async () => {
  const root = process.argv[1], out = [];
  const directory = await fs.promises.opendir(root);
  for await (const entry of directory) {
    if (entry.name === ".git") continue;
    let dir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { dir = (await fs.promises.stat(path.join(root, entry.name))).isDirectory(); }
      catch (error) { if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error; }
    }
    out.push({ name: entry.name, dir });
    if (out.length > 500) break;
  }
  console.log(JSON.stringify(out));
})().catch(error => { console.error(String(error)); process.exitCode = 1; });`;

function normalized(path) {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return /^[A-Za-z]:[\\/]|^\\\\/.test(path) || value.startsWith("//") ? value.toLowerCase() : value;
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") {
    let result;
    try { result = await exec("node", ["-e", NODE_DIRECTORY, path]); }
    catch (error) {
      if (String(error).includes("cannot start node: program not found")) return windowsDirectory();
      throw error;
    }
    if (result.code !== 0) throw new Error(result.stderr || "Cannot list this folder");
    return JSON.parse(result.stdout);
  }
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0"), out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

export default class Files extends View {
  init(_props, cx) {
    this.locations = new Map();
    this.preview = Boolean(props()?.preview);
    if (this.preview) {
      this.root = props().root;
      this.on = props().on;
      this.context = {};
      this.show(props().path, cx);
      return;
    }
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    this.refresh(cx);
    // Reconcile even when a watch silently misses events or cannot follow linked/ignored trees.
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    this.watchTask = cx.spawn(async cx => {
      try {
        while (this.context === context) {
          const paths = await watchFolder(root);
          if (this.current(context)) { this.watchError = null; this.queueChanges(paths, context, cx); }
        }
      } catch (error) {
        if (this.context === context) {
          this.watched = null;
          this.watchError = `Live refresh unavailable; checking every 10 seconds: ${String(error)}`;
          cx.notify();
        }
      }
    });
  }

  queueChanges(paths, context, cx) {
    const root = normalized(context.cwd);
    for (const changed of paths) {
      const path = normalized(changed);
      if (path === root) {
        for (const folder of ["", ...this.folders]) context.dirty.add(folder);
        context.gitRoot = undefined;
        context.refreshGitRoot = true;
        continue;
      }
      if (!path.startsWith(root + "/")) continue;
      const relative = changed.replace(/\\/g, "/").slice(context.cwd.replace(/[\\/]+$/, "").length + 1);
      const parent = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : "";
      if (parent === "" || this.folders.has(parent)) context.dirty.add(parent);
      if (relative === ".git" || relative === ".git/config") {
        context.gitRoot = undefined; context.refreshGitRoot = true;
      }
    }
    if (context.scheduled) return;
    context.scheduled = true;
    cx.timer.after(250, cx => {
      if (!this.current(context)) return;
      context.scheduled = false;
      this.refresh(cx, []);
    });
  }

  current(context) {
    return this.context === context && (this.preview || key(this.locations) === context.key);
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? filePath(root, path) : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = this.entryCount - (this.entries.get(path)?.length ?? 0);
    const next = entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
    const previous = this.entries.get(path);
    if (!previous || previous.length !== next.length || next.some((e, i) => e.name !== previous[i].name || e.dir !== previous[i].dir)) {
      this.entries.set(path, next); this.entryCount = used + next.length; this.rowCache = null;
      const directories = new Set(next.filter(e => e.dir).map(e => path ? `${path}/${e.name}` : e.name));
      for (const folder of [...this.folders]) {
        const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
        if (parent === path && !directories.has(folder)) this.collapse(folder);
      }
    }
    this.limits.delete(path);
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limits.add(path);
    this.limited = this.limits.size > 0;
  }

  async gitMarks(context) {
    const { cwd, on } = context;
    if (context.gitRoot === undefined) {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      if (top.code !== 0 && !top.stderr.includes("not a git repository")) throw new Error(top.stderr || "Cannot find the Git root");
      context.gitRoot = top.code === 0 ? top.stdout.trim() : null;
    }
    if (!context.gitRoot) return {};
    const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on });
    if (status.code !== 0) throw new Error(status.stderr || "Cannot read Git status");
    const marks = {};
    for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
      const xy = entry.slice(0, 2);
      marks[normalized(filePath(context.gitRoot, entry.slice(3)))] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
    }
    return marks;
  }

  refresh(cx, paths = null, git = true) {
    const where = location(this.locations), next = JSON.stringify(where);
    const { cwd, on, tab } = where;
    if (tab && cwd) this.locations.set(tab, { cwd, on });
    if (next !== this.context?.key) {
      if (this.context) {
        this.saved.set(this.context.key, { folders: this.folders, entries: this.entries, limits: this.limits, file: this.file });
        const cached = [...this.saved.values()].filter(saved => saved.entries);
        while (cached.length > 8) cached.shift().entries = null;
      }
      const saved = this.saved.get(next);
      this.watchTask?.cancel();
      this.context = { key: next, cwd, on, dirty: new Set(), gitDirty: false }; this.root = cwd; this.on = on;
      this.entries = new Map(saved?.entries); this.folders = new Set(saved?.folders); this.limits = new Set(saved?.limits);
      this.entryCount = [...this.entries.values()].reduce((count, entries) => count + entries.length, 0); this.rowCache = null;
      this.pending = new Set(); this.marks = {}; this.show(null); this.watched = null; this.error = null; this.limited = this.limits.size > 0;
      this.gitError = null; this.watchError = null;
      this.loading = false;
      paths = null;
      if (saved?.file) this.show(saved.file, cx);
    }
    if (!cwd) return;
    const context = this.context;
    if (paths === null) context.refreshGitRoot = true;
    for (const path of paths ?? ["", ...this.folders]) context.dirty.add(path);
    context.gitDirty ||= git;
    this.watch(cwd, cx);
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async cx => {
      try {
        while (this.current(context) && (context.dirty.size || context.gitDirty)) {
          if (context.dirty.size) {
            const paths = [...context.dirty], errors = [];
            context.dirty.clear();
            let index = 0;
            await Promise.all(Array.from({ length: Math.min(4, paths.length) }, async () => {
              while (index < paths.length && this.current(context)) {
                const path = paths[index++];
                if (path && !this.folders.has(path)) continue;
                this.pending.add(path);
                try { await this.loadFolder(path, context); }
                catch (error) { errors.push({ path, error }); }
                finally { if (this.context === context) this.pending.delete(path); }
              }
            }));
            if (!this.current(context)) return;
            this.error = errors.find(e => !e.path || this.folders.has(e.path))?.error?.toString() ?? null;
            cx.notify();
          }
          if (!context.gitDirty) continue;
          context.gitDirty = false;
          const remaining = 2000 - (Date.now() - (context.lastGit ?? 0));
          if (remaining > 0) {
            if (!context.gitScheduled) {
              context.gitScheduled = true;
              cx.timer.after(remaining, cx => {
                if (!this.current(context)) return;
                context.gitScheduled = false;
                this.refresh(cx, []);
              });
            }
            continue;
          }
          try {
            if (context.refreshGitRoot) {
              context.gitRoot = undefined; context.refreshGitRoot = false;
            }
            const marks = await this.gitMarks(context);
            if (this.current(context)) { this.marks = marks; this.gitError = null; }
          } catch (error) {
            if (this.current(context)) this.gitError = `Git badges unavailable: ${String(error)}`;
          } finally { context.lastGit = Date.now(); }
        }
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      this.collapse(path);
    } else {
      this.folders.add(path); this.rowCache = null;
      if (!this.entries.has(path)) this.refresh(cx, [path], false);
    }
    cx.notify();
  }

  collapse(path) {
    for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
      this.folders.delete(folder);
      this.entryCount -= this.entries.get(folder)?.length ?? 0;
      this.entries.delete(folder); this.limits.delete(folder);
    }
    this.limited = this.limits.size > 0; this.rowCache = null;
  }

  show(path, cx) {
    this.code?.release(); this.code = null; this.markdown = null; this.file = path; this.fileError = null;
    if (!path || !cx) return;
    const context = this.context, root = this.root, on = this.on;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(filePath(root, path), { on });
        if (this.file !== path || !this.current(context)) return;
        if (text === null) { this.fileError = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.fileError = "Binary file · no text preview"; return; }
        const t = theme(), ext = path.includes(".") ? path.split(".").pop().toLowerCase() : "txt";
        if (LANG[ext] === "markdown") {
          this.markdown = text.length > 400000 ? text.slice(0, 400000) + "\n\n(File truncated)" : text;
          this.markdownMode = "preview";
        }
        this.code = EditorState.new({ language: LANG[ext] ?? ext, readonly: true,
          value: text.length > 400000 ? text.slice(0, 400000) + "\n… (file truncated)" : text,
          font_family: settings().font_family, font_size: 12,
          syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
      } catch { if (this.file === path && this.current(context)) this.fileError = "Cannot preview this file (binary, too large, or unreadable)"; }
      finally { cx.notify(); }
    });
  }

  openFile(path) {
    const pane = panes().find(p => p.focused)?.pane;
    if (!pane) {
      notify({ title: "Cannot open file", body: "Focus a tile in the current tab first.", level: "error" });
      return;
    }
    run("pane.split", {
      pane, direction: "right", mod: "files-tiled",
      props: { preview: true, root: this.root, path, on: this.on }
    });
  }

  close() {
    this.code?.release();
    this.watchTask?.cancel();
  }

  rows(prefix, depth, out) {
    if (out.length >= TOTAL || depth > 40) return out;
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path);
      out.push({ ...entry, path, open, depth, key: JSON.stringify([this.context.key, path]) });
      if (entry.dir && open) this.rows(path, depth + 1, out);
    }
    return out;
  }

  row(row, t) {
    const mark = this.marks[normalized(filePath(this.root, row.path))];
    return h_flex().id(`file-${row.path}`).h(28).flex_none().pl(8 + row.depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer().hover(s => s.bg(t.hover))
      .child(row.dir ? svg(`mods/files-tiled/chevron-${row.open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
      .child(svg(`mods/files-tiled/${row.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(row.name))
      .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark)));
  }

  render(cx) {
    if (!this.preview && key(this.locations) !== this.context?.key) this.refresh(cx);
    const t = theme();
    const context = this.context;
    if (!this.file && !this.rowCache) {
      const rows = this.rows("", 0, []);
      this.rowCache = { rows, byKey: new Map(rows.map(row => [row.key, row])) };
    }
    const rows = this.rowCache?.rows ?? [], byKey = this.rowCache?.byKey;
    return v_flex().id("files").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(this.file) && !this.preview, el => el.child(div().id("files-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.show(null); cx.notify(); }).child("←")))
        .child(div().font_semibold().child("Files"))
        .when(this.markdown !== null && this.markdown !== undefined, el => el.children(["preview", "source"].map(mode =>
          div().id(`markdown-${mode}`).px(7).py(3).rounded(3).cursor_pointer()
            .bg(this.markdownMode === mode ? t.selected : t.background)
            .text_color(this.markdownMode === mode ? t.accent : t.muted).text_size(11)
            .on_click((_e, cx) => { this.markdownMode = mode; cx.notify(); })
            .child(mode === "preview" ? "Preview" : "Source"))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(this.file ?? this.root?.split(/[\\/]/).pop() ?? "")))
      .when(!this.file, el => el.child(v_flex().flex_1().min_h(0).p(6)
        .child(v_flex().relative().flex_1().min_h(0)
          .child(v_virtual_list("files-tree", rows.length, 28, index => rows[index].key,
            range => rows.slice(range.start, range.end).map(row => this.row(row, t)))
            .flex_1().min_h(0).on_item_click((key, cx) => {
              if (!this.current(context)) return;
              const row = byKey.get(key);
              if (row) row.dir ? this.toggle(row.path, cx) : this.openFile(row.path);
            }))
          .child(Scrollbar.vertical("files-tree").absolute().inset_0()))
        .when(Boolean(this.error) || !this.entries.get("")?.length, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(Boolean(this.gitError || this.watchError), el => el.child(div().p(8).text_size(11).text_color(t.dim).child(this.gitError || this.watchError)))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total")))))
      .when(Boolean(this.file), el => el.child(this.markdown !== null && this.markdown !== undefined && this.markdownMode === "preview"
        ? div().id("markdown-content").flex_1().min_h(0).min_w(0).overflow_y_scrollbar().p(14).child(TextView.markdown("file-markdown", this.markdown))
        : this.code ? Editor.new(this.code).flex_1().min_h(0) : div().p(12).text_color(t.dim).child(this.fileError || "Loading file…")));
  }
}
