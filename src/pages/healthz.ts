import type { APIRoute } from 'astro';

// A server that answers is the difference between this stack and the static
// one, so the app says so at a URL a container healthcheck can call. It touches
// nothing else on purpose: a healthcheck that queries the database reports the
// database, and then a slow query restarts a perfectly healthy app.
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(JSON.stringify({ ok: true, commit: import.meta.env.PUBLIC_BUILD_COMMIT ?? 'dev' }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
