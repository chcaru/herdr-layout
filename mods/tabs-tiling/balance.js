// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
import { exec } from "herdr";

const RPC = `
const { spawn } = require("node:child_process");
const child = spawn("hc", ["connect"], { stdio: ["pipe", "pipe", "pipe"] });
let done = false, buffer = "", stderr = "";
function finish(response, error) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  child.kill();
  if (error) { console.error(error); process.exitCode = 1; }
  else console.log(JSON.stringify(response));
}
const timer = setTimeout(() => finish(null, "Core document request timed out"), 10000);
child.on("error", error => finish(null, error.message));
child.stderr.on("data", chunk => { stderr += chunk; });
child.on("close", () => { if (!done) finish(null, stderr || "Core connection closed before its response"); });
child.stdout.on("data", chunk => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    try { const response = JSON.parse(line); if (response.id === 1) finish(response); }
    catch (error) { finish(null, "Invalid core response: " + error.message); }
  }
});
child.stdin.on("error", error => finish(null, error.message));
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, ...JSON.parse(process.argv[1]) }) + "\\n");
`;

async function rpc(method, params) {
  const result = await exec("node", ["-e", RPC, JSON.stringify({ method, params })], { timeout: 15000 });
  if (result.code !== 0) throw new Error(result.stderr || "Core document request failed");
  const response = JSON.parse(result.stdout);
  if (response.error) {
    const error = new Error(response.error.message);
    error.kind = response.error.data?.kind;
    throw error;
  }
  return response.result;
}

export function equalize(node) {
  if (node?.type === "block" && typeof node.id === "string") return 1;
  if (!["row", "column"].includes(node?.type) || typeof node.id !== "string" || !node.children?.length) {
    throw new Error("Cannot balance an unsupported pane layout.");
  }
  const counts = node.children.map(equalize);
  const total = counts.reduce((sum, count) => sum + count, 0);
  node.children.forEach((child, index) => { child.size = { weight: counts[index] / total }; });
  return total;
}

export async function balanceTab(id, on = null, added = [], removed = []) {
  const tabId = on && id.startsWith(on + "/") ? id.slice(on.length + 1) : id;
  const required = added.map(id => on && id.startsWith(on + "/") ? id.slice(on.length + 1) : id);
  const excluded = removed.map(id => on && id.startsWith(on + "/") ? id.slice(on.length + 1) : id);
  for (let attempt = 0; attempt < 3; attempt++) {
    const snapshot = await rpc("doc.get", { name: "herdr-app", on });
    const tab = snapshot.value?.spaces?.flatMap(space => space.tabs).find(tab => tab.id === tabId);
    if (!tab) {
      if (excluded.length) return;
      throw new Error("The split tab is no longer available.");
    }
    const leaves = node => node.type === "block" ? [node.id] : node.children.flatMap(leaves);
    const ids = new Set(leaves(tab.root));
    if (required.some(id => !ids.has(id))) {
      if (attempt < 2) continue;
      throw new Error("The new split is not yet saved; its layout was left unchanged.");
    }
    if (excluded.some(id => ids.has(id))) {
      if (attempt < 2) continue;
      throw new Error("The closed pane is not yet removed; its layout was left unchanged.");
    }
    equalize(tab.root);
    const resize = async node => {
      for (const child of node.children ?? []) {
        const target = on ? on + "/" + child.id : child.id;
        const result = await exec("herdr-app", ["do", "layout.resize", JSON.stringify({ id: target, weight: child.size.weight })]);
        if (result.code !== 0) throw new Error(result.stderr || "Tile resize failed");
        const response = JSON.parse(result.stdout);
        if (response.error) throw new Error(response.error);
        await resize(child);
      }
    };
    try {
      await resize(tab.root);
    } catch (error) {
      throw new Error(`Tile sizing may be partially updated: ${String(error)}`);
    }
    return;
  }
}
