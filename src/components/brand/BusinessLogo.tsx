import { component$ } from "@qwik.dev/core";
import { BUSINESS_CONFIG } from "~/config/business";

interface BusinessLogoProps {
  inverse?: boolean;
  compact?: boolean;
  class?: string;
}

/**
 * Identidad principal de Gisela Lentz.
 *
 * El símbolo reproduce el diente con la G interior de la marca original. La
 * variante clara mantiene la misma silueta para que la identidad sea estable
 * en navegación, acceso, documentos legales y agenda impresa.
 */
export const BusinessLogo = component$<BusinessLogoProps>(
  ({ inverse = false, compact = false, class: className }) => (
    <span
      class={[
        "business-logo",
        inverse && "business-logo-inverse",
        compact && "business-logo-compact",
        className,
      ]}
    >
      <img
        class="business-logo-symbol"
        src={
          inverse
            ? "/brand/gisela-lentz-mark-white.svg"
            : "/brand/gisela-lentz-mark.svg"
        }
        width={64}
        height={64}
        alt=""
        aria-hidden="true"
      />

      {!compact && (
        <span class="business-logo-copy">
          <strong>{BUSINESS_CONFIG.name}</strong>
          <small>{BUSINESS_CONFIG.subtitle}</small>
        </span>
      )}
    </span>
  ),
);
