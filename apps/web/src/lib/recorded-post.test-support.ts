/** A stub `fetch` that records every call and answers each with `response`. */
export const answering = (response: Response | Error) => {
  const requests: { url: string; init: RequestInit }[] = [];
  const send = async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (response instanceof Error) throw response;
    return response;
  };
  return { requests, send };
};

/** The first recorded call, with its JSON body parsed, for one assertion. */
export const firstPost = (requests: { url: string; init: RequestInit }[]) => ({
  url: requests[0]?.url,
  method: requests[0]?.init.method,
  headers: requests[0]?.init.headers,
  body: JSON.parse(String(requests[0]?.init.body)) as unknown,
});
