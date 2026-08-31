import { component$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { Icon } from "~/components/ui/Icon";
import { BUSINESS_CONFIG, PUBLIC_BUSINESS_CONFIG } from "~/config/business";
import { getCanonicalUrl } from "~/config/site";

import "./landing.css";

const SERVICES = [
  {
    name: "Consulta",
    description: "Para revisar tu situación y definir los próximos pasos.",
    number: "01",
  },
  {
    name: "Restauraciones",
    description: "Atención programada para restauraciones dentales.",
    number: "02",
  },
  {
    name: "Extracciones",
    description: "Evaluación y turnos para extracciones.",
    number: "03",
  },
  {
    name: "Limpieza dental",
    description: "Turnos para limpieza y cuidado odontológico.",
    number: "04",
  },
  {
    name: "Ortopedia y ortodoncia",
    description: "Consultas y seguimiento siempre con turno.",
    number: "05",
  },
] as const;

const HOURS = [
  ["Lunes", "9:30 a 15:00"],
  ["Martes", "13:30 a 17:00"],
  ["Miércoles", "9:30 a 12:00 y 16:00 a 21:00"],
  ["Jueves", "10:00 a 15:00"],
  ["Viernes", "9:30 a 11:00"],
] as const;

const FAQS = [
  {
    question: "¿Cómo puedo pedir un turno con Gisela Lentz?",
    answer:
      "Los turnos y las consultas administrativas se coordinan únicamente por WhatsApp. Escribí al +54 9 2291 41-4102 y contá brevemente qué necesitás.",
  },
  {
    question: "¿Dónde está el consultorio?",
    answer:
      "El consultorio está en Calle 11 N° 1375, entre 26 y 28, Miramar, Provincia de Buenos Aires.",
  },
  {
    question: "¿Qué días y horarios atiende Gisela?",
    answer:
      "Atiende con turno los lunes de 9:30 a 15:00; martes de 13:30 a 17:00; miércoles de 9:30 a 12:00 y de 16:00 a 21:00; jueves de 10:00 a 15:00; y viernes de 9:30 a 11:00. Los feriados nacionales el consultorio permanece cerrado.",
  },
  {
    question: "¿Qué tipo de atención odontológica ofrece?",
    answer:
      "Podés consultar por evaluaciones, restauraciones, extracciones, limpieza dental, ortopedia y ortodoncia. Si no sabés qué tipo de turno necesitás, pedí una consulta por WhatsApp.",
  },
  {
    question: "¿La atención es particular o por IOMA?",
    answer:
      "El consultorio organiza turnos tanto para atención particular como con cobertura IOMA. Consultá por WhatsApp los requisitos vigentes para tu caso.",
  },
  {
    question: "¿Qué hago si necesito atención urgente?",
    answer:
      "Escribí por WhatsApp e indicá que se trata de una urgencia para que Gisela revise el mensaje personalmente. Las urgencias se atienden de forma particular. Ante una emergencia grave, acercate a una guardia.",
  },
] as const;

const MAP_URL =
  "https://www.google.com/maps/search/?api=1&query=Calle+11+1375%2C+entre+26+y+28%2C+Miramar%2C+Buenos+Aires";

export default component$(() => {
  return (
    <div class="landing-page">
      <a class="landing-skip-link" href="#contenido">
        Ir al contenido
      </a>

      <header class="landing-header">
        <div class="landing-container landing-header-inner">
          <a
            class="landing-brand-link"
            href="/"
            aria-label="Gisela Lentz, inicio"
          >
            <BusinessLogo />
          </a>

          <nav class="landing-nav" aria-label="Navegación principal">
            <a href="#atencion">Atención</a>
            <a href="#consultorio">Consultorio</a>
            <a href="#preguntas">Preguntas frecuentes</a>
          </nav>

          <a
            class="landing-button landing-button-small"
            href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Pedir un turno por WhatsApp"
          >
            <Icon name="message" size={18} />
            <span>Pedir turno</span>
          </a>
        </div>
      </header>

      <main id="contenido">
        <section class="landing-hero" aria-labelledby="hero-title">
          <div class="landing-container landing-hero-grid">
            <div class="landing-hero-copy">
              <p class="landing-eyebrow">Consultorio odontológico en Miramar</p>
              <h1 id="hero-title">Gisela Lentz</h1>
              <p class="landing-hero-tagline">{BUSINESS_CONFIG.tagline}</p>
              <p class="landing-hero-summary">
                Gisela brinda atención odontológica personalizada en Miramar.
                Consultá por un turno de manera simple y directa a través de
                WhatsApp.
              </p>

              <div class="landing-hero-actions">
                <a
                  class="landing-button landing-button-primary"
                  href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="message" size={21} />
                  Escribir por WhatsApp
                </a>
                <a class="landing-text-link" href="#consultorio">
                  Ver ubicación y horarios
                  <span aria-hidden="true">↓</span>
                </a>
              </div>

              <ul class="landing-hero-facts" aria-label="Información principal">
                <li>
                  <Icon name="check-circle" size={18} />
                  Atención con turno
                </li>
                <li>
                  <Icon name="check-circle" size={18} />
                  IOMA y particular
                </li>
                <li>
                  <Icon name="check-circle" size={18} />
                  Contacto directo
                </li>
              </ul>
            </div>

            <div class="landing-hero-visual" aria-hidden="true">
              <div class="landing-hero-image-wrap">
                <BusinessLogo inverse compact class="landing-hero-mark" />
              </div>
              <div class="landing-hero-note landing-hero-note-location">
                <span class="landing-note-icon" aria-hidden="true">
                  ⌖
                </span>
                <span>
                  <small>Consultorio</small>
                  <strong>Miramar</strong>
                </span>
              </div>
              <div class="landing-hero-note landing-hero-note-hours">
                <Icon name="clock" size={20} />
                <span>
                  <small>Atención</small>
                  <strong>Lunes a viernes</strong>
                </span>
              </div>
            </div>
          </div>
        </section>

        <section class="landing-fact-strip" aria-label="Datos de contacto">
          <div class="landing-container landing-fact-grid">
            <article>
              <span class="landing-fact-icon" aria-hidden="true">
                01
              </span>
              <div>
                <h2>Ubicación</h2>
                <p>Calle 11 N° 1375, entre 26 y 28, Miramar</p>
              </div>
            </article>
            <article>
              <span class="landing-fact-icon" aria-hidden="true">
                02
              </span>
              <div>
                <h2>Atención</h2>
                <p>Con turno, de lunes a viernes</p>
              </div>
            </article>
            <article>
              <span class="landing-fact-icon" aria-hidden="true">
                03
              </span>
              <div>
                <h2>Contacto</h2>
                <p>Únicamente por WhatsApp</p>
              </div>
            </article>
          </div>
        </section>

        <section
          id="atencion"
          class="landing-section landing-services"
          aria-labelledby="services-title"
        >
          <div class="landing-container">
            <div class="landing-section-heading landing-section-heading-split">
              <div>
                <p class="landing-eyebrow">Atención odontológica</p>
                <h2 id="services-title">Un turno para lo que necesitás</h2>
              </div>
              <p>
                Si no sabés qué opción elegir, escribí por WhatsApp y pedí una
                consulta. Gisela te orienta sobre el tipo de turno adecuado.
              </p>
            </div>

            <div class="landing-service-grid">
              {SERVICES.map((service) => (
                <article key={service.name} class="landing-service-card">
                  <span>{service.number}</span>
                  <div>
                    <h3>{service.name}</h3>
                    <p>{service.description}</p>
                  </div>
                  <span class="landing-service-arrow" aria-hidden="true">
                    ↗
                  </span>
                </article>
              ))}
            </div>

            <aside class="landing-urgent-note" aria-labelledby="urgent-title">
              <span class="landing-urgent-icon">
                <Icon name="alert" size={24} />
              </span>
              <div>
                <h3 id="urgent-title">¿Necesitás atención urgente?</h3>
                <p>
                  Escribí por WhatsApp e indicá que es una urgencia. Gisela
                  revisa personalmente el mensaje para darte un turno lo antes
                  posible. Ante una emergencia grave, acercate a una guardia.
                </p>
              </div>
              <a
                href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Escribir ahora <span aria-hidden="true">→</span>
              </a>
            </aside>
          </div>
        </section>

        <section
          class="landing-section landing-approach"
          aria-labelledby="approach-title"
        >
          <div class="landing-container landing-approach-grid">
            <div class="landing-approach-intro">
              <p class="landing-eyebrow">Una atención cercana</p>
              <h2 id="approach-title">Cada paso, claro y sin vueltas</h2>
              <p>
                Desde el primer mensaje hasta el día del turno, la comunicación
                se mantiene simple, personal y en un único canal.
              </p>
              <a
                class="landing-text-link"
                href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Iniciar una consulta <span aria-hidden="true">→</span>
              </a>
            </div>

            <ol class="landing-steps">
              <li>
                <span>1</span>
                <div>
                  <h3>Escribí por WhatsApp</h3>
                  <p>
                    Contá brevemente qué necesitás y si tu atención es
                    particular o por IOMA.
                  </p>
                </div>
              </li>
              <li>
                <span>2</span>
                <div>
                  <h3>Coordiná tu turno</h3>
                  <p>
                    Recibí por el mismo chat las opciones disponibles y la
                    información necesaria.
                  </p>
                </div>
              </li>
              <li>
                <span>3</span>
                <div>
                  <h3>Acercate al consultorio</h3>
                  <p>
                    Te esperamos en Calle 11 N° 1375, entre 26 y 28, en Miramar.
                  </p>
                </div>
              </li>
            </ol>
          </div>
        </section>

        <section
          id="consultorio"
          class="landing-section landing-office"
          aria-labelledby="office-title"
        >
          <div class="landing-container landing-office-grid">
            <div class="landing-location-card">
              <div class="landing-location-mark" aria-hidden="true">
                <BusinessLogo inverse compact class="landing-location-logo" />
              </div>
              <p class="landing-location-kicker">Consultorio en Miramar</p>
              <address>
                Calle 11 N° 1375
                <br />
                entre 26 y 28
                <br />
                Miramar, Provincia de Buenos Aires
              </address>
              <a href={MAP_URL} target="_blank" rel="noopener noreferrer">
                Cómo llegar con Google Maps <span aria-hidden="true">↗</span>
              </a>
            </div>

            <div class="landing-hours-card">
              <p class="landing-eyebrow">Días y horarios</p>
              <h2 id="office-title">Atención con turno previo</h2>
              <dl>
                {HOURS.map(([day, time]) => (
                  <div key={day}>
                    <dt>{day}</dt>
                    <dd>{time}</dd>
                  </div>
                ))}
              </dl>
              <p class="landing-hours-note">
                <Icon name="info" size={18} />
                Los feriados nacionales el consultorio permanece cerrado.
              </p>
              <a
                class="landing-button landing-button-primary"
                href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                <Icon name="message" size={20} />
                Consultar disponibilidad
              </a>
            </div>
          </div>
        </section>

        <section
          id="preguntas"
          class="landing-section landing-faq"
          aria-labelledby="faq-title"
        >
          <div class="landing-container landing-faq-grid">
            <div class="landing-faq-intro">
              <p class="landing-eyebrow">Información útil</p>
              <h2 id="faq-title">Preguntas frecuentes</h2>
              <p>
                Encontrá las respuestas básicas sobre turnos, ubicación y
                atención. Para cualquier otra consulta, escribí directamente.
              </p>
            </div>

            <div class="landing-faq-list">
              {FAQS.map((faq, index) => (
                <details key={faq.question} open={index === 0}>
                  <summary>
                    <span>{faq.question}</span>
                    <span class="landing-faq-toggle" aria-hidden="true">
                      +
                    </span>
                  </summary>
                  <p>{faq.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section class="landing-closing" aria-labelledby="closing-title">
          <div class="landing-container landing-closing-inner">
            <div>
              <p class="landing-eyebrow">Turnos por WhatsApp</p>
              <h2 id="closing-title">¿Coordinamos tu próxima consulta?</h2>
              <p>
                Escribile a Gisela y recibí toda la información por el canal
                oficial del consultorio.
              </p>
            </div>
            <a
              class="landing-button landing-button-light"
              href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Icon name="message" size={21} />
              {PUBLIC_BUSINESS_CONFIG.phoneDisplay}
            </a>
          </div>
        </section>
      </main>

      <footer class="landing-footer">
        <div class="landing-container landing-footer-main">
          <div class="landing-footer-brand">
            <BusinessLogo inverse />
            <p>Atención odontológica con turno en Miramar.</p>
          </div>

          <div class="landing-footer-column">
            <h2>Consultorio</h2>
            <address>
              Calle 11 N° 1375, entre 26 y 28
              <br />
              Miramar, Buenos Aires
            </address>
          </div>

          <div class="landing-footer-column">
            <h2>Contacto</h2>
            <a
              href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              WhatsApp {PUBLIC_BUSINESS_CONFIG.phoneDisplay}
            </a>
            <span>Lunes a viernes, con turno</span>
          </div>
        </div>

        <div class="landing-container landing-footer-bottom">
          <p>© 2026 {PUBLIC_BUSINESS_CONFIG.displayName}</p>
          <nav aria-label="Enlaces legales">
            <a href="/privacy-policy">Privacidad</a>
            <a href="/terms-of-service">Términos</a>
            <a href="/login">Acceso al consultorio</a>
          </nav>
        </div>
      </footer>

      <a
        class="landing-floating-whatsapp"
        href={PUBLIC_BUSINESS_CONFIG.whatsappUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Escribir por WhatsApp a Gisela Lentz"
      >
        <Icon name="message" size={23} />
        <span>WhatsApp</span>
      </a>
    </div>
  );
});

export const head: DocumentHead = () => {
  const canonicalUrl = getCanonicalUrl("/");
  const socialImage = getCanonicalUrl(
    "/brand/gisela-lentz-whatsapp-profile.png",
  );
  const description =
    "Gisela Lentz brinda atención odontológica en Miramar. Consultá por turnos, ubicación y horarios, y comunicate directamente por WhatsApp.";

  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Dentist",
        "@id": `${canonicalUrl}#consultorio`,
        name: PUBLIC_BUSINESS_CONFIG.displayName,
        alternateName: "Consultorio Odontológico Lentz Gisela",
        url: canonicalUrl,
        logo: getCanonicalUrl("/brand/gisela-lentz-logo.svg"),
        image: socialImage,
        telephone: PUBLIC_BUSINESS_CONFIG.phoneE164,
        description,
        address: {
          "@type": "PostalAddress",
          streetAddress: PUBLIC_BUSINESS_CONFIG.streetAddress,
          addressLocality: PUBLIC_BUSINESS_CONFIG.locality,
          addressRegion: PUBLIC_BUSINESS_CONFIG.region,
          addressCountry: PUBLIC_BUSINESS_CONFIG.country,
        },
        areaServed: {
          "@type": "City",
          name: PUBLIC_BUSINESS_CONFIG.locality,
        },
        openingHoursSpecification: [
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Monday",
            opens: "09:30",
            closes: "15:00",
          },
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Tuesday",
            opens: "13:30",
            closes: "17:00",
          },
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Wednesday",
            opens: "09:30",
            closes: "12:00",
          },
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Wednesday",
            opens: "16:00",
            closes: "21:00",
          },
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Thursday",
            opens: "10:00",
            closes: "15:00",
          },
          {
            "@type": "OpeningHoursSpecification",
            dayOfWeek: "Friday",
            opens: "09:30",
            closes: "11:00",
          },
        ],
        contactPoint: {
          "@type": "ContactPoint",
          contactType: "appointments",
          telephone: PUBLIC_BUSINESS_CONFIG.phoneE164,
          availableLanguage: "Spanish",
        },
        employee: { "@id": `${canonicalUrl}#gisela-lentz` },
      },
      {
        "@type": "Person",
        "@id": `${canonicalUrl}#gisela-lentz`,
        name: BUSINESS_CONFIG.name,
        jobTitle: "Odontóloga",
        image: socialImage,
        worksFor: { "@id": `${canonicalUrl}#consultorio` },
      },
      {
        "@type": "WebSite",
        "@id": `${canonicalUrl}#website`,
        url: canonicalUrl,
        name: PUBLIC_BUSINESS_CONFIG.displayName,
        inLanguage: "es-AR",
        about: { "@id": `${canonicalUrl}#consultorio` },
      },
      {
        "@type": "FAQPage",
        "@id": `${canonicalUrl}#preguntas-frecuentes`,
        mainEntity: FAQS.map((faq) => ({
          "@type": "Question",
          name: faq.question,
          acceptedAnswer: { "@type": "Answer", text: faq.answer },
        })),
      },
    ],
  };

  return {
    title: "Gisela Lentz | Odontóloga en Miramar",
    meta: [
      { name: "description", content: description },
      {
        name: "robots",
        content:
          "index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1",
      },
      { name: "author", content: BUSINESS_CONFIG.name },
      { property: "og:type", content: "website" },
      { property: "og:locale", content: "es_AR" },
      { property: "og:site_name", content: PUBLIC_BUSINESS_CONFIG.displayName },
      {
        property: "og:title",
        content: "Gisela Lentz · Odontología en Miramar",
      },
      { property: "og:description", content: description },
      { property: "og:url", content: canonicalUrl },
      { property: "og:image", content: socialImage },
      { property: "og:image:width", content: "1024" },
      { property: "og:image:height", content: "1024" },
      {
        property: "og:image:alt",
        content: "Símbolo de Gisela Lentz Odontología",
      },
      { name: "twitter:card", content: "summary" },
      {
        name: "twitter:title",
        content: "Gisela Lentz · Odontología en Miramar",
      },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: socialImage },
    ],
    scripts: [
      {
        type: "application/ld+json",
        script: JSON.stringify(structuredData),
      },
    ],
  };
};
