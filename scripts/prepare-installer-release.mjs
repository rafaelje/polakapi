import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, URL } from "node:url";

async function main() {
  const { values } = parseArgs({
    options: {
      assets: { type: "string" },
      output: { type: "string" },
      version: { type: "string" },
      "allow-partial": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/prepare-installer-release.mjs --assets DIR --output NEW_DIR --version X.Y.Z [--allow-partial]\nPrepare immutable release assets and checksums. --allow-partial is for local platform testing only.",
    );
    return;
  }
  if (!values.assets || !values.output || !/^\d+\.\d+\.\d+$/.test(values.version ?? "")) {
    throw new Error("Expected --assets, --output and a numeric --version X.Y.Z");
  }
  const assets = resolve(values.assets);
  const output = resolve(values.output);
  const files = [];
  const rows = [];
  const targets = new Set();
  for (const file of (await readdir(assets)).sort()) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file)) throw new Error(`Unsafe asset name: ${file}`);
    const path = join(assets, file);
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error(`Asset must be a regular file: ${file}`);
    if (stat.size === 0) throw new Error(`Empty asset: ${file}`);
    if (!file.startsWith(`polakapi_${values.version}_`))
      throw new Error(`Asset version does not match: ${file}`);
    let target;
    if (file.endsWith("_universal.dmg")) target = ["macos", "universal"];
    else if (file.endsWith("_aarch64.dmg")) target = ["macos", "arm64"];
    else if (file.endsWith("_x64.dmg")) target = ["macos", "x64"];
    else if (file.endsWith("_amd64.AppImage")) target = ["linux", "x64"];
    else if (file.endsWith("_x64-setup.exe")) target = ["windows", "x64"];
    else if (!file.endsWith("_amd64.deb")) throw new Error(`Unsupported asset: ${file}`);
    if (target) {
      const key = target.join("/");
      if (targets.has(key)) throw new Error(`Duplicate platform/architecture: ${key}`);
      targets.add(key);
      rows.push([values.version, ...target, file, await hash(path)]);
    }
    files.push(path);
  }
  if (targets.size === 0) throw new Error("No installable packages found");
  if (!values["allow-partial"]) {
    for (const target of ["macos/universal", "linux/x64", "windows/x64"]) {
      if (!targets.has(target)) throw new Error(`Missing release package: ${target}`);
    }
  }
  for (const name of ["install.sh", "install.ps1"]) {
    const path = fileURLToPath(new URL(name, import.meta.url));
    const checksum = await hash(path);
    files.push(path);
    if (name === "install.ps1") rows.push([values.version, "windows", "any", name, checksum]);
  }
  await mkdir(output);
  for (const path of files) await copyFile(path, join(output, basename(path)));
  await writeFile(
    join(output, "manifest.tsv"),
    "version\tplatform\tarch\tfile\tsha256\n" + rows.map((row) => row.join("\t")).join("\n") + "\n",
  );
  await writeFile(join(output, "release-version.txt"), values.version + "\n");
  const sums = [];
  for (const name of (await readdir(output)).sort())
    sums.push(`${await hash(join(output, name))}  ${name}`);
  await writeFile(join(output, "SHA256SUMS"), sums.join("\n") + "\n");
  console.log(`Prepared ${targets.size} package targets in ${output}`);
}

async function hash(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

main().catch((error) => {
  console.error(`Release preparation failed: ${error.message}`);
  process.exitCode = 1;
});
