import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

const command = new URL("./prepare-installer-release.mjs", import.meta.url);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "polakapi-release-test-"));
  console.log(`Scratch: ${root}`);
  const assets = join(root, "assets");
  await mkdir(assets);
  await writeFile(join(assets, "polakapi_0.20.1_universal.dmg"), "abc");
  await writeFile(join(assets, "polakapi_0.20.1_amd64.AppImage"), "abc");
  await writeFile(join(assets, "polakapi_0.20.1_x64-setup.exe"), "abc");
  return { root, assets, output: join(root, "prepared") };
}

function run(f, extra = []) {
  return spawnSync(
    process.execPath,
    [
      fileURLToPath(command),
      "--assets",
      f.assets,
      "--output",
      f.output,
      "--version",
      "0.20.1",
      ...extra,
    ],
    { encoding: "utf8" },
  );
}

test("prepares a complete, version-pinned installer release with checksums", async () => {
  const f = await fixture();
  const result = run(f);
  assert.equal(result.status, 0, result.stderr);
  const manifest = await readFile(join(f.output, "manifest.tsv"), "utf8");
  assert.ok(manifest.startsWith("version\tplatform\tarch\tfile\tsha256\n"));
  assert.ok(
    manifest.includes(
      "0.20.1\tmacos\tuniversal\tpolakapi_0.20.1_universal.dmg\tba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n",
    ),
  );
  assert.ok(manifest.includes("0.20.1\tlinux\tx64\t"));
  assert.ok(manifest.includes("0.20.1\twindows\tx64\t"));
  assert.ok(manifest.includes("0.20.1\twindows\tany\tinstall.ps1\t"));
  assert.equal(await readFile(join(f.output, "release-version.txt"), "utf8"), "0.20.1\n");
  assert.ok((await readdir(f.output)).includes("install.sh"));
});

test("refuses empty packages before creating a release directory", async () => {
  const f = await fixture();
  await writeFile(join(f.assets, "polakapi_0.20.1_universal.dmg"), "");
  const result = run(f);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /empty/i);
  assert.ok(!(await readdir(f.root)).includes("prepared"));
});

test("does not overwrite existing release bytes", async () => {
  const f = await fixture();
  assert.equal(run(f).status, 0);
  const previous = await readFile(join(f.output, "manifest.tsv"));
  await writeFile(join(f.assets, "polakapi_0.20.1_universal.dmg"), "changed");
  assert.notEqual(run(f).status, 0);
  assert.deepEqual(await readFile(join(f.output, "manifest.tsv")), previous);
  assert.equal(await readFile(join(f.output, "polakapi_0.20.1_universal.dmg"), "utf8"), "abc");
});

test("requires complete releases unless local partial preparation is explicit", async () => {
  const f = await fixture();
  await unlink(join(f.assets, "polakapi_0.20.1_amd64.AppImage"));
  await unlink(join(f.assets, "polakapi_0.20.1_x64-setup.exe"));
  assert.match(run(f).stderr, /Missing release package/);
  assert.ok(!(await readdir(f.root)).includes("prepared"));
  const result = run(f, ["--allow-partial"]);
  assert.equal(result.status, 0, result.stderr);
});

test("rejects unknown arguments without creating output", async () => {
  const f = await fixture();
  const result = run(f, ["--force"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown option/);
  assert.ok(!(await readdir(f.root)).includes("prepared"));
});
