import { component$, Slot } from "@qwik.dev/core";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { BUSINESS_CONFIG } from "~/config/business";

type LegalSection = "privacy" | "terms" | "data-deletion";

interface LegalPageProps {
  current: LegalSection;
  eyebrow: string;
  title: string;
  intro: string;
}

const links: Array<{ href: string; label: string; key: LegalSection }> = [
  { href: "/privacy-policy", label: "Privacidad", key: "privacy" },
  { href: "/terms-of-service", label: "Términos", key: "terms" },
  {
    href: "/data-deletion",
    label: "Eliminación de datos",
    key: "data-deletion",
  },
];

export const LegalPage = component$<LegalPageProps>((props) => {
  return (
    <div class="legal-page">
      <a class="legal-skip-link" href="#legal-content">
        Ir al contenido
      </a>

      <header class="legal-header">
        <div class="legal-header-inner">
          <a
            class="legal-brand"
            href="/"
            aria-label={`${BUSINESS_CONFIG.name}, inicio`}
          >
            <BusinessLogo />
          </a>

          <nav class="legal-nav" aria-label="Información legal">
            {links.map((link) => (
              <a
                key={link.key}
                href={link.href}
                class={{
                  "legal-nav-link": true,
                  active: props.current === link.key,
                }}
                aria-current={props.current === link.key ? "page" : undefined}
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <main id="legal-content" class="legal-main">
        <section class="legal-hero" aria-labelledby="legal-title">
          <p class="legal-eyebrow">{props.eyebrow}</p>
          <h1 id="legal-title">{props.title}</h1>
          <p class="legal-lead">{props.intro}</p>
          <p class="legal-updated">
            Última actualización: 12 de agosto de 2026
          </p>
        </section>

        <article class="legal-document">
          <Slot />
        </article>
      </main>

      <footer class="legal-footer">
        <div class="legal-footer-inner">
          <p>
            Para consultas de privacidad, escribí al mismo número oficial de
            WhatsApp Business con el que te comunicaste con el servicio.
          </p>
          <nav aria-label="Enlaces legales del pie">
            {links.map((link) => (
              <a key={link.key} href={link.href}>
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
});
