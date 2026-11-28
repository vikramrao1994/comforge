/**
 * `bun tooling/brand/brand.ts [--check]` — writes the Comforge brand SVGs in docs/assets/brand/
 * from this one source, or (`--check`) fails when a committed file differs from it.
 *
 * The wordmark is drawn as monoline stroke paths, not text, so it renders identically without
 * any installed font. The social preview's tagline is text (system sans stack); its PNG is
 * rasterized from the SVG by `bun tooling/brand/social.ts` (needs agent-browser, not run in CI).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dir, "../../docs/assets/brand");

/** Palette: two inks and one accent per scheme. Contrast ≥ 4.5:1 for every text pairing. */
export const PALETTE = {
  light: {
    ink: "#0f1720",
    muted: "#4b5563",
    accent: "#0b7285",
    onAccent: "#ffffff",
    canvas: "#ffffff",
  },
  dark: {
    ink: "#e6edf3",
    muted: "#9aa4b2",
    accent: "#3bc9db",
    onAccent: "#0d1117",
    canvas: "#0d1117",
  },
} as const;

const STROKE = 3.4;

/** The mark: an accent tile with a prompt chevron and cursor bar. 40×40. */
function mark(x: number, y: number, s: { accent: string; onAccent: string }) {
  return [
    `<rect x="${x}" y="${y}" width="40" height="40" rx="9" fill="${s.accent}"/>`,
    `<path d="M${x + 12} ${y + 12.5} L${x + 20} ${y + 20} L${x + 12} ${y + 27.5} M${x + 23} ${y + 27.5} H${x + 29}" fill="none" stroke="${s.onAccent}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`,
  ].join("");
}

/** "comforge" in geometric monoline lowercase; x-height 10→30, baseline 30. Width ≈ 187. */
function wordmark(ox: number, oy: number, ink: string) {
  const p = (d: string) =>
    d.replace(/([XY])([-\d.]+)/g, (_, axis: string, n: string) =>
      String(Number(n) + (axis === "X" ? ox : oy)),
    );
  // Coordinates are written with X/Y prefixes so the offset can be applied, then stripped.
  const d = [
    // c
    "MX17.07 Y12.93 A10 10 0 1 0 X17.07 Y27.07",
    // o
    "MX33 Y10 A10 10 0 1 1 X32.99 Y10 Z",
    // m
    "MX49 Y10 VY30 MX49 Y16 A6 6 0 0 1 X61 Y16 VY30 MX61 Y16 A6 6 0 0 1 X73 Y16 VY30",
    // f
    "MX91 Y3.2 A7 7 0 0 0 X83 Y9 VY30 MX78.5 Y12 HX89",
    // o
    "MX107 Y10 A10 10 0 1 1 X106.99 Y10 Z",
    // r
    "MX123 Y10 VY30 MX123 Y19 A9 9 0 0 1 X133.5 Y10.4",
    // g
    "MX149 Y10 A10 10 0 1 1 X148.99 Y10 Z MX159 Y10 VY31 A8 8 0 0 1 X144 Y35.5",
    // e
    "MX165 Y20 HX185 A10 10 0 1 0 X182.07 Y27.07",
  ]
    .map(p)
    .join(" ");
  return `<path d="${d.replace(/[XY]/g, "")}" fill="none" stroke="${ink}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>`;
}

function logo(scheme: "light" | "dark") {
  const s = PALETTE[scheme];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="250" height="48" viewBox="0 0 250 48" role="img" aria-labelledby="t"><title id="t">Comforge</title>${mark(2, 4, s)}${wordmark(58, 4, s.ink)}</svg>\n`;
}

function markOnly() {
  const s = PALETTE.light;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="44" height="44" viewBox="0 0 44 44" role="img" aria-labelledby="t"><title id="t">Comforge</title>${mark(2, 2, s)}</svg>\n`;
}

const SANS = `ui-sans-serif, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

/** GitHub social preview, 1280×640 (GitHub's recommended size), dark. */
function social() {
  const s = PALETTE.dark;
  const scale = 3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640" role="img" aria-labelledby="t"><title id="t">Comforge — Build with agents. Govern with code.</title>
<rect width="1280" height="640" fill="${s.canvas}"/>
<rect x="0" y="0" width="1280" height="6" fill="${s.accent}"/>
<g transform="translate(120 150) scale(${scale})">${mark(0, 0, s)}${wordmark(56, 0, s.ink)}</g>
<text x="120" y="370" fill="${s.ink}" font-family="${SANS}" font-size="56" font-weight="600">Build with agents. Govern with code.</text>
<text x="120" y="440" fill="${s.muted}" font-family="${SANS}" font-size="28">Isolated tasks · exact-commit validation · governed pull requests · recoverable writes</text>
<text x="120" y="560" fill="${s.accent}" font-family="${MONO}" font-size="26">npm install @comforge/cli @comforge/mcp</text>
</svg>
`;
}

export const FILES: Record<string, () => string> = {
  "comforge-logo-light.svg": () => logo("light"),
  "comforge-logo-dark.svg": () => logo("dark"),
  "comforge-mark.svg": markOnly,
  "social-preview.svg": social,
};

/** Problems with the committed brand files (empty when they match this source). */
export function checkBrand(): string[] {
  const problems: string[] = [];
  for (const [name, make] of Object.entries(FILES)) {
    const file = path.join(OUT, name);
    if (!existsSync(file) || readFileSync(file, "utf8") !== make())
      problems.push(
        `docs/assets/brand/${name} differs from tooling/brand/brand.ts: run bun tooling/brand/brand.ts`,
      );
  }
  if (!existsSync(path.join(OUT, "social-preview.png")))
    problems.push(
      "docs/assets/brand/social-preview.png is missing: run bun tooling/brand/social.ts",
    );
  return problems;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const problems = checkBrand();
    for (const p of problems) console.log(p);
    process.exit(problems.length ? 1 : 0);
  }
  for (const [name, make] of Object.entries(FILES)) writeFileSync(path.join(OUT, name), make());
  console.log(`wrote ${Object.keys(FILES).length} files to docs/assets/brand`);
}
