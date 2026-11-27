/**
 * The releasable Comforge packages: the one registry every release
 * tool reads for a package's identity, source, mirror branch, tag, npm workflow, consumer
 * pin and dependencies. A package not listed here cannot be planned, approved or published.
 *
 * `@comforge/core` reproduces exactly the identity it had before the registry existed
 * (`core/v*` on `releases/core`, `npm-publish.yml`). Each package publishes to npm through
 * its **own** workflow file: npm Trusted Publishing matches repository and workflow file
 * name, not the tag, so a shared file name would let one package's release branch publish
 * the other package.
 */
import path from "node:path";

export interface PackageProfile {
  /** Short id used in branch and file names. */
  readonly id: "core" | "github" | "ledger" | "cli" | "mcp";
  readonly name:
    | "@comforge/core"
    | "@comforge/github"
    | "@comforge/ledger"
    | "@comforge/cli"
    | "@comforge/mcp";
  /** Source directory of the package. */
  readonly dir: string;
  /** Independent example consumer shipped on the release branch. */
  readonly example: string;
  readonly tagPrefix: string;
  readonly releaseBranch: string;
  /** Release-branch path → source of the files the release branch carries for npm. */
  readonly assets: Readonly<Record<string, string>>;
  /** The mirror workflow that publishes this package to npm (its Trusted Publisher identity). */
  readonly npmWorkflow: string;
  /** The verified release recorded as this package's planning baseline. */
  readonly pinDir: string;
  /** Other registry packages this package's manifest depends on. */
  readonly dependsOn: readonly PackageProfile["name"][];
  /** Test suites of this package; every release candidate and consumer update runs all packages'. */
  readonly tests: readonly string[];
  /** Whether a downstream consumer installs this package from npm (adoption is tracked). */
  readonly consumedDownstream: boolean;
  /**
   * A source literal that must equal the package version (`export const NAME = "x.y.z";`), kept a
   * literal because bundlers cannot follow a runtime package.json read. The version step rewrites it.
   */
  readonly versionConstant?: { readonly file: string; readonly name: string };
}

const ASSETS_DIR = "tooling/release/assets";
const NPM_HELPER = { ".github/comforge/npm-release.mjs": `${ASSETS_DIR}/npm-release.mjs` };

export const PACKAGES: Readonly<Record<PackageProfile["name"], PackageProfile>> = {
  "@comforge/core": {
    id: "core",
    name: "@comforge/core",
    dir: "packages/core",
    example: "examples/core-consumer",
    tagPrefix: "core/v",
    releaseBranch: "releases/core",
    assets: { ".github/workflows/npm-publish.yml": `${ASSETS_DIR}/npm-publish.yml`, ...NPM_HELPER },
    npmWorkflow: ".github/workflows/npm-publish.yml",
    pinDir: "releases/baseline/core",
    dependsOn: [],
    tests: ["packages/core/test", "tests/release"],
    consumedDownstream: true,
  },
  "@comforge/github": {
    id: "github",
    name: "@comforge/github",
    dir: "packages/github",
    example: "examples/github-consumer",
    tagPrefix: "github/v",
    releaseBranch: "releases/github",
    assets: {
      ".github/workflows/npm-publish-github.yml": `${ASSETS_DIR}/npm-publish-github.yml`,
      ...NPM_HELPER,
    },
    npmWorkflow: ".github/workflows/npm-publish-github.yml",
    pinDir: "releases/baseline/github",
    dependsOn: ["@comforge/core"],
    tests: ["packages/github/test", "tests/github"],
    // Adopted at 0.1.0: the engineering gateway's read
    // transport. The application imports only the installed release, never this source.
    consumedDownstream: true,
  },
  "@comforge/ledger": {
    id: "ledger",
    name: "@comforge/ledger",
    dir: "packages/ledger",
    example: "examples/ledger-consumer",
    tagPrefix: "ledger/v",
    releaseBranch: "releases/ledger",
    assets: {
      ".github/workflows/npm-publish-ledger.yml": `${ASSETS_DIR}/npm-publish-ledger.yml`,
      ...NPM_HELPER,
    },
    npmWorkflow: ".github/workflows/npm-publish-ledger.yml",
    pinDir: "releases/baseline/ledger",
    // Structurally compatible with @comforge/github's OperationLedger, without depending on it.
    dependsOn: [],
    tests: ["packages/ledger/test", "tests/ledger"],
    // Adopted at 0.1.0: the lifecycle CLI's file ledger and the
    // gateway's SQLite ledger are thin adapters over the installed release, never this source.
    consumedDownstream: true,
  },
  "@comforge/cli": {
    id: "cli",
    name: "@comforge/cli",
    dir: "packages/cli",
    example: "examples/cli-consumer",
    tagPrefix: "cli/v",
    releaseBranch: "releases/cli",
    assets: {
      ".github/workflows/npm-publish-cli.yml": `${ASSETS_DIR}/npm-publish-cli.yml`,
      ...NPM_HELPER,
    },
    npmWorkflow: ".github/workflows/npm-publish-cli.yml",
    pinDir: "releases/baseline/cli",
    // Exact published versions of all three: the executable is built and tested against them.
    dependsOn: ["@comforge/core", "@comforge/github", "@comforge/ledger"],
    tests: ["packages/cli/test", "tests/cli"],
    // Pinned from npm by downstream consumers, which adopt it together with @comforge/mcp.
    consumedDownstream: true,
  },
  // The lifecycle as an MCP server over the published CLI services.
  "@comforge/mcp": {
    id: "mcp",
    name: "@comforge/mcp",
    dir: "packages/mcp",
    example: "examples/mcp-consumer",
    tagPrefix: "mcp/v",
    releaseBranch: "releases/mcp",
    assets: {
      ".github/workflows/npm-publish-mcp.yml": `${ASSETS_DIR}/npm-publish-mcp.yml`,
      ...NPM_HELPER,
    },
    npmWorkflow: ".github/workflows/npm-publish-mcp.yml",
    pinDir: "releases/baseline/mcp",
    // @comforge/ledger: the SQLite operation store of the host services (`@comforge/mcp/host`).
    dependsOn: ["@comforge/core", "@comforge/github", "@comforge/ledger", "@comforge/cli"],
    tests: ["packages/mcp/test", "tests/mcp"],
    consumedDownstream: true,
    versionConstant: { file: "src/tools.ts", name: "SERVER_VERSION" },
  },
};

export type PackageName = PackageProfile["name"];
export const PACKAGE_NAMES = Object.keys(PACKAGES) as PackageName[];
export const CORE = PACKAGES["@comforge/core"];

export const isPackageName = (name: unknown): name is PackageName =>
  typeof name === "string" && Object.hasOwn(PACKAGES, name);

export class UnknownPackageError extends Error {
  constructor(name: unknown) {
    super(
      `not a releasable Comforge package: ${String(name)} (known: ${PACKAGE_NAMES.join(", ")})`,
    );
  }
}

/** The profile of a registry package; by full name or short id. */
export function profileOf(name: unknown): PackageProfile {
  if (isPackageName(name)) return PACKAGES[name];
  const byId = Object.values(PACKAGES).find((p) => p.id === name);
  if (byId) return byId;
  throw new UnknownPackageError(name);
}

/** Source paths a release of `p` is built from; a dirty copy of any of them refuses the run. */
export const sourceInputs = (p: PackageProfile): string[] => [
  p.dir,
  p.example,
  ...new Set(Object.values(p.assets).map((src) => path.dirname(src))),
];

export const pinFile = (p: PackageProfile) => `${p.pinDir}/RELEASE.json`;

/** Every package's suites: a change to one is checked against all (core → github compatibility). */
export const allTests = (): string[] => Object.values(PACKAGES).flatMap((p) => p.tests);

/** Packages that depend, directly or not, on `name`. */
export function dependentsOf(name: PackageName): PackageName[] {
  const out = new Set<PackageName>();
  const visit = (target: PackageName) => {
    for (const p of Object.values(PACKAGES))
      if (p.dependsOn.includes(target) && !out.has(p.name)) {
        out.add(p.name);
        visit(p.name);
      }
  };
  visit(name);
  return [...out];
}

/** Refuses a registry whose dependencies are unknown or cyclic, or whose identities collide. */
export function assertRegistry(
  packages: Readonly<Record<string, PackageProfile>> = PACKAGES,
): void {
  const all = Object.values(packages);
  for (const field of [
    "id",
    "dir",
    "tagPrefix",
    "releaseBranch",
    "npmWorkflow",
    "pinDir",
  ] as const) {
    const values = all.map((p) => p[field]);
    if (new Set(values).size !== values.length) throw new Error(`registry: duplicate ${field}`);
  }
  for (const p of all) {
    if (!p.assets[p.npmWorkflow])
      throw new Error(`registry: ${p.name} does not ship its npm workflow`);
    for (const other of all)
      if (other !== p && Object.hasOwn(p.assets, other.npmWorkflow))
        throw new Error(`registry: ${p.name} ships ${other.name}'s npm workflow`);
    for (const dep of p.dependsOn)
      if (!Object.hasOwn(packages, dep))
        throw new Error(`registry: ${p.name} depends on unknown ${dep}`);
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, trail: string[]) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting")
      throw new Error(`registry: dependency cycle ${[...trail, name].join(" → ")}`);
    state.set(name, "visiting");
    for (const dep of packages[name]?.dependsOn ?? []) visit(dep, [...trail, name]);
    state.set(name, "done");
  };
  for (const p of all) visit(p.name, []);
}
