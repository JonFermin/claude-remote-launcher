import { normalize, sep } from "node:path";

// Returns a predicate that tests whether `dir` lives under any of the
// supplied prefixes. Platform-native separator so it works on Windows and Unix.
export function makeIsAllowedDir(allowedDirs) {
  const prefixes = allowedDirs.map((p) => normalize(p).replace(/[\\/]$/, "") + sep);
  return function isAllowedDir(dir) {
    const norm = normalize(dir).replace(/[\\/]$/, "") + sep;
    return prefixes.some((p) => norm === p || norm.startsWith(p));
  };
}
