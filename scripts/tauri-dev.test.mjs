import assert from "node:assert/strict";
import test from "node:test";

import { buildTauriArgs, childExitCode } from "./tauri-dev-args.mjs";

test("forwards an empty argument list without adding undefined", () => {
  assert.deepEqual(buildTauriArgs([], undefined), { args: [] });
});

test("forwards non-development subcommands unchanged", () => {
  assert.deepEqual(buildTauriArgs(["build", "--bundles", "nsis"], undefined), {
    args: ["build", "--bundles", "nsis"],
  });
});

test("adds the default development URL override", () => {
  const result = buildTauriArgs(["dev"], undefined);

  assert.equal(result.devPort, "1420");
  assert.deepEqual(result.args.slice(0, 2), ["dev", "--config"]);
  assert.deepEqual(JSON.parse(result.args[2]), {
    build: { devUrl: "http://localhost:1420" },
  });
});

test("normalizes a custom development port", () => {
  const result = buildTauriArgs(["dev", "--verbose"], "1422");

  assert.equal(result.devPort, "1422");
  assert.deepEqual(result.args.slice(0, 2), ["dev", "--verbose"]);
  assert.deepEqual(JSON.parse(result.args[3]), {
    build: { devUrl: "http://localhost:1422" },
  });
});

test("inserts the development config before forwarded Cargo arguments", () => {
  const result = buildTauriArgs(["dev", "--", "--features", "custom"], "1422");

  assert.deepEqual(result.args.slice(0, 2), ["dev", "--config"]);
  assert.deepEqual(JSON.parse(result.args[2]), {
    build: { devUrl: "http://localhost:1422" },
  });
  assert.deepEqual(result.args.slice(3), ["--", "--features", "custom"]);
});

for (const port of ["", "0", "65536", "1.5", "not-a-number"]) {
  test(`rejects invalid development port ${JSON.stringify(port)}`, () => {
    assert.throws(() => buildTauriArgs(["dev"], port), /invalid TAURI_DEV_PORT/);
  });
}

test("uses a non-zero status when a child exits without a code", () => {
  assert.equal(childExitCode(null), 1);
  assert.equal(childExitCode(0), 0);
  assert.equal(childExitCode(2), 2);
});
