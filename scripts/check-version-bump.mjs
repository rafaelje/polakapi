import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import semver from "semver";

export const VERSION_PATHS = [
  "package.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
];

function requiredText(read, path) {
  const contents = read(path);
  if (contents === undefined || contents === null) {
    throw new Error(`Unable to read ${path}.`);
  }
  return String(contents);
}

function jsonVersion(contents, path) {
  const version = JSON.parse(contents).version;
  if (typeof version !== "string" || version.length === 0) {
    throw new Error(`${path} does not contain a version.`);
  }
  return version;
}

function tomlTable(contents, header, path) {
  const lines = contents.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start < 0) throw new Error(`${path} does not contain ${header}.`);

  const table = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().startsWith("[")) break;
    table.push(line);
  }
  return table;
}

function tomlString(table, key) {
  const pattern = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']\\s*(?:#.*)?$`);
  for (const line of table) {
    const match = line.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function cargoTomlVersion(contents) {
  const path = "src-tauri/Cargo.toml";
  const version = tomlString(tomlTable(contents, "[package]", path), "version");
  if (!version) throw new Error(`${path} [package] does not contain a version.`);
  return version;
}

function cargoLockVersion(contents) {
  const path = "src-tauri/Cargo.lock";
  const lines = contents.split(/\r?\n/);
  const workspacePackages = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "[[package]]") continue;
    const table = [];
    for (index += 1; index < lines.length && !lines[index].trim().startsWith("["); index += 1) {
      table.push(lines[index]);
    }
    index -= 1;
    if (tomlString(table, "name") === "polakapi" && !tomlString(table, "source")) {
      workspacePackages.push(table);
    }
  }

  if (workspacePackages.length !== 1) {
    throw new Error(`${path} must contain exactly one source-less polakapi package entry.`);
  }
  const version = tomlString(workspacePackages[0], "version");
  if (!version) throw new Error(`${path} polakapi package entry does not contain a version.`);
  return version;
}

export function readVersions(read) {
  return {
    "package.json": jsonVersion(requiredText(read, "package.json"), "package.json"),
    "src-tauri/tauri.conf.json": jsonVersion(
      requiredText(read, "src-tauri/tauri.conf.json"),
      "src-tauri/tauri.conf.json",
    ),
    "src-tauri/Cargo.toml": cargoTomlVersion(requiredText(read, "src-tauri/Cargo.toml")),
    "src-tauri/Cargo.lock": cargoLockVersion(requiredText(read, "src-tauri/Cargo.lock")),
  };
}

export function validateVersionBump(base, current) {
  for (const path of VERSION_PATHS) {
    const baseVersion = base[path];
    const currentVersion = current[path];
    if (!semver.valid(baseVersion)) {
      throw new Error(`${path} PR base version (${baseVersion}) is not valid semver.`);
    }
    if (!semver.valid(currentVersion)) {
      throw new Error(`${path} version (${currentVersion}) is not valid semver.`);
    }
    if (!semver.gt(currentVersion, baseVersion)) {
      throw new Error(
        `${path} version (${currentVersion}) must be greater than the PR base (${baseVersion}).`,
      );
    }
  }

  const packageVersion = current["package.json"];
  const mismatches = VERSION_PATHS.filter((path) => current[path] !== packageVersion);
  if (mismatches.length > 0) {
    throw new Error(
      `Current versions must match package.json (${packageVersion}); mismatched: ${mismatches.join(", ")}.`,
    );
  }
}

export function checkVersionBump(baseSha) {
  if (!baseSha) throw new Error("BASE_SHA is required.");
  const base = readVersions((path) =>
    execFileSync("git", ["show", `${baseSha}:${path}`], { encoding: "utf8" }),
  );
  const current = readVersions((path) => readFileSync(path, "utf8"));
  validateVersionBump(base, current);
  return { base, current };
}

function main() {
  try {
    const { base, current } = checkVersionBump(process.env.BASE_SHA);
    console.log(
      `Desktop versions: ${base["package.json"]} → ${current["package.json"]} (${VERSION_PATHS.join(", ")})`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
