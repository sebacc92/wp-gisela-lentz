import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("el proveedor SSR deja estable el documento durante la navegación", () => {
  const root = source("src/root.tsx");
  const routesLayout = source("src/routes/layout.tsx");
  const documentStart = root.indexOf("const RouterDocument = component$(");
  const rootStart = root.indexOf("export default component$(");

  assert.ok(documentStart >= 0 && rootStart > documentStart);
  assert.doesNotMatch(root, /\buseQwikRouter\b/);
  assert.match(root, /import "\.\/global\.css";/);

  const document = root.slice(documentStart, rootStart);
  assert.doesNotMatch(document, /useLocation\(\)/);
  assert.doesNotMatch(document, /getCanonicalUrl\(/);
  assert.doesNotMatch(document, /rel="canonical"/);
  assert.match(document, /<DocumentHeadTags\s*\/>/);
  assert.match(document, /<RouterOutlet\s*\/>/);

  assert.match(routesLayout, /export default component\$\(\(\) => <Slot \/>\)/);
  assert.match(routesLayout, /export const head: DocumentHead = \(\{ url \}\)/);
  assert.match(routesLayout, /key: "canonical"/);
  assert.match(routesLayout, /rel: "canonical"/);
  assert.match(routesLayout, /href: getCanonicalUrl\(url\.pathname\)/);

  const routerRoot = root.slice(rootStart);
  assert.match(
    routerRoot,
    /<QwikRouterProvider>[\s\S]*<RouterDocument\s*\/>[\s\S]*<\/QwikRouterProvider>/,
  );
  assert.doesNotMatch(routerRoot, /useLocation\(\)/);
});
