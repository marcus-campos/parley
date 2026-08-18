/**
 * Territory paths.
 *
 * A territory path is ALWAYS POSIX and relative to the repository root. Without
 * that rule a session on Windows claiming `src\app.ts` and a session in WSL
 * claiming `src/app.ts` would hold the same file without ever colliding — the
 * worst failure class, the silent one.
 */

const WILDCARD = /[*?]/;

/** Normalise to POSIX, relative to repo root. Throws on paths that escape it. */
export function normalizeTerritoryPath(input: string): string {
  const s = input.replace(/\\/g, "/").trim().replace(/^\/+/, "");
  const out: string[] = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) throw new Error(`territory path escapes repository root: ${input}`);
      out.pop();
      continue;
    }
    out.push(seg);
  }
  if (out.length === 0) throw new Error(`empty territory path: ${input}`);
  return out.join("/");
}

function segRegex(seg: string): RegExp {
  let re = "";
  for (const ch of seg) {
    if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/**
 * A wildcard-free pattern that names a DIRECTORY also covers everything beneath
 * it: claiming `src/backend` means the directory, not one inode.
 *
 * Directory-ness is decided by the last segment: a dot anywhere after the first
 * character reads as a file (`app.ts`), a leading dot or no dot at all reads as
 * a directory (`.github`, `backend`). The heuristic is wrong for a directory
 * literally named `v1.2` — write `v1.2/**` when that happens. Without it,
 * `**\/*.py` would "conflict" with `src/app.ts` through a `src/app.ts/x.py`
 * that can never exist, and every claim would collide with every other.
 */
function looksLikeDirectory(segs: string[]): boolean {
  const last = segs[segs.length - 1] ?? "";
  return last.indexOf(".", 1) === -1;
}

function expand(pattern: string): string[][] {
  const segs = pattern.split("/");
  if (WILDCARD.test(pattern)) return [segs];
  return looksLikeDirectory(segs) ? [segs, [...segs, "**"]] : [segs];
}

function matchSegs(pat: string[], path: string[]): boolean {
  if (pat.length === 0) return path.length === 0;
  const [head, ...rest] = pat;
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) if (matchSegs(rest, path.slice(i))) return true;
    return false;
  }
  if (path.length === 0) return false;
  if (!segRegex(head!).test(path[0]!)) return false;
  return matchSegs(rest, path.slice(1));
}

/** Does `pattern` cover the concrete `path`? Both must already be normalised. */
export function matchesPath(pattern: string, path: string): boolean {
  const target = path.split("/");
  return expand(pattern).some((p) => matchSegs(p, target));
}

function segsCompatible(a: string, b: string): boolean {
  const wa = WILDCARD.test(a);
  const wb = WILDCARD.test(b);
  if (!wa && !wb) return a === b;
  if (wa && !wb) return segRegex(a).test(b);
  if (!wa && wb) return segRegex(b).test(a);
  // Both sides carry wildcards. Deciding this exactly is regex intersection;
  // we answer "maybe" and let the conflict surface. Deliberately conservative:
  // a false conflict costs one conversation, a false clear costs two agents
  // editing the same file.
  return true;
}

function overlapSegs(a: string[], b: string[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a.length === 0) return b.every((s) => s === "**");
  if (b.length === 0) return a.every((s) => s === "**");
  const [ha, ...ra] = a;
  const [hb, ...rb] = b;
  if (ha === "**") return overlapSegs(ra, b) || overlapSegs(a, rb);
  if (hb === "**") return overlapSegs(a, rb) || overlapSegs(ra, b);
  if (!segsCompatible(ha!, hb!)) return false;
  return overlapSegs(ra, rb);
}

/** Could any concrete path be covered by both patterns at once? */
export function patternsOverlap(a: string, b: string): boolean {
  const A = expand(a);
  const B = expand(b);
  return A.some((x) => B.some((y) => overlapSegs(x, y)));
}
