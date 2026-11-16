// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
import { appHome, exec } from "herdr";

async function command(program, args, options) {
  const response = await exec(program, args, options);
  if (response.code !== 0) throw new Error(response.stderr || response.stdout || `${program} failed`);
  const result = JSON.parse(response.stdout);
  if (result.error) throw new Error(result.error);
  return result;
}

export async function forkPane(pane, terminal, title) {
  const created = await command("node", [`${appHome()}\\mods\\pane-fork\\fork.cjs`, terminal, title], { timeout: 60000 });
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(created.sessionId) ||
      created.sessionId === created.sourceSessionId) throw new Error("Copilot returned no independent fork session ID.");
  try {
    const split = await command("herdr-app", ["do", "pane.split", JSON.stringify({
      pane, direction: "right",
      argv: ["copilot", "--disable-builtin-mcps", "--resume", created.sessionId]
    })]);
    if (!split.pane) throw new Error("No new panel ID was returned.");
    return { pane: split.pane, sessionId: created.sessionId };
  } catch (error) {
    throw new Error(`Fork saved as ${created.sessionId}, but its panel could not open: ${String(error)}`);
  }
}
