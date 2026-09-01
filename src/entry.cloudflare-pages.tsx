import { createQwikRouter } from "@qwik.dev/router/middleware/cloudflare-pages";
import render from "./entry.ssr";
import { withCloudflareResponseHeaders } from "./lib/cloudflare-response";

const qwikFetch = createQwikRouter({ render });

const fetch: typeof qwikFetch = async (request, env, ctx) => {
  const response = await qwikFetch(request, env, ctx);
  return withCloudflareResponseHeaders(request, response);
};

export { fetch };
