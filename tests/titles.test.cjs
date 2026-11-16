const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const { test } = require("node:test");
const program = { name: "Copilot", key: "copilot", agent: true };

for (const mod of ["agents-titles", "tabs-tiling", "pane-fork"]) {
const source = fs.readFileSync(
  path.join(__dirname, "..", "mods", mod, "titles.js"), "utf8"
).replace(/^export /gm, "");
const { title, leadPanes } = vm.runInNewContext(`${source}\n({ title, leadPanes })`);

test(`${mod}: automatic and Copilot-named tabs use the cleaned live conversation title`, () => {
  for (const tab of [{ name: "1", named: false }, { name: "Copilot", named: true }]) {
    assert.equal(title(tab, { title: "\u25cf Improve terminal layout", program }), "Improve terminal layout");
  }
});

test(`${mod}: custom tab names and generic or path titles retain the existing tab label`, () => {
  assert.equal(title({ name: "My investigation", named: true }, { title: "A live title", program }), "My investigation");
  for (const live of ["Copilot", "copilot", "", "~\\repo", "/repo", "C:\\dev\\repo", "user@host"]) {
    assert.equal(title({ name: "Copilot", named: true }, { title: live, program }), "Copilot");
  }
});

test(`${mod}: strips Copilot's automatic suffix without altering custom tab names`, () => {
  const lead = { title: "\u25cf Investigate explorer - GitHub Copilot", program };
  assert.equal(title({ name: "Copilot", named: true }, lead), "Investigate explorer");
  assert.equal(title({ name: "My investigation", named: true }, lead), "My investigation");
  assert.equal(title({ name: "Copilot", named: true }, { title: "Copilot - GitHub Copilot", program }), "Copilot");
  assert.equal(title({ name: "1", named: false }, { title: "GitHub Copilot integration notes", program }), "GitHub Copilot integration notes");
});

test(`${mod}: multi-pane tabs select a stable agent lead, ignoring mod panes`, () => {
  const all = [
    { tab: "tab", terminal: null, title: "Scratchpad" },
    { tab: "tab", terminal: "shell", program: { agent: false }, focused: true },
    { tab: "tab", terminal: "first", program },
    { tab: "tab", terminal: "second", program, focused: true }
  ];
  assert.equal(leadPanes(all).get("tab"), all[2]);
});
}
