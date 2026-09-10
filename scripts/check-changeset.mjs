import { execFileSync } from "node:child_process";
import console from "node:console";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export function validateChangesetPlan(plan, packageName) {
  const bumpTypes = new Set(["patch", "minor", "major"]);
  const changesets = plan.changesets.filter((changeset) =>
    changeset.releases.some(
      (release) => release.name === packageName && bumpTypes.has(release.type),
    ),
  );
  if (changesets.length === 0 || changesets.some((changeset) => !changeset.summary.trim())) {
    throw new Error(
      `Add a non-empty changeset declaring a patch, minor, or major bump for ${packageName}.`,
    );
  }
  const release = plan.releases.find((entry) => entry.name === packageName);
  if (!release || !bumpTypes.has(release.type) || release.newVersion === release.oldVersion) {
    throw new Error(`The changeset must produce a version bump for ${packageName}.`);
  }
  return release;
}

export function checkChangeset(
  cwd = process.cwd(),
  baseRef = process.env.CHANGESET_BASE_REF ?? "origin/main",
) {
  const temp = mkdtempSync(join(tmpdir(), "polakapi-changeset-"));
  try {
    const output = join(temp, "status.json");
    const cli = fileURLToPath(import.meta.resolve("@changesets/cli/bin.js"));
    execFileSync(process.execPath, [cli, "status", "--since", baseRef, "--output", output], {
      cwd,
      stdio: "pipe",
    });
    const packageName = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")).name;
    const base = execFileSync("git", ["merge-base", baseRef, "HEAD"], {
      cwd,
      encoding: "utf8",
    }).trim();
    const added = new Set(
      execFileSync("git", ["diff", "--name-only", "--diff-filter=A", base, "--", ".changeset"], {
        cwd,
        encoding: "utf8",
      })
        .trim()
        .split("\n"),
    );
    const plan = JSON.parse(readFileSync(output, "utf8"));
    plan.changesets = plan.changesets.filter((entry) => added.has(`.changeset/${entry.id}.md`));
    const release = validateChangesetPlan(plan, packageName);
    console.log(`${release.name}: ${release.oldVersion} → ${release.newVersion} (${release.type})`);
    return release;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkChangeset();
  } catch (error) {
    console.error(error.message);
    console.error(
      "Run pnpm changeset, stage the new .changeset/*.md file, then rerun pnpm changeset:check.",
    );
    process.exitCode = 1;
  }
}
