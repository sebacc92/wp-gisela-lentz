import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const layout = readFileSync(
  resolve(process.cwd(), "src/routes/app/layout.tsx"),
  "utf8",
);
const sessionCheck = layout.match(
  /useVisibleTask\$\(async \(\) => \{([\s\S]*?)\n  \}\);/,
)?.[1];
assert.ok(
  sessionCheck,
  "El layout debe validar la sesión antes de mostrar el panel",
);
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
  ...args: string[]
) => (...args: unknown[]) => Promise<void>;

function fixture(options: {
  profileError?: boolean;
  active?: boolean;
  session?: boolean;
}) {
  let signOuts = 0;
  const navigations: string[] = [];
  const profile = {
    full_name: "Test",
    role: "admin",
    active: options.active ?? true,
  };
  const context = {
    ready: { value: false },
    error: { value: "" },
    appUser: { fullName: "", isAdmin: false, preserveInboxUnread: false },
    botAutomation: { error: "", enabled: null },
    loginUrl: "/login?next=%2Fapp",
    inactiveLoginUrl: "/login?next=%2Fapp&error=inactive",
    BUSINESS_CONFIG: { name: "Test" },
    isAdminProfile: (value: { role: string }) => value.role === "admin",
    navigate: async (path: string) => {
      navigations.push(path);
    },
    getSupabaseClient: () => ({
      auth: {
        getSession: async () => ({
          data: {
            session:
              options.session === false ? null : { user: { id: "test-user" } },
          },
        }),
        signOut: async () => {
          signOuts += 1;
        },
      },
      from: (table: string) => {
        const query = {
          select: () => query,
          eq: () => query,
          single: async () =>
            table === "profiles"
              ? {
                  data: options.profileError ? null : profile,
                  error: options.profileError
                    ? new Error("Network unavailable")
                    : null,
                }
              : { data: { automations_enabled: true }, error: null },
        };
        return query;
      },
    }),
  };
  return {
    context,
    navigations,
    signOuts: () => signOuts,
    run: () =>
      new AsyncFunction(...Object.keys(context), sessionCheck!)(
        ...Object.values(context),
      ),
  };
}

test("un error consultando el perfil conserva sesión y mantiene el panel cerrado", async () => {
  const current = fixture({ profileError: true });
  await current.run();
  assert.equal(current.signOuts(), 0);
  assert.equal(current.context.ready.value, false);
  assert.match(current.context.error.value, /No pudimos validar tu sesión/);
  assert.deepEqual(current.navigations, []);
  assert.match(layout, /onClick\$=\{\(\) => window\.location\.reload\(\)\}/);
});

test("un perfil realmente inactivo sí cierra sesión sin mostrar el panel", async () => {
  const current = fixture({ active: false });
  await current.run();
  assert.equal(current.signOuts(), 1);
  assert.equal(current.context.ready.value, false);
  assert.deepEqual(current.navigations, [current.context.inactiveLoginUrl]);
});

test("una sesión válida con perfil activo habilita el panel", async () => {
  const current = fixture({});
  await current.run();
  assert.equal(current.signOuts(), 0);
  assert.equal(current.context.ready.value, true);
  assert.equal(current.context.appUser.isAdmin, true);
  assert.equal(current.context.error.value, "");
});

test("sin sesión se vuelve al login sin habilitar el panel", async () => {
  const current = fixture({ session: false });
  await current.run();
  assert.equal(current.signOuts(), 0);
  assert.equal(current.context.ready.value, false);
  assert.deepEqual(current.navigations, [current.context.loginUrl]);
});
