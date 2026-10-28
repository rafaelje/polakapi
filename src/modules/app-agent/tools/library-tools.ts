import { invoke } from "../../../shared/tauri/invoke";
import { flushSaveWorkspaces } from "../../../shared/persistence/workspaces-store";
import type { ContextDetail, SearchHit } from "../../agent-context/types";
import type { MemoryProjectGroup } from "../../memory-library/types";
import type { SkillEntry } from "../../skills-library/types";
import { oneOf, optionalInteger, optionalString, requiredString } from "./args";
import { findProjectByRef } from "./resolve";
import { requireController, ToolError, type ToolDef } from "./types";

// Read-only access to what polakapi already indexes: skills, Claude Code
// auto-memory, and the context each live AI CLI pane has accumulated.

const PTY_ARG = { type: "string", description: "ptyId of a live AI CLI pane." };

async function contextDetail(ptyId: string): Promise<ContextDetail> {
  try {
    return await invoke<ContextDetail>("agent_context_detail", { ptyId }, { toastOnError: false });
  } catch (error) {
    throw new ToolError(`no readable context for "${ptyId}": ${String(error)}`);
  }
}

function matchesQuery(entry: SkillEntry, query: string): boolean {
  const haystack = `${entry.name} ${entry.description} ${entry.cli} ${entry.source}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export const libraryTools: ToolDef[] = [
  {
    name: "polakapi_skills_list",
    description:
      "List the skills polakapi finds for every CLI: global ones under the user's home and project ones inside registered projects. Filter by free text, scope or cli.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words that must all appear in name/description." },
        scope: { type: "string", enum: ["global", "project"] },
        cli: { type: "string", description: "claude, codex, opencode or cursor." },
        project: { type: "string", description: "Only project skills of this project id/name." },
      },
    },
    run: async (args, ctx) => {
      const state = requireController(ctx).getState();
      await flushSaveWorkspaces();
      const entries = await invoke<SkillEntry[]>("skills_list", {}, { toastOnError: false });
      const query = optionalString(args, "query");
      const scope = oneOf(args, "scope", ["global", "project"] as const);
      const cli = optionalString(args, "cli");
      const projectRef = optionalString(args, "project");
      const projectPath = projectRef ? findProjectByRef(state, projectRef).project.path : null;
      return entries
        .filter((entry) => !query || matchesQuery(entry, query))
        .filter((entry) => !scope || entry.scope === scope)
        .filter((entry) => !cli || entry.cli === cli)
        .filter((entry) => !projectPath || entry.projectPath === projectPath)
        .map((entry) => ({
          cli: entry.cli,
          name: entry.name,
          description: entry.description,
          scope: entry.scope,
          source: entry.source,
          path: entry.path,
          projectPath: entry.projectPath,
        }));
    },
  },
  {
    name: "polakapi_skill_read",
    description: "Read a skill file by the path returned from polakapi_skills_list.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Skill path from polakapi_skills_list." },
        projectPath: {
          type: "string",
          description: "projectPath from the listing, for project-scoped skills.",
        },
      },
      required: ["path"],
    },
    run: async (args) => {
      try {
        return await invoke<string>(
          "skill_read",
          {
            path: requiredString(args, "path"),
            projectPath: optionalString(args, "projectPath") ?? null,
          },
          { toastOnError: false },
        );
      } catch (error) {
        throw new ToolError(`could not read skill: ${String(error)}`);
      }
    },
  },
  {
    name: "polakapi_memory_list",
    description:
      "List Claude Code auto-memory files grouped by project directory (MEMORY.md is the index of each group).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    run: async () =>
      (await invoke<MemoryProjectGroup[]>("memory_list", {}, { toastOnError: false })).map(
        (group) => ({
          dirName: group.dirName,
          files: group.files.map((file) => ({
            name: file.name,
            description: file.description,
            path: file.path,
            isIndex: file.isIndex,
          })),
        }),
      ),
  },
  {
    name: "polakapi_memory_read",
    description: "Read one auto-memory file by the path returned from polakapi_memory_list.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    run: async (args) => {
      try {
        return await invoke<string>(
          "memory_read",
          { path: requiredString(args, "path") },
          { toastOnError: false },
        );
      } catch (error) {
        throw new ToolError(`could not read memory file: ${String(error)}`);
      }
    },
  },
  {
    name: "polakapi_agent_context",
    description:
      "Inspect what a live AI CLI pane has in its context window: token totals, breakdown by kind, and the newest entries (tool calls, file reads, prompts, answers) with short previews.",
    inputSchema: {
      type: "object",
      properties: {
        ptyId: PTY_ARG,
        limit: { type: "integer", description: "Newest entries to include, 1 to 200. Default 40." },
      },
      required: ["ptyId"],
    },
    run: async (args) => {
      const detail = await contextDetail(requiredString(args, "ptyId"));
      const limit = optionalInteger(args, "limit", { min: 1, max: 200 }) ?? 40;
      return {
        summary: detail.summary,
        breakdown: detail.breakdown,
        note: detail.note,
        totalEntries: detail.entries.length,
        entries: detail.entries.slice(-limit).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          label: entry.label,
          detail: entry.detail,
          timestamp: entry.timestamp,
          estTokens: entry.estTokens,
          preview: entry.preview,
        })),
      };
    },
  },
  {
    name: "polakapi_agent_context_search",
    description:
      "Regex search over the full bodies of a live AI CLI pane's context entries. Lower-case patterns match case-insensitively.",
    inputSchema: {
      type: "object",
      properties: { ptyId: PTY_ARG, pattern: { type: "string" } },
      required: ["ptyId", "pattern"],
    },
    run: async (args) => {
      const ptyId = requiredString(args, "ptyId");
      const detail = await contextDetail(ptyId);
      try {
        const hits = await invoke<SearchHit[]>(
          "agent_context_search",
          { ptyId, pattern: requiredString(args, "pattern"), identity: detail.identity },
          { toastOnError: false },
        );
        const byId = new Map(detail.entries.map((entry) => [entry.id, entry]));
        return hits.map((hit) => ({
          entryId: hit.entryId,
          matches: hit.matches,
          snippet: hit.snippet,
          label: byId.get(hit.entryId)?.label ?? null,
          kind: byId.get(hit.entryId)?.kind ?? null,
        }));
      } catch (error) {
        throw new ToolError(`search failed: ${String(error)}`);
      }
    },
  },
  {
    name: "polakapi_agent_context_entry",
    description: "Full text of one context entry of a live AI CLI pane.",
    inputSchema: {
      type: "object",
      properties: { ptyId: PTY_ARG, entryId: { type: "integer" } },
      required: ["ptyId", "entryId"],
    },
    run: async (args) => {
      const ptyId = requiredString(args, "ptyId");
      const entryId = optionalInteger(args, "entryId", { min: 0 });
      if (entryId === undefined) throw new ToolError('"entryId" is required');
      const detail = await contextDetail(ptyId);
      try {
        const text = await invoke<string | null>(
          "agent_context_entry",
          { ptyId, entryId, identity: detail.identity },
          { toastOnError: false },
        );
        if (text === null) throw new ToolError(`entry ${entryId} not found`);
        return text;
      } catch (error) {
        if (error instanceof ToolError) throw error;
        throw new ToolError(`could not read entry: ${String(error)}`);
      }
    },
  },
];
