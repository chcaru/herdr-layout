// Customized for this Herdr layout; recorded provenance is in ATTRIBUTION.md.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

export function leadPanes(all) {
  const leads = new Map();
  for (const p of all) {
    if (!p.terminal) continue;
    const current = leads.get(p.tab);
    // First agent, else first focused terminal, else first terminal in the tab.
    if (!current || (!current.program?.agent && (p.program?.agent || (!current.focused && p.focused)))) leads.set(p.tab, p);
  }
  return leads;
}

export function title(tab, lead) {
  const program = lead?.program?.name;
  const live = clean(lead?.title).replace(/\s+-\s+GitHub Copilot$/i, "").trim();
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead?.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== program && !path && !live.includes("@") && live.toLowerCase() !== lead?.program?.key;
  return (tab.name === program || !tab.named) && telling ? live : tab.name;
}
