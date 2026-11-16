const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");
const root = path.join(__dirname, "..", "mods");
const load = file => fs.readFileSync(file.replace(/\\/g, path.sep), "utf8").replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "").replace("default class", "class");
function element() {
  const node = { attrs: {}, childNodes: [] };
  const proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    return (...args) => {
      if (key === "when") { if (args[0]) args[1](proxy); }
      else if (key === "child") node.childNodes.push(args[0]);
      else if (key === "children") node.childNodes.push(...args[0]);
      else node.attrs[key] = args[0];
      return proxy;
    };
  } });
  return proxy;
}
const nodes = node => typeof node === "object" ? [node, ...node.childNodes.flatMap(nodes)] : [];
function fixture() {
  const state = {
    queue: {}, events: [], now: {},
    space: { id: "space", folder: "C:\\repo", machine: null, active: true, tabs: [{ id: "tab" }] },
    pane: { pane: "captured", terminal: "t1", tab: "tab", cwd: "C:\\repo", app: "copilot", program: { key: "copilot" }, status: "idle" }
  };
  const sandbox = {
    View: class {}, div: element, h_flex: element, v_flex: element, svg: element,
    spaces: () => state.space ? [state.space] : [], panes: () => state.pane ? [state.pane] : [],
    focused: () => ({ pane: state.pane?.pane }),
    layout: () => ({ id: "panel", hidden: state.hidden, children: [{ id: "panel-body", active: state.active ?? "files", children: [{ id: "files" }, { id: "changes" }] }] }),
    shared: key => state.queue[key], setShared: (key, value) => { state.events.push(["shared", key]); state.queue[key] = value; },
    run: (name, args) => state.events.push(["run", name, JSON.parse(JSON.stringify(args))]),
    openOverlay: args => state.events.push(["open", JSON.parse(JSON.stringify(args))]),
    closeOverlay: id => state.events.push(["close", id]),
    notify: args => state.events.push(["error", args.body]),
    props: () => state.props ?? ({ overlay: "own" }), window: () => ({ platform: "windows" }),
    commands: () => ["tab.new", "tab.rename", "space.new", "terminal.open", "pane.split", "app.settings", "layout.switch"]
      .map(name => ({ name, args: [], about: "" })),
    layouts: () => ["files-left"], keys: () => state.bound ?? [], theme: () => ({ dim: "dim" }), agents: () => [],
    localStorage: { getItem: () => null, setItem() {} },
    InputState: { new: () => ({ on() {}, focus() {} }) }, Input: { new: element }
  };
  sandbox.win = sandbox.window;
  const { Palette, customEntries, prepareCustom, shortcutLabel } = vm.runInNewContext(
    `${load(`${root}\\custom-palette\\actions.js`)}\n${load(`${root}\\custom-palette\\status.js`)}\n${load(`${root}\\custom-palette\\main.js`)}\n({ Palette, customEntries, prepareCustom, shortcutLabel })`, sandbox);
  const palette = new Palette();
  palette.init({}, { timer: { after() {} }, focus_handle() {} });
  return { state, palette, customEntries, prepareCustom, shortcutLabel, entry: action => customEntries().find(e => e.action === action) };
}

test("custom actions are pinned before recent and standard commands without duplication", () => {
  const f = fixture();
  f.palette.recent = ["tab.new:{}", "custom:new-agent"];
  const rows = f.palette.rows();
  const firstNormal = rows.findIndex(row => !row.e.custom);
  assert.equal(firstNormal, f.customEntries().length);
  assert.ok(rows.slice(0, firstNormal).every(row => row.head === "Custom"));
  assert.equal(rows[firstNormal].head, "Recent");
  assert.equal(new Set(rows.map(row => row.e.id)).size, rows.length);
});

test("search matches all directional custom actions and keeps matches above ordinary commands", () => {
  const f = fixture();
  f.palette.query = "split right";
  const rows = f.palette.rows();
  assert.ok(rows.some(row => !row.e.custom && row.e.title === "Split right"));
  assert.ok(rows[0].e.custom);
  for (const kind of ["agent", "scratchpad", "terminal"]) {
    for (const direction of ["right", "left", "up", "down"]) {
      f.palette.query = `${kind} ${direction}`;
      assert.ok(f.palette.rows().some(row => row.e.action === `split-${kind}-${direction}`));
    }
  }
  f.palette.query = "rename";
  assert.ok(f.palette.rows().some(row => row.e.name === "tab.rename"));
  f.palette.query = "no command can match zzzzzzzzzzz";
  assert.equal(f.palette.rows().length, 0);
});

test("gold applies to every part of a custom title, selected or not, including fuzzy matches", () => {
  const f = fixture(), theme = { accent: "gold", foreground: "white", muted: "gray" };
  for (const selected of [true, false]) {
    for (const hits of [undefined, [0, 4]]) {
      const title = f.palette.title(theme, "New agent", hits, selected, true);
      assert.ok(nodes(title).filter(node => node.attrs.text_color).every(node => node.attrs.text_color === "gold"));
    }
  }
  assert.equal(f.palette.title(theme, "Ordinary", undefined, false, false).attrs.text_color, "gray");
});

test("new Copilot uses the original current space and custom launch flags", () => {
  const f = fixture();
  f.palette.go(f.entry("new-agent"));
  assert.deepEqual(f.state.events, [["close", "own"], ["run", "tab.new", {
    name: "Copilot", space: "space", folder: "C:\\repo", argv: ["copilot", "--disable-builtin-mcps"]
  }]]);
});

for (const kind of ["agent", "scratchpad", "terminal"]) {
  test(`${kind} splits dispatch after palette close with captured pane and direction`, () => {
    for (const direction of ["right", "left", "up", "down"]) {
      const f = fixture();
      const execute = f.prepareCustom(f.entry(`split-${kind}-${direction}`));
      f.state.pane = { ...f.state.pane, pane: "different" };
      execute();
      const request = f.state.queue["tabs-tiling.split-request"];
      assert.equal(request.pane, "captured");
      assert.equal(request.kind, kind);
      assert.equal(request.direction, direction);
      if (kind === "scratchpad") assert.equal(request.folder, "C:\\repo");
    }
    const f = fixture();
    f.palette.go(f.entry(`split-${kind}-right`));
    assert.equal(f.state.events[0][0], "close");
    assert.equal(f.state.events[1][0], "shared");
  });
}

test("pending splits and missing targets report errors without closing or starting anything", () => {
  for (const pending of [true, false]) {
    const f = fixture();
    if (pending) f.state.queue["tabs-tiling.split-request"] = { pane: "other" };
    else f.state.pane = null;
    f.palette.go(f.entry("split-agent-right"));
    assert.equal(f.state.events.length, 1);
    assert.equal(f.state.events[0][0], "error");
  }
});

test("fork uses the original pane header's persistent worker and rejects working/non-Copilot agents", () => {
  const f = fixture();
  f.palette.go(f.entry("fork"));
  assert.equal(f.state.queue["pane-fork.request"].pane, "captured");
  assert.equal(f.state.events[0][0], "close");
  for (const pane of [{ status: "working" }, { app: "other", program: { key: "shell" } }]) {
    const invalid = fixture();
    Object.assign(invalid.state.pane, pane);
    invalid.palette.go(invalid.entry("fork"));
    assert.equal(invalid.state.events[0][0], "error");
    assert.equal(invalid.state.queue["pane-fork.request"], undefined);
  }
});

test("Files/Changes actions switch, open, or close the same sidebar panel", () => {
  const f = fixture();
  f.palette.go(f.entry("changes"));
  assert.equal(f.state.events[1][1], "layout.select");
  assert.equal(f.state.events[1][2].child, "changes");
  assert.equal(f.state.events[2][1], "layout.show");
  const active = fixture();
  active.palette.go(active.entry("files"));
  assert.equal(active.state.events[1][1], "layout.hide");
});

test("new space opens the existing agent-selection menu on the current machine", () => {
  const f = fixture();
  f.state.space.machine = "vps";
  f.palette.go(f.entry("new-space"));
  assert.equal(f.state.events[1][0], "open");
  assert.deepEqual(f.state.events[1][1].props, { spaceMenu: true, newSpace: true, machine: "vps" });
});

test("standard commands retain their normal dispatch", () => {
  const f = fixture();
  f.palette.go(f.palette.rows().find(row => row.e.name === "tab.rename").e);
  assert.deepEqual(f.state.events, [["close", "own"], ["run", "tab.rename", {}]]);
});

test("only the requested pane schedules one fork, outside render, and clears the request first", () => {
  let request = { pane: "target" }, forks = 0;
  const callbacks = [];
  const Pane = vm.runInNewContext(`${load(`${root}\\pane-fork\\main.js`)}\nPane`, {
    View: class {}, shared: () => request, setShared: (_key, value) => { request = value; },
    notify: () => assert.fail("No errors expected")
  });
  const pane = new Pane();
  pane.init();
  pane.fork = () => { assert.equal(request, null); forks++; };
  const cx = { timer: { after: (_ms, fn) => callbacks.push(fn) } };
  pane.scheduleFork("other", cx);
  assert.equal(callbacks.length, 0);
  pane.scheduleFork("target", cx);
  pane.scheduleFork("target", cx);
  assert.equal(callbacks.length, 1);
  assert.equal(forks, 0);
  callbacks[0](cx);
  assert.equal(forks, 1);
});

test("fork scheduling errors can be retried without leaving the header stuck", () => {
  const Pane = vm.runInNewContext(`${load(`${root}\\pane-fork\\main.js`)}\nPane`, {
    View: class {}, shared: () => ({ pane: "target" })
  });
  const pane = new Pane();
  pane.init();
  assert.throws(() => pane.scheduleFork("target", { timer: { after() { throw new Error("timer failed"); } } }), /timer failed/);
  assert.equal(pane.forkScheduled, false);
  let scheduled = false;
  pane.scheduleFork("target", { timer: { after() { scheduled = true; } } });
  assert.equal(scheduled, true);
});

test("the shortcut and status-bar click open the same persistent custom palette", () => {
  const keys = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "keys.json"), "utf8"));
  const calls = [];
  const Status = vm.runInNewContext(`${load(`${root}\\custom-palette\\status.js`)}\nWorkspaceStatus`, {
    View: class {}, div: element, h_flex: element, svg: element,
    window: () => ({ platform: "windows" }), theme: () => ({}), spaces: () => [], agents: () => [],
    keys: () => Object.entries(keys.global).map(([keys, action]) => ({ section: "global", keys, action })),
    run: (name, args) => calls.push([name, args.name])
  });
  const status = new Status();
  assert.equal(status.hint({}), "Ctrl+Shift+P  commands");
  const button = nodes(status.render()).find(node => node.attrs.id === "palette");
  button.attrs.on_click();
  assert.deepEqual(calls, [["mod.open", "custom-palette"]]);
});

test("existing keyboard bindings appear as subtle right-aligned text, without keycap boxes", () => {
  const f = fixture();
  f.state.bound = [{ section: "global", action: "tab.rename", keys: "f2" }];
  f.palette.query = "Rename tab";
  const hint = nodes(f.palette.render()).find(node => node.childNodes.includes("F2"));
  assert.ok(hint);
  assert.equal(hint.attrs.text_color, "dim");
  assert.equal(hint.attrs.text_size, 11);
  assert.ok("text_right" in hint.attrs);
  assert.ok("flex_none" in hint.attrs);
  assert.ok(!("border_1" in hint.attrs));
  assert.ok(!("bg" in hint.attrs));
  assert.equal(f.shortcutLabel("ctrl-shift-o"), "Ctrl+Shift+O");
  assert.equal(f.shortcutLabel("ctrl--"), "Ctrl+-");
  assert.equal(f.shortcutLabel("ctrl-k ctrl-c"), "Ctrl+K Ctrl+C");
});

test("every custom action has a unique real binding that displays its shortcut", () => {
  const f = fixture();
  const bound = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "keys.json"), "utf8")).global;
  f.state.bound = Object.entries(bound).map(([keys, action]) => ({ section: "global", keys, action }));
  const used = new Set();
  for (const entry of f.customEntries()) {
    const key = f.state.bound.find(binding => binding.action === entry.name)?.keys;
    assert.ok(key, `Missing shortcut for ${entry.title}`);
    assert.ok(!used.has(key));
    used.add(key);
  }
  f.palette.query = "Copilot agent";
  const hints = nodes(f.palette.render()).filter(node => node.childNodes.includes("Ctrl+Alt+C Enter"));
  assert.equal(hints.length, 1);
  assert.equal(f.shortcutLabel("ctrl-alt-s right"), "Ctrl+Alt+S Right");
  for (const binding of f.state.bound.filter(binding =>
    binding.action === "custom-palette.new-agent" || binding.action.startsWith("custom-palette.split-agent-"))) {
    assert.ok(binding.keys.startsWith("ctrl-alt-c "));
  }
});

test("shortcut dispatch reuses the palette action pipeline without opening or closing a popup", () => {
  const f = fixture();
  f.state.props = { status: true };
  f.palette.dispatchShortcut("split-scratchpad-left");
  assert.equal(f.state.queue["tabs-tiling.split-request"].kind, "scratchpad");
  assert.equal(f.state.queue["tabs-tiling.split-request"].direction, "left");
  assert.equal(f.state.queue["tabs-tiling.split-request"].pane, "captured");
  assert.equal(f.state.events[0][0], "shared");
  f.palette.close();
  assert.ok(!f.state.events.some(event => event[0] === "close"));
  assert.throws(() => f.palette.dispatchShortcut("unknown"), /Unknown custom shortcut/);
});

test("sidebar mark and controls resolve packaged assets in wide, rail, and footer views", () => {
  const bundle = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "bundle.json"), "utf8"));
  const layout = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "layouts", `${bundle.layout}.json`), "utf8"));
  const sidebar = layout.children.find(node => node.id === "sidebar");
  const mod = sidebar.children.find(node => node.id === "brand").content.mod;
  const assets = new Set();
  const renderedAssets = new Map();
  const asset = name => {
    const relative = path.relative(root, path.join(__dirname, "..", name)).split(path.sep);
    assert.ok(bundle.mods[relative[0]]?.includes(relative[1]), `Unpackaged asset: ${name}`);
    assert.ok(fs.statSync(path.join(root, ...relative)).isFile());
    assets.add(name);
    const node = element();
    renderedAssets.set(name, node);
    return node;
  };
  let footer = false;
  let accent = "#e6b450";
  const Chrome = vm.runInNewContext(`${load(path.join(root, mod, "main.js"))}\nWorkspaceChrome`, {
    View: class {}, div: element, h_flex: element, v_flex: element, image: asset, svg: asset,
    theme: () => ({ accent }), layout: () => layout, window: () => ({ platform: "windows" }),
    props: () => ({ footer }), shared: () => null, updates: () => ({ app: {} })
  });
  const chrome = new Chrome();
  chrome.render();
  assert.equal(renderedAssets.get(`mods/${mod}/mark.svg`).attrs.text_color, accent);
  accent = "#6cb6ff";
  chrome.render();
  assert.equal(renderedAssets.get(`mods/${mod}/mark.svg`).attrs.text_color, accent);
  footer = true;
  chrome.render();
  sidebar.size.px = 44;
  chrome.render();
  footer = false;
  chrome.render();
  assert.equal(assets.size, 5);
});
