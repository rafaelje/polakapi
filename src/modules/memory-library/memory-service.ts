import { invoke } from "../../shared/tauri/invoke";
import type { MemoryDeleteResult, MemoryProjectGroup } from "./types";

export function listMemories(): Promise<MemoryProjectGroup[]> {
  return invoke<MemoryProjectGroup[]>("memory_list", undefined, {
    errorMessage: "Could not scan Claude memory directories",
  });
}

export function readMemory(path: string): Promise<string> {
  return invoke<string>("memory_read", { path }, { errorMessage: "Could not read memory file" });
}

export function writeMemory(path: string, content: string): Promise<void> {
  return invoke<void>(
    "memory_write",
    { path, content },
    { errorMessage: "Could not save memory file" },
  );
}

export function deleteMemory(path: string): Promise<MemoryDeleteResult> {
  return invoke<MemoryDeleteResult>(
    "memory_delete",
    { path },
    { errorMessage: "Could not delete memory file" },
  );
}
