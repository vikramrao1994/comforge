import type { ComforgeConfig } from "./config.ts";
import { type Runtime } from "./runtime.ts";
import type { ProvisionStep } from "./state.ts";
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
export declare const PROVISION_RESULT_SCHEMA = "comforge-provision-result/v1";
/** Runs the trusted provisioning commands in `checkout`; throws on the first failure. */
export declare function provision(rt: Runtime, trusted: ComforgeConfig, checkout: string, primary: string, dropCredentials: readonly string[], purpose?: "checkout" | "snapshot"): ProvisionStep[];
