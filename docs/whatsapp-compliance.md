# Cumplimiento y protección del número de WhatsApp

Revisión operativa: **6 de septiembre de 2026**. Este documento resume controles del
producto; no reemplaza asesoramiento jurídico argentino ni garantiza decisiones
futuras de Meta. Ante una regla dudosa o una política aún no revisada, el
comportamiento esperado es **no enviar**.

Fuentes oficiales revisadas:

- [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
- [Precios oficiales de la plataforma](https://whatsappbusiness.com/products/platform-pricing/)
- [WhatsApp Messaging Guidelines](https://www.whatsapp.com/legal/messaging-guidelines)
- [WhatsApp Business Terms](https://www.whatsapp.com/legal/business-terms)
- [Documentación de WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/)

Meta exige una experiencia esperada por el usuario: número entregado por la
persona, opt-in para comunicaciones posteriores, respeto inmediato de bajas,
plantillas aprobadas para iniciar conversaciones y texto libre sólo dentro de la
ventana de 24 horas desde el último mensaje del usuario. También exige una vía
clara de escalamiento humano y restringe pedir identificadores sensibles o usar
información de salud cuando la regulación aplicable no lo permita.

## Alcance permitido para Gisela Lentz

WhatsApp se usa para tareas administrativas:

- solicitar, reservar, confirmar, reprogramar o cancelar turnos;
- enviar recordatorios consentidos;
- informar datos del consultorio que Gisela haya configurado;
- derivar la conversación a atención humana.

No se usa para historia clínica, diagnóstico, triage, odontograma, recetas,
medicación, estudios, radiografías, fotografías clínicas, pagos, marketing,
campañas ni venta de productos sanitarios. El bot no es un servicio de
emergencias. Una urgencia sólo genera prioridad y handoff.

No pedir ni enviar números completos de DNI, pasaporte, tarjeta, cuenta bancaria,
CBU/CUIT/CUIL u otros identificadores sensibles. Si una gestión requiere datos
clínicos o identificatorios, detener el flujo y usar un canal y procedimiento
aprobados por la responsable del consultorio.

## Reglas que aplica el sistema

1. **Ventana de servicio:** texto libre e interacciones sólo antes de
   `último mensaje entrante + 24 horas`. Un mensaje saliente o un estado de
   entrega no extiende esa ventana.
2. **Mensajes proactivos a pacientes fuera de ventana:** sólo plantillas que Health sincroniza como
   `APPROVED`, categoría real `UTILITY`, calidad aceptable y vinculadas a un
   turno del mismo contacto.
3. **Consentimiento de pacientes:** plantilla o recordatorio requiere un evento de opt-in para
   `appointment_updates`, con fuente, versión del aviso y evidencia. Un “hola” o
   pedido de turno no crea permiso permanente.
4. **Baja:** `BAJA`, `STOP` y frases inequívocas se procesan antes del bot. La
   baja pausa automatización, cancela recordatorios pendientes y bloquea
   plantillas. Una nueva consulta permite responder dentro de su ventana, pero no
   reactiva recordatorios.
5. **Idempotencia:** cada envío usa una clave estable. Doble clic, reintento o
   webhook repetido no crea otro despacho lógico.
6. **Frecuencia:** existen límites internos conservadores para mensajes,
   respuestas automáticas y plantillas. No deben interpretarse como cuotas
   oficiales de Meta.
7. **Calidad:** calidad no verificada o amarilla bloquea proactivos; roja, número
   `FLAGGED` o restricción activa el corte global. Recuperar verde no levanta
   automáticamente una pausa manual.
8. **Handoff:** el operador reclama modo manual antes de enviar. Toda respuesta
   automática vuelve a consultar el modo justo antes de Graph.
9. **Urgencias y contenido clínico:** se marca atención humana/prioritaria y no se
   continúa la reserva ni se brinda indicación clínica.
10. **Test mode:** todo envío, incluso manual, se limita a la allowlist. Un
    bloqueo guarda IDs y resultado, nunca teléfono, texto, payload o secret.
11. **Kill switch:** con `WHATSAPP_AUTOMATIONS_ENABLED=false` siguen funcionando
    webhook, persistencia, inbox y respuesta manual, pero no bot, handoffs
    automáticos ni recordatorios.
12. **IA administrativa opcional:** requiere además
    `OPENAI_ADMINISTRATIVE_ENABLED=true` y `ai_enabled=true`, sólo admite
    consultas de horarios/ubicación y envía al proveedor una pregunta canónica
    con dirección y horarios estructurados. No comparte el mensaje original,
    identidad, teléfono del paciente, cobertura, turnos, comprobantes ni datos
    de salud; usa `store=false` y deriva a una persona ante datos faltantes o una
    respuesta riesgosa. `store=false` evita estado de aplicación, pero los logs
    de prevención de abuso del proveedor pueden conservar contenido hasta 30
    días salvo que el proyecto tenga Zero Data Retention.

La autoridad final de mensajería es el backend compartido y el trigger
`enforce_whatsapp_outbound_policy`. El ledger `whatsapp_consent_events` es
append-only; el resumen de consentimiento del contacto no se edita manualmente.

## Agenda privada de Gisela y resumen de las 21:00

El acceso privado usa exactamente un teléfono personal E.164 en el secreto
`WHATSAPP_OWNER_NUMBERS`. No se acepta un nombre de perfil, un mensaje diciendo
“soy Gisela”, el teléfono público del consultorio ni un número agregado desde la
UI. Una lista ausente o con varios teléfonos falla cerrada. La aplicación está
pensada únicamente para esta profesional.

El webhook comprueba la firma de Meta y registra el teléfono del remitente
observado en ese evento. El backend revalida esa evidencia, su vigencia de
24 horas y el destinatario real justo antes de enviar. El navegador no puede
editar `messages.metadata`; el número editable de un contacto no concede acceso
privado. Si Meta sólo comparte un identificador sin teléfono, la respuesta
privada se bloquea hasta contar con identidad telefónica verificable.

Desde ese teléfono Gisela puede pedir “turnos de hoy”, “turnos de mañana”,
“turnos de la semana” o “datos de Ana Pérez”. Las respuestas contienen datos
administrativos necesarios y quedan registradas. No se exportan notas libres,
motivos de consulta, tratamientos, odontogramas ni historias clínicas. Los
adjuntos del teléfono autorizado no se envían a IA para interpretar consultas
privadas; los pedidos privados se hacen por texto.

Con `WHATSAPP_OWNER_DAILY_SUMMARY_ENABLED=true`, el worker de recordatorios
prepara una única agenda de mañana a las **21:00 de Buenos Aires**. El cron se
invoca cada cinco minutos; permite reintentos hasta las 21:15. Después omite ese
día. Incluye turnos activos del sistema y horarios ocupados importados desde
Google Calendar, sin copiar títulos libres de esos eventos. Excluye
pre-reservas vencidas e indica si Calendar carece de una revisión reciente.

Este resumen se envía sólo en texto libre dentro de las 24 horas desde un
mensaje entrante verificado de Gisela. Una salida, eco del teléfono comercial,
confirmación de entrega o importación de historial no abre ni renueva esa
ventana. La baja, una pausa de conversación o los interruptores del bot frenan
el resumen. Si no hay ventana, se registra la omisión y **no se usa una plantilla
como alternativa**. Los recordatorios a pacientes conservan su configuración y
consentimiento separados.

La tabla privada `whatsapp_owner_daily_summaries` conserva fecha, estado, motivo
de omisión, destinatario y texto del primer intento. La fecha es única; los
reintentos no cambian el contenido ni crean otro despacho lógico. La autorización
y la hora se controlan otra vez en SQL y antes de Graph. No se persiste la agenda
si el resumen ya se omite por falta de ventana.

La página oficial de precios consultada el 6/9/2026 indica que los mensajes de
servicio dentro de la ventana son gratuitos. El código garantiza que este
resumen no usa plantillas; el costo final depende de las condiciones vigentes
de Meta, que deben revisarse si cambian. Esto es una revisión de controles del
producto, no una certificación de cumplimiento de la cuenta ni de obligaciones
locales sobre datos de salud.

## Texto de consentimiento sugerido

Debe ser revisado legalmente y presentarse con una acción explícita no premarcada:

> Acepto recibir por WhatsApp mensajes de Gisela Lentz sobre confirmaciones,
> cambios y recordatorios de mis turnos. Puedo darme de baja en cualquier momento
> respondiendo BAJA.

Guardar sólo contacto, decisión, alcance, fuente, versión, fecha y referencia de
evidencia. Dentro del bot, el opt-in reconoce la frase exacta `Acepto recibir
recordatorios de turnos` o el botón `opt_in_appointment_reminders`. Para una baja
no se exige una frase exacta.

## Checklist antes de mensajes proactivos

- Proyecto Supabase, Vercel, WABA y Phone Number ID nuevos/verificados.
- Callback y firma probados; eventos de otra WABA o número ignorados.
- Perfil comercial real y actualizado con un contacto de soporte.
- Política de privacidad publicada y revisión jurídica local completada.
- Si se habilitará IA: clave exclusiva del proyecto, presupuesto/límites
  revisados, datos estructurados del consultorio correctos y los tres kill
  switches probados primero con datos ficticios.
- Health confirma pertenencia Phone/WABA, calidad y plantillas
  `APPROVED / UTILITY`.
- Horarios, bloqueos, servicios, textos y responsables de handoff revisados.
- Test mode activo con un único número propio durante la prueba inicial.
- Entrada, salida manual, baja, mensaje posterior, doble clic, urgencia y handoff
  verificados sin datos reales de pacientes.
- Consentimiento demostrable para cada contacto que recibirá recordatorios.
- Recién entonces activar el aviso del día anterior, inicialmente a las 21:00,
  y crear el cron. Mantener el segundo aviso apagado salvo decisión posterior
  documentada.

## Incidente de calidad o destinatario inesperado

1. Poner `WHATSAPP_AUTOMATIONS_ENABLED=false`, mantener test mode y detener cron.
2. No rotar el número ni intentar evadir una restricción.
3. Revisar WhatsApp Manager: calidad, motivos, plantillas pausadas y reportes.
4. Auditar consentimiento, frecuencia, duplicados, allowlist y contexto del
   turno sin exportar contenido personal innecesario.
5. Corregir la causa y usar los canales oficiales de soporte/apelación si
   corresponde.
6. Reanudar manualmente con el volumen mínimo y sólo destinatarios esperados.

## Revisión continua

Meta puede cambiar políticas y aplicar enforcement por calidad o feedback. Revisar
las fuentes oficiales antes de conectar el número real, habilitar una categoría
nueva, activar recordatorios o cambiar el producto. Registrar fecha y responsable
de cada revisión.
