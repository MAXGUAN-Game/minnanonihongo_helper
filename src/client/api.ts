export class ClientApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
    this.name = 'ClientApiError';
  }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch('/api' + path, { ...options, headers: { ...(options.body && typeof options.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  const data: unknown = await response.json().catch(() => { throw new ClientApiError('服务暂时没有响应，请重试。', response.status); });
  if (!response.ok) {
    const failure = data && typeof data === 'object' ? data as Record<string, unknown> : {};
    throw new ClientApiError(typeof failure.error === 'string' ? failure.error : '操作没有完成，请重试。', response.status, typeof failure.code === 'string' ? failure.code : undefined);
  }
  return data as T;
}
export const post = <T>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
