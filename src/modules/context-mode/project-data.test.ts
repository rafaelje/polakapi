import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
vi.mock("../../shared/ui/modal", () => ({ confirmModal: vi.fn() }));
vi.mock("../../shared/ui/toast", () => ({ showToast: vi.fn() }));

import { invoke } from "../../shared/tauri/invoke";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { clearProjectContextData, describeData, formatBytes } from "./project-data";

const project = { name: "ice-games", path: "/repos/ice-games" };
const calls = (): string[] => vi.mocked(invoke).mock.calls.map((call) => call[0]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("clearProjectContextData", () => {
  it("asks before deleting, and says how much will go", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce({ sessions: 2, bytes: 3 * 1024 * 1024 })
      .mockResolvedValueOnce({ sessions: 2, bytes: 3 * 1024 * 1024 });
    vi.mocked(confirmModal).mockResolvedValueOnce(true);

    await clearProjectContextData(project);

    const options = vi.mocked(confirmModal).mock.calls[0][0];
    expect(options.danger).toBe(true);
    expect(options.message).toContain("2 sessions, 3.0 MB");
    expect(options.message).toContain("ice-games/.polakapi");
    expect(calls()).toEqual(["ctx_project_data_summary", "ctx_clear_project_data"]);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Deleted 2 sessions"), "info");
  });

  it("deletes nothing when the user cancels", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ sessions: 1, bytes: 10 });
    vi.mocked(confirmModal).mockResolvedValueOnce(false);

    await clearProjectContextData(project);

    expect(calls()).toEqual(["ctx_project_data_summary"]);
  });

  it("does not ask when there is nothing to delete", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ sessions: 0, bytes: 0 });

    await clearProjectContextData(project);

    expect(confirmModal).not.toHaveBeenCalled();
    expect(calls()).toEqual(["ctx_project_data_summary"]);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("No context mode data"), "info");
  });
});

describe("formatting", () => {
  it("scales sizes and pluralises sessions", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(describeData({ sessions: 1, bytes: 0 })).toBe("1 session, 0 B");
  });
});
