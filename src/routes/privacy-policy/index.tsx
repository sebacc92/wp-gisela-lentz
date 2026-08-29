import { component$ } from "@qwik.dev/core";
import type { DocumentHead } from "@qwik.dev/router";
import { LegalPage } from "~/components/legal/LegalPage";

export default component$(() => {
  return (
    <LegalPage
      current="privacy"
      eyebrow="Privacidad y datos personales"
      title="Política de Privacidad"
      intro="Esta política explica qué información procesa la plataforma de gestión de WhatsApp y turnos del Consultorio Odontológico Lentz Gisela, cómo se utiliza y qué opciones tienen las personas respecto de sus datos."
    >
      <section>
        <h2>1. Política de Privacidad</h2>
        <p>
          Esta Política de Privacidad se aplica a la plataforma administrativa
          utilizada por el Consultorio Odontológico Lentz Gisela para organizar
          comunicaciones por WhatsApp, contactos, solicitudes de turnos,
          recordatorios y tareas relacionadas con su atención.
        </p>
        <p>
          La plataforma no es una historia clínica electrónica ni sustituye la
          consulta profesional, el diagnóstico o la atención de urgencias. Sin
          embargo, una persona podría incluir voluntariamente información
          personal o vinculada con su salud en un mensaje; en ese caso, dicha
          información formará parte de la conversación recibida.
        </p>
      </section>

      <section>
        <h2>2. Responsable</h2>
        <p>
          El responsable de esta plataforma y del tratamiento de los datos
          descritos en esta política es el
          <strong> Consultorio Odontológico Lentz Gisela</strong>.
        </p>
      </section>

      <section>
        <h2>3. Información que recopilamos</h2>
        <p>
          De acuerdo con la interacción y las funciones utilizadas, la
          plataforma puede procesar las siguientes categorías de información:
        </p>
        <ul>
          <li>
            <strong>Datos de contacto:</strong> nombre y apellido, número de
            teléfono, identificador de WhatsApp, correo electrónico opcional,
            teléfono alternativo y condición de paciente existente o nuevo.
          </li>
          <li>
            <strong>Datos administrativos:</strong> cobertura informada —por
            ejemplo, IOMA o Particular—, notas administrativas y estado, fechas
            y constancias de autorización o baja de comunicaciones.
          </li>
          <li>
            <strong>Conversaciones:</strong> mensajes enviados voluntariamente
            por WhatsApp, respuestas, fecha y hora, estado de entrega o lectura,
            archivos o referencias a archivos, y datos necesarios para ordenar y
            asignar la conversación.
          </li>
          <li>
            <strong>Turnos:</strong> servicio o motivo informado, profesional,
            fecha, hora, duración, estado, origen, cambios, cancelaciones y
            datos de una pre-reserva cuando corresponda.
          </li>
          <li>
            <strong>Señas:</strong> comprobante que la persona decida enviar,
            estado de su revisión, vencimiento de la pre-reserva y registro de
            la confirmación efectuada por personal autorizado.
          </li>
          <li>
            <strong>Datos técnicos y de seguridad:</strong> identificadores de
            mensajes y eventos, registros de auditoría, errores y datos
            necesarios para operar y proteger las integraciones.
          </li>
          <li>
            <strong>Usuarios internos:</strong> datos de cuenta y acceso
            gestionados mediante Supabase Auth, nombre, rol, estado y actividad
            de las personas autorizadas a utilizar la plataforma.
          </li>
          <li>
            <strong>Integración opcional con Google Calendar:</strong>
            identificadores y correo de la cuenta administradora conectada,
            identificador y nombre del calendario, y la credencial de
            autorización almacenada mediante Supabase Vault.
          </li>
        </ul>
      </section>

      <section>
        <h2>4. Cómo obtenemos la información</h2>
        <p>La información puede obtenerse:</p>
        <ul>
          <li>
            directamente de la persona cuando escribe por WhatsApp, solicita un
            turno o envía información o archivos;
          </li>
          <li>
            de Meta/WhatsApp, al transmitir los mensajes, identificadores y
            estados necesarios para prestar el servicio de mensajería;
          </li>
          <li>
            del personal autorizado del consultorio, cuando registra o actualiza
            un contacto, un turno o una gestión administrativa; y
          </li>
          <li>
            de los sistemas técnicos que generan registros necesarios para el
            funcionamiento, la trazabilidad y la seguridad.
          </li>
        </ul>
      </section>

      <section>
        <h2>5. Para qué utilizamos los datos</h2>
        <p>La información se utiliza para:</p>
        <ul>
          <li>recibir, ordenar y responder consultas por WhatsApp;</li>
          <li>identificar contactos y mantener su información actualizada;</li>
          <li>solicitar, asignar, confirmar, reprogramar o cancelar turnos;</li>
          <li>
            gestionar pre-reservas, señas y su revisión administrativa humana;
          </li>
          <li>
            enviar confirmaciones o recordatorios administrativos cuando
            corresponda y exista la autorización necesaria;
          </li>
          <li>
            derivar una conversación al personal del consultorio cuando sea
            necesario; y
          </li>
          <li>
            mantener la seguridad, evitar duplicados, resolver fallas y dejar
            constancia de las acciones administrativas.
          </li>
        </ul>
      </section>

      <section>
        <h2>6. Mensajería mediante WhatsApp</h2>
        <p>
          WhatsApp se utiliza como canal de comunicación con el consultorio. Los
          mensajes que la persona envía pueden ser procesados por la plataforma
          para gestionar consultas y turnos, organizar la conversación y
          permitir una respuesta del personal. Cuando las funciones
          administrativas automáticas estén habilitadas, también podrán
          utilizarse para orientar opciones o, cuando exista la autorización
          necesaria, enviar confirmaciones y recordatorios.
        </p>
        <p>
          La mensajería se integra mediante la WhatsApp Cloud API de Meta. Por
          ello, Meta y WhatsApp también procesan información necesaria para
          transmitir y prestar sus servicios, de acuerdo con sus propias
          políticas y condiciones. Recomendamos consultar la
          <a
            href="https://www.whatsapp.com/legal/privacy-policy"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de WhatsApp
          </a>
          y la
          <a
            href="https://www.facebook.com/privacy/policy/"
            target="_blank"
            rel="noreferrer"
          >
            política de privacidad de Meta
          </a>
          .
        </p>
        <p>
          No vendemos los datos personales ni los utilizamos para publicidad de
          terceros. No envíes por WhatsApp contraseñas, códigos de verificación
          ni información que no sea necesaria para la gestión solicitada.
        </p>
      </section>

      <section>
        <h2>7. Datos relacionados con turnos</h2>
        <p>
          Para gestionar un turno pueden registrarse la persona de contacto, el
          servicio o motivo informado, la cobertura, el profesional, la fecha,
          el horario, la duración, el estado y las modificaciones realizadas.
          Estos datos se utilizan con fines organizativos y administrativos.
        </p>
        <p>
          Si el consultorio habilita la integración opcional con Google
          Calendar, se copia a un calendario privado el nombre de la persona, la
          fecha, el horario y un identificador interno del turno. La plataforma
          no agrega al paciente como invitado ni copia allí su teléfono, notas,
          comprobantes o archivos. Al desconectar la integración, los eventos ya
          creados no se eliminan automáticamente y pueden permanecer en ese
          calendario hasta que su titular los elimine.
        </p>
      </section>

      <section>
        <h2>8. Comprobantes y señas</h2>
        <p>
          Cuando corresponda, la persona puede enviar voluntariamente por
          WhatsApp un comprobante relacionado con una seña. La plataforma
          registra el mensaje y las referencias técnicas asociadas para que
          personal autorizado pueda revisar el comprobante y registrar el
          resultado. El archivo se obtiene de Meta cuando se visualiza y no se
          guarda como archivo en el almacenamiento de Supabase.
        </p>
        <p>
          La revisión es humana: la plataforma no analiza ni valida
          automáticamente el comprobante y no procesa ni acredita la
          transferencia. Antes de enviarlo, recomendamos ocultar la información
          que no sea necesaria para identificar la operación.
        </p>
      </section>

      <section>
        <h2>9. Proveedores tecnológicos</h2>
        <p>
          Para operar la plataforma pueden intervenir proveedores que procesan
          información siguiendo sus propias condiciones y políticas:
        </p>
        <ul>
          <li>
            <strong>Meta / WhatsApp:</strong> canal de mensajería y transmisión
            de mensajes, archivos y estados mediante WhatsApp Cloud API.
          </li>
          <li>
            <strong>Supabase:</strong> base de datos PostgreSQL, autenticación,
            funciones de servidor y otros servicios de infraestructura.
          </li>
          <li>
            <strong>Vercel:</strong> alojamiento y entrega de la aplicación web.
          </li>
          <li>
            <strong>OpenAI:</strong> sólo si el consultorio habilita el
            asistente administrativo opcional. Recibe una pregunta canónica
            sobre horarios o ubicación, la dirección y las reglas estructuradas
            de horarios del consultorio, y un identificador técnico seudónimo.
            No recibe el mensaje original, nombre o teléfono del paciente,
            cobertura, turnos, comprobantes ni información clínica. La solicitud
            se realiza con almacenamiento desactivado y las consultas dudosas se
            derivan a una persona.
          </li>
          <li>
            <strong>Google:</strong> únicamente cuando el consultorio habilita
            la sincronización opcional con Google Calendar.
          </li>
        </ul>
        <p>
          Podés consultar las políticas de
          <a
            href="https://supabase.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            Supabase
          </a>
          ,
          <a
            href="https://vercel.com/legal/privacy-notice"
            target="_blank"
            rel="noreferrer"
          >
            Vercel
          </a>
          ,
          <a
            href="https://openai.com/policies/privacy-policy/"
            target="_blank"
            rel="noreferrer"
          >
            OpenAI
          </a>
          y
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noreferrer"
          >
            Google
          </a>
          en sus respectivos sitios.
        </p>
      </section>

      <section>
        <h2>10. Conservación de datos</h2>
        <p>
          Los datos se conservarán durante el tiempo necesario para prestar el
          servicio, gestionar la relación con el paciente y cumplir las
          obligaciones aplicables. El período puede variar según el tipo de
          información, su finalidad y las necesidades administrativas o de
          seguridad relacionadas con el servicio.
        </p>
      </section>

      <section>
        <h2>11. Seguridad</h2>
        <p>
          Aplicamos medidas técnicas razonables para proteger la información,
          entre ellas autenticación de usuarios internos, controles de acceso
          según funciones, validación de comunicaciones con servicios externos y
          registros de auditoría. Ningún sistema conectado a Internet puede
          garantizar seguridad absoluta.
        </p>
      </section>

      <section>
        <h2>12. Compartición de información</h2>
        <p>
          La información puede ser consultada por personal autorizado del
          consultorio y procesada por los proveedores tecnológicos necesarios
          para prestar el servicio. También podrá comunicarse cuando sea exigido
          por una obligación aplicable o por una solicitud válida de autoridad
          competente.
        </p>
        <p>
          No vendemos, alquilamos ni comercializamos datos personales, y no los
          compartimos para publicidad de terceros.
        </p>
      </section>

      <section>
        <h2>13. Derechos del usuario</h2>
        <p>
          De acuerdo con las normas que resulten aplicables, la persona puede
          solicitar acceso, corrección, actualización o eliminación de sus
          datos, pedir información sobre su uso, o retirar una autorización para
          comunicaciones futuras. Para proteger la información, antes de
          responder una solicitud podremos requerir una verificación razonable
          de identidad.
        </p>
      </section>

      <section>
        <h2>14. Eliminación o modificación de datos</h2>
        <p>
          Para solicitar la modificación o eliminación de datos, escribí al
          canal oficial de WhatsApp del consultorio con la frase
          <strong> “SOLICITUD DE PRIVACIDAD”</strong> o
          <strong> “ELIMINAR MIS DATOS”</strong> para que el personal revise la
          solicitud. También podés consultar las
          <a href="/data-deletion"> instrucciones de eliminación de datos</a>.
        </p>
        <p>
          Enviar <strong>“BAJA”</strong> detiene las comunicaciones proactivas,
          pero no elimina por sí solo el historial. Una solicitud se atenderá
          considerando la verificación de identidad, la información que deba
          conservarse y las obligaciones aplicables. Los proveedores externos
          pueden aplicar sus propios procesos y períodos de conservación, por lo
          que una eliminación en esta plataforma no elimina automáticamente las
          copias bajo control de Meta, Google o el dispositivo de la propia
          persona.
        </p>
      </section>

      <section>
        <h2>15. Cambios en esta política</h2>
        <p>
          Esta política puede actualizarse para reflejar cambios en la
          plataforma, en sus proveedores o en las prácticas administrativas. La
          versión vigente se publicará en esta página e indicará su fecha de
          actualización.
        </p>
      </section>

      <section>
        <h2>16. Contacto</h2>
        <p>
          Para consultas o solicitudes relacionadas con privacidad, escribí al
          WhatsApp oficial del Consultorio Odontológico Lentz Gisela:
          <a href="https://wa.me/5492291414102"> +54 9 2291 414102</a>. Incluí
          la frase <strong>“SOLICITUD DE PRIVACIDAD”</strong> para su revisión
          por el personal y no envíes contraseñas ni códigos de verificación.
        </p>
      </section>
    </LegalPage>
  );
});

export const head: DocumentHead = {
  title: "Política de Privacidad | Consultorio Odontológico Lentz Gisela",
  meta: [
    {
      name: "description",
      content:
        "Política de privacidad de la plataforma de gestión de WhatsApp y turnos del Consultorio Odontológico Lentz Gisela.",
    },
    { name: "robots", content: "index, follow" },
  ],
};
