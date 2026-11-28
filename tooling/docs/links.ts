/**
 * `bun run validate links` — every link, image and badge in the repository's Markdown resolves,
 * without a network call:
 *
 * - relative links and images, and absolute links into this repository
 *   (`github.com/<repo>/blob|tree|raw/main/…`, `raw.githubusercontent.com/<repo>/main/…`), name a
 *   tracked path, and a `#fragment` names a heading of the target page (GitHub's slug rules);
 * - a package README uses absolute links only, because npm renders it without the repository;
 * - badges point at something that exists: a workspace package (shields.io npm badges) or a
 *   workflow file (GitHub Actions badges).
 *
 * Whether github.com and shields.io serve those URLs is not checked here (no network in CI).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { trackedFiles } from "../disclosure";
import { PACKAGES, REPO } from "./contracts";

const PUBLIC = "vikramrao1994/comforge";
const ABSOLUTE = new RegExp(
  `^https://(?:github\\.com/${PUBLIC}/(?:blob|tree|raw)/main/|raw\\.githubusercontent\\.com/${PUBLIC}/main/)([^?#]*)(#.*)?$`,
);

/** GitHub's heading anchor: lowercase, punctuation dropped, spaces to hyphens, -N on repeats. */
export function anchors(markdown: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.trimStart().startsWith("```")) fenced = !fenced;
    if (fenced) continue;
    const m = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (!m) continue;
    const base = (m[1] as string)
      .replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/ /g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

function targets(text: string): string[] {
  const found: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const prose = line.replace(/`[^`]*`/g, "");
    for (const m of prose.matchAll(/\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g))
      found.push(m[1] as string);
    for (const m of prose.matchAll(/\b(?:src|href|srcset)="([^"]+)"/g))
      found.push((m[1] as string).split(/\s+/)[0] as string);
  }
  return found;
}

export function checkLinks(): string[] {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const dirs = new Set(
    tracked.flatMap((f) =>
      f
        .split("/")
        .slice(0, -1)
        .map((_, i, a) => a.slice(0, i + 1).join("/")),
    ),
  );
  const exists = (rel: string) =>
    rel === "" || trackedSet.has(rel) || dirs.has(rel.replace(/\/$/, ""));
  const pages = tracked.filter(
    (f) => /\.md$/.test(f) && !f.startsWith("harness/") && existsSync(path.join(REPO, f)),
  );
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (rel: string) => {
    if (!anchorCache.has(rel))
      anchorCache.set(rel, anchors(readFileSync(path.join(REPO, rel), "utf8")));
    return anchorCache.get(rel) as Set<string>;
  };
  const problems: string[] = [];
  for (const file of pages) {
    const isPackageReadme = /^packages\/[^/]+\/README\.md$/.test(file);
    for (const target of targets(readFileSync(path.join(REPO, file), "utf8"))) {
      let rel: string | undefined;
      let fragment: string | undefined;
      // The release mirror's disclosure scan allows only github.com/<repository> in shipped
      // files, so a package README links images through github.com/<repository>/raw/main/.
      if (isPackageReadme && target.startsWith("https://raw.githubusercontent.com/"))
        problems.push(
          `${file}: ${target} fails the release disclosure scan; use github.com/${PUBLIC}/raw/main/`,
        );
      const absolute = target.match(ABSOLUTE);
      if (absolute) {
        rel = decodeURIComponent(absolute[1] as string).replace(/\/$/, "");
        fragment = absolute[2]?.slice(1);
      } else if (/^https:\/\/img\.shields\.io\//.test(target)) {
        const pkg = target.match(/@comforge\/([a-z]+)/)?.[1];
        if (pkg && !PACKAGES.includes(pkg as never))
          problems.push(`${file}: badge for unknown package @comforge/${pkg}`);
        continue;
      } else if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/workflows\/([^/]+)/.test(target)) {
        const wf = target.match(/actions\/workflows\/([^/?#]+)/)?.[1] as string;
        if (!trackedSet.has(`.github/workflows/${wf}`))
          problems.push(`${file}: workflow ${wf} does not exist`);
        continue;
      } else if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        continue; // another site: not checked offline
      } else if (target.startsWith("#")) {
        rel = file;
        fragment = target.slice(1);
      } else {
        if (isPackageReadme && !target.startsWith("dist/"))
          problems.push(`${file}: relative link ${target} breaks on npm; use an absolute URL`);
        if (file.startsWith("packages/") && target.startsWith("dist/")) continue;
        const [p, f] = target.split("#") as [string, string | undefined];
        rel = path.posix.normalize(
          path.posix.join(path.posix.dirname(file), decodeURIComponent(p)),
        );
        fragment = f;
        if (rel.startsWith("..")) {
          problems.push(`${file}: ${target} leaves the repository`);
          continue;
        }
        if (rel === ".") rel = "";
      }
      if (!exists(rel)) {
        problems.push(`${file}: ${target} → ${rel} is not a tracked path`);
        continue;
      }
      if (fragment && rel.endsWith(".md") && statSync(path.join(REPO, rel)).isFile()) {
        if (!anchorsOf(rel).has(fragment.toLowerCase()))
          problems.push(`${file}: ${target} → no heading #${fragment} in ${rel}`);
      }
    }
  }
  return [...new Set(problems)];
}

if (import.meta.main) {
  const problems = checkLinks();
  for (const p of problems) console.log(p);
  process.exit(problems.length ? 1 : 0);
}
