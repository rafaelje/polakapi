import { splitPath } from "../file-path";

export interface FileLanguage {
  fence: string;
  highlight: string | null;
}

const BY_EXTENSION: Readonly<Record<string, FileLanguage>> = {
  ts: { fence: "ts", highlight: "typescript" },
  tsx: { fence: "tsx", highlight: "typescript" },
  mts: { fence: "ts", highlight: "typescript" },
  cts: { fence: "ts", highlight: "typescript" },
  js: { fence: "js", highlight: "javascript" },
  jsx: { fence: "jsx", highlight: "javascript" },
  mjs: { fence: "js", highlight: "javascript" },
  cjs: { fence: "js", highlight: "javascript" },
  json: { fence: "json", highlight: "json" },
  jsonc: { fence: "jsonc", highlight: "json" },
  rs: { fence: "rust", highlight: "rust" },
  css: { fence: "css", highlight: "css" },
  scss: { fence: "scss", highlight: "scss" },
  html: { fence: "html", highlight: "xml" },
  htm: { fence: "html", highlight: "xml" },
  xml: { fence: "xml", highlight: "xml" },
  svg: { fence: "svg", highlight: "xml" },
  vue: { fence: "vue", highlight: "xml" },
  md: { fence: "md", highlight: "markdown" },
  markdown: { fence: "md", highlight: "markdown" },
  sh: { fence: "sh", highlight: "bash" },
  bash: { fence: "bash", highlight: "bash" },
  zsh: { fence: "zsh", highlight: "bash" },
  yml: { fence: "yaml", highlight: "yaml" },
  yaml: { fence: "yaml", highlight: "yaml" },
  toml: { fence: "toml", highlight: "ini" },
  ini: { fence: "ini", highlight: "ini" },
  py: { fence: "python", highlight: "python" },
  go: { fence: "go", highlight: "go" },
  java: { fence: "java", highlight: "java" },
  kt: { fence: "kotlin", highlight: "kotlin" },
  kts: { fence: "kotlin", highlight: "kotlin" },
  swift: { fence: "swift", highlight: "swift" },
  c: { fence: "c", highlight: "c" },
  h: { fence: "c", highlight: "c" },
  cc: { fence: "cpp", highlight: "cpp" },
  cpp: { fence: "cpp", highlight: "cpp" },
  hpp: { fence: "cpp", highlight: "cpp" },
  cs: { fence: "csharp", highlight: "csharp" },
  php: { fence: "php", highlight: "php" },
  rb: { fence: "ruby", highlight: "ruby" },
  sql: { fence: "sql", highlight: "sql" },
  diff: { fence: "diff", highlight: "diff" },
  patch: { fence: "diff", highlight: "diff" },
};

const BY_NAME: Readonly<Record<string, FileLanguage>> = {
  dockerfile: { fence: "dockerfile", highlight: "dockerfile" },
  makefile: { fence: "makefile", highlight: "makefile" },
};

export function languageForPath(path: string): FileLanguage {
  const name = splitPath(path).name.toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return { fence: "", highlight: null };
  const extension = name.slice(dot + 1);
  return BY_EXTENSION[extension] ?? { fence: extension, highlight: null };
}
