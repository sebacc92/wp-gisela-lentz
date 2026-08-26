# Cumplimiento y protección del número de WhatsApp

Revisión operativa: **12 de agosto de 2026**. Este documento resume controles del
producto; no reemplaza asesoramiento jurídico argentino ni garantiza decisiones
futuras de Meta. Ante una regla dudosa o una política aún no revisada, el
comportamiento esperado es **no enviar**.

Fuentes oficiales revisadas:

- [WhatsApp Business Messaging Policy](https://whatsappbusiness.com/policy/)
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
2. **Mensajes proactivos:** sólo plantillas que Health sincroniza como
   `APPROVED`, categoría real `UTILITY`, calidad aceptable y vinculadas a un
   turno del mismo contacto.
3. **Consentimiento:** plantilla o recordatorio requiere un evento de opt-in para
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

La autoridad final de mensajería es el backend compartido y el trigger
`enforce_whatsapp_outbound_policy`. El ledger `whatsapp_consent_events` es
append-only; el resumen de consentimiento del contacto no se edita manualmente.

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
