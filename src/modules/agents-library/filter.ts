import type { AgentDef } from "./types";

// Precomputed lowercased haystack per agent — name + description + every
// file title and content. Kept as a WeakMap so callers can call
// `filterAgents` with the live controller list without paying the concat
// cost on every keystroke.
const haystackCache = new WeakMap<AgentDef, string>();

function haystackOf(agent: AgentDef): string {
  const cached = haystackCache.get(agent);
  if (cached) return cached;
  const parts: string[] = [agent.name, agent.description];
  for (const f of agent.files) {
    parts.push(f.title, f.content);
  }
  const s = parts.join(" ").toLowerCase();
  haystackCache.set(agent, s);
  return s;
}

export function filterAgents(agents: readonly AgentDef[], query: string): AgentDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...agents];
  const tokens = q.split(/\s+/u).filter(Boolean);
  return agents.filter((a) => {
    const h = haystackOf(a);
    return tokens.every((t) => h.includes(t));
  });
}
