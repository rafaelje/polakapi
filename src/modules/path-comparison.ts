export function normalizePath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizePath(left);
  const normalizedRight = normalizePath(right);
  return useWindowsComparison(normalizedLeft, normalizedRight)
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

export function pathStartsWith(path: string, prefix: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPrefix = normalizePath(prefix);
  const pathWithBoundary = normalizedPrefix === "/" ? "/" : `${normalizedPrefix}/`;
  return useWindowsComparison(normalizedPath, normalizedPrefix)
    ? normalizedPath.toLowerCase().startsWith(pathWithBoundary.toLowerCase())
    : normalizedPath.startsWith(pathWithBoundary);
}

function useWindowsComparison(left: string, right: string): boolean {
  return isWindowsPath(left) && isWindowsPath(right);
}

function isWindowsPath(path: string): boolean {
  return /^(?:[A-Za-z]:(?:\/|$)|\/\/)/.test(path);
}
