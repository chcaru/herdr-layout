// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
const cp = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const validId = id => new RegExp(`^${UUID}$`).test(id);
const sessionRoot = path.join(os.homedir(), ".copilot", "session-state");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function call(program, args) {
  const result = cp.spawnSync(program, args, { encoding: "utf8", timeout: 10000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw new Error(`${program} ${args[0]}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `${program} failed`);
  return result.stdout;
}

function core(args) {
  const result = JSON.parse(call("hc", [args[0], "--json", ...args.slice(1)]));
  if (result.error) throw new Error(result.error);
  return result;
}

function owner(processes, rootPid) {
  const parents = new Map(processes.map(p => [p.ProcessId, p.ParentProcessId]));
  const candidates = [];
  for (const process of processes.filter(p => p.Name.toLowerCase() === "copilot.exe")) {
    let pid = process.ProcessId, depth = 0;
    const seen = new Set();
    while (pid && !seen.has(pid)) {
      if (pid === rootPid) { candidates.push({ ...process, depth }); break; }
      seen.add(pid);
      pid = parents.get(pid);
      depth++;
    }
  }
  candidates.sort((a, b) => a.depth - b.depth);
  if (!candidates.length || candidates[0].depth === candidates[1]?.depth) {
    throw new Error("Cannot identify a unique Copilot process for this pane.");
  }
  if (!candidates[0].ExecutablePath) throw new Error("Cannot read the Copilot executable path.");
  return candidates[0];
}

function scalar(yaml, key) {
  const value = yaml.match(new RegExp(`^${key}:\\s*(.*)$`, "m"))?.[1]?.trim();
  if (!value) return null;
  if (value.startsWith('"')) return JSON.parse(value);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replace(/''/g, "'");
  if (value === "|" || value === ">") throw new Error(`Unsupported multiline session ${key}.`);
  return value;
}

function selectSession(candidates, title) {
  const name = title.replace(/ - GitHub Copilot$/, "").replace(/^[\s●◉○✓✔✗✘⏳⟳↻]+/, "").trim();
  const matches = candidates.filter(s => (s.name || `Session ${s.id.slice(0, 8)}`) === name);
  if (matches.length === 1) return matches[0];
  if (!matches.length && candidates.length === 1 && (!name || name === "GitHub Copilot")) return candidates[0];
  throw new Error("Cannot identify the active conversation unambiguously. Finish any session picker or rename prompt, then retry.");
}

function sessions(pid) {
  return fs.readdirSync(sessionRoot, { withFileTypes: true })
    .filter(e => e.isDirectory() && validId(e.name))
    .filter(e => fs.existsSync(path.join(sessionRoot, e.name, `inuse.${pid}.lock`)))
    .map(e => {
      const yaml = fs.readFileSync(path.join(sessionRoot, e.name, "workspace.yaml"), "utf8");
      return { id: e.name, name: scalar(yaml, "name"), cwd: scalar(yaml, "cwd") };
    });
}

function acknowledgedFork(event, name) {
  if (event.type !== "session.info" || event.data?.infoType !== "fork" ||
      !event.data.message?.startsWith(`Forked this session into "${name}" (`)) return null;
  return event.data.message.match(new RegExp(`\\((${UUID})\\)\\.$`))?.[1] ?? null;
}

function firstEvent(id) {
  const fd = fs.openSync(path.join(sessionRoot, id, "events.jsonl"), "r");
  try {
    const buffer = Buffer.alloc(65536);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const first = buffer.toString("utf8", 0, count).split("\n")[0];
    return JSON.parse(first);
  } finally { fs.closeSync(fd); }
}

async function fork(address, title) {
  if (!address || address.includes("/")) throw new Error("Conversation forks currently support local Windows Copilot panes only.");
  const terminal = core(["get", address]);
  if (terminal.state !== "live" || terminal.status?.app !== "copilot") throw new Error("This pane is not a running Copilot agent.");
  if (terminal.status.state === "working") throw new Error("Wait for the current turn to finish before forking.");
  const processes = JSON.parse(call("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath) | ConvertTo-Json -Compress"]));
  const process = owner(processes, terminal.pid);
  const source = selectSession(sessions(process.ProcessId), terminal.title || title);
  if (!source.cwd) throw new Error("The current conversation has no saved working directory.");
  const original = firstEvent(source.id);
  const startedAt = Date.now();
  const name = `${source.name || `Session ${source.id.slice(0, 8)}`} (fork ${crypto.randomUUID().slice(0, 8)})`;
  const eventsFile = path.join(sessionRoot, source.id, "events.jsonl");
  const decoder = new StringDecoder("utf8");
  let offset = fs.statSync(eventsFile).size, pending = "";
  const helper = core(["run", "--bg", "--no-parent", "--no-notify", "--cwd", source.cwd, "--",
    process.ExecutablePath, "--disable-builtin-mcps", "--resume", source.id, "--interactive", `/fork ${name}`]);
  if (!helper.address || helper.address === address) throw new Error("No disposable fork-helper terminal was created.");
  let result;
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const size = fs.statSync(eventsFile).size;
      if (size < offset) throw new Error("The source conversation was rewound while the fork was being created.");
      const fd = fs.openSync(eventsFile, "r");
      try {
        const buffer = Buffer.alloc(Math.min(size - offset, 1024 * 1024));
        const count = fs.readSync(fd, buffer, 0, buffer.length, offset);
        offset += count;
        pending += decoder.write(buffer.subarray(0, count));
      } finally { fs.closeSync(fd); }
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const id = acknowledgedFork(JSON.parse(line), name);
        if (!id) continue;
        if (id === source.id) throw new Error("Copilot did not create an independent conversation.");
        const event = firstEvent(id);
        if (event.type !== "session.start" || event.data.sessionId !== id ||
            event.id !== original.id || Date.parse(event.timestamp) < startedAt) {
          throw new Error("Could not verify the new conversation's fork ancestry.");
        }
        result = { sessionId: id, sourceSessionId: source.id };
        break;
      }
      if (result) break;
      if (core(["get", helper.address]).state !== "live") throw new Error("Copilot exited before acknowledging the fork.");
      await pause(250);
    }
    if (!result) throw new Error("Copilot did not acknowledge the fork within 20 seconds.");
  } finally {
    if (core(["get", helper.address]).state === "live") core(["kill", helper.address]);
    core(["rm", helper.address]);
  }
  return result;
}

module.exports = { owner, scalar, selectSession, acknowledgedFork, fork };
if (require.main === module) {
  fork(process.argv[2], process.argv[3] || "").then(
    result => console.log(JSON.stringify(result)),
    error => { console.error(String(error)); process.exitCode = 1; }
  );
}
