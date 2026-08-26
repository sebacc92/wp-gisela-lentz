import { component$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { LegalPage } from "~/components/legal/LegalPage";
import { BUSINESS_CONFIG, getPageTitle } from "~/config/business";

export default component$(() => {
  return (
    <LegalPage
      current="data-deletion"
      eyebrow="Control de tus datos"
      title="Eliminación de datos"
      intro="Podés solicitar la eliminación de los datos personales asociados a tu contacto y a tus conversaciones con el servicio siguiendo estos pasos."
    >
      <section class="legal-callout" aria-labelledby="deletion-contact-title">
        <p class="legal-callout-label">Canal de solicitud</p>
        <h2 id="deletion-contact-title">Escribinos desde tu WhatsApp</h2>
        <p>
          Enviá <strong>“ELIMINAR MIS DATOS”</strong> al mismo número oficial de
          WhatsApp Business mediante el cual te comunicaste con el servicio. Si
          necesitás asistencia, pedí hablar con una persona. También podés usar
          los datos de soporte visibles en el perfil comercial de ese número.
        </p>
      </section>

      <section>
        <h2>1. Cómo presentar la solicitud</h2>
        <ol>
          <li>
            Escribí desde el número de teléfono asociado a los datos que querés
            eliminar. Esto ayuda a comprobar que la solicitud te pertenece.
          </li>
          <li>
            Indicá si pedís eliminar todos tus datos o solo una parte, por
            ejemplo, conversaciones o datos de turnos.
          </li>
          <li>
            Si la solicitud se envía por otro canal, incluí el número de
            WhatsApp asociado y la información mínima necesaria para localizar
            los datos.
          </li>
        </ol>
        <p>
          No envíes contraseñas, códigos de verificación, datos financieros ni
          copias completas de documentos. Podemos pedir una verificación
          razonable antes de eliminar información para evitar que otra persona
          actúe en tu nombre.
        </p>
      </section>

      <section>
        <h2>2. Qué ocurre después</h2>
        <p>Una vez verificada la solicitud:</p>
        <ul>
          <li>se localizarán los datos asociados al contacto;</li>
          <li>
            se eliminarán o anonimizarán los registros que ya no sean
            necesarios, incluidos comprobantes de seña asociados cuando
            corresponda;
          </li>
          <li>
            se cancelarán las comunicaciones proactivas pendientes cuando
            corresponda;
          </li>
          <li>
            se comunicará el resultado por el mismo canal o por el canal de
            soporte utilizado.
          </li>
        </ul>
        <p>
          La solicitud se procesará dentro del plazo que establezca la normativa
          aplicable. Si hace falta información adicional o existe una razón
          válida para conservar una parte de los datos, se informará al
          solicitante.
        </p>
      </section>

      <section>
        <h2>3. Datos que pueden conservarse temporalmente</h2>
        <p>
          Puede conservarse información mínima cuando sea necesaria para cumplir
          una obligación legal, atender un reclamo, proteger la seguridad,
          prevenir fraude o registrar una preferencia de no contacto. Las copias
          de respaldo pueden permanecer hasta completar su ciclo normal de
          expiración. Los datos retenidos se limitarán a lo estrictamente
          necesario y no se usarán para nuevas comunicaciones comerciales.
        </p>
      </section>

      <section>
        <h2>4. Diferencia entre baja y eliminación</h2>
        <p>
          Enviar <strong>“BAJA”</strong> indica que no querés recibir nuevas
          comunicaciones proactivas. Esa acción no elimina automáticamente el
          historial que deba conservarse para gestionar la baja. Si también
          querés eliminar tus datos, enviá <strong>“ELIMINAR MIS DATOS”</strong>{" "}
          y seguí el procedimiento de esta página.
        </p>
      </section>

      <section>
        <h2>5. Copias en WhatsApp, Google o tu dispositivo</h2>
        <p>
          Este procedimiento cubre los datos controlados por la plataforma. No
          elimina automáticamente las copias de los mensajes que permanezcan en
          tu dispositivo ni la información que Meta o WhatsApp conserven bajo
          sus propias políticas. Si el consultorio conectó Google Calendar,
          pueden existir copias administrativas de nombre, fecha y horario en su
          calendario privado; aclaralo en la solicitud para que también sean
          localizadas. Para datos controlados directamente por Meta o Google,
          utilizá además las opciones de privacidad de cada cuenta o sus canales
          correspondientes.
        </p>
      </section>

      <section>
        <h2>6. Consultas</h2>
        <p>
          Para consultar el estado de una solicitud, respondé en el mismo chat
          de WhatsApp Business o utilizá los datos de soporte publicados en el
          perfil comercial. Para conocer el tratamiento general de la
          información, consultá la{" "}
          <a href="/privacy-policy">Política de privacidad</a>.
        </p>
      </section>
    </LegalPage>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Eliminación de datos"),
  meta: [
    {
      name: "description",
      content: `Instrucciones para solicitar la eliminación de datos personales procesados por ${BUSINESS_CONFIG.name}.`,
    },
    { name: "robots", content: "index, follow" },
  ],
};
