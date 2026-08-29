import { component$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { LegalPage } from "~/components/legal/LegalPage";
import { BUSINESS_CONFIG, getPageTitle } from "~/config/business";

export default component$(() => {
  return (
    <LegalPage
      current="terms"
      eyebrow="Información legal"
      title="Términos de uso"
      intro="Estos términos establecen las condiciones generales para utilizar la plataforma y sus comunicaciones administrativas por WhatsApp Business."
    >
      <section>
        <h2>1. Alcance</h2>
        <p>
          La plataforma de {BUSINESS_CONFIG.name} permite gestionar contactos,
          conversaciones de WhatsApp Business, turnos, una copia opcional en
          Google Calendar y automatizaciones administrativas. Es operada por la
          persona responsable del perfil oficial de WhatsApp Business asociado
          al servicio.
        </p>
        <p>
          Al interactuar con el servicio o utilizar la plataforma, aceptás estos
          términos en la medida en que resulten aplicables a tu relación con el
          servicio.
        </p>
      </section>

      <section>
        <h2>2. Uso del servicio</h2>
        <p>La plataforma puede utilizarse para:</p>
        <ul>
          <li>recibir y responder consultas administrativas;</li>
          <li>solicitar, confirmar, reprogramar o cancelar turnos;</li>
          <li>
            enviar avisos o recordatorios relacionados con un turno cuando estén
            permitidos;
          </li>
          <li>
            organizar la atención entre automatizaciones y personal autorizado.
          </li>
          <li>
            copiar los turnos a un Google Calendar privado conectado por una
            persona administradora del consultorio.
          </li>
        </ul>
        <p>
          Elegir un horario genera una pre-reserva temporal, no un turno
          confirmado. Enviar un comprobante tampoco acredita automáticamente un
          pago: una persona autorizada debe revisarlo y confirmar la seña. La
          confirmación definitiva depende del aviso que emita el servicio.
        </p>
        <p>
          Si la pre-reserva vence antes de recibir el comprobante, el horario
          puede volver a quedar disponible. Un comprobante recibido después del
          vencimiento se conserva para revisión, pero no recrea ni confirma el
          turno automáticamente.
        </p>
      </section>

      <section>
        <h2>3. Canal administrativo, no de emergencias</h2>
        <p>
          WhatsApp se utiliza como canal administrativo. No reemplaza una
          consulta profesional, no brinda diagnóstico ni constituye un servicio
          de urgencias o emergencias. Ante una urgencia, utilizá los canales de
          emergencia o atención presencial que correspondan en tu ubicación.
        </p>
        <p>
          Evitá enviar historias clínicas, estudios, imágenes médicas,
          documentos de identidad completos, datos financieros, contraseñas o
          códigos de seguridad por el chat.
        </p>
      </section>

      <section>
        <h2>4. Responsabilidades de uso</h2>
        <p>Quien utilice el servicio se compromete a:</p>
        <ul>
          <li>brindar información razonablemente exacta y actualizada;</li>
          <li>
            no hacerse pasar por otra persona ni usar datos ajenos sin permiso;
          </li>
          <li>
            no enviar contenido ilegal, abusivo, malicioso o destinado a afectar
            la seguridad o disponibilidad de la plataforma;
          </li>
          <li>
            respetar la privacidad de terceros y no utilizar el servicio para
            spam o comunicaciones no solicitadas.
          </li>
        </ul>
        <p>
          Los operadores internos deben contar con autorización de la
          organización que utiliza la plataforma y cumplir las políticas
          oficiales de WhatsApp, las reglas de consentimiento y la normativa
          aplicable.
        </p>
      </section>

      <section>
        <h2>5. Servicios de terceros</h2>
        <p>
          La plataforma depende de servicios de terceros, incluidos Supabase, la
          WhatsApp Cloud API de Meta y, cuando el consultorio habilita la
          integración opcional correspondiente, OpenAI para respuestas
          administrativas acotadas y Google Calendar para la copia privada de
          turnos. Su funcionamiento también está sujeto a las condiciones,
          límites y disponibilidad técnica de esos proveedores. Una demora,
          interrupción o rechazo de una operación por parte de un tercero puede
          afectar temporalmente el servicio.
        </p>
      </section>

      <section>
        <h2>6. Señas y cancelaciones</h2>
        <p>
          La plataforma registra administrativamente si un comprobante fue
          recibido y quién confirmó su revisión. No procesa transferencias ni
          decide si un comprobante bancario es auténtico. Las devoluciones o
          acuerdos por cancelación se gestionan directamente con el consultorio;
          esta versión no realiza devoluciones automáticas.
        </p>
      </section>

      <section>
        <h2>7. Disponibilidad y cambios</h2>
        <p>
          Se procura mantener el servicio disponible y la información
          actualizada, pero pueden existir tareas de mantenimiento, fallas o
          cambios necesarios por motivos técnicos, de seguridad, normativos o de
          políticas de los proveedores. No se garantiza disponibilidad
          ininterrumpida.
        </p>
        <p>
          El acceso puede limitarse o suspenderse cuando sea necesario para
          proteger a las personas, evitar abuso, cumplir una obligación o
          preservar la seguridad del servicio.
        </p>
      </section>

      <section>
        <h2>8. Privacidad y comunicaciones</h2>
        <p>
          El tratamiento de datos se describe en la
          <a href="/privacy-policy"> Política de privacidad</a>. Podés pedir que
          no se inicien nuevos mensajes escribiendo <strong>“BAJA”</strong> por
          WhatsApp y solicitar la eliminación de datos siguiendo las
          <a href="/data-deletion"> instrucciones publicadas</a>.
        </p>
      </section>

      <section>
        <h2>9. Actualizaciones y contacto</h2>
        <p>
          Estos términos pueden actualizarse cuando cambie el servicio o sus
          requisitos. La versión vigente estará disponible en esta página.
        </p>
        <p>
          Para consultas sobre estos términos, escribí al mismo número oficial
          de WhatsApp Business con el que interactuaste o utilizá los datos de
          soporte publicados en su perfil comercial.
        </p>
      </section>
    </LegalPage>
  );
});

export const head: DocumentHead = {
  title: getPageTitle("Términos de uso"),
  meta: [
    {
      name: "description",
      content: `Condiciones generales de uso de la plataforma de ${BUSINESS_CONFIG.name} y sus comunicaciones por WhatsApp Business.`,
    },
    { name: "robots", content: "index, follow" },
  ],
};
