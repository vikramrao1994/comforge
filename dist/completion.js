import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { z } from "zod";
import { assertIdentity, hasControlCharacter } from "./identity.js";
import { FINDING_ID_PATTERN, FINDING_SEVERITIES } from "./review.js";
import { canonicalBody } from "./specification.js";
/**
 * Issue completion records: input contract, consistency and content rules, canonical
 * payload, digest, rendering and marker decoding. Pure: no I/O, no environment, no
 * clock. Secret detection and link formats are supplied by the caller.
 *
 * A ticket reports its outcome as one comment on its issue: a human-readable rendering
 * plus one hidden marker carrying the structured result:
 *
 *   <!-- <namespace>:completion v1 issue=<n> ticket=<id> digest=<64 hex> payload=<base64url JSON> -->
 *
 * digest = SHA-256 of `<completionScheme>\n` + the payload JSON (schema field order,
 * so the JSON is its own canonical form). A reader recomputes it, so an edited payload
 * reads as `integrity: "mismatch"`. An earlier result is never edited: a new record
 * lists what it supersedes.
 *
 * The marker is unkeyed: anyone who can comment can forge one. Integrity says nothing
 * about the author; which author's record counts, and which record is current, is the
 * caller's trusted decision. A completion record reports work; it never approves,
 * merges, deploys, closes an issue or authorizes execution.
 */
export const COMPLETION_NOTICE = "Completion result. It reports work; it is not an approval, not a merge or deployment " +
    "authorization, not an issue closure and not an authorization to execute anything.";
/**
 * Issue type → what a `completed` result must contain and whether a pull request
 * is the deliverable. `pr: "required"` applies to completed and partial results;
 * `pr: "on_request"` means a PR may be linked only with the explicit request
 * that asked for it (`pullRequest.reason`).
 */
export const ISSUE_TYPE_MATRIX = {
    audit: { family: "audit", sections: ["verdict", "recommendations"], pr: "on_request" },
    security_audit: { family: "audit", sections: ["verdict", "recommendations"], pr: "on_request" },
    architecture_audit: {
        family: "audit",
        sections: ["verdict", "recommendations"],
        pr: "on_request",
    },
    investigation: {
        family: "investigation",
        sections: ["reproduction", "observations", "root_cause", "recommendation"],
        pr: "on_request",
    },
    architecture: {
        family: "architecture",
        sections: ["options", "tradeoffs", "decision", "rationale"],
        pr: "on_request",
    },
    implementation: { family: "implementation", sections: ["changed_behavior"], pr: "required" },
    bug_fix: { family: "implementation", sections: ["changed_behavior"], pr: "required" },
    refactor: { family: "implementation", sections: ["changed_behavior"], pr: "required" },
    experiment: {
        family: "experiment",
        sections: ["hypothesis", "method", "results"],
        pr: "on_request",
    },
};
export const ISSUE_TYPES = Object.keys(ISSUE_TYPE_MATRIX);
export const SECTION_KEYS = [
    "verdict",
    "recommendations",
    "reproduction",
    "observations",
    "root_cause",
    "recommendation",
    "options",
    "tradeoffs",
    "decision",
    "rationale",
    "changed_behavior",
    "hypothesis",
    "method",
    "results",
];
export const OUTCOMES = ["completed", "partial", "blocked", "failed"];
export const GATE_STATUSES = ["PASS", "FAIL", "UNAVAILABLE", "SKIPPED"];
export const CONFIDENCES = ["high", "medium", "low"];
export const DISPOSITIONS = ["open_until_merge", "owner_may_close", "leave_open"];
export const COMPLETION_LIMITS = {
    summaryMaxChars: 3_000,
    sectionMaxChars: 3_000,
    findingsMax: 30,
    findingTitleMaxChars: 200,
    findingTextMaxChars: 2_000,
    gatesMax: 20,
    gateTextMaxChars: 300,
    pathsMax: 50,
    pathMaxChars: 200,
    notesMax: 15,
    noteMaxChars: 800,
    // GitHub rejects comments over 65,536 characters; rendering + base64 payload must fit.
    commentMaxChars: 65_000,
};
const SHA = z.string().regex(/^[0-9a-f]{40}$/, "a full 40-character lowercase commit SHA");
const DIGEST = z.string().regex(/^[0-9a-f]{64}$/, "the 64-character specification digest");
const line = (max) => z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0 && !hasControlCharacter(v), "a non-empty single line");
const text = (max) => z
    .string()
    .min(1)
    .max(max)
    .refine((v) => v.trim().length > 0, "non-empty text");
const repoPath = z
    .string()
    .min(1)
    .max(COMPLETION_LIMITS.pathMaxChars)
    .refine((p) => !p.startsWith("/") &&
    !p.includes("\\") &&
    !p.split("/").some((part) => part === ".." || part === "." || part === "") &&
    !hasControlCharacter(p), "a repository-relative path without '..'");
const notes = z
    .array(text(COMPLETION_LIMITS.noteMaxChars))
    .max(COMPLETION_LIMITS.notesMax)
    .default([]);
/** Strict: an approval, merge, close, label or execution flag is rejected, never ignored. */
function buildInputSchema(completionScheme, ticketPattern, runnerId) {
    return z
        .object({
        contract: z.literal(completionScheme),
        issueNumber: z.number().int().min(1).max(10_000_000),
        ticketId: z.string().max(80).regex(ticketPattern, "an engineering ticket ID"),
        specificationDigest: DIGEST,
        issueType: z.enum(ISSUE_TYPES),
        outcome: z.enum(OUTCOMES),
        sourceRevision: SHA,
        pullRequest: z
            .object({
            number: z.number().int().min(1).max(10_000_000),
            headSha: SHA,
            reason: line(COMPLETION_LIMITS.noteMaxChars).optional(),
        })
            .strict()
            .optional(),
        execution: z
            .object({
            runner: z.literal(runnerId),
            model: line(80).optional(),
        })
            .strict(),
        summary: text(COMPLETION_LIMITS.summaryMaxChars),
        sections: z
            .partialRecord(z.enum(SECTION_KEYS), text(COMPLETION_LIMITS.sectionMaxChars))
            .default({}),
        blocker: text(COMPLETION_LIMITS.noteMaxChars).optional(),
        findings: z
            .array(z
            .object({
            id: z.string().regex(FINDING_ID_PATTERN, "a stable finding ID such as H1 or SEC-3"),
            severity: z.enum(FINDING_SEVERITIES),
            confidence: z.enum(CONFIDENCES),
            title: line(COMPLETION_LIMITS.findingTitleMaxChars),
            evidence: text(COMPLETION_LIMITS.findingTextMaxChars),
            recommendation: text(COMPLETION_LIMITS.findingTextMaxChars).optional(),
        })
            .strict())
            .max(COMPLETION_LIMITS.findingsMax)
            .default([])
            .refine((items) => new Set(items.map((f) => f.id)).size === items.length, "unique IDs"),
        changedArtifacts: z.array(repoPath).max(COMPLETION_LIMITS.pathsMax).default([]),
        evidence: z
            .array(z.object({ path: repoPath, commit: SHA }).strict())
            .max(COMPLETION_LIMITS.pathsMax)
            .default([]),
        validation: z
            .array(z
            .object({
            gate: line(COMPLETION_LIMITS.gateTextMaxChars),
            command: line(COMPLETION_LIMITS.gateTextMaxChars).optional(),
            status: z.enum(GATE_STATUSES),
            reason: line(COMPLETION_LIMITS.gateTextMaxChars).optional(),
        })
            .strict())
            .max(COMPLETION_LIMITS.gatesMax)
            .default([]),
        limitations: notes,
        nextSteps: notes,
    })
        .strict();
}
const GateSchema = z
    .object({
    gate: z.string(),
    command: z.string().nullable(),
    status: z.enum(GATE_STATUSES),
    reason: z.string().nullable(),
    // `lifecycle-ledger`: read by the publisher from the exact-snapshot validation of
    // the head; `reported`: stated by the executing agent.
    source: z.enum(["lifecycle-ledger", "reported"]),
})
    .strict();
function buildPayloadSchema(completionScheme, ticketPattern) {
    return z
        .object({
        scheme: z.literal(completionScheme),
        repository: z.string(),
        issueNumber: z.number().int().positive(),
        ticketId: z.string().regex(ticketPattern),
        specification: z.object({ digest: DIGEST, digestVerified: z.boolean() }).strict(),
        issueType: z.enum(ISSUE_TYPES),
        outcome: z.enum(OUTCOMES),
        disposition: z.enum(DISPOSITIONS),
        sourceRevision: SHA,
        pullRequest: z
            .object({
            number: z.number().int().positive(),
            headSha: SHA,
            reason: z.string().nullable(),
        })
            .strict()
            .nullable(),
        execution: z.object({ runner: z.string(), model: z.string().nullable() }).strict(),
        summary: z.string(),
        sections: z.array(z.object({ key: z.enum(SECTION_KEYS), text: z.string() }).strict()),
        blocker: z.string().nullable(),
        findings: z.array(z
            .object({
            id: z.string(),
            severity: z.enum(FINDING_SEVERITIES),
            confidence: z.enum(CONFIDENCES),
            title: z.string(),
            evidence: z.string(),
            recommendation: z.string().nullable(),
        })
            .strict()),
        changedArtifacts: z.array(z.string()),
        evidence: z.array(z.object({ path: z.string(), commit: SHA }).strict()),
        validation: z.array(GateSchema),
        limitations: z.array(z.string()),
        nextSteps: z.array(z.string()),
        supersedes: z.array(z.number().int().positive()),
    })
        .strict();
}
// Local paths would disclose the author's machine layout in a published comment.
const LOCAL_PATH = /(?:^|[\s`'"(=])(?:\/Users\/|\/home\/|\/private\/|\/var\/folders\/|\/tmp\/|~\/|[A-Za-z]:\\)/;
// Text outside inline code that would notify a forge user.
const MENTION = /(?:^|[^\w`])@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\b/;
function outsideCode(value) {
    return value.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}
export function deriveDisposition(issueType, outcome) {
    if (outcome !== "completed")
        return "leave_open";
    return ISSUE_TYPE_MATRIX[issueType].family === "implementation"
        ? "open_until_merge"
        : "owner_may_close";
}
const OUTCOME_LABEL = {
    completed: "Completed",
    partial: "Partial",
    blocked: "Blocked",
    failed: "Failed",
};
const TYPE_LABEL = {
    audit: "Audit",
    security_audit: "Security audit",
    architecture_audit: "Architecture audit",
    investigation: "Investigation",
    architecture: "Architecture decision",
    implementation: "Implementation",
    bug_fix: "Bug fix",
    refactor: "Refactor",
    experiment: "Experiment",
};
const SECTION_LABEL = {
    verdict: "Verdict",
    recommendations: "Recommendations",
    reproduction: "Reproduction",
    observations: "Observations",
    root_cause: "Root cause",
    recommendation: "Recommendation",
    options: "Options",
    tradeoffs: "Tradeoffs",
    decision: "Decision",
    rationale: "Rationale",
    changed_behavior: "Changed behavior",
    hypothesis: "Hypothesis",
    method: "Method",
    results: "Results",
};
const DISPOSITION_LABEL = {
    open_until_merge: "stays open until the pull request is merged or the owner decides otherwise",
    owner_may_close: "work delivered; the owner decides whether to close it",
    leave_open: "stays open — the work is not complete",
};
const SEVERITY_LABEL = {
    critical: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
    info: "Info",
};
const cell = (value) => value.replace(/\|/g, "\\|").replace(/\n/g, " ");
export function createCompletionProtocol(config) {
    assertIdentity("completion", "completionScheme", "scheme", config.completionScheme);
    assertIdentity("completion", "repository", "repository", config.repository);
    assertIdentity("completion", "markerNamespace", "markerNamespace", config.markerNamespace);
    assertIdentity("completion", "runner.id", "runnerId", config.runner?.id);
    assertIdentity("completion", "runner.label", "label", config.runner?.label);
    assertIdentity("completion", "publishCommand", "command", config.publishCommand);
    if (!(config.ticketPattern instanceof RegExp))
        throw new TypeError("factory-core: invalid completion protocol ticketPattern");
    if (typeof config.redact !== "function")
        throw new TypeError("factory-core: invalid completion protocol redact");
    if (typeof config.links?.comment !== "function" || typeof config.links?.blob !== "function")
        throw new TypeError("factory-core: invalid completion protocol links");
    const markerPrefix = `${config.markerNamespace}:`;
    const reservedMarkerPrefixes = Object.freeze([...config.reservedMarkerPrefixes]);
    if (!reservedMarkerPrefixes.includes(markerPrefix) ||
        reservedMarkerPrefixes.some((p) => typeof p !== "string" || p.length === 0))
        throw new TypeError("factory-core: invalid completion protocol reservedMarkerPrefixes");
    const { completionScheme, repository, markerNamespace, ticketPattern, publishCommand, redact } = config;
    const runner = Object.freeze({ ...config.runner });
    const links = config.links;
    const inputSchema = buildInputSchema(completionScheme, ticketPattern, runner.id);
    const payloadSchema = buildPayloadSchema(completionScheme, ticketPattern);
    const markerPattern = new RegExp(`<!-- ${markerNamespace}:completion v1 issue=([0-9]{1,10}) ticket=([A-Z0-9-]{1,80}) digest=([0-9a-f]{64}) payload=([A-Za-z0-9_-]{1,200000}) -->`);
    const completionTexts = (input) => [
        input.summary,
        input.blocker ?? "",
        input.pullRequest?.reason ?? "",
        input.execution.model ?? "",
        ...Object.values(input.sections),
        ...input.findings.flatMap((f) => [f.title, f.evidence, f.recommendation ?? ""]),
        ...input.validation.flatMap((g) => [g.gate, g.command ?? "", g.reason ?? ""]),
        ...input.changedArtifacts,
        ...input.evidence.map((e) => e.path),
        ...input.limitations,
        ...input.nextSteps,
    ];
    const textProblems = (values) => {
        const problems = [];
        for (const value of values) {
            if (reservedMarkerPrefixes.some((prefix) => value.includes(prefix)))
                problems.push("text contains a reserved server marker prefix");
            if (value.includes("<!--") || value.includes("-->"))
                problems.push("text contains an HTML comment, which would hide content in the rendering");
            if (LOCAL_PATH.test(value))
                problems.push("text contains a local filesystem path");
            if (MENTION.test(outsideCode(value)))
                problems.push("text contains an @mention outside inline code");
            const redaction = redact(value);
            if (redaction.count > 0)
                problems.push(`text contains secret-like values (${redaction.kinds.join(", ")})`);
        }
        return [...new Set(problems)];
    };
    const contentProblems = (input) => textProblems(completionTexts(input));
    const consistencyProblems = (input) => {
        const problems = [];
        const spec = ISSUE_TYPE_MATRIX[input.issueType];
        const sectionKeys = Object.keys(input.sections);
        for (const key of sectionKeys)
            if (!spec.sections.includes(key))
                problems.push(`section "${key}" does not belong to a ${input.issueType} result`);
        if (input.outcome === "completed") {
            for (const key of spec.sections)
                if (!sectionKeys.includes(key))
                    problems.push(`a completed ${input.issueType} needs section "${key}"`);
            if (input.blocker)
                problems.push("a completed result cannot have a blocker");
            const failed = input.validation.filter((g) => g.status === "FAIL").map((g) => g.gate);
            if (failed.length > 0)
                problems.push(`a completed result cannot have failing gates (${failed.join(", ")}); report partial or failed`);
        }
        if ((input.outcome === "blocked" || input.outcome === "failed") && !input.blocker)
            problems.push(`a ${input.outcome} result needs a blocker`);
        if (input.outcome === "partial" && input.limitations.length === 0)
            problems.push("a partial result needs at least one limitation");
        if (input.outcome !== "completed" && input.nextSteps.length === 0)
            problems.push(`a ${input.outcome} result needs at least one next step`);
        for (const gate of input.validation)
            if (gate.status !== "PASS" && !gate.reason)
                problems.push(`gate "${gate.gate}" is ${gate.status} and needs a reason`);
        if (spec.pr === "required") {
            if ((input.outcome === "completed" || input.outcome === "partial") && !input.pullRequest)
                problems.push(`a ${input.outcome} ${input.issueType} needs its pull request`);
            if (input.pullRequest && input.pullRequest.headSha !== input.sourceRevision)
                problems.push("sourceRevision must be the pull request head that was validated");
        }
        else if (input.pullRequest && !input.pullRequest.reason) {
            problems.push(`a ${input.issueType} result links a pull request only with the explicit request for it (pullRequest.reason)`);
        }
        return problems;
    };
    const buildCompletionPayload = (input, context) => {
        const order = ISSUE_TYPE_MATRIX[input.issueType].sections;
        return {
            scheme: completionScheme,
            repository,
            issueNumber: input.issueNumber,
            ticketId: input.ticketId,
            specification: { digest: input.specificationDigest, digestVerified: context.digestVerified },
            issueType: input.issueType,
            outcome: input.outcome,
            disposition: deriveDisposition(input.issueType, input.outcome),
            sourceRevision: input.sourceRevision,
            pullRequest: input.pullRequest
                ? {
                    number: input.pullRequest.number,
                    headSha: input.pullRequest.headSha,
                    reason: input.pullRequest.reason?.normalize("NFC").trim() ?? null,
                }
                : null,
            execution: { runner: input.execution.runner, model: input.execution.model ?? null },
            summary: canonicalBody(input.summary),
            sections: Object.entries(input.sections)
                .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
                .map(([key, value]) => ({
                key: key,
                text: canonicalBody(value),
            })),
            blocker: input.blocker ? canonicalBody(input.blocker) : null,
            findings: input.findings.map((f) => ({
                id: f.id,
                severity: f.severity,
                confidence: f.confidence,
                title: f.title.normalize("NFC").trim(),
                evidence: canonicalBody(f.evidence),
                recommendation: f.recommendation ? canonicalBody(f.recommendation) : null,
            })),
            changedArtifacts: [...input.changedArtifacts],
            evidence: input.evidence.map((e) => ({ path: e.path, commit: e.commit })),
            validation: [
                ...context.ledgerGates,
                ...input.validation.map((g) => ({
                    gate: g.gate.normalize("NFC").trim(),
                    command: g.command?.trim() ?? null,
                    status: g.status,
                    reason: g.reason?.trim() ?? null,
                    source: "reported",
                })),
            ],
            limitations: input.limitations.map(canonicalBody),
            nextSteps: input.nextSteps.map(canonicalBody),
            supersedes: [...context.supersedes],
        };
    };
    const serializeCompletionPayload = (payload) => JSON.stringify(payloadSchema.parse(payload));
    const completionDigest = (serializedPayload) => createHash("sha256").update(`${completionScheme}\n${serializedPayload}`, "utf8").digest("hex");
    const sameResult = (a, b) => serializeCompletionPayload({ ...a, supersedes: [] }) ===
        serializeCompletionPayload({ ...b, supersedes: [] });
    const composeCompletionComment = (payload) => {
        const serialized = serializeCompletionPayload(payload);
        const digest = completionDigest(serialized);
        const lines = [
            payload.outcome === "completed" ? "> [!NOTE]" : "> [!WARNING]",
            `> **${COMPLETION_NOTICE}**`,
            "",
            `## ${OUTCOME_LABEL[payload.outcome]} · ${TYPE_LABEL[payload.issueType]} — ${payload.ticketId}`,
            "",
            `- Specification: #${payload.issueNumber} \`${payload.specification.digest}\`${payload.specification.digestVerified ? " (digest verified at publication)" : " (digest NOT verified)"}`,
            `- Source revision: \`${payload.sourceRevision}\``,
            payload.pullRequest
                ? `- Pull request: #${payload.pullRequest.number} at head \`${payload.pullRequest.headSha}\`${payload.pullRequest.reason ? ` — requested: ${payload.pullRequest.reason}` : ""}`
                : "- Pull request: none",
            `- Issue: ${DISPOSITION_LABEL[payload.disposition]}`,
            `- Executed by: ${runner.label}${payload.execution.model ? ` (${payload.execution.model})` : ""}`,
        ];
        if (payload.supersedes.length > 0)
            lines.push(`- Supersedes: ${payload.supersedes.map((id) => links.comment(payload.issueNumber, id)).join(", ")}`);
        lines.push("", "### Summary", "", payload.summary, "");
        if (payload.blocker)
            lines.push("### Blocker", "", payload.blocker, "");
        for (const section of payload.sections)
            lines.push(`### ${SECTION_LABEL[section.key]}`, "", section.text, "");
        if (payload.findings.length > 0) {
            lines.push("### Findings", "");
            for (const f of payload.findings) {
                lines.push(`#### ${f.id} · ${SEVERITY_LABEL[f.severity]} · confidence ${f.confidence} · ${f.title}`, "", f.evidence, "");
                if (f.recommendation)
                    lines.push(`**Recommendation:** ${f.recommendation}`, "");
            }
        }
        if (payload.validation.length > 0) {
            lines.push("### Validation", "", "| Gate | Status | Source | Command / reason |", "|---|---|---|---|");
            for (const g of payload.validation)
                lines.push(`| ${cell(g.gate)} | **${g.status}** | ${g.source === "lifecycle-ledger" ? "lifecycle ledger" : "reported by the agent"} | ${cell([g.command ? `\`${g.command}\`` : "", g.reason ?? ""].filter(Boolean).join(" — "))} |`);
            lines.push("");
        }
        if (payload.evidence.length > 0)
            lines.push("### Evidence", "", ...payload.evidence.map((e) => `- [\`${e.path}\`](${links.blob(e.commit, e.path)}) at \`${e.commit.slice(0, 12)}\``), "");
        if (payload.changedArtifacts.length > 0)
            lines.push("### Changed artifacts", "", ...payload.changedArtifacts.map((p) => `- \`${p}\``), "");
        if (payload.limitations.length > 0)
            lines.push("### Limitations", "", ...payload.limitations.map((l) => `- ${l}`), "");
        if (payload.nextSteps.length > 0)
            lines.push("### Next steps", "", ...payload.nextSteps.map((l) => `- ${l}`), "");
        lines.push("---", `<sub>Completion digest \`${completionScheme}:${digest}\` · published with \`${publishCommand}\`</sub>`, `<!-- ${markerNamespace}:completion v1 issue=${payload.issueNumber} ticket=${payload.ticketId} digest=${digest} payload=${Buffer.from(serialized, "utf8").toString("base64url")} -->`);
        return lines.join("\n");
    };
    const parseCompletionMarker = (body) => {
        const match = markerPattern.exec(body ?? "");
        if (!match)
            return null;
        const [, issue, ticketId, digest, payload] = match;
        if (!issue || !ticketId || !digest || !payload)
            return null;
        return { issueNumber: Number(issue), ticketId, digest, payload };
    };
    const decodeCompletion = (marker) => {
        let serialized;
        let parsed;
        try {
            serialized = Buffer.from(marker.payload, "base64url").toString("utf8");
            const result = payloadSchema.safeParse(JSON.parse(serialized));
            if (!result.success)
                return { integrity: "unreadable", payload: null };
            parsed = result.data;
        }
        catch {
            return { integrity: "unreadable", payload: null };
        }
        const consistent = completionDigest(serialized) === marker.digest &&
            parsed.issueNumber === marker.issueNumber &&
            parsed.ticketId === marker.ticketId &&
            parsed.repository === repository;
        return { integrity: consistent ? "verified" : "mismatch", payload: parsed };
    };
    return Object.freeze({
        scheme: completionScheme,
        repository,
        markerPrefix,
        inputSchema,
        payloadSchema,
        completionTexts,
        contentProblems,
        textProblems,
        consistencyProblems,
        buildCompletionPayload,
        serializeCompletionPayload,
        completionDigest,
        sameResult,
        composeCompletionComment,
        parseCompletionMarker,
        decodeCompletion,
    });
}
