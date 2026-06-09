/**
 * Shared "touch-ratchet" helpers for source-hygiene gates.
 *
 * The no-new-rot pattern:
 *   - findings on lines the PR did NOT add  -> tolerated (pre-existing legacy)
 *   - findings on lines the PR ADDED        -> blocked
 *
 * A consuming gate:
 *   1. Resolves the diff base via `resolveBaseRef(envVarName)`. CI sets the
 *      env var to the PR base ref (e.g. `origin/main`); locally we fall back to
 *      standard candidates. Returns null in strict mode (no base resolvable).
 *   2. Builds a rename map via `buildRenameMap(base)` so a moved file is diffed
 *      against its pre-rename path.
 *   3. For each candidate finding, asks `getAddedLineNumbers(file, base,
 *      renameMap)` whether the line was added by the PR, then keeps only the
 *      introduced subset.
 *
 * Intentionally lightweight: no merge-base graph parsing, no submodule support,
 * no rename-similarity tuning. Uses `git diff --unified=0 --find-renames
 * base...HEAD` (three-dot = "what did the PR write?").
 *
 * SECURITY: every git invocation uses `execFileSync` (no shell) and
 * `--end-of-options`. Paths come from caller-controlled inputs (allowlists,
 * walk-tree results), so we avoid shell metacharacters and
 * argument-as-flag misinterpretation.
 */
import { execFileSync } from "node:child_process";

/** Verify a ref resolves; throws if not. */
export function verifyGitRef(ref) {
  execFileSync("git", ["rev-parse", "--verify", "--quiet", "--end-of-options", ref], {
    stdio: "ignore",
  });
}

/**
 * Resolve the diff base ref.
 * - explicit env var: verify it; throw a clear error if it does not resolve
 *   (almost always a CI fetch-depth misconfiguration — fail loud, not silent).
 * - no env var: try origin/main, origin/master, main, master in order.
 * - none resolvable: return null (strict mode — caller treats all as added).
 */
export function resolveBaseRef(envVarName) {
  const explicit = process.env[envVarName];
  if (explicit) {
    try {
      verifyGitRef(explicit);
      return explicit;
    } catch {
      throw new Error(
        `${envVarName}='${explicit}' does not resolve to a git ref. Check CI fetch-depth and the base ref name.`,
      );
    }
  }
  for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
    try {
      verifyGitRef(candidate);
      return candidate;
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Map current-path -> base-path (pre-rename) for files renamed/copied between base and HEAD. */
export function buildRenameMap(base) {
  const map = new Map();
  if (!base) return map;
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--name-status",
        "-z",
        "--find-renames",
        "--end-of-options",
        `${base}...HEAD`,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return map;
  }
  const parts = out.split("\0");
  let i = 0;
  while (i < parts.length) {
    const status = parts[i];
    if (!status) {
      i += 1;
      continue;
    }
    if (status.startsWith("R") || status.startsWith("C")) {
      const oldPath = parts[i + 1];
      const newPath = parts[i + 2];
      if (oldPath && newPath) map.set(newPath, oldPath);
      i += 3;
    } else {
      i += 2;
    }
  }
  return map;
}

/**
 * Return the set of new-side 1-indexed line numbers the PR ADDED to `file`.
 * Three-value contract:
 *   null      -> no base, OR file is new at base => treat ALL findings as added.
 *   empty Set -> file existed at base but diff threw / had no additions => all legacy.
 *   non-empty -> block only findings whose line is in the set.
 */
export function getAddedLineNumbers(file, base, renameMap) {
  if (!base) return null;
  const basePath = renameMap.get(file) ?? file;
  try {
    execFileSync("git", ["cat-file", "-e", `${base}:${basePath}`], { stdio: "ignore" });
  } catch {
    return null; // genuinely new file -> every finding is introduced
  }
  let out;
  try {
    out = execFileSync(
      "git",
      [
        "--literal-pathspecs",
        "diff",
        "--find-renames",
        "--unified=0",
        `${base}...HEAD`,
        "--end-of-options",
        "--",
        basePath,
        file,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return new Set(); // conservative: treat all findings as pre-existing
  }
  const added = new Set();
  let newLine = 0;
  for (const line of out.split("\n")) {
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk) {
      newLine = parseInt(hunk[1], 10);
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) {
      added.add(newLine);
      newLine += 1;
    } else if (line.startsWith("-")) {
      // removed line — does not advance the new-side counter
    } else if (line.startsWith(" ")) {
      newLine += 1;
    }
  }
  return added;
}
