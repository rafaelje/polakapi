import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { syncVersions } from "./sync-versions.mjs";

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "polakapi-version-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, "src-tauri"));
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "polakapi", private: true, version: "0.11.0" }),
  );
  writeFileSync(
    join(cwd, "src-tauri/tauri.conf.json"),
    '{"version":"0.11.0","productName":"polakapi"}\n',
  );
  writeFileSync(
    join(cwd, "src-tauri/Cargo.toml"),
    '[package]\nname = "polakapi"\nversion = "0.11.0"\n\n[dependencies]\nother = "1.0.0"\n',
  );
  writeFileSync(
    join(cwd, "src-tauri/Cargo.lock"),
    'version = 4\n\n[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "polakapi"\nversion = "0.11.0"\n',
  );
  return cwd;
}

test("applies a real changeset once and synchronizes all desktop versions", (t) => {
  const cwd = fixture(t);
  mkdirSync(join(cwd, ".changeset"));
  writeFileSync(
    join(cwd, ".changeset/config.json"),
    JSON.stringify({
      ...JSON.parse(readFileSync(new URL("../.changeset/config.json", import.meta.url))),
      format: false,
    }),
  );
  writeFileSync(
    join(cwd, ".changeset/test.md"),
    '---\n"polakapi": patch\n---\n\nFollow terminal output.\n',
  );
  const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
  execFileSync(process.execPath, [cli, "version"], { cwd, stdio: "pipe" });

  assert.throws(() => syncVersions(cwd, true), /Versions must match/);
  assert.equal(syncVersions(cwd), "0.11.1");
  assert.equal(syncVersions(cwd, true), "0.11.1");
  assert.equal(JSON.parse(readFileSync(join(cwd, "src-tauri/tauri.conf.json"))).version, "0.11.1");
  assert.match(readFileSync(join(cwd, "src-tauri/Cargo.toml"), "utf8"), /version = "0.11.1"/);
  assert.match(
    readFileSync(join(cwd, "src-tauri/Cargo.lock"), "utf8"),
    /name = "other"\nversion = "1.0.0"/,
  );
  assert.match(readFileSync(join(cwd, "CHANGELOG.md"), "utf8"), /0\.11\.1/);
  assert.throws(() => readFileSync(join(cwd, ".changeset/test.md")), { code: "ENOENT" });
});

test("check mode reports drift without rewriting version files", (t) => {
  const cwd = fixture(t);
  const path = join(cwd, "src-tauri/tauri.conf.json");
  writeFileSync(path, '{"version":"0.10.0"}\n');
  assert.throws(() => syncVersions(cwd, true), /tauri.conf.json/);
  assert.equal(readFileSync(path, "utf8"), '{"version":"0.10.0"}\n');
});

test("a malformed Cargo manifest fails before writing any version files", (t) => {
  const cwd = fixture(t);
  const path = join(cwd, "src-tauri/tauri.conf.json");
  writeFileSync(path, '{"version":"0.10.0"}\n');
  writeFileSync(join(cwd, "src-tauri/Cargo.toml"), "[dependencies]\n");
  assert.throws(() => syncVersions(cwd), /Cannot locate/);
  assert.equal(readFileSync(path, "utf8"), '{"version":"0.10.0"}\n');
});
