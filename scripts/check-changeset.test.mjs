import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { URL } from "node:url";
import { checkChangeset } from "./check-changeset.mjs";

function fixture(t, inherited = false) {
  const cwd = mkdtempSync(join(tmpdir(), "polakapi-changeset-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Changeset Test");
  git("config", "user.email", "changeset-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(
    join(cwd, "package.json"),
    JSON.stringify({ name: "polakapi", version: "0.11.0", private: true }),
  );
  mkdirSync(join(cwd, ".changeset"));
  writeFileSync(
    join(cwd, ".changeset/config.json"),
    readFileSync(new URL("../.changeset/config.json", import.meta.url)),
  );
  if (inherited)
    writeFileSync(
      join(cwd, ".changeset/inherited.md"),
      '---\n"polakapi": patch\n---\n\nExisting change.\n',
    );
  git("add", ".");
  git("commit", "-m", "Base fixture");
  const base = git("rev-parse", "HEAD");
  return {
    cwd,
    base,
    add(name, content) {
      writeFileSync(join(cwd, name), content);
      git("add", name);
    },
  };
}

test("a new patch changeset schedules 0.11.1 for the private desktop app", (t) => {
  const repo = fixture(t);
  repo.add(
    ".changeset/new.md",
    '---\n"polakapi": patch\n---\n\nFollow the latest terminal output.\n',
  );
  assert.equal(checkChangeset(repo.cwd, repo.base).newVersion, "0.11.1");
});

test("missing and empty changesets cannot satisfy the PR gate", (t) => {
  const repo = fixture(t);
  repo.add("README.md", "Documentation change.\n");
  assert.throws(() => checkChangeset(repo.cwd, repo.base));
  repo.add(".changeset/empty.md", "---\n---\n");
  assert.throws(() => checkChangeset(repo.cwd, repo.base), /non-empty changeset/);
});

test("an inherited changeset does not count, even when its note is edited", (t) => {
  const repo = fixture(t, true);
  repo.add("README.md", "New change.\n");
  assert.throws(() => checkChangeset(repo.cwd, repo.base));
  repo.add(".changeset/inherited.md", '---\n"polakapi": patch\n---\n\nEdited old note.\n');
  assert.throws(() => checkChangeset(repo.cwd, repo.base), /non-empty changeset/);
});

test("a bump for an unknown package or an invalid bump type fails", (t) => {
  const repo = fixture(t);
  repo.add(".changeset/new.md", '---\n"unknown": patch\n---\n\nWrong package.\n');
  assert.throws(() => checkChangeset(repo.cwd, repo.base));
  repo.add(".changeset/new.md", '---\n"polakapi": invalid\n---\n\nInvalid bump.\n');
  assert.throws(() => checkChangeset(repo.cwd, repo.base));
});

test("a version bump requires a release note", (t) => {
  const repo = fixture(t);
  repo.add(".changeset/new.md", '---\n"polakapi": patch\n---\n\n');
  assert.throws(() => checkChangeset(repo.cwd, repo.base), /non-empty changeset/);
});
