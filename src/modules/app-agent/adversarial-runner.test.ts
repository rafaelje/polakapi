import { beforeEach, expect, it, vi } from "vitest";
import { defaultModelFor } from "../../shared/agent-cli";
import { LOOP_CLIS } from "../loop/types";

vi.mock("../adversarial/scheduler/invokers", () => ({
  invokers: {
    validateCli: vi.fn().mockResolvedValue({ ok: true }),
    branchDiff: vi.fn().mockResolvedValue({ filesChanged: 0, diff: "" }),
  },
}));

import { invokers } from "../adversarial/scheduler/invokers";
import { AdversarialRunner } from "./adversarial-runner";

beforeEach(() => vi.clearAllMocks());

it.each(LOOP_CLIS)("uses the shared default model for a %s operator review", async (cli) => {
  const runner = new AdversarialRunner();
  await expect(
    runner.start({ projectPath: "/repo", baseRef: "main", critic: { cli } }),
  ).rejects.toThrow("the diff is empty; nothing to review");
  expect(invokers.validateCli).toHaveBeenNthCalledWith(1, {
    cli,
    model: defaultModelFor(cli),
    effort: "default",
  });
  expect(invokers.validateCli).toHaveBeenNthCalledWith(2, {
    cli: "codex",
    model: defaultModelFor("codex"),
    effort: "high",
  });
});
