/**
 * The owner's release approval.
 *
 *  bun run release:keygen [--login LOGIN] [--out FILE]
 *  bun run release:approve [--run ID | --build] [--key FILE] [--minutes N] [--no-dispatch --out FILE]
 *
 * `approve` downloads the candidate the publishing workflow built for the current origin/main
 * (a dry-run dispatch), shows it, asks the owner to type its version, unlocks the owner's
 * passphrase-protected Ed25519 key and signs a release authorization for exactly that
 * candidate, then dispatches the workflow with it. Nothing is typed but the version and the
 * passphrase: no SHA, no digest.
 *
 * Both commands need an interactive terminal and an encrypted key. That is the custody
 * boundary, not a convenience: a coding agent runs without a terminal and never learns the
 * passphrase, so it can prepare a candidate but cannot approve one. Never add a flag, an
 * environment variable or a file that supplies the passphrase.
 */
import { spawnSync } from "node:child_process";
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { keyIdFor } from "@comforge/cli/authority";
import {
  assertCandidateIntegrity,
  assertCandidateReady,
  CandidateRefusal,
  type ReleaseCandidate,
  renderCandidate,
} from "./candidate";
import { profileOf } from "./packages";
import {
  type AuthorizationEnvelope,
  AuthorizationRefusal,
  buildAuthorization,
  CANDIDATE_ARTIFACT,
  candidateRunName,
  DEFAULT_LIFETIME_MS,
  encodeEnvelope,
  expectedRepository,
  MAX_LIFETIME_MS,
  PUBLISH_WORKFLOW,
  type ReleaseTrust,
  RUN_NAME_PREFIX,
  signAuthorization,
  TRUST_FILE,
  TrustSchema,
  trustAt,
  verifyReleaseAuthorization,
  workflowDigestAt,
} from "./releaseAuthorization";

export const DEFAULT_KEY_FILE = path.join(
  homedir(),
  ".config",
  "comforge",
  "release-signing-key.pem",
);
const MIN_PASSPHRASE = 12;
const REPO = path.resolve(import.meta.dir, "..", "..");

export class ApprovalRefusal extends Error {
  constructor(
    readonly code:
      | "not-interactive"
      | "declined"
      | "key-unprotected"
      | "key-locked"
      | "key-untrusted"
      | "key-location"
      | "candidate-stale"
      | "candidate-not-found",
    message: string,
  ) {
    super(`release approval refused (${code}): ${message}`);
  }
}

export interface ApproveIo {
  /** stdin and stdout are a terminal. */
  interactive: boolean;
  print(text: string): void;
  ask(question: string): Promise<string>;
  askHidden(question: string): Promise<string>;
}

export interface ApproveInput {
  /** The package the owner chose to approve; a candidate of any other package is refused. */
  expectedPackage?: string;
  candidate: ReleaseCandidate;
  candidateRun: number | null;
  /** origin/main now; the candidate must be built from it. */
  mainSha: string;
  workflowSha256: string;
  trust: ReleaseTrust;
  keyPem: string;
  repository: string;
  now: Date;
  lifetimeMs?: number;
}

/** Shows the candidate, takes the owner's explicit approval and returns the signed record. */
export async function approveCandidate(
  input: ApproveInput,
  io: ApproveIo,
): Promise<AuthorizationEnvelope> {
  if (!io.interactive)
    throw new ApprovalRefusal(
      "not-interactive",
      "approval needs the owner at an interactive terminal",
    );
  const { candidate } = input;
  assertCandidateIntegrity(candidate);
  if (input.expectedPackage !== undefined && candidate.package !== input.expectedPackage)
    throw new ApprovalRefusal(
      "candidate-not-found",
      `the candidate is ${candidate.package}, not the ${input.expectedPackage} you asked to approve`,
    );
  assertCandidateReady(candidate);
  if (candidate.sourceCommit !== input.mainSha)
    throw new ApprovalRefusal(
      "candidate-stale",
      `the candidate was built from ${candidate.sourceCommit}; origin/main is ${input.mainSha}. Build a new candidate.`,
    );
  if (!/-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(input.keyPem))
    throw new ApprovalRefusal(
      "key-unprotected",
      "the signing key is not passphrase-protected; generate one with bun run release:keygen",
    );
  const lifetimeMs = input.lifetimeMs ?? DEFAULT_LIFETIME_MS;
  io.print(renderCandidate(candidate));
  io.print(
    [
      "",
      `Publishing workflow: ${PUBLISH_WORKFLOW} sha256 ${input.workflowSha256}`,
      `Candidate run: ${input.candidateRun ?? "(local file)"}`,
      `The approval is good for one dispatch within ${Math.round(lifetimeMs / 60000)} minutes.`,
      "",
    ].join("\n"),
  );
  const typed = (
    await io.ask(`Type ${candidate.version} to approve this release (anything else cancels): `)
  ).trim();
  if (typed !== candidate.version)
    throw new ApprovalRefusal("declined", "the owner did not approve");
  if (candidate.workflowApproval) {
    const phrase = "approve workflow change";
    const w = (
      await io.ask(`This release changes the npm publishing workflow. Type "${phrase}": `)
    ).trim();
    if (w !== phrase) throw new ApprovalRefusal("declined", "the workflow change was not approved");
  }
  const passphrase = await io.askHidden("Signing key passphrase: ");
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey({ key: input.keyPem, format: "pem", passphrase });
  } catch {
    throw new ApprovalRefusal("key-locked", "the passphrase does not unlock the signing key");
  }
  const publicKeyPem = createPublicKey(privateKey)
    .export({ type: "spki", format: "pem" })
    .toString();
  const keyId = keyIdFor(publicKeyPem);
  const trusted = input.trust.keys.find((k) => k.keyId === keyId);
  if (!trusted)
    throw new ApprovalRefusal(
      "key-untrusted",
      `key ${keyId} is not in ${TRUST_FILE} on origin/main; the workflow would refuse it`,
    );
  const authorization = buildAuthorization({
    candidate,
    workflowSha256: input.workflowSha256,
    repository: input.repository,
    issuer: trusted.login,
    authorizationId: randomUUID(),
    nonce: randomBytes(16).toString("hex"),
    candidateRun: input.candidateRun,
    now: input.now,
    lifetimeMs,
  });
  const envelope = signAuthorization(authorization, privateKey);
  // The record must pass the workflow's own offline check before it is sent anywhere.
  verifyReleaseAuthorization(envelope, {
    trust: input.trust,
    repository: input.repository,
    candidate,
    workflowSha256: input.workflowSha256,
    now: input.now,
  });
  return envelope;
}

export interface KeygenInput {
  out: string;
  login: string;
  label: string;
  repoRoot: string;
}

/** Owner side: a new passphrase-protected Ed25519 release key and its trust entry. */
export async function generateReleaseKey(input: KeygenInput, io: ApproveIo) {
  if (!io.interactive)
    throw new ApprovalRefusal(
      "not-interactive",
      "key generation needs the owner at an interactive terminal",
    );
  const out = path.resolve(input.out);
  const rel = path.relative(path.resolve(input.repoRoot), out);
  if (!rel.startsWith("..") && !path.isAbsolute(rel))
    throw new ApprovalRefusal("key-location", "the signing key must live outside the repository");
  if (existsSync(out)) throw new ApprovalRefusal("key-location", `${out} already exists`);
  const first = await io.askHidden(`New passphrase (at least ${MIN_PASSPHRASE} characters): `);
  if (first.length < MIN_PASSPHRASE)
    throw new ApprovalRefusal(
      "key-unprotected",
      `the passphrase needs at least ${MIN_PASSPHRASE} characters`,
    );
  if ((await io.askHidden("Repeat the passphrase: ")) !== first)
    throw new ApprovalRefusal("declined", "the passphrases differ");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  writeFileSync(
    out,
    privateKey.export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: first }),
    { mode: 0o600, flag: "wx" },
  );
  return { keyId: keyIdFor(publicKeyPem), publicKeyPem, login: input.login, label: input.label };
}

/** Adds a key to the working-tree trust file; the owner commits it through normal review. */
export function addTrustedKey(trustFile: string, entry: ReleaseTrust["keys"][number]): void {
  const trust = TrustSchema.parse(JSON.parse(readFileSync(trustFile, "utf8")));
  if (trust.keys.some((k) => k.keyId === entry.keyId)) return;
  trust.keys.push(entry);
  writeFileSync(trustFile, `${JSON.stringify(trust, null, 2)}\n`);
}

function readLine(question: string, hidden: boolean): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stdout.write(question);
    let buffer = "";
    const done = (fn: () => void) => {
      stdin.off("data", onData);
      if (hidden) stdin.setRawMode(false);
      stdin.pause();
      fn();
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n")
          return done(() => {
            if (hidden) process.stdout.write("\n");
            resolve(buffer);
          });
        if (ch === "\u0003" || ch === "\u0004")
          return done(() => reject(new ApprovalRefusal("declined", "cancelled")));
        if (ch === "\u007f" || ch === "\b") buffer = buffer.slice(0, -1);
        else buffer += ch;
      }
    };
    if (hidden) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.resume();
  });
}

const terminalIo: ApproveIo = {
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  print: (text) => console.log(text),
  ask: (q) => readLine(q, false),
  askHidden: (q) => readLine(q, true),
};

function run(cmd: string, args: string[], options: { cwd?: string } = {}): string {
  const r = spawnSync(cmd, args, { cwd: options.cwd ?? REPO, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(
      `${cmd} ${args[0]} ${args[1] ?? ""} failed: ${(r.stderr || r.stdout).trim().slice(0, 500)}`,
    );
  return r.stdout.trim();
}

type RunRow = {
  databaseId: number;
  headSha: string;
  conclusion: string;
  status: string;
  displayTitle: string;
};

function candidateRuns(): RunRow[] {
  return JSON.parse(
    run("gh", [
      "run",
      "list",
      "--workflow",
      path.basename(PUBLISH_WORKFLOW),
      "--branch",
      "main",
      "--event",
      "workflow_dispatch",
      "--json",
      "databaseId,headSha,conclusion,status,displayTitle",
      "-L",
      "30",
    ]),
  ) as RunRow[];
}

/** The latest successful dry run (a candidate build, not a release) of `pkg` for `sha`. */
function findCandidateRun(sha: string, pkg: string): number | null {
  const row = candidateRuns().find(
    (r) =>
      r.headSha === sha && r.conclusion === "success" && r.displayTitle === candidateRunName(pkg),
  );
  return row?.databaseId ?? null;
}

function buildCandidateRun(sha: string, pkg: string): number {
  const before = new Set(candidateRuns().map((r) => r.databaseId));
  run("gh", [
    "workflow",
    "run",
    path.basename(PUBLISH_WORKFLOW),
    "--ref",
    "main",
    "-f",
    `package=${profileOf(pkg).id}`,
  ]);
  for (let i = 0; i < 30; i++) {
    const fresh = candidateRuns().find(
      (r) =>
        !before.has(r.databaseId) && r.headSha === sha && r.displayTitle === candidateRunName(pkg),
    );
    if (fresh) {
      console.log(`building candidate in run ${fresh.databaseId} …`);
      const watch = spawnSync("gh", ["run", "watch", String(fresh.databaseId), "--exit-status"], {
        stdio: "inherit",
      });
      if (watch.status !== 0)
        throw new ApprovalRefusal(
          "candidate-not-found",
          `candidate run ${fresh.databaseId} failed`,
        );
      return fresh.databaseId;
    }
    Bun.sleepSync(2000);
  }
  throw new ApprovalRefusal("candidate-not-found", "the dispatched candidate run did not appear");
}

async function cli(argv: string[]): Promise<number> {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const command = argv[0];
  if (command === "keygen") {
    const login = arg("--login") ?? run("gh", ["api", "user", "--jq", ".login"]);
    const entry = await generateReleaseKey(
      {
        out: arg("--out") ?? DEFAULT_KEY_FILE,
        login,
        label: arg("--label") ?? `${login} release key`,
        repoRoot: REPO,
      },
      terminalIo,
    );
    addTrustedKey(path.join(REPO, TRUST_FILE), entry);
    console.log(
      [
        `key ${entry.keyId} for ${login} written to ${arg("--out") ?? DEFAULT_KEY_FILE} (encrypted, mode 600)`,
        `added to ${TRUST_FILE}; commit it through normal review. It is trusted only once it is on main.`,
        "Keep the passphrase out of every file, shell history and agent session.",
      ].join("\n"),
    );
    return 0;
  }
  if (command !== "approve") {
    console.error(
      "usage: releaseApprove.ts keygen [--login L] [--out FILE] | approve [--package NAME] [--run ID | --build] [--key FILE] [--minutes N] [--no-dispatch --out FILE]",
    );
    return 2;
  }
  // Refuse before any network call: nothing below is for a non-interactive caller.
  if (!terminalIo.interactive)
    throw new ApprovalRefusal(
      "not-interactive",
      "approval needs the owner at an interactive terminal",
    );
  const pkg = profileOf(arg("--package") ?? "@comforge/core").name;
  run("git", ["fetch", "-q", "origin", "main"]);
  const mainSha = run("git", ["rev-parse", "refs/remotes/origin/main"]);
  const runArg = arg("--run");
  const runId = runArg
    ? Number(runArg)
    : argv.includes("--build")
      ? buildCandidateRun(mainSha, pkg)
      : findCandidateRun(mainSha, pkg);
  if (!runId)
    throw new ApprovalRefusal(
      "candidate-not-found",
      `no successful ${pkg} candidate run for origin/main ${mainSha.slice(0, 12)}; rerun with --build (dispatches a dry run and waits)`,
    );
  const dir = mkdtempSync(path.join(tmpdir(), "comforge-approval-"));
  run("gh", ["run", "download", String(runId), "-n", CANDIDATE_ARTIFACT, "-D", dir]);
  const candidate = JSON.parse(
    readFileSync(path.join(dir, "candidate.json"), "utf8"),
  ) as ReleaseCandidate;
  const minutes = Number(arg("--minutes") ?? DEFAULT_LIFETIME_MS / 60000);
  const keyFile = arg("--key") ?? DEFAULT_KEY_FILE;
  if (!existsSync(keyFile))
    throw new ApprovalRefusal(
      "key-untrusted",
      `no signing key at ${keyFile}; run bun run release:keygen first`,
    );
  const envelope = await approveCandidate(
    {
      expectedPackage: pkg,
      candidate,
      candidateRun: runId,
      mainSha,
      workflowSha256: workflowDigestAt(REPO, mainSha),
      trust: trustAt(REPO, mainSha),
      keyPem: readFileSync(keyFile, "utf8"),
      repository: expectedRepository({} as NodeJS.ProcessEnv),
      now: new Date(),
      lifetimeMs: Math.min(minutes * 60000, MAX_LIFETIME_MS),
    },
    terminalIo,
  );
  const a = envelope.authorization;
  const inputs = [
    "-f",
    `package=${profileOf(a.package).id}`,
    "-f",
    "publish=true",
    "-f",
    `authorization=${encodeEnvelope(envelope)}`,
    "-f",
    `authorization_id=${a.authorizationId}`,
    "-f",
    `approve_workflows=${a.mirrorWorkflowApproval ?? ""}`,
  ];
  if (argv.includes("--no-dispatch")) {
    const out = arg("--out");
    if (!out) throw new ApprovalRefusal("declined", "--no-dispatch needs --out FILE");
    writeFileSync(out, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    console.log(
      `authorization ${a.authorizationId} written to ${out}; dispatch with gh workflow run ${path.basename(PUBLISH_WORKFLOW)} --ref main and the inputs it names`,
    );
    return 0;
  }
  run("gh", ["workflow", "run", path.basename(PUBLISH_WORKFLOW), "--ref", "main", ...inputs]);
  console.log(
    [
      `approved ${a.package} ${a.version} (${a.sourceCommit.slice(0, 12)}, candidate ${a.candidateDigest.slice(0, 19)}…)`,
      `dispatched run "${RUN_NAME_PREFIX}${a.authorizationId}"; the approval expires ${a.expiresAt}`,
      `watch: gh run list --workflow ${path.basename(PUBLISH_WORKFLOW)} -L 3`,
    ].join("\n"),
  );
  return 0;
}

if (import.meta.main)
  cli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error((error as Error).message);
      const refused =
        error instanceof ApprovalRefusal ||
        error instanceof AuthorizationRefusal ||
        error instanceof CandidateRefusal;
      process.exit(refused ? 1 : 2);
    });
