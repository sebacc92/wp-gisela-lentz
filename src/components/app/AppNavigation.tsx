import { $, component$, useContext, useSignal } from "@qwik.dev/core";
import { Link, useNavigate } from "@qwik.dev/router";
import { APP_USER_CONTEXT } from "~/components/app/AppUserContext";
import { BotAutomationControl } from "~/components/app/BotAutomationControl";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { BUSINESS_CONFIG } from "~/config/business";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon, type IconName } from "../ui/Icon";

interface AppNavigationProps {
  active:
    | "home"
    | "appointments"
    | "inbox"
    | "patients"
    | "odontogram"
    | "settings"
    | "templates"
    | "manual";
}

const navItems: Array<{
  key: Exclude<AppNavigationProps["active"], "templates">;
  label: string;
  mobileLabel: string;
  description: string;
  href: string;
  icon: IconName;
  adminOnly?: boolean;
}> = [
  {
    key: "home",
    label: "Inicio",
    mobileLabel: "Inicio",
    description: "Ver el resumen del día",
    href: "/app",
    icon: "clock",
  },
  {
    key: "appointments",
    label: "Agenda",
    mobileLabel: "Agenda",
    description: "Ver y organizar los turnos",
    href: "/app/appointments",
    icon: "calendar",
  },
  {
    key: "inbox",
    label: "Mensajes",
    mobileLabel: "Mensajes",
    description: "Leer y responder mensajes de WhatsApp",
    href: "/app/inbox",
    icon: "message",
  },
  {
    key: "patients",
    label: "Pacientes",
    mobileLabel: "Pacientes",
    description: "Buscar y editar pacientes",
    href: "/app/patients",
    icon: "user",
  },
  {
    key: "odontogram",
    label: "Odontograma",
    mobileLabel: "Ficha",
    description: "Registrar el estado clínico de cada paciente",
    href: "/app/odontogram",
    icon: "smile",
    // Dato de salud: fuera del alcance del rol operativo.
    adminOnly: true,
  },
  {
    key: "settings",
    label: "Configuración",
    mobileLabel: "Ajustes",
    description: "Cambiar horarios, servicios y mensajes",
    href: "/app/settings",
    icon: "settings",
  },
  {
    key: "manual",
    label: "Manual",
    mobileLabel: "Manual",
    description: "Consultar la guía de uso del consultorio",
    href: "/app/manual",
    icon: "file",
    adminOnly: true,
  },
];

export const AppNavigation = component$<AppNavigationProps>(({ active }) => {
  const navigate = useNavigate();
  const appUser = useContext(APP_USER_CONTEXT);
  const mobileMoreOpen = useSignal(false);
  const profileInitials = appUser.fullName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("es-AR") ?? "")
    .join("");

  const openMobileMore = $(() => {
    mobileMoreOpen.value = true;
    requestAnimationFrame(() => {
      document.getElementById("mobile-more-close")?.focus();
    });
  });

  const closeMobileMore = $(() => {
    mobileMoreOpen.value = false;
    requestAnimationFrame(() => {
      document.getElementById("mobile-more-trigger")?.focus();
    });
  });

  return (
    <>
      <a class="app-skip-link" href="#app-content">
        Saltar al contenido principal
      </a>

      <aside class="app-nav" aria-label="Navegación principal">
        <Link
          class="brand-mark"
          href="/app"
          aria-label={`${BUSINESS_CONFIG.name}, ir a Inicio`}
        >
          <BusinessLogo inverse />
        </Link>

        <BotAutomationControl variant="sidebar" />

        <nav class="nav-items">
          {navItems
            .filter((item) => !item.adminOnly || appUser.isAdmin)
            .map((item) => (
              <Link
                key={item.key}
                class={{
                  "nav-link": true,
                  active:
                    item.key === active ||
                    (active === "templates" && item.key === "settings"),
                }}
                href={item.href}
                title={item.description}
                aria-label={`${item.label}: ${item.description}`}
                aria-current={
                  item.key === active ||
                  (active === "templates" && item.key === "settings")
                    ? "page"
                    : undefined
                }
              >
                <Icon name={item.icon} size={21} />
                <span>{item.label}</span>
              </Link>
            ))}
        </nav>

        <div class="nav-profile">
          <div class="nav-user" title={appUser.fullName}>
            <div class="profile-avatar">{profileInitials}</div>
            <span class="nav-user-copy">
              <small
                title={
                  appUser.preserveInboxUnread
                    ? "Abrir chats no los marca como leídos"
                    : undefined
                }
              >
                {appUser.preserveInboxUnread
                  ? "Desarrollador · modo observador"
                  : "Sesión iniciada"}
              </small>
              <strong>{appUser.fullName}</strong>
            </span>
          </div>
          <Link
            class="logout-link"
            href="/login"
            title="Cerrar sesión"
            onClick$={async (event) => {
              event.preventDefault();
              await getSupabaseClient().auth.signOut();
              await navigate("/login");
            }}
          >
            <Icon name="logout" size={19} />
            <span>Cerrar sesión</span>
          </Link>
        </div>
      </aside>

      <nav class="mobile-nav" aria-label="Navegación principal">
        {navItems
          .filter((item) =>
            ["home", "appointments", "inbox", "patients"].includes(item.key),
          )
          .map((item) => (
            <Link
              key={item.key}
              class={{
                "mobile-nav-link": true,
                active:
                  item.key === active ||
                  (active === "templates" && item.key === "settings"),
              }}
              href={item.href}
              title={item.description}
              aria-label={`${item.label}: ${item.description}`}
              aria-current={
                item.key === active ||
                (active === "templates" && item.key === "settings")
                  ? "page"
                  : undefined
              }
            >
              <Icon name={item.icon} size={20} />
              <span>{item.mobileLabel}</span>
            </Link>
          ))}

        <button
          id="mobile-more-trigger"
          class={{
            "mobile-nav-link": true,
            active: ["odontogram", "settings", "templates", "manual"].includes(
              active,
            ),
          }}
          type="button"
          aria-label="Abrir más opciones"
          aria-haspopup="dialog"
          aria-expanded={mobileMoreOpen.value}
          aria-controls="mobile-more-menu"
          onClick$={openMobileMore}
        >
          <Icon name="more" size={20} />
          <span>Más</span>
        </button>
      </nav>

      {mobileMoreOpen.value && (
        <div
          class="mobile-more-layer"
          role="presentation"
          onClick$={closeMobileMore}
        >
          <section
            id="mobile-more-menu"
            class="mobile-more-sheet"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-more-title"
            tabIndex={-1}
            onClick$={(event) => event.stopPropagation()}
            onKeyDown$={async (event, element) => {
              if (event.key === "Escape") {
                event.preventDefault();
                await closeMobileMore();
                return;
              }

              if (event.key !== "Tab") return;
              const focusable = Array.from(
                element.querySelectorAll<HTMLElement>(
                  'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
                ),
              );
              if (!focusable.length) return;

              const first = focusable[0];
              const last = focusable[focusable.length - 1];
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <span
              class="focus-sentinel"
              tabIndex={0}
              aria-hidden="true"
              onFocus$={() =>
                document
                  .querySelector<HTMLButtonElement>(".mobile-more-logout")
                  ?.focus()
              }
            />
            <header class="mobile-more-header">
              <h2 id="mobile-more-title" class="sr-only">
                Más opciones de navegación
              </h2>
              <div class="mobile-more-profile">
                <div class="profile-avatar" aria-hidden="true">
                  {profileInitials}
                </div>
                <span>
                  <small>
                    {appUser.preserveInboxUnread
                      ? "Desarrollador · modo observador"
                      : "Sesión iniciada"}
                  </small>
                  <strong>{appUser.fullName}</strong>
                </span>
              </div>
              <button
                id="mobile-more-close"
                class="icon-button"
                type="button"
                aria-label="Cerrar más opciones"
                onClick$={closeMobileMore}
              >
                <Icon name="x" size={20} />
              </button>
            </header>

            <nav class="mobile-more-links" aria-label="Más secciones">
              {navItems
                .filter(
                  (item) =>
                    ["odontogram", "settings", "manual"].includes(item.key) &&
                    (!item.adminOnly || appUser.isAdmin),
                )
                .map((item) => {
                  const isCurrentDestination = item.key === active;
                  const isHighlighted =
                    isCurrentDestination ||
                    (active === "templates" && item.key === "settings");
                  return (
                    <Link
                      key={item.key}
                      class={{
                        "mobile-more-link": true,
                        active: isHighlighted,
                      }}
                      href={item.href}
                      aria-current={isHighlighted ? "page" : undefined}
                      onClick$={
                        isCurrentDestination ? closeMobileMore : undefined
                      }
                    >
                      <span class="mobile-more-link-icon">
                        <Icon name={item.icon} size={21} />
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                    </Link>
                  );
                })}
            </nav>

            <button
              class="mobile-more-logout"
              type="button"
              onClick$={async () => {
                mobileMoreOpen.value = false;
                await getSupabaseClient().auth.signOut();
                await navigate("/login");
              }}
            >
              <Icon name="logout" size={20} />
              Cerrar sesión
            </button>
            <span
              class="focus-sentinel"
              tabIndex={0}
              aria-hidden="true"
              onFocus$={() =>
                document.getElementById("mobile-more-close")?.focus()
              }
            />
          </section>
        </div>
      )}
    </>
  );
});
