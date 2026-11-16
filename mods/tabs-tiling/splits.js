// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
import { exec } from "herdr";

export const COPILOT_ARGS = ["copilot", "--disable-builtin-mcps"];

async function command(name, args) {
  const response = await exec("herdr-app", ["do", name, JSON.stringify(args)]);
  if (response.code !== 0) throw new Error(response.stderr || response.stdout || `${name} failed`);
  const result = JSON.parse(response.stdout);
  if (result.error) throw new Error(result.error);
  return result;
}

export async function splitPane(direction, pane, options = {}, label = "Terminal") {
  const axis = { right: "right", left: "right", up: "down", down: "down" }[direction];
  if (!axis || !pane) throw new Error("Choose a valid split direction and a pane.");
  const created = await command("pane.split", { ...options, pane, direction: axis });
  if (!created.pane) throw new Error("Split returned no new pane ID; placement could not be confirmed.");
  if (direction === "left" || direction === "up") {
    try {
      await command("pane.swap", { pane: created.pane, target: pane });
    } catch (error) {
      throw new Error(`${label} started in a ${axis} split, but ${direction} placement failed: ${String(error)}`);
    }
  }
  return created.pane;
}

export function splitCopilot(direction, pane) {
  return splitPane(direction, pane, { argv: COPILOT_ARGS }, "Copilot");
}
