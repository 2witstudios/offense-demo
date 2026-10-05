/**
 * Reads a request body incrementally and cancels the stream the moment it
 * exceeds `maxBytes`, so chunked or understated-Content-Length bodies are
 * never buffered whole. Returns null when the cap is exceeded.
 */
export async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes)
    return null;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
