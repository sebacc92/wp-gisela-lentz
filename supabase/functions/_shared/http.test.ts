import assert from "node:assert/strict";
import test from "node:test";
import { corsHeaders, isRequestOriginAllowed } from "./http.ts";

function withAllowedOrigins(value: string, run: () => void): void {
  const target = globalThis as unknown as {
    Deno?: {
      env: {
        get(name: string): string | undefined;
        set?(name: string, value: string): void;
        delete?(name: string): void;
      };
    };
  };
  const previous = target.Deno;
  if (previous?.env.set && previous.env.delete) {
    const previousValue = previous.env.get("APP_ALLOWED_ORIGINS");
    previous.env.set("APP_ALLOWED_ORIGINS", value);
    try {
      run();
    } finally {
      if (previousValue === undefined)
        previous.env.delete("APP_ALLOWED_ORIGINS");
      else previous.env.set("APP_ALLOWED_ORIGINS", previousValue);
    }
    return;
  }
  target.Deno = {
    env: {
      get: (name) => (name === "APP_ALLOWED_ORIGINS" ? value : undefined),
    },
  };
  try {
    run();
  } finally {
    if (previous) target.Deno = previous;
    else delete target.Deno;
  }
}

test("CORS habilita únicamente orígenes configurados de forma exacta", () => {
  withAllowedOrigins("https://gisela.example, https://admin.example", () => {
    const allowed = new Headers(
      corsHeaders(
        new Request("https://edge.example", {
          headers: { Origin: "https://gisela.example" },
        }),
      ),
    );
    assert.equal(
      allowed.get("Access-Control-Allow-Origin"),
      "https://gisela.example",
    );

    const subdomain = new Headers(
      corsHeaders(
        new Request("https://edge.example", {
          headers: { Origin: "https://otro.gisela.example" },
        }),
      ),
    );
    assert.equal(subdomain.get("Access-Control-Allow-Origin"), null);
  });
});

test("CORS falla cerrado para un origen desconocido o ausente", () => {
  withAllowedOrigins("https://gisela.example", () => {
    const unknown = new Headers(
      corsHeaders(
        new Request("https://edge.example", {
          headers: { Origin: "https://sitio-no-autorizado.example" },
        }),
      ),
    );
    const missing = new Headers(
      corsHeaders(new Request("https://edge.example")),
    );
    assert.equal(unknown.get("Access-Control-Allow-Origin"), null);
    assert.equal(missing.get("Access-Control-Allow-Origin"), null);
  });
});

test("la autorización de origen exige un Origin explícito y exacto", () => {
  withAllowedOrigins("https://gisela.example", () => {
    assert.equal(
      isRequestOriginAllowed(
        new Request("https://edge.example", {
          headers: { Origin: "https://gisela.example" },
        }),
      ),
      true,
    );
    assert.equal(
      isRequestOriginAllowed(
        new Request("https://edge.example", {
          headers: { Origin: "https://evil.example" },
        }),
      ),
      false,
    );
    assert.equal(
      isRequestOriginAllowed(new Request("https://edge.example")),
      false,
    );
  });
});

test("una allowlist de producción inválida no reactiva localhost", () => {
  withAllowedOrigins(
    "https://gisela.example/path,https://user@gisela.example,http://gisela.example",
    () => {
      assert.equal(
        isRequestOriginAllowed(
          new Request("https://edge.example", {
            headers: { Origin: "http://localhost:5173" },
          }),
        ),
        false,
      );
      assert.equal(
        isRequestOriginAllowed(
          new Request("https://edge.example", {
            headers: { Origin: "https://gisela.example" },
          }),
        ),
        false,
      );
    },
  );
});
