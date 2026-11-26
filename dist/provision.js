import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { CliError } from "./errors.js";
import { detectSecrets } from "./protocols.js";
import { childEnv } from "./runtime.js";
/**
 * R4: provisioning commands and what they report.
 *
 * Each `checkout.provision` command runs in the new checkout, without the GitHub credential,
 * with three variables: `COMFORGE_PRIMARY` (the primary checkout, for host scripts that copy
 * from it), `COMFORGE_PROVISION_PURPOSE` (`checkout` for a working checkout, `snapshot` for a
 * verification clone, where a host script should not link developer files) and
 * `COMFORGE_PROVISION_RESULT` (a file in a directory the CLI created outside the checkout). A command may write `comforge-provision-result/v1` JSON there, for example the
 * digest of what it copied; the CLI records it as evidence. The file is optional; when present
 * it must be a regular file (never a link), at most 64 KiB, strictly in the schema and free of
 * secret-like text, or provisioning fails and the new checkout is removed.
 */
export const PROVISION_RESULT_SCHEMA = "comforge-provision-result/v1";
const MAX_RESULT_BYTES = 64 * 1024;
const ProvisionResult = z
    .object({
    schema: z.literal(PROVISION_RESULT_SCHEMA),
    steps: z
        .array(z
        .object({
        name: z.string().regex(/^[a-z0-9][a-z0-9:._-]{0,63}$/),
        detail: z.string().max(500),
        digest: z
            .string()
            .regex(/^(sha256:)?[0-9a-f]{64}$/)
            .optional(),
    })
        .strict())
        .max(20),
})
    .strict();
function readResult(file, command) {
    let stat;
    try {
        stat = lstatSync(file);
    }
    catch {
        return [];
    }
    const refuse = (message) => {
        throw new CliError("io", `provisioning result of ${command}: ${message}`, { command });
    };
    if (!stat.isFile())
        refuse("not a regular file");
    if (stat.size > MAX_RESULT_BYTES)
        refuse(`larger than ${MAX_RESULT_BYTES} bytes`);
    let raw;
    try {
        raw = JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return refuse("not JSON");
    }
    const parsed = ProvisionResult.safeParse(raw);
    if (!parsed.success)
        return refuse(`not ${PROVISION_RESULT_SCHEMA}`);
    for (const step of parsed.data.steps)
        if (detectSecrets(`${step.name} ${step.detail}`).count > 0)
            refuse("it contains secret-like text, which is never recorded");
    return parsed.data.steps;
}
/** Runs the trusted provisioning commands in `checkout`; throws on the first failure. */
export function provision(rt, trusted, checkout, primary, dropCredentials, purpose = "checkout") {
    const done = [];
    for (const command of trusted.checkout.provision) {
        const label = command.join(" ");
        const dir = mkdtempSync(path.join(tmpdir(), "comforge-provision-"));
        const resultFile = path.join(dir, "result.json");
        try {
            const r = rt.run(command[0], command.slice(1), {
                cwd: checkout,
                env: {
                    ...childEnv(rt.env, { dropCredentials }),
                    COMFORGE_PRIMARY: primary,
                    COMFORGE_PROVISION_PURPOSE: purpose,
                    COMFORGE_PROVISION_RESULT: resultFile,
                },
            });
            if (r.status !== 0)
                throw new CliError("io", `provisioning failed: ${label}`, {
                    command,
                    status: r.status,
                    stderr: r.stderr.slice(-2000),
                });
            done.push({ command: label, steps: readResult(resultFile, label) });
        }
        finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    return done;
}
