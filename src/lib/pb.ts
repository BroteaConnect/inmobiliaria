// pb.ts — dependency-free PocketBase browser client for Brotea apps.
// The instance URL is inlined at build time (C1 contract); at runtime the
// <meta name="pb-url"> tag is the fallback so plain scripts can use it too.
// Covers what factory apps need: password auth, CRUD, files and realtime.

const PB_URL: string =
  (import.meta.env.PUBLIC_PB_URL as string | undefined)?.trim() ||
  (typeof document !== 'undefined'
    ? document.querySelector('meta[name="pb-url"]')?.getAttribute('content') || ''
    : '');

const TOKEN_KEY = 'pb_token';

export const pbUrl = () => PB_URL;
export const authToken = () => (typeof localStorage !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null);
export const isLoggedIn = () => !!authToken();
export const logout = () => localStorage.removeItem(TOKEN_KEY);

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (!(init.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  const token = authToken();
  if (token) headers['Authorization'] = token;
  const res = await fetch(`${PB_URL}${path}`, { ...init, headers });
  if (!res.ok) throw new Error(`pb ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.status === 204 ? (undefined as T) : res.json();
}

/** Password login against a PocketBase auth collection (default: users). */
export async function login(identity: string, password: string, collection = 'users') {
  const data = await request<{ token: string; record: unknown }>(
    `/api/collections/${collection}/auth-with-password`,
    { method: 'POST', body: JSON.stringify({ identity, password }) },
  );
  localStorage.setItem(TOKEN_KEY, data.token);
  return data.record;
}

export interface ListResult<T> { page: number; perPage: number; totalItems: number; items: T[] }

export const list = <T>(collection: string, params: Record<string, string> = {}) =>
  request<ListResult<T>>(`/api/collections/${collection}/records?${new URLSearchParams(params)}`);

export const getOne = <T>(collection: string, id: string) =>
  request<T>(`/api/collections/${collection}/records/${id}`);

/** Pass a FormData to upload files, or a plain object for JSON fields. */
export const create = <T>(collection: string, data: object | FormData) =>
  request<T>(`/api/collections/${collection}/records`, {
    method: 'POST', body: data instanceof FormData ? data : JSON.stringify(data),
  });

export const update = <T>(collection: string, id: string, data: object | FormData) =>
  request<T>(`/api/collections/${collection}/records/${id}`, {
    method: 'PATCH', body: data instanceof FormData ? data : JSON.stringify(data),
  });

export const remove = (collection: string, id: string) =>
  request<void>(`/api/collections/${collection}/records/${id}`, { method: 'DELETE' });

export const fileUrl = (record: { collectionId: string; id: string }, filename: string) =>
  `${PB_URL}/api/files/${record.collectionId}/${record.id}/${filename}`;

/**
 * Realtime via PocketBase's SSE protocol: open the stream, then register the
 * topics with the clientId it hands us. Returns an unsubscribe function.
 */
export function subscribe(
  topics: string[],
  onEvent: (topic: string, data: { action: string; record: unknown }) => void,
): () => void {
  const es = new EventSource(`${PB_URL}/api/realtime`);
  es.addEventListener('PB_CONNECT', async (e) => {
    const { clientId } = JSON.parse((e as MessageEvent).data);
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = authToken();
    if (token) headers['Authorization'] = token;
    await fetch(`${PB_URL}/api/realtime`, {
      method: 'POST', headers,
      body: JSON.stringify({ clientId, subscriptions: topics }),
    });
  });
  for (const t of topics) {
    es.addEventListener(t, (e) => onEvent(t, JSON.parse((e as MessageEvent).data)));
  }
  return () => es.close();
}
