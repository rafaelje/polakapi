// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { reviewSharing } from "./review-sharing";

it("shares only after a user selects one peer and clicks; revocation sends no reviewer", async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const panel = reviewSharing("source", "session", [{ id: "peer", label: "Claude" }], send);
  const select = panel.querySelector("select")!;
  const [share, stop] = panel.querySelectorAll("button");
  expect(send).not.toHaveBeenCalled();
  expect(share.disabled).toBe(true);
  select.value = "peer";
  select.dispatchEvent(new Event("change"));
  share.click();
  await vi.waitFor(() => expect(send).toHaveBeenCalledWith("source", "session", "peer"));
  await vi.waitFor(() => expect(stop.disabled).toBe(false));
  stop.click();
  expect(send).toHaveBeenLastCalledWith("source", "session", null);
});
