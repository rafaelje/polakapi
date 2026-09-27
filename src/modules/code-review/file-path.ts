export interface SplitPath {
  dir: string;
  name: string;
}

export function splitPath(path: string): SplitPath {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
