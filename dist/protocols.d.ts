import { type CompletionProtocol, type Redaction, type SpecificationProtocol } from "@comforge/core";
import type { ComforgeConfig } from "./config.ts";
/**
 * The @comforge/core specification and completion protocols, bound to the identity in the
 * trusted configuration. The kernel holds the contracts (schemas, digests, markers,
 * rendering); the configuration only names them, so a repository that configures the same
 * names produces byte-identical records.
 */
export declare function specificationProtocol(config: ComforgeConfig): SpecificationProtocol | null;
export declare function detectSecrets(value: string): Redaction;
export declare function completionProtocol(config: ComforgeConfig): CompletionProtocol;
/** Comment authors GitHub reports as owning the repository; a result by anyone else is never current. */
export declare const TRUSTED_ASSOCIATIONS: readonly string[];
export interface IssueCommentView {
    id: number;
    authorAssociation: string | null;
    body: string | null | undefined;
}
/**
 * The current completion result per ticket on one issue: the newest verified record by a
 * repository owner, member or collaborator. Earlier ones are superseded, never edited; a
 * forged or altered marker stays readable evidence and is never current.
 */
export declare function currentResults(protocol: CompletionProtocol, issueNumber: number, comments: readonly IssueCommentView[]): {
    ticketId: string;
    commentId: number;
}[];
