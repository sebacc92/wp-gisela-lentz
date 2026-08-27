import assert from "node:assert/strict";
import test from "node:test";

import { isAdminProfile } from "./admin-access.ts";

test("sólo un perfil ADMIN activo habilita el Manual", () => {
  assert.equal(isAdminProfile({ active: true, role: "ADMIN" }), true);
  assert.equal(isAdminProfile({ active: true, role: "OPERADOR" }), false);
  assert.equal(isAdminProfile({ active: false, role: "ADMIN" }), false);
  assert.equal(isAdminProfile(null), false);
  assert.equal(isAdminProfile({ active: "true", role: "ADMIN" }), false);
});
