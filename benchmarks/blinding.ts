/**
 * Cost: none — builds review packets; scoring is done later by Claude Code subagents,
 *   never by an API judge script
 *
 * Blinded quality scoring packets. A packet holds the task, the diff and the success-check
 * output with arm identity removed; packet ids are assigned in a seeded shuffled order and the
 * mapping back to runs is written to a separate directory that scorers never read.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { shuffled } from "./prng.ts";

export interface BlindingInput {
  runId: string;
  repo: string;
  task: string;
  arm: string;
  prompt: string;
  diff: string;
  successOutput: string;
}
export interface Packet {
  packetId: string;
  task: string;
  repositoryLanguage: string;
  prompt: string;
  diff: string;
  successCheckOutput: string;
}

/** Paths an arm leaves in a diff that would reveal it; excluded from the packet diff. */
export const ARM_ARTIFACT_PATHSPECS = [
  ":!comforge.config.json",
  ":!docs/comforge",
  ":!.specify",
  ":!specs",
  ":!openspec",
  ":!.claude",
  ":!.mcp.json",
];

const IDENTIFYING: RegExp[] = [
  /spec[-_ ]?kit/gi,
  /specify/gi,
  /open[-_ ]?spec/gi,
  /comforge/gi,
  /bench-lifecycle/gi,
  /bench-spec/gi,
  /syn-gh/gi,
  /vanilla/gi,
  /\bmcp\b/gi,
  /agent\/[\w.-]+/g,
];
export const scrubIdentity = (text: string) =>
  IDENTIFYING.reduce((t, re) => t.replace(re, "[tool]"), text);
export const leaksIdentity = (text: string) =>
  IDENTIFYING.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });

export const RUBRIC = {
  schema: "comforge-adoption-001/quality-rubric/v1",
  scorers:
    "Claude Code subagents reading one packet each; no access to the blinding map or run metadata",
  instructions:
    "Score only what the packet shows. Do not guess which tool produced it. Return one JSON object per packet matching `responseShape`.",
  criteria: [
    {
      id: "correctness",
      scale: "0-4",
      question:
        "Does the diff implement the task as specified, beyond the success check's own assertions?",
    },
    {
      id: "scope-discipline",
      scale: "0-4",
      question: "Does it change only what the task needs, without unrelated edits?",
    },
    {
      id: "test-integrity",
      scale: "0-4",
      question: "Are existing tests left alone, and are added tests meaningful?",
    },
    {
      id: "readability",
      scale: "0-4",
      question:
        "Is the code clear and consistent with the repository's conventions (see CONTRIBUTING)?",
    },
    {
      id: "constraint-adherence",
      scale: "0-4",
      question: "Does it respect every constraint stated in the task text?",
    },
  ],
  responseShape: {
    packetId: "string",
    scores: { correctness: "0-4" },
    rationale: "one or two sentences per criterion",
  },
  limits:
    "An ordinal rubric over a small sample; scores are not pooled across tasks and are never read as a ranking.",
};

export function buildPackets(inputs: BlindingInput[], seed: string) {
  const order = shuffled(inputs, `${seed}:blinding`);
  const packets: Packet[] = [];
  const mapping: Record<string, { runId: string; arm: string; repo: string; task: string }> = {};
  const leaks: string[] = [];
  order.forEach((r, i) => {
    const packetId = `P${String(i + 1).padStart(3, "0")}`;
    const packet: Packet = {
      packetId,
      task: r.task,
      repositoryLanguage: r.repo === "ts-service" ? "TypeScript" : "Python",
      prompt: scrubIdentity(r.prompt),
      diff: scrubIdentity(r.diff),
      successCheckOutput: scrubIdentity(r.successOutput),
    };
    if (leaksIdentity(JSON.stringify(packet))) leaks.push(packetId);
    packets.push(packet);
    mapping[packetId] = { runId: r.runId, arm: r.arm, repo: r.repo, task: r.task };
  });
  return { packets, mapping, leaks };
}

/** Writes packets + rubric under `packetsDir`, and the mapping only under `mappingDir`. */
export function writeBlindedReview(
  built: ReturnType<typeof buildPackets>,
  packetsDir: string,
  mappingDir: string,
) {
  if (
    path.resolve(packetsDir) === path.resolve(mappingDir) ||
    path.resolve(mappingDir).startsWith(path.resolve(packetsDir) + path.sep)
  )
    throw new Error("the blinding map must live outside the packets directory");
  if (built.leaks.length)
    throw new Error(`identity leaked into packets: ${built.leaks.join(", ")}`);
  mkdirSync(packetsDir, { recursive: true });
  mkdirSync(mappingDir, { recursive: true });
  for (const p of built.packets)
    writeFileSync(path.join(packetsDir, `${p.packetId}.json`), `${JSON.stringify(p, null, 2)}\n`);
  writeFileSync(path.join(packetsDir, "rubric.json"), `${JSON.stringify(RUBRIC, null, 2)}\n`);
  writeFileSync(
    path.join(mappingDir, "blinding-map.json"),
    `${JSON.stringify(built.mapping, null, 2)}\n`,
  );
}
