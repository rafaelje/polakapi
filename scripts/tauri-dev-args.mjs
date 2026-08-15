export function buildTauriArgs(argv, rawPort) {
  const [subcommand, ...rest] = argv;
  const args = subcommand === undefined ? [] : [subcommand, ...rest];

  if (subcommand !== "dev") {
    return { args };
  }

  const port = rawPort ?? "1420";
  const numericPort = Number(port);

  if (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535) {
    throw new Error(`invalid TAURI_DEV_PORT: ${port}`);
  }

  const devPort = String(numericPort);
  const separatorIndex = args.indexOf("--");
  const insertAt = separatorIndex === -1 ? args.length : separatorIndex;
  args.splice(
    insertAt,
    0,
    "--config",
    JSON.stringify({ build: { devUrl: `http://localhost:${devPort}` } }),
  );

  return { args, devPort };
}

export function childExitCode(code) {
  return code ?? 1;
}
