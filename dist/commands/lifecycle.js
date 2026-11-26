import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readSpecificationIssue } from "@comforge/github";
import { loadInitiative, requireCheckout } from "../context.js";
import { CliError, EXIT, fail } from "../errors.js";
import { githubError } from "../github.js";
import { specificationProtocol } from "../protocols.js";
import { checkoutDir, checkoutParent, fetchBase, initiativeFromBranch, parseInitiative, trustedConfigAt, } from "../repository.js";
import { childEnv, git, gitOk } from "../runtime.js";
import { nowIso } from "../state.js";
// --- start ------------------------------------------------------------------------------
export async function start(ctx, options) {
    const { rt, repo } = ctx;
    const working = ctx.working();
    const baseSha = fetchBase(rt, repo.root, working);
    const { config: trusted, digest } = trustedConfigAt(rt, repo.root, baseSha);
    if (trusted.repository.remote !== working.repository.remote ||
        trusted.repository.baseBranch !== working.repository.baseBranch)
        fail("untrusted-config-change", "the working configuration names another remote or base branch than the base revision's", {
            base: { remote: trusted.repository.remote, branch: trusted.repository.baseBranch },
        });
    const initiative = parseInitiative(options.id, trusted);
    if (await ctx.state.get(initiative.id))
        fail("conflict", `${initiative.id} is already started; use comforge status or comforge revise`, {
            initiative: initiative.id,
        });
    // A phase must start from the same specification its ticket started from.
    const parent = initiative.phase ? await ctx.state.get(initiative.ticket) : null;
    const specification = await verifiedSpecification(ctx, trusted, initiative.ticket, options, parent);
    const checkout = checkoutDir(trusted, repo.root, initiative);
    if (existsSync(checkout))
        fail("would-overwrite", `${checkout} already exists`, { checkout });
    mkdirSync(checkoutParent(trusted, repo.root), { recursive: true });
    const { remote, baseBranch } = trusted.repository;
    const remoteUrl = git(rt, repo.root, ["config", "--get", `remote.${remote}.url`]);
    git(rt, repo.root, [
        "clone",
        "--quiet",
        "--no-hardlinks",
        "--no-checkout",
        "--origin",
        remote,
        repo.root,
        checkout,
    ]);
    const provisioned = [];
    try {
        git(rt, checkout, ["remote", "set-url", remote, remoteUrl]);
        git(rt, checkout, [
            "fetch",
            "--quiet",
            remote,
            `+refs/heads/${baseBranch}:refs/remotes/${remote}/${baseBranch}`,
        ]);
        git(rt, checkout, ["checkout", "--quiet", "-b", initiative.branch, baseSha]);
        if (options.provision !== false)
            for (const command of trusted.checkout.provision) {
                const r = rt.run(command[0], command.slice(1), {
                    cwd: checkout,
                    env: childEnv(rt.env, { dropCredentials: credentialVariables(trusted) }),
                });
                if (r.status !== 0)
                    throw new CliError("io", `provisioning failed: ${command.join(" ")}`, {
                        command,
                        status: r.status,
                        stderr: r.stderr.slice(-2000),
                    });
                provisioned.push(command.join(" "));
            }
    }
    catch (error) {
        // Only what this invocation created is removed.
        rmSync(checkout, { recursive: true, force: true });
        throw error;
    }
    const record = await ctx.state.create({
        ticket: initiative.ticket,
        phase: initiative.phase,
        branch: initiative.branch,
        checkout,
        primary: repo.root,
        base: { remote, branch: baseBranch, sha: baseSha },
        trustedConfig: digest,
        specification,
        validations: [],
        revisions: [],
        publications: [],
        completions: [],
        operations: [],
        cleanedAt: null,
    }, initiative.id);
    return {
        result: {
            initiative: record.operationId,
            branch: record.branch,
            checkout,
            base: record.base,
            specification,
            provisioned,
        },
    };
}
export const credentialVariables = (config) => config.security.credentials.source === "env" ? [config.security.credentials.variable] : [];
async function verifiedSpecification(ctx, trusted, ticket, options, parent) {
    const protocol = specificationProtocol(trusted);
    if (options.issue === undefined) {
        if (protocol && trusted.specification?.required)
            fail("specification-invalid", "this repository requires --issue N naming the published specification");
        if (parent?.specification)
            fail("specification-invalid", `the phase must name #${parent.specification.issueNumber}, as ${ticket} did`);
        return null;
    }
    if (!protocol)
        fail("config-invalid", "--issue needs a specification section in the configuration");
    const read = await readSpecificationIssue(ctx.github(trusted).evidence, protocol, options.issue).catch(githubError);
    if (read.issue.isPullRequest)
        fail("specification-invalid", `#${options.issue} is a pull request`);
    if (read.issue.state !== "open")
        fail("stale", `#${options.issue} is ${read.issue.state}`);
    const v = read.verification;
    if (!v)
        fail("specification-invalid", `#${options.issue} is not a published specification`);
    const verification = v;
    if (verification.ticketId !== ticket)
        fail("conflict", `#${options.issue} specifies ${verification.ticketId}, not ${ticket}`);
    if (!verification.digestMatches)
        fail("stale", `#${options.issue} was edited after publication; its digest no longer matches`);
    if (options.expectDigest && options.expectDigest !== verification.digest)
        fail("conflict", "the specification digest is not the expected one", {
            expected: options.expectDigest,
            actual: verification.digest,
        });
    if (parent?.specification &&
        (parent.specification.issueNumber !== options.issue ||
            parent.specification.digest !== verification.digest))
        fail("conflict", `${ticket} started from another specification; a phase keeps it`);
    return { issueNumber: options.issue, digest: verification.digest };
}
// --- revise -----------------------------------------------------------------------------
export async function revise(ctx, options) {
    const working = ctx.working();
    const pull = await ctx.github(working).evidence.getPullRequest(options.pr).catch(githubError);
    const initiative = initiativeFromBranch(pull.head.ref, working);
    if (!initiative)
        fail("not-found", `#${options.pr} (${pull.head.ref}) is not an initiative branch`);
    const { record, trusted } = await loadInitiative(ctx, initiative.id);
    if (pull.head.repository !== `${trusted.repository.owner}/${trusted.repository.name}`)
        fail("policy-denied", "the pull request head is not in this repository");
    if (pull.state !== "open")
        fail("stale", `#${options.pr} is ${pull.merged ? "merged" : "closed"}`);
    if (options.reviewedHead && options.reviewedHead !== pull.head.sha)
        fail("stale", "the review is of an older head than the pull request's", {
            reviewed: options.reviewedHead,
            current: pull.head.sha,
        });
    const checkout = requireCheckout(record);
    const head = git(ctx.rt, checkout, ["rev-parse", "HEAD"]);
    if (head !== pull.head.sha &&
        !gitOk(ctx.rt, checkout, ["merge-base", "--is-ancestor", pull.head.sha, head]))
        fail("stale", "the checkout does not contain the pull request head; fetch and reconcile it first", {
            checkout: head,
            pullRequest: pull.head.sha,
        });
    const updated = await ctx.state.update(record.operationId, (r) => {
        r.revisions.push({
            prNumber: options.pr,
            reviewedHead: pull.head.sha,
            at: nowIso(ctx.rt.now()),
        });
    });
    return {
        result: {
            initiative: updated.operationId,
            checkout,
            pullRequest: options.pr,
            reviewedHead: pull.head.sha,
            checkoutHead: head,
        },
    };
}
// --- status -----------------------------------------------------------------------------
export function stageOf(record) {
    if (record.cleanedAt)
        return "cleaned";
    if (record.completions.length > 0)
        return "completed";
    if (record.publications.length > 0)
        return "published";
    if (record.validations.at(-1)?.status === "PASS")
        return "verified";
    return "started";
}
const summary = (r) => ({
    initiative: r.operationId,
    stage: stageOf(r),
    branch: r.branch,
    checkout: r.checkout,
    base: r.base,
    specification: r.specification,
    lastValidation: r.validations.at(-1) ?? null,
    lastPublication: r.publications.at(-1) ?? null,
    lastCompletion: r.completions.at(-1) ?? null,
    cleanedAt: r.cleanedAt,
});
export async function status(ctx, options) {
    if (options.id) {
        const record = await ctx.state.get(options.id);
        if (!record)
            fail("not-found", `${options.id} has no local state`, { initiative: options.id });
        const r = record;
        return {
            result: {
                ...summary(r),
                validations: r.validations,
                publications: r.publications,
                completions: r.completions,
                revisions: r.revisions,
                operations: r.operations,
            },
        };
    }
    const all = await ctx.state.list();
    return { result: { initiatives: all.map(summary) } };
}
// --- verify -----------------------------------------------------------------------------
export async function verify(ctx, options) {
    const { rt } = ctx;
    const { record, trusted } = await loadInitiative(ctx, options.id);
    const checkout = requireCheckout(record);
    const dirty = git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]);
    if (dirty)
        fail("dirty-checkout", "commit or remove local changes first; verification is of a commit", {
            changes: dirty.split("\n").slice(0, 20),
        });
    const head = git(rt, checkout, ["rev-parse", "HEAD"]);
    if (options.commit && options.commit !== head)
        fail("stale", "the checkout is not at the requested commit", {
            requested: options.commit,
            head,
        });
    const tree = git(rt, checkout, ["rev-parse", "HEAD^{tree}"]);
    const missingTrailer = commitsWithoutTrailer(ctx, trusted, record, checkout);
    if (missingTrailer.length > 0)
        fail("policy-denied", `commits without "${trusted.commits.trailer}: ${record.ticket}"`, {
            commits: missingTrailer,
        });
    // Validation runs the candidate's code: never with the GitHub credential, never with the
    // developer's gh login. The CLI is not a sandbox; see the README's security section.
    const ghHome = mkdtempSync(path.join(tmpdir(), "comforge-gh-"));
    const commands = [];
    try {
        const env = {
            ...childEnv(rt.env, { dropCredentials: credentialVariables(trusted) }),
            GH_CONFIG_DIR: ghHome,
            COMFORGE_VERIFY: "1",
        };
        for (const command of trusted.validation.commands) {
            const started = rt.now();
            const r = rt.run(command.run[0], command.run.slice(1), {
                cwd: checkout,
                env,
                timeoutMs: trusted.validation.timeoutSeconds * 1000,
            });
            commands.push({
                name: command.name,
                exitStatus: r.status,
                timedOut: r.timedOut,
                durationMs: rt.now() - started,
            });
            if (r.status !== 0)
                break;
        }
    }
    finally {
        rmSync(ghHome, { recursive: true, force: true });
    }
    const after = git(rt, checkout, ["rev-parse", "HEAD"]);
    const changed = git(rt, checkout, ["status", "--porcelain", "--untracked-files=normal"]);
    const passed = commands.length === trusted.validation.commands.length &&
        commands.every((c) => c.exitStatus === 0) &&
        after === head &&
        changed === "";
    const validation = {
        commit: head,
        tree,
        status: passed ? "PASS" : "FAIL",
        at: nowIso(rt.now()),
        commands,
    };
    await ctx.state.update(record.operationId, (r) => {
        r.validations.push(validation);
    });
    return {
        result: {
            initiative: record.operationId,
            ...validation,
            ...(after !== head || changed
                ? { note: "validation changed the checkout; the result is FAIL" }
                : {}),
        },
        exit: passed ? EXIT.ok : EXIT.refused,
    };
}
function commitsWithoutTrailer(ctx, trusted, record, checkout) {
    const trailer = trusted.commits.trailer;
    if (!trailer)
        return [];
    const log = git(ctx.rt, checkout, [
        "log",
        "--no-merges",
        `--format=%H%x1f%(trailers:key=${trailer},valueonly,separator=%x1e)%x1d`,
        `${record.base.sha}..HEAD`,
    ]);
    return log
        .split("\x1d")
        .map((entry) => entry.trim())
        .filter(Boolean)
        .filter((entry) => {
        const [sha, values = ""] = entry.split("\x1f");
        return (!values
            .split("\x1e")
            .map((v) => v.trim())
            .includes(record.ticket) && sha);
    })
        .map((entry) => entry.split("\x1f")[0]);
}
// --- cleanup ----------------------------------------------------------------------------
export async function cleanup(ctx, options) {
    let id = options.target;
    let pull = null;
    if (/^\d+$/.test(options.target)) {
        const working = ctx.working();
        pull = await ctx
            .github(working)
            .evidence.getPullRequest(Number(options.target))
            .catch(githubError);
        const initiative = initiativeFromBranch(pull.head.ref, working);
        if (!initiative)
            fail("not-found", `#${options.target} is not an initiative's pull request`);
        id = initiative.id;
    }
    const { record, trusted } = await loadInitiative(ctx, id);
    const published = record.publications.at(-1) ?? null;
    if (published) {
        pull ??= await ctx
            .github(trusted)
            .evidence.getPullRequest(published.prNumber)
            .catch(githubError);
        if (!pull.merged)
            fail("policy-denied", `#${pull.number} is not merged; cleanup follows a merge`, {
                state: pull.state,
            });
        if (pull.head.sha !== published.commit)
            fail("stale", "the merged head is not the published one", {
                merged: pull.head.sha,
                published: published.commit,
            });
    }
    const delivered = published?.commit ?? null;
    const completion = record.completions.find((c) => delivered === null || c.commit === delivered);
    if (!completion && !options.allowMissingCompletion)
        fail("policy-denied", "no completion record for the delivered head; run comforge complete, or pass --allow-missing-completion", {
            head: delivered,
        });
    const actions = [];
    if (existsSync(record.checkout)) {
        const dirty = git(ctx.rt, record.checkout, [
            "status",
            "--porcelain",
            "--untracked-files=normal",
        ]);
        if (dirty)
            fail("dirty-checkout", "the checkout has uncommitted changes", {
                changes: dirty.split("\n").slice(0, 20),
            });
        const head = git(ctx.rt, record.checkout, ["rev-parse", "HEAD"]);
        if (delivered && head !== delivered)
            fail("dirty-checkout", "the checkout has commits that were never published", {
                head,
                published: delivered,
            });
        const top = git(ctx.rt, record.checkout, ["rev-parse", "--show-toplevel"]);
        if (path.resolve(top) !== path.resolve(record.checkout))
            fail("conflict", "the recorded checkout is not a repository root; refusing to remove it");
        actions.push(`remove ${record.checkout}`);
    }
    actions.push("mark the initiative cleaned");
    if (!options.execute)
        return { result: { initiative: id, executed: false, actions } };
    if (existsSync(record.checkout))
        rmSync(record.checkout, { recursive: true, force: true });
    await ctx.state.update(id, (r) => {
        r.cleanedAt = nowIso(ctx.rt.now());
    });
    return { result: { initiative: id, executed: true, actions } };
}
