import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  symlink,
  writeFile,
  chmod,
  lstat,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile as execFileCallback } from "node:child_process";
import { URL } from "node:url";
import test from "node:test";

const execFile = promisify(execFileCallback);
const installer = path.resolve("scripts/install.sh");
const testOnPosix = (name, fn) => test(name, { skip: process.platform === "win32" }, fn);
let scratch;
const scratchPaths = [];
let server;
let source;
let records;

async function startSource(version = "1.2.3", appText = "#!/bin/sh\necho polakapi\n") {
  if (server) await new Promise((resolve) => server.close(resolve));
  const packageName = `polakapi-${version}-linux-x64.AppImage`;
  const macName = `polakapi-${version}-macos-universal.dmg`;
  const windowsName = `polakapi-${version}-windows-x64.exe`;
  const powershellText = "Write-Output 'fake Windows installer'\n";
  const digest = (contents) => createHash("sha256").update(contents).digest("hex");
  records = new Map([
    ["release-version.txt", `${version}\n`],
    [packageName, appText],
    [macName, "fixture dmg"],
    [windowsName, "fixture nsis"],
    ["install.ps1", powershellText],
    [
      "manifest.tsv",
      `version\tplatform\tarch\tfile\tsha256\n${version}\tmacos\tuniversal\t${macName}\t${digest("fixture dmg")}\n${version}\tlinux\tx64\t${packageName}\t${digest(appText)}\n${version}\twindows\tx64\t${windowsName}\t${digest("fixture nsis")}\n${version}\twindows\tany\tinstall.ps1\t${digest(powershellText)}\n`,
    ],
  ]);
  server = createServer((request, response) => {
    const body = records.get(
      decodeURIComponent(new URL(request.url, "http://localhost").pathname.slice(1)),
    );
    if (body === undefined) {
      response.writeHead(404).end("missing");
      return;
    }
    response.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  source = `http://127.0.0.1:${server.address().port}`;
  return packageName;
}

async function run(args, extraEnv = {}, script = installer) {
  try {
    const result = await execFile("/bin/sh", [script, ...args], {
      env: {
        ...process.env,
        HOME: path.join(scratch, "home"),
        XDG_DATA_HOME: path.join(scratch, "data"),
        XDG_BIN_HOME: path.join(scratch, "bin"),
        PATH: `${path.join(scratch, "test-bin")}:${process.env.PATH}`,
        ...extraEnv,
      },
      timeout: 15000,
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

test.beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "polakapi-installer-"));
  scratchPaths.push(scratch);
  const testBin = path.join(scratch, "test-bin");
  await mkdir(testBin, { recursive: true });
  await writeFile(
    path.join(testBin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; *) exit 1;; esac\n',
  );
  await writeFile(path.join(testBin, "pgrep"), "#!/bin/sh\nexit 1\n");
  await writeFile(
    path.join(testBin, "ldconfig"),
    "#!/bin/sh\necho 'libfuse.so.2 (libc6,x86-64) => /lib/libfuse.so.2'\n",
  );
  await chmod(path.join(testBin, "uname"), 0o755);
  await chmod(path.join(testBin, "pgrep"), 0o755);
  await chmod(path.join(testBin, "ldconfig"), 0o755);
});

test.afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  server = undefined;
});

test.after(() =>
  console.log(`Installer test scratch (parent cleanup required): ${scratchPaths.join(", ")}`),
);

testOnPosix("help is available without downloads or filesystem changes", async () => {
  const result = await run(["--help"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /--source URL/);
  assert.deepEqual(
    await (await import("node:fs/promises")).readdir(path.join(scratch, "home")).catch(() => []),
    [],
  );
});

testOnPosix("accepts full platform manifests and installs Linux AppImage", async () => {
  const packageName = await startSource();
  const target = path.join(scratch, 'installed $`% "app');
  const result = await run(["--source", source, "--version", "1.2.3", "--install-dir", target]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), /echo polakapi/);
  assert.match(
    await readFile(path.join(scratch, "data", "applications", "polakapi.desktop"), "utf8"),
    /Exec=.*polakapi\.AppImage/,
  );
  const desktop = await readFile(
    path.join(scratch, "data", "applications", "polakapi.desktop"),
    "utf8",
  );
  assert.ok(desktop.includes("\\$"));
  assert.ok(desktop.includes("\\`"));
  assert.ok(desktop.includes("%%"));
  assert.ok(desktop.includes('\\"app'));
  assert.match(result.stdout, /Installed polakapi 1\.2\.3/);
  assert.equal(packageName, "polakapi-1.2.3-linux-x64.AppImage");
});

testOnPosix(
  "same-version reinstall and upgrade replace the application through public commands",
  async () => {
    const target = path.join(scratch, "installed app");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "user-data.txt"), "keep this\n");
    await startSource("1.2.3", "#!/bin/sh\necho first\n");
    assert.equal((await run(["--source", source, "--install-dir", target])).code, 0);
    await startSource("1.2.3", "#!/bin/sh\necho reinstalled\n");
    assert.equal((await run(["--source", source, "--install-dir", target])).code, 0);
    assert.match(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), /reinstalled/);
    await startSource("1.3.0", "#!/bin/sh\necho upgraded\n");
    assert.equal((await run(["--source", source, "--install-dir", target])).code, 0);
    assert.match(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), /upgraded/);
    assert.equal(await readFile(path.join(target, "user-data.txt"), "utf8"), "keep this\n");
    assert.match(
      await readFile(path.join(scratch, "data", "applications", "polakapi.desktop"), "utf8"),
      /Exec=".*installed app.*polakapi\.AppImage"/,
    );
  },
);

testOnPosix(
  "failed staged activation restores the prior AppImage and removes its stage",
  async () => {
    const target = path.join(scratch, "installed");
    const bin = path.join(scratch, "failure-bin");
    await mkdir(target, { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(target, "polakapi.AppImage"), "preserve old\n");
    await writeFile(
      path.join(bin, "mv"),
      '#!/bin/sh\ncase "$1" in */.polakapi-stage.*/polakapi.AppImage) exit 1;; esac\nexec /bin/mv "$@"\n',
    );
    await chmod(path.join(bin, "mv"), 0o755);
    await startSource();
    const result = await run(["--source", source, "--install-dir", target], {
      PATH: `${bin}:${path.join(scratch, "test-bin")}:${process.env.PATH}`,
    });
    assert.notEqual(result.code, 0);
    assert.equal(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), "preserve old\n");
    assert.deepEqual(await readdir(target), ["polakapi.AppImage"]);
  },
);

testOnPosix("refuses a directory-following AppImage symlink before replacement", async () => {
  const target = path.join(scratch, "installed");
  const nested = path.join(scratch, "user-data");
  await mkdir(target, { recursive: true });
  await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "keep.txt"), "untouched\n");
  await symlink(nested, path.join(target, "polakapi.AppImage"));
  await startSource();
  const result = await run(["--source", source, "--install-dir", target]);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /refusing to replace a directory/);
  assert.equal(await readFile(path.join(nested, "keep.txt"), "utf8"), "untouched\n");
});

testOnPosix(
  "checksum mismatch and download failure preserve an existing installation",
  async () => {
    const target = path.join(scratch, "installed");
    await startSource("1.2.3");
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "polakapi.AppImage"), "existing version\n");
    await startSource("1.3.0");
    records.set(
      "manifest.tsv",
      records
        .get("manifest.tsv")
        .replace(/(linux\tx64\t[^\t]+\t)[a-f0-9]{64}/, `$1${"0".repeat(64)}`),
    );
    const badChecksum = await run(["--source", source, "--install-dir", target]);
    assert.notEqual(badChecksum.code, 0);
    assert.equal(
      await readFile(path.join(target, "polakapi.AppImage"), "utf8"),
      "existing version\n",
    );

    records.delete("manifest.tsv");
    const missingManifest = await run(["--source", source, "--install-dir", target]);
    assert.notEqual(missingManifest.code, 0);
    assert.equal(
      await readFile(path.join(target, "polakapi.AppImage"), "utf8"),
      "existing version\n",
    );

    const packageName = await startSource("1.4.0");
    records.set(
      "manifest.tsv",
      records.get("manifest.tsv").replace(packageName, "../polakapi.AppImage"),
    );
    const unsafeManifest = await run(["--source", source, "--install-dir", target]);
    assert.notEqual(unsafeManifest.code, 0);
    assert.equal(
      await readFile(path.join(target, "polakapi.AppImage"), "utf8"),
      "existing version\n",
    );
  },
);

testOnPosix("refuses to replace a running installation", async () => {
  const bin = path.join(scratch, "running-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "pgrep"), "#!/bin/sh\nexit 0\n");
  await chmod(path.join(bin, "pgrep"), 0o755);
  const target = path.join(scratch, "installed");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "polakapi.AppImage"), "keep me\n");
  await startSource();
  const result = await run(["--source", source, "--install-dir", target], {
    PATH: `${bin}:${path.join(scratch, "test-bin")}:${process.env.PATH}`,
  });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /is running/);
  assert.equal(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), "keep me\n");
});

testOnPosix("macOS running-process guard matches only the selected install path", async () => {
  const target = path.join(scratch, "Applications");
  const bin = path.join(scratch, "mac-bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    path.join(bin, "uname"),
    '#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n',
  );
  await writeFile(
    path.join(bin, "pgrep"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${path.join(scratch, "pgrep-args.txt")}'\n[ "$2" = '/polakapi\\.app/' ] && exit 0\nexit 1\n`,
  );
  await writeFile(
    path.join(bin, "hdiutil"),
    `#!/bin/sh\nif [ "$1" = attach ]; then while [ "$#" -gt 0 ]; do if [ "$1" = -mountpoint ]; then shift; mkdir -p "$1/polakapi.app"; break; fi; shift; done; fi\nexit 0\n`,
  );
  await writeFile(path.join(bin, "codesign"), "#!/bin/sh\nexit 0\n");
  await writeFile(path.join(bin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n');
  await Promise.all(
    ["uname", "pgrep", "hdiutil", "codesign", "ditto"].map((name) =>
      chmod(path.join(bin, name), 0o755),
    ),
  );
  await startSource();
  const result = await run(["--source", source, "--version", "1.2.3", "--install-dir", target], {
    PATH: `${bin}:${path.join(scratch, "test-bin")}:${process.env.PATH}`,
  });
  assert.equal(result.code, 0, result.stderr);
  const pgrepArgs = await readFile(path.join(scratch, "pgrep-args.txt"), "utf8");
  assert.match(pgrepArgs, /Applications\/polakapi\\\.app\/Contents\/MacOS\/polakapi/);
  const repeated = await run(["--source", source, "--version", "1.2.3", "--install-dir", target], {
    PATH: `${bin}:${path.join(scratch, "test-bin")}:${process.env.PATH}`,
  });
  assert.equal(repeated.code, 0, repeated.stderr);
});

testOnPosix("rejects source control characters before downloads or installation", async () => {
  const target = path.join(scratch, "must-not-exist");
  for (const source of [
    "https://example.com/release\nhttps://evil.example",
    "https://example.com/release\n",
    "https://example.com/release\r\nX-Injected: yes",
    "https://example.com/release\t",
    "https://example.com/release\x01",
  ]) {
    const result = await run(["--source", source, "--install-dir", target]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /source must be HTTPS or explicit loopback HTTP/);
    await assert.rejects(lstat(target), { code: "ENOENT" });
  }
});

testOnPosix(
  "rejects malformed arguments, unsafe sources, and unsupported architectures before mutation",
  async () => {
    for (const args of [
      ["--unknown"],
      ["--version"],
      ["--source", "http://example.com/release"],
      ["--version", "1.2"],
      ["--source", "http://127.0.0.1:80@evil.example/release"],
      ["--source", "http://127.0.0.1@evil.example/release"],
      ["--source", "https://example.com/release?redirect=http://evil.example"],
      ["--source", "https://example.com/release#fragment"],
      ["--source", "https://example.com/release\nhttps://evil.example"],
      ["--source", "https://example.com/release\r\nX-Injected: yes"],
    ]) {
      const result = await run(args);
      assert.notEqual(result.code, 0, args.join(" "));
    }
    await writeFile(
      path.join(scratch, "test-bin", "uname"),
      '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo mips;; *) exit 1;; esac\n',
    );
    const result = await run(
      ["--source", "https://example.com", "--install-dir", path.join(scratch, "unused")],
      {
        PATH: `${path.join(scratch, "test-bin")}:${process.env.PATH}`,
      },
    );
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /architecture/i);
    assert.equal(
      await (await import("node:fs/promises"))
        .readdir(scratch)
        .then((items) => items.includes("unused")),
      false,
    );
  },
);

async function createGitBashStubs() {
  const bin = path.join(scratch, "bin");
  await mkdir(bin, { recursive: true });
  const log = path.join(scratch, "powershell-args.txt");
  await writeFile(path.join(bin, "uname"), "#!/bin/sh\necho MINGW64_NT-10.0\n");
  await writeFile(path.join(bin, "cygpath"), "#!/bin/sh\nprintf '%s' \"$2\"\n");
  await writeFile(
    path.join(bin, "powershell.exe"),
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\nexit 0\n`,
  );
  await Promise.all(
    ["uname", "cygpath", "powershell.exe"].map((name) => chmod(path.join(bin, name), 0o755)),
  );
  const gitBashDir = path.join(scratch, "gitbash");
  await mkdir(gitBashDir, { recursive: true });
  const script = path.join(gitBashDir, "install.sh");
  await copyFile(installer, script);
  await chmod(script, 0o755);
  return { bin, log, script };
}

testOnPosix("Git Bash verifies the downloaded PowerShell script before delegation", async () => {
  const { bin, log, script } = await createGitBashStubs();
  await startSource();
  const result = await run(
    ["--source", source, "--version", "1.2.3"],
    {
      PATH: `${bin}:${process.env.PATH}`,
    },
    script,
  );
  assert.equal(result.code, 0, result.stderr);
  const args = await readFile(log, "utf8");
  const argv = args.trimEnd().split("\n");
  assert.deepEqual(argv.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File"]);
  assert.match(argv[4], /install\.ps1$/);
  assert.deepEqual(argv.slice(5), ["-Source", source, "-Version", "1.2.3"]);
  assert.doesNotMatch(args, /Bypass|Unrestricted|Set-ExecutionPolicy/i);
});

testOnPosix("Git Bash never invokes a checksum-corrupted PowerShell script", async () => {
  const { bin, log, script } = await createGitBashStubs();
  await startSource();
  records.set(
    "manifest.tsv",
    records
      .get("manifest.tsv")
      .replace(/(windows\tany\tinstall\.ps1\t)[a-f0-9]{64}/, `$1${"0".repeat(64)}`),
  );
  const result = await run(
    ["--source", source, "--version", "1.2.3"],
    {
      PATH: `${bin}:${process.env.PATH}`,
    },
    script,
  );
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /checksum verification failed/);
  await assert.rejects(readFile(log, "utf8"), { code: "ENOENT" });
});

testOnPosix("Malformed manifests preserve existing installation bytes", async () => {
  const target = path.join(scratch, "existing");
  await mkdir(target);
  await writeFile(path.join(target, "polakapi.AppImage"), "old executable");
  await writeFile(path.join(target, "workspace.json"), '{"preserve":true}');
  await startSource();
  const valid = records.get("manifest.tsv");
  for (const invalid of [
    valid + valid.split("\n")[2] + "\n",
    valid.replace("polakapi-1.2.3-linux-x64.AppImage", "../polakapi.AppImage"),
    valid.replace("1.2.3\tlinux", "1.2.4\tlinux"),
    valid.replace("version\tplatform", "bad\tplatform"),
  ]) {
    records.set("manifest.tsv", invalid);
    const result = await run(["--source", source, "--install-dir", target]);
    assert.notEqual(result.code, 0, result.stdout);
    assert.deepEqual(await readdir(target), ["polakapi.AppImage", "workspace.json"]);
    assert.equal(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), "old executable");
    assert.equal(await readFile(path.join(target, "workspace.json"), "utf8"), '{"preserve":true}');
  }
});

testOnPosix("Redirect rejection leaves persisted bytes unchanged", async () => {
  const target = path.join(scratch, "existing");
  await mkdir(target);
  await writeFile(path.join(target, "polakapi.AppImage"), "old executable");
  let hits = 0;
  server = createServer((req, res) => {
    if (req.url === "/release-version.txt") res.end("1.2.3\n");
    else if (req.url === "/manifest.tsv")
      res.writeHead(302, { Location: `${source}/destination` }).end();
    else {
      hits++;
      res.end("unexpected");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  source = `http://127.0.0.1:${server.address().port}`;
  const result = await run(["--source", source, "--install-dir", target]);
  assert.notEqual(result.code, 0);
  assert.equal(hits, 0);
  assert.equal(await readFile(path.join(target, "polakapi.AppImage"), "utf8"), "old executable");
});

testOnPosix("Git Bash forwards installation paths with spaces under RemoteSigned", async () => {
  const { bin, log, script } = await createGitBashStubs();
  await startSource();
  const target = path.join(scratch, "Installed Apps");
  const result = await run(
    ["--source", source, "--version", "1.2.3", "--install-dir", target],
    { PATH: `${bin}:${process.env.PATH}` },
    script,
  );
  assert.equal(result.code, 0, result.stderr);
  const argv = (await readFile(log, "utf8")).trimEnd().split("\n");
  assert.deepEqual(argv.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "RemoteSigned", "-File"]);
  assert.deepEqual(argv.slice(5), ["-Source", source, "-Version", "1.2.3", "-InstallDir", target]);
});
