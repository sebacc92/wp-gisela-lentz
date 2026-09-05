import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

test("el proveedor SSR queda aislado del documento reactivo al navegar", () => {
  const root = source("src/root.tsx");
  const documentStart = root.indexOf("const RouterDocument = component$(");
  const rootStart = root.indexOf("export default component$(");

  assert.ok(documentStart >= 0 && rootStart > documentStart);
  assert.doesNotMatch(root, /\buseQwikRouter\b/);

  const document = root.slice(documentStart, rootStart);
  assert.match(document, /useLocation\(\)/);
  assert.match(document, /getCanonicalUrl\(url\.pathname\)/);
  assert.match(document, /<RouterOutlet\s*\/>/);

  const routerRoot = root.slice(rootStart);
  assert.match(
    routerRoot,
    /<QwikRouterProvider>[\s\S]*<RouterDocument\s*\/>[\s\S]*<\/QwikRouterProvider>/,
  );
  assert.doesNotMatch(routerRoot, /useLocation\(\)/);
});
