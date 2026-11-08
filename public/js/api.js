export class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || `שגיאה (${status})`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, url, body, extraHeaders = {}) {
  const headers = { 'x-requested-with': 'niv-bot', ...extraHeaders };
  let payload;
  if (body instanceof Blob || body instanceof ArrayBuffer) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(url, { method, headers: method === 'GET' ? {} : headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return { message: text }; } })() : null;
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    location.hash = '#/login';
    throw new ApiError(401, data);
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
  patch: (url, body = {}) => request('PATCH', url, body),
  del: (url) => request('DELETE', url),
  upload: (url, file) => request('POST', url, file, { 'content-type': file.type === 'application/json' ? 'application/octet-stream' : file.type || 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) }),
};
