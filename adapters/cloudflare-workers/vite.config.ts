import { cloudflarePagesAdapter } from "@qwik.dev/router/adapters/cloudflare-pages/vite";
import { extendConfig } from "@qwik.dev/router/vite";
import baseConfig from "../../vite.config.ts";

export default extendConfig(baseConfig, () => {
  return {
    build: {
      ssr: true,
      outDir: "server",
      rollupOptions: {
        input: ["src/entry.cloudflare-pages.tsx"],
      },
    },
    plugins: [
      cloudflarePagesAdapter({
        functionRoutes: false,
        ssg: null,
      }),
    ],
  };
});
