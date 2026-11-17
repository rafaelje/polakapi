import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import test from "node:test";

const isWindows = process.platform === "win32";
const scriptPath = fileURLToPath(new URL("./install.ps1", import.meta.url));
const powershell = process.env.POWERSHELL ?? "powershell.exe";

function runInstaller(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ["-NoProfile", "-File", scriptPath, ...args], {
      cwd,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

async function withReleaseServer(t, files) {
  const server = createServer((request, response) => {
    const name = new URL(request.url, "http://127.0.0.1").pathname.slice(1);
    const data = files.get(name);
    if (!data) {
      response.writeHead(404).end("not found");
      return;
    }
    if (data.redirect) {
      response.writeHead(302, { Location: data.redirect }).end();
      return;
    }
    response.writeHead(200).end(data);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function makeRelease(
  t,
  {
    payload = Buffer.from("not a real NSIS executable"),
    manifestVersion = "1.2.3",
    expectedHash,
    manifestOverride,
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "polakapi-windows-installer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hash = expectedHash ?? createHash("sha256").update(payload).digest("hex");
  const installerScript = await readFile(scriptPath);
  const installerScriptHash = createHash("sha256").update(installerScript).digest("hex");
  const manifest =
    manifestOverride ??
    [
      "version\tplatform\tarch\tfile\tsha256",
      `${manifestVersion}\twindows\tx64\tpolakapi-setup.exe\t${hash}`,
      `${manifestVersion}\twindows\tany\tinstall.ps1\t${installerScriptHash}`,
    ].join("\n") + "\n";
  const files = new Map([
    ["manifest.tsv", Buffer.from(manifest)],
    ["release-version.txt", Buffer.from(`${manifestVersion}\n`)],
    ["polakapi-setup.exe", payload],
    ["install.ps1", installerScript],
  ]);
  const source = await withReleaseServer(t, files);
  return { root, source, files };
}

test(
  "prints help through the public command",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "polakapi-windows-help-"));
    t.after(() => rm(root, { recursive: true, force: true }));

    const result = await runInstaller(["-Help"], root);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage: install\.ps1/i);
  },
);

test(
  "rejects unknown arguments before creating the requested install directory",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "polakapi-windows-args-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const installDir = path.join(root, "must-not-exist");

    const result = await runInstaller(["-UnknownOption", "value", "-InstallDir", installDir], root);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /UnknownOption/i);
    await assert.rejects(readFile(installDir));
  },
);

test(
  "rejects a corrupted release checksum without changing existing installation state",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const { root, source } = await makeRelease(t, { expectedHash: "0".repeat(64) });
    const installDir = path.join(root, "installed");
    await mkdir(installDir);
    await writeFile(path.join(installDir, "user-data.txt"), "preserve me");

    const result = await runInstaller(
      ["-Source", source, "-Version", "1.2.3", "-InstallDir", installDir],
      root,
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /checksum verification failed/i);
    assert.equal(await readFile(path.join(installDir, "user-data.txt"), "utf8"), "preserve me");
    assert.deepEqual(await readdir(installDir), ["user-data.txt"]);
  },
);

test(
  "rejects a malformed manifest without changing existing installation state",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const { root, source } = await makeRelease(t, {
      manifestOverride:
        "version\tplatform\tarch\tfile\tsha256\n1.2.3\twindows\tx64\tinstaller.exe\tnot-a-hash\n",
    });
    const installDir = path.join(root, "installed");
    await mkdir(installDir);
    await writeFile(path.join(installDir, "user-data.txt"), "preserve me");

    const result = await runInstaller(["-Source", source, "-InstallDir", installDir], root);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /invalid SHA-256/i);
    assert.deepEqual(await readdir(installDir), ["user-data.txt"]);
    assert.equal(await readFile(path.join(installDir, "user-data.txt"), "utf8"), "preserve me");
  },
);

test(
  "rejects a requested version that conflicts with the release manifest before install",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const { root, source } = await makeRelease(t);
    const installDir = path.join(root, "must-not-exist");

    const result = await runInstaller(
      ["-Source", source, "-Version", "9.9.9", "-InstallDir", installDir],
      root,
    );

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /Requested version does not match/i);
    await assert.rejects(readFile(installDir));
  },
);

test(
  "rejects an insecure redirect before requesting its destination",
  { skip: !isWindows && "PowerShell tests require native Windows" },
  async (t) => {
    const { root, source, files } = await makeRelease(t);
    files.set("manifest.tsv", { redirect: "http://example.invalid/manifest.tsv" });
    const installDir = path.join(root, "must-not-exist");

    const result = await runInstaller(["-Source", source, "-InstallDir", installDir], root);

    assert.notEqual(result.status, 0);
    assert.match(`${result.stderr}\n${result.stdout}`, /redirects must use HTTPS/i);
    await assert.rejects(readFile(installDir));
  },
);
