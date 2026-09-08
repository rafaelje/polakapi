import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./update-check", () => ({ fetchUpdateCheck: vi.fn() }));
vi.mock("../../shared/ui/modal", () => ({ confirmModal: vi.fn() }));
vi.mock("../../shared/ui/toast", () => ({ showToast: vi.fn() }));
vi.mock("../../shared/tauri/invoke", () => ({ invoke: vi.fn() }));
import { fetchUpdateCheck } from "./update-check";
import { confirmModal } from "../../shared/ui/modal";
import { showToast } from "../../shared/ui/toast";
import { invoke } from "../../shared/tauri/invoke";
import { checkForUpdatesManually } from "./manual-check";
const result = {
  currentVersion: "0.9.1",
  latestVersion: "0.9.2",
  updateAvailable: true,
  releaseUrl: "https://github.com/rafaelje/polakapi/releases/tag/v0.9.2",
};
beforeEach(() => vi.clearAllMocks());
describe("manual update checks", () => {
  it("opens a new release only after the user chooses to view it", async () => {
    vi.mocked(fetchUpdateCheck).mockResolvedValue(result);
    vi.mocked(confirmModal).mockResolvedValue(true);
    await checkForUpdatesManually();
    expect(invoke).toHaveBeenCalledWith("open_url", { url: result.releaseUrl });
  });
  it("reports up-to-date status without a release dialog", async () => {
    vi.mocked(fetchUpdateCheck).mockResolvedValue({ ...result, updateAvailable: false });
    await checkForUpdatesManually();
    expect(showToast).toHaveBeenCalledWith("polakapi v0.9.1 is up to date", "success");
    expect(confirmModal).not.toHaveBeenCalled();
  });
  it("reports network failures and allows a subsequent retry", async () => {
    vi.mocked(fetchUpdateCheck)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ ...result, updateAvailable: false });
    await checkForUpdatesManually();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Could not check"), "error");
    await checkForUpdatesManually();
    expect(fetchUpdateCheck).toHaveBeenCalledTimes(2);
  });
});
