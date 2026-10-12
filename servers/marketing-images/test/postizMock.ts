export const POSTIZ_KEY = 'pk-test-fake-postiz-key-do-not-leak';
export const POSTIZ_ENV = { POSTIZ_URL: 'https://postiz.example.test', POSTIZ_API_KEY: POSTIZ_KEY } as const;
export const POSTIZ_UPLOAD_URL = 'https://postiz.example.test/api/public/v1/upload';

export interface PostizCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  fieldNames: string[];
  fileName: string;
  fileType: string;
  bytes: Buffer;
}

export type PostizAnswer = Response | Error;

/** A scripted Postiz: records every upload (multipart parsed), answers 200 with sequential ids unless told otherwise. */
export function postizMock(answer?: (callNumber: number) => PostizAnswer): { fetch: typeof fetch; calls: PostizCall[] } {
  const calls: PostizCall[] = [];
  const fn: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const form = init?.body instanceof FormData ? init.body : undefined;
    const part = form?.get('file') as File | null | undefined;
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers,
      fieldNames: form ? [...form.keys()] : [],
      fileName: part?.name ?? '',
      fileType: part?.type ?? '',
      bytes: part ? Buffer.from(await part.arrayBuffer()) : Buffer.alloc(0),
    });
    const n = calls.length;
    const next = answer
      ? answer(n)
      : new Response(JSON.stringify({ id: `media-${n}`, name: part?.name ?? 'f', path: `https://uploads.postiz.test/media-${n}.png` }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (next instanceof Error) throw next;
    return next;
  };
  return { fetch: fn, calls };
}
