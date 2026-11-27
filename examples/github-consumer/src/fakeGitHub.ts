import type { GitHubTransport } from "@comforge/github";

/**
 * A synthetic GitHub for the example: canned responses keyed by API path. A real consumer
 * passes `createFetchTransport({ token })` instead; nothing else changes.
 */
export function fakeGitHub(routes: Record<string, unknown | ((query: Record<string, string>) => unknown)>): GitHubTransport {
  return {
    async get(path, query = {}) {
      const route = routes[path];
      if (route === undefined) throw new Error(`fake GitHub has no route for ${path}`);
      return typeof route === "function" ? (route as (q: Record<string, string>) => unknown)({ ...query }) : route;
    },
  };
}
