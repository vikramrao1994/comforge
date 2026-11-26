import { existsSync } from "node:fs";
import path from "node:path";
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
export const RoutingCategorySchema = z
    .object({
    label: z.string().max(120).optional(),
    description: z.string().max(1000).optional(),
    // Empty for a fallback category that is never matched by a task, only listed.
    triggers: z.array(z.string().min(2).max(120)).max(200),
    files: z.array(z.string().min(1).max(300)).max(100).optional(),
    validation: z.array(z.string().min(1).max(400)).max(50).optional(),
    guidance: z.array(z.string().min(1).max(300)).max(50).optional(),
})
    .passthrough();
export const RoutingManifestSchema = z
    .object({
    version: z.literal(1),
    categories: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/), RoutingCategorySchema),
})
    .passthrough();
/** The generic checks: schema, triggers unique across categories, referenced files present. */
export function checkManifest(raw, root) {
    const parsed = RoutingManifestSchema.safeParse(raw);
    if (!parsed.success)
        return {
            manifest: null,
            issues: parsed.error.issues.slice(0, 50).map((i) => ({
                category: null,
                rule: "schema",
                message: `${i.path.join(".") || "(root)"}: ${i.message}`,
            })),
        };
    const manifest = parsed.data;
    const issues = [];
    const owner = new Map();
    for (const [id, category] of Object.entries(manifest.categories)) {
        for (const trigger of category.triggers) {
            const key = trigger.trim().toLowerCase();
            const first = owner.get(key);
            if (first !== undefined)
                issues.push({
                    category: id,
                    rule: "duplicate-trigger",
                    message: `"${trigger}" is also a trigger of ${first === id ? "this category" : first}`,
                });
            else
                owner.set(key, id);
        }
        for (const file of [...(category.files ?? []), ...(category.guidance ?? [])]) {
            const resolved = path.resolve(root, file);
            if (path.relative(root, resolved).startsWith("..") || !existsSync(resolved))
                issues.push({
                    category: id,
                    rule: "missing-file",
                    message: `${file} does not exist in the repository`,
                });
        }
    }
    return { manifest, issues };
}
const words = (text) => text.toLowerCase().normalize("NFKC");
/**
 * The category for `task`: the one with the most matching triggers (a trigger matches as a whole
 * phrase), ties broken by the longer matched text. Never a guess:
 * - two categories still tied → no match, `ambiguous` names them so the agent asks or narrows;
 * - nothing matches → no match, `fallback` names the trigger-less categories (if any) to list.
 * The task text is only matched against triggers; it selects guidance and grants nothing.
 */
export function routeTask(manifest, task) {
    const norm = (t) => words(t)
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
    const text = ` ${norm(task)} `;
    const scored = Object.entries(manifest.categories)
        .map(([id, category]) => {
        const matched = category.triggers.filter((t) => norm(t) !== "" && text.includes(` ${norm(t)} `));
        return { id, category, matched, weight: matched.reduce((n, t) => n + norm(t).length, 0) };
    })
        .filter((s) => s.matched.length > 0)
        .sort((a, b) => b.matched.length - a.matched.length || b.weight - a.weight || a.id.localeCompare(b.id));
    const [best, second] = scored;
    const tied = best !== undefined &&
        second !== undefined &&
        best.matched.length === second.matched.length &&
        best.weight === second.weight;
    const fallback = Object.entries(manifest.categories)
        .filter(([, c]) => c.triggers.length === 0)
        .map(([id]) => id);
    return {
        match: best && !tied
            ? { id: best.id, matchedTriggers: best.matched, category: best.category }
            : null,
        ambiguous: tied
            ? scored
                .filter((s) => s.matched.length === best.matched.length && s.weight === best.weight)
                .map((s) => s.id)
            : [],
        fallback: best ? [] : fallback,
        alternatives: scored
            .slice(tied ? 0 : 1, 4)
            .map((s) => ({ id: s.id, matchedTriggers: s.matched })),
    };
}
