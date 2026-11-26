import { z } from "zod";
/**
 * A generic task-routing manifest: categories with triggers, the files worth reading and the
 * validation commands for that area. `comforge context` returns the one category a task
 * matches, so an agent loads one area's guidance instead of a whole repository's.
 *
 * The manifest is guidance, not authority: no command reads it to decide a permission.
 * Repository-specific keys on a category (for example a knowledge index or code-graph entry
 * points) are kept and returned untouched; only the generic fields are checked.
 */
export declare const RoutingCategorySchema: z.ZodObject<{
    label: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodString>;
    triggers: z.ZodArray<z.ZodString>;
    files: z.ZodOptional<z.ZodArray<z.ZodString>>;
    validation: z.ZodOptional<z.ZodArray<z.ZodString>>;
    guidance: z.ZodOptional<z.ZodArray<z.ZodString>>;
}, z.core.$loose>;
export declare const RoutingManifestSchema: z.ZodObject<{
    version: z.ZodLiteral<1>;
    categories: z.ZodRecord<z.ZodString, z.ZodObject<{
        label: z.ZodOptional<z.ZodString>;
        description: z.ZodOptional<z.ZodString>;
        triggers: z.ZodArray<z.ZodString>;
        files: z.ZodOptional<z.ZodArray<z.ZodString>>;
        validation: z.ZodOptional<z.ZodArray<z.ZodString>>;
        guidance: z.ZodOptional<z.ZodArray<z.ZodString>>;
    }, z.core.$loose>>;
}, z.core.$loose>;
export type RoutingManifest = z.infer<typeof RoutingManifestSchema>;
export interface RoutingIssue {
    category: string | null;
    rule: "schema" | "duplicate-trigger" | "missing-file";
    message: string;
}
/** The generic checks: schema, triggers unique across categories, referenced files present. */
export declare function checkManifest(raw: unknown, root: string): {
    manifest: RoutingManifest | null;
    issues: RoutingIssue[];
};
/**
 * The category for `task`: the one with the most matching triggers (a trigger matches as a whole
 * phrase), ties broken by the longer matched text. Never a guess:
 * - two categories still tied → no match, `ambiguous` names them so the agent asks or narrows;
 * - nothing matches → no match, `fallback` names the trigger-less categories (if any) to list.
 * The task text is only matched against triggers; it selects guidance and grants nothing.
 */
export declare function routeTask(manifest: RoutingManifest, task: string): {
    match: {
        id: string;
        matchedTriggers: string[];
        category: {
            [x: string]: unknown;
            label?: string | undefined;
            description?: string | undefined;
            triggers: string[];
            files?: string[] | undefined;
            validation?: string[] | undefined;
            guidance?: string[] | undefined;
        };
    } | null;
    ambiguous: string[];
    fallback: string[];
    alternatives: {
        id: string;
        matchedTriggers: string[];
    }[];
};
