import { component$, useSignal, useVisibleTask$ } from "@qwik.dev/core";
import { Link, useNavigate } from "@qwik.dev/router";
import { BusinessLogo } from "~/components/brand/BusinessLogo";
import { BUSINESS_CONFIG } from "~/config/business";
import { isAdminProfile } from "~/lib/admin-access";
import { getSupabaseClient } from "~/lib/supabase/client";
import { Icon, type IconName } from "../ui/Icon";

interface AppNavigationProps {
  active:
    | "home"
    | "appointments"
    | "inbox"
    | "patients"
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
  const fullName = useSignal(BUSINESS_CONFIG.name);
  const profileInitials = useSignal("GL");
  const isAdmin = useSignal(false);

  // The profile is intentionally resolved only in the browser so the sidebar
  // never renders an ADMIN-only link before the authenticated user is known.
  // eslint-disable-next-line qwik/no-use-visible-task
  useVisibleTask$(async () => {
    const client = getSupabaseClient();
    const {
      data: { user },
    } = await client.auth.getUser();
    if (!user) return;

    const { data: profile } = await client
      .from("profiles")
      .select("full_name,role,active")
      .eq("id", user.id)
      .single();
    if (!profile) return;

    isAdmin.value = isAdminProfile(profile);
    if (!profile.full_name) return;

    fullName.value = profile.full_name;
    profileInitials.value = profile.full_name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part: string) => part[0]?.toLocaleUpperCase("es-AR") ?? "")
      .join("");
  });

  return (
    <>
      <aside class="app-nav" aria-label="Navegación principal">
        <Link
          class="brand-mark"
          href="/app"
          aria-label={`${BUSINESS_CONFIG.name}, ir a Inicio`}
        >
          <BusinessLogo inverse />
        </Link>

        <nav class="nav-items">
          {navItems
            .filter((item) => !item.adminOnly || isAdmin.value)
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
          <div class="nav-user" title={fullName.value}>
            <div class="profile-avatar">{profileInitials.value}</div>
            <span class="nav-user-copy">
              <small>Sesión iniciada</small>
              <strong>{fullName.value}</strong>
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

      <nav
        class={{
          "mobile-nav": true,
          "mobile-nav-has-manual": isAdmin.value,
        }}
        aria-label="Navegación principal"
      >
        {navItems
          .filter((item) => !item.adminOnly || isAdmin.value)
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
      </nav>
    </>
  );
});
