const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const nodePath = require("node:path");
const { test } = require("node:test");

const source = fs.readFileSync(
  nodePath.join(__dirname, "..", "mods", "scratchpad-markdown", "main.js"), "utf8"
).replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
const path = "C:\\Users\\test\\notes.txt";

function fixture(beforeWrite, folder = "C:\\work\\repo") {
  const files = new Map();
  const writes = [];
  const tasks = [];
  const controls = new Map();
  const previews = [];
  function element() {
    let id;
    const proxy = new Proxy({}, {
      get: (_target, name) => (...args) => {
        if (name === "id") id = args[0];
        if (name === "on_click" && id) controls.set(id, args[0]);
        if (name === "when" && args[0]) args[1](proxy);
        return proxy;
      }
    });
    return proxy;
  }
  const state = options => ({
    options,
    text: options.value,
    value() { return this.text; },
    set_value(text) { this.text = text; },
    on() {},
    release() {}
  });
  const Scratchpad = vm.runInNewContext(`${source}\nScratchpad`, {
    View: class {},
    EditorState: { new: state },
    InputState: { new: state },
    div: element, h_flex: element, v_flex: element,
    Editor: { new: element }, Input: { new: element },
    TextView: { markdown: (_id, text) => { previews.push(text); return element(); } },
    theme: () => ({}),
    props: () => ({ folder }),
    settings: () => ({ font_family: "Geist Mono" }),
    readTextFile: async name => files.get(name) ?? null,
    writeTextFile: async (name, text, expected) => {
      if (beforeWrite) await beforeWrite();
      assert.equal(files.get(name) ?? null, expected, "File changed outside editor");
      files.set(name, text);
      writes.push({ name, text });
    }
  });
  const editor = new Scratchpad();
  editor.init();
  const defaultPath = editor.pathInput.value();
  editor.pathInput.set_value(path);
  const cx = { notify() {}, stop_propagation() {}, spawn(fn) { tasks.push(fn(cx)); } };
  return {
    editor, files, writes, cx, defaultPath, controls, previews,
    async save(replace = false) {
      editor.save(cx, replace);
      await Promise.all(tasks.splice(0));
    }
  };
}

test("creates a Unicode multiline file and updates it with the saved snapshot", async () => {
  const f = fixture();
  f.editor.editor.set_value("notes: \u96ea\nsecond line\n");
  await f.save();
  assert.equal(f.files.get(path), "notes: \u96ea\nsecond line\n");
  assert.equal(f.editor.path, path);
  f.editor.editor.set_value("updated");
  await f.save();
  assert.equal(f.files.get(path), "updated");
  assert.equal(f.editor.savedText, "updated");
});

test("defaults to the supplied space root, including a drive root", () => {
  assert.equal(fixture().defaultPath, "C:\\work\\repo\\Untitled.md");
  assert.equal(fixture().editor.editor.options.language, "markdown");
  assert.equal(fixture(undefined, "C:\\").defaultPath, "C:\\Untitled.md");
  const missing = fixture(undefined, "");
  assert.equal(missing.defaultPath, "");
  assert.match(missing.editor.error, /no space folder/);
});

test("Markdown preview and edit modes preserve the unsaved buffer and save its original source", async () => {
  const f = fixture();
  const state = f.editor.editor;
  const text = "# Draft\n\n**Important** notes and `code`.";
  state.set_value(text);
  f.editor.render();
  f.controls.get("scratchpad-preview")(null, f.cx);
  f.editor.render();
  assert.equal(f.previews.at(-1), text);
  assert.equal(f.editor.editor, state);
  await f.save();
  assert.equal(f.files.get(path), text);
  f.controls.get("scratchpad-edit")(null, f.cx);
  assert.equal(f.editor.editor.value(), text);
});

test("captures scratchpad splits and launches Copilot agents in the current space folder", () => {
  const tabsSource = fs.readFileSync(
    nodePath.join(__dirname, "..", "mods", "tabs-tiling", "main.js"), "utf8"
  ).replace(/^import .*;\r?\n/gm, "").replace("export default class", "class");
  const commands = [];
  const Tabs = vm.runInNewContext(`${tabsSource}\nTabs`, {
    View: class {},
    COPILOT_ARGS: ["copilot", "--disable-builtin-mcps"],
    spaces: () => [{ id: "current", active: true, folder: "C:\\Users\\test", tabs: [{ id: "terminal" }, { id: "scratch" }] }],
    panes: () => [
      { tab: "unrelated", cwd: "C:\\other" },
      { tab: "terminal", cwd: "C:\\work\\repo" },
      { tab: "scratch", pane: "scratch-pane", cwd: null, focused: true }
    ],
    run: (command, args) => commands.push({ command, args }),
    notify: () => assert.fail("Valid space should not produce an error")
  });
  const tabs = new Tabs();
  const target = tabs.captureSplit("scratchpad");
  assert.equal(target.pane, "scratch-pane");
  assert.equal(target.folder, "C:\\work\\repo");
  tabs.newAgent();
  assert.equal(commands[0].command, "tab.new");
  assert.equal(commands[0].args.space, "current");
  assert.equal(commands[0].args.folder, "C:\\work\\repo");
  assert.deepEqual(Array.from(commands[0].args.argv), ["copilot", "--disable-builtin-mcps"]);
});

test("requires explicit confirmation before replacing an existing file", async () => {
  const f = fixture();
  f.files.set(path, "original");
  f.editor.editor.set_value("replacement");
  await f.save();
  assert.equal(f.files.get(path), "original");
  assert.equal(f.writes.length, 0);
  assert.equal(f.editor.pending.expected, "original");
  await f.save(true);
  assert.equal(f.files.get(path), "replacement");
});

test("rejects externally changed files on resave and on confirmed replacement", async () => {
  const f = fixture();
  f.editor.editor.set_value("first");
  await f.save();
  f.files.set(path, "external edit");
  f.editor.editor.set_value("second");
  await f.save();
  assert.equal(f.files.get(path), "external edit");
  assert.match(f.editor.error, /Save failed/);
  assert.equal(f.editor.savedText, "first");

  const other = fixture();
  other.files.set(path, "original");
  await other.save();
  other.files.set(path, "changed after confirmation prompt");
  await other.save(true);
  assert.equal(other.files.get(path), "changed after confirmation prompt");
  assert.match(other.editor.error, /Save failed/);
});

test("edits during a save remain unsaved rather than becoming the saved snapshot", async () => {
  let resume;
  const gate = new Promise(resolve => { resume = resolve; });
  const f = fixture(() => gate);
  f.editor.editor.set_value("snapshot");
  const saving = f.save();
  f.editor.editor.set_value("new edits");
  resume();
  await saving;
  assert.equal(f.files.get(path), "snapshot");
  assert.equal(f.editor.savedText, "snapshot");
  assert.notEqual(f.editor.editor.value(), f.editor.savedText);
  assert.equal(f.editor.saving, false);
});

test("rejects relative paths and stale replacement targets without writing", async () => {
  const f = fixture();
  f.editor.pathInput.set_value("notes.txt");
  await f.save();
  assert.match(f.editor.error, /absolute file path/);
  assert.equal(f.writes.length, 0);
  f.editor.pathInput.set_value(path);
  f.editor.pending = { path: "C:\\Users\\test\\other.txt", expected: "old" };
  await f.save(true);
  assert.match(f.editor.error, /save path changed/);
  assert.equal(f.writes.length, 0);
});
