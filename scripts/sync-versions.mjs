import console from "node:console";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

function replaceVersion(text, pattern, version, file) {
  const match = pattern.exec(text);
  if (!match) throw new Error(`Cannot locate the polakapi version in ${file}.`);
  return text.replace(pattern, `${match[1]}${version}${match[3]}`);
}

export function syncVersions(cwd = process.cwd(), check = false) {
  const version = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).version;
  if (!/^\d+\.\d+\.\d+(?:-[\da-zA-Z.-]+)?$/.test(version)) {
    throw new Error("package.json must contain a valid release version.");
  }
  const tauriPath = "src-tauri/tauri.conf.json";
  const tauriText = readFileSync(join(cwd, tauriPath), "utf8");
  const tauri = JSON.parse(tauriText);
  const manifestPath = "src-tauri/Cargo.toml";
  const manifestText = readFileSync(join(cwd, manifestPath), "utf8");
  const lockPath = "src-tauri/Cargo.lock";
  const lockText = readFileSync(join(cwd, lockPath), "utf8");
  const updates = [
    [
      tauriPath,
      tauriText,
      tauri.version === version ? tauriText : `${JSON.stringify({ ...tauri, version }, null, 2)}\n`,
    ],
    [
      manifestPath,
      manifestText,
      replaceVersion(
        manifestText,
        /(\[package\][^[]*?\nversion\s*=\s*")([^"]+)(")/,
        version,
        manifestPath,
      ),
    ],
    [
      lockPath,
      lockText,
      replaceVersion(
        lockText,
        /(\[\[package\]\]\r?\nname = "polakapi"\r?\nversion = ")([^"]+)(")/,
        version,
        lockPath,
      ),
    ],
  ];
  const changed = updates.filter(([, before, after]) => before !== after);
  if (check && changed.length > 0) {
    throw new Error(
      `Versions must match package.json (${version}): ${changed.map(([file]) => file).join(", ")}. Run node scripts/sync-versions.mjs.`,
    );
  }
  if (!check) {
    for (const [file, , content] of changed) writeFileSync(join(cwd, file), content);
  }
  return version;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      `Desktop versions match ${syncVersions(process.cwd(), process.argv.includes("--check"))}.`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
