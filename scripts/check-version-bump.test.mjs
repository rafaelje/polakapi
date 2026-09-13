import assert from "node:assert/strict";
import test from "node:test";

import { readVersions, validateVersionBump } from "./check-version-bump.mjs";

const files = ({
  packageVersion = "0.11.1",
  tauriVersion = packageVersion,
  cargoVersion = packageVersion,
  lockVersion = packageVersion,
} = {}) => ({
  "package.json": JSON.stringify({ version: packageVersion }),
  "src-tauri/tauri.conf.json": JSON.stringify({ version: tauriVersion }),
  "src-tauri/Cargo.toml": `[package]\nname = "polakapi"\nversion = "${cargoVersion}"\n\n[dependencies]\nserde = "1"\n`,
  "src-tauri/Cargo.lock": `[[package]]\nname = "another-package"\nversion = "99.0.0"\n\n[[package]]\nname = "polakapi"\nversion = "${lockVersion}"\n`,
});

const readFrom = (contents) => (path) => contents[path];

test("accepts aligned valid versions greater than every base version", () => {
  const base = readVersions(readFrom(files({ packageVersion: "0.11.0" })));
  const current = readVersions(readFrom(files()));

  assert.doesNotThrow(() => validateVersionBump(base, current));
});

for (const [field, pathPattern] of [
  ["tauriVersion", String.raw`src-tauri/tauri\.conf\.json`],
  ["cargoVersion", String.raw`src-tauri/Cargo\.toml`],
  ["lockVersion", String.raw`src-tauri/Cargo\.lock`],
]) {
  test(`rejects a stale ${field} even when package.json increased`, () => {
    const base = readVersions(readFrom(files({ packageVersion: "0.11.0" })));
    const current = readVersions(readFrom(files({ [field]: "0.11.0" })));

    assert.throws(
      () => validateVersionBump(base, current),
      new RegExp(
        `${pathPattern} version \\(0\\.11\\.0\\) must be greater than the PR base \\(0\\.11\\.0\\)`,
      ),
    );
  });
}

test("rejects current desktop versions that are greater but not aligned", () => {
  const base = readVersions(readFrom(files({ packageVersion: "0.11.0" })));
  const current = readVersions(
    readFrom(files({ packageVersion: "0.12.0", lockVersion: "0.11.1" })),
  );

  assert.throws(
    () => validateVersionBump(base, current),
    /Current versions must match package\.json/,
  );
});

test("rejects malformed versions in any required file", () => {
  const base = readVersions(readFrom(files({ packageVersion: "0.11.0" })));
  const current = readVersions(readFrom(files({ cargoVersion: "next" })));

  assert.throws(
    () => validateVersionBump(base, current),
    /src-tauri\/Cargo\.toml version \(next\) is not valid semver/,
  );
});

test("reads the source-less polakapi Cargo.lock entry instead of a registry package", () => {
  const contents = files({ lockVersion: "0.11.7" });
  contents["src-tauri/Cargo.lock"] = `[[package]]
name = "polakapi"
version = "9.9.9"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "polakapi"
version = "0.11.7"
`;
  const versions = readVersions(readFrom(contents));

  assert.equal(versions["src-tauri/Cargo.lock"], "0.11.7");
});

test("rejects a Cargo.lock file without a polakapi package entry", () => {
  const contents = files();
  contents["src-tauri/Cargo.lock"] = '[[package]]\nname = "another-package"\nversion = "1.0.0"\n';

  assert.throws(() => readVersions(readFrom(contents)), /polakapi package entry/);
});
