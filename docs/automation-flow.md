# Flujo de automatización

La automatización y todos los cambios de turnos son deterministas. Cada
conversación tiene una fila durable en `automation_sessions`; los cambios
críticos se confirman contra Postgres y no dependen de la decisión de un
modelo. La IA opcional puede redactar respuestas administrativas y transcribir
los datos visibles de un comprobante, pero una regla fija decide si corresponde
confirmar la seña.

```text
idle
 ├─ Sacar turno ─► choosing_appointment_patient (si el mensaje no lo aclara)
 │                  ├─ para mí ─► collecting_patient_profile (sólo datos faltantes)
 │                  ├─ persona a cargo ya cargada ─► selecting_service
 │                  └─ otra persona ─► collecting_dependent_profile (su propia ficha)
 │                  └─ perfil completo ─► selecting_service
 │                  └─ servicio ─► ortodoncia: primera vez / en tratamiento con Gisela
 │                                   └─ selecting_slot
 │                                   └─ horario ─► confirming_appointment
 │                                                    ├─ confirmar sin seña ─► turno confirmado + Calendar
 │                                                    ├─ pre-reservar ─► pre-reserva + mensaje de seña
 │                                                    │                 └─ imagen/PDF ─► validación básica
 │                                                    │                                      ├─ válido ─► turno confirmado
 │                                                    │                                      └─ no válido/tardío ─► human_handoff
 │                                                    ├─ otro ─► selecting_slot
 │                                                    └─ volver ─► idle
 ├─ Ver mis turnos ─► reviewing_appointments
 ├─ Reprogramar ─► selecting_appointment_to_reschedule
 │                  └─ confirming_reschedule_request
 │                      └─ selecting_new_slot
 │                          └─ confirming_new_slot
 │                              ├─ confirmar ─► turno actualizado
 │                              ├─ otro ─► selecting_new_slot
 │                              └─ conservar ─► idle
 ├─ Cancelar ─► selecting_appointment_to_cancel
 │               └─ confirming_cancellation ─► turno cancelado
 ├─ Horarios y ubicación ─► información configurada
 │                           └─ IA administrativa opcional o human_handoff
 └─ Hablar con la secretaria ─► human_handoff
```

Estados adicionales:

- `out_of_hours`: envía una sola respuesta configurable por cooldown. El
  cooldown evita repetir ese aviso; no descarta ni deja sin procesar los
  mensajes siguientes.
- `human_handoff`: deja `automation_mode=manual` y `needs_human=true`.
- una urgencia marca además `priority=true`, envía un aviso administrativo
  configurable y no ofrece diagnóstico ni tratamiento.

## Perfil y reserva

1. La primera respuesta es sólo el saludo configurado. Antes de pedir datos, el
   bot resuelve para quién es el turno: si el mensaje ya lo aclara («un turno
   para mí», «un turno para mi hijo») sigue sin preguntar, y si no, ofrece
   **Para mí** / **Para otra persona** junto a las personas que ese WhatsApp ya
   tiene a cargo. Varios turnos en un mismo pedido siguen derivando a una
   persona: el flujo reserva de a un paciente por vez.
2. Después el bot recopila de forma determinista y de a un dato por mensaje:
   nombre y apellido, si ya se atendió con ella antes, teléfono de contacto y
   cobertura. Si el teléfono del remitente está disponible, puede confirmarlo
   con **Este WhatsApp**; si no, escribe otro número con código de área.
3. Un turno para otra persona pide esos mismos cuatro datos, pero sobre ella y
   guardados en su propia ficha: nada se escribe en la ficha de quien escribe.
   Esa ficha queda a cargo del contacto (`contacts.responsible_contact_id`),
   puede no tener WhatsApp propio y el turno la referencia en
   `appointments.patient_contact_id`. El turno sigue perteneciendo a este
   WhatsApp: seña, recordatorios y avisos no cambian de destinatario, y la
   duración sale de la cobertura de quien se atiende. Pedir otro turno para la
   misma persona reutiliza su ficha en lugar de duplicarla.
4. Se muestran únicamente servicios activos. Los marcados con
   `requires_orthodontic_intake=true` preguntan **Primera vez** o **En tratamiento
   con Gisela** antes de ofrecer horarios. La elección se guarda en el turno
   (`orthodontic_visit_type=first_visit|in_treatment`) y no se infiere de
   `is_existing_patient` ni de una consulta anterior por otro motivo.
5. IOMA usa inicialmente 30 minutos y Particular 60. Ambos valores se leen de
   configuración y `get_available_slots_for_coverage` los aplica realmente.
6. Al confirmar el horario, `create_service_appointment` toma un lock y vuelve a
   validar la disponibilidad local y de Google Calendar. **En tratamiento con
   Gisela** crea `confirmed/not_required`, sin vencimiento ni datos de seña. El
   resto conserva la política configurada: con seña activa crea una pre-reserva
   temporal. Ambas ramas verifican la proyección exacta en Google antes de
   enviar una confirmación o un pedido de seña; una proyección pendiente deriva
   a revisión humana y conserva el turno guardado.
7. Una pre-reserva con seña guarda una copia del monto, alias y titular vigentes, y esos
   mismos datos se envían en el mensaje configurable. Un cambio posterior en
   Configuración no altera lo que se le pidió transferir a ese paciente. El
   turno continúa en “Esperando seña”.
   Un turno de ortodoncia en tratamiento confirma **Sin seña** y vuelve a `idle`,
   sin ingresar en `waiting_deposit` ni solicitar comprobantes.
8. Una imagen JPEG/PNG o un PDF sólo se interpreta como comprobante cuando la
   sesión está en `waiting_deposit` y tiene una pre-reserva asociada. La IA
   transcribe legibilidad, monto, moneda, fecha, alias o destino, titular e
   identificador de operación; no decide si el pago es válido.
9. La regla fija aprueba cuando el comprobante es legible, el monto coincide
   exactamente y coincide el alias o el titular guardado en esa pre-reserva.
   Moneda, fecha e identificador de operación se conservan sólo como datos
   auxiliares: no bloquean la confirmación. Postgres vuelve a comprobar los tres
   datos esenciales y confirma el turno automáticamente dentro de una
   transacción.
10. Si otro pedido ocupó el horario, se informa de forma simple y se ofrecen
    alternativas.

Un comprobante no legible, inválido, no asociado, tardío o cuyo procesamiento
falla deriva a revisión manual. Gisela también conserva los controles para
confirmar o cancelar manualmente. Un comprobante tardío se guarda, pero nunca
revive ni confirma una reserva vencida.

## Reprogramación y cancelación

- Sólo se consultan reservas/turnos futuros activos del mismo contacto, incluidos
  los de las personas que tiene a cargo. Esos se listan con el nombre de quien se
  atiende y ofrecen horarios según la cobertura de esa persona.
- Si hay varios, el paciente debe seleccionar uno.
- El turno original se conserva hasta confirmar el nuevo horario.
- Si era una pre-reserva pendiente, conserva monto, alias, titular y vencimiento
  ya informados, y continúa en `waiting_deposit` para poder leer el comprobante.
- Conserva también la elección de ortodoncia y su condición de seña: un turno
  en tratamiento sigue confirmado sin seña al reprogramarse.
- Una cancelación siempre requiere confirmación inequívoca.
- Los botones de un recordatorio validan que el turno siga activo y pertenezca al
  contacto antes de cambiarlo.
- Los turnos confirmados sin seña participan de los mismos recordatorios y del
  resumen privado para Gisela que los demás turnos confirmados.

## Atención humana y urgencias

- Una respuesta manual pausa el bot antes del envío externo.
- `Reanudar automatización` limpia `needs_human` y la prioridad ya atendida.
- Después de dos entradas inválidas, el bot pasa la conversación a atención
  manual.
- La lectura automática de imágenes y PDF sólo se intenta en
  `waiting_deposit`. Fuera de ese estado, o ante un archivo no legible o un
  fallo de lectura, la conversación pasa a revisión manual.
- Palabras de urgencia, dolor intenso, sangrado, emergencia, accidente o trauma
  marcan prioridad y detienen el flujo de reserva.
- La conversación prioritaria queda visible en rojo en la bandeja.

## Fuera de horario

La comprobación usa la zona horaria configurada, franjas semanales y excepciones.
Un bloqueo vigente prevalece sobre el horario habitual; una apertura excepcional
puede habilitarlo. El cooldown evita repetir el aviso ante cada mensaje, pero no
impide que el flujo procese las entradas posteriores.

## Controles globales

- La confirmación sin seña usa el propósito `appointment_confirmation`, que
  exige la ejecución causal del mensaje entrante y conserva los controles de
  automatización, pausa humana y ventana de servicio de 24 horas. Justo antes
  de enviar comprueba otra vez paciente, estado `confirmed/not_required`,
  horarios originales y proyección `confirmed` en Google Calendar. Un cambio
  concurrente bloquea el mensaje obsoleto. No sustituye este mensaje por una
  plantilla paga ni usa la confirmación de un depósito como evidencia.

- `app_settings.automations_enabled=false`: apaga las respuestas del bot desde
  la aplicación. Es la posición operativa por defecto; una persona `ADMIN` puede
  cambiarla desde el interruptor del menú en escritorio o desde Inicio en
  mobile. Cada cambio queda auditado.
- Una persona `ADMIN` puede abrir desde una conversación una ventana de prueba
  individual de 24 horas. Esta excepción sólo reemplaza el interruptor
  operativo anterior para ese chat: no cambia `automation_mode`, no quita una
  pausa manual, no evita consentimiento, locks, leases, idempotencia, seguridad
  de destinatario ni pausas de envío. La ventana se vuelve a comprobar al
  finalizar el webhook, al reclamar o recuperar trabajo, al registrar efectos y
  justo antes de enviar a Graph. Activaciones, extensiones y revocaciones quedan
  auditadas sin copiar teléfonos ni mensajes.
- `WHATSAPP_AUTOMATIONS_ENABLED=false`: no se invoca el bot ni se despachan
  handoffs, respuestas urgentes o recordatorios automáticos. Webhook, bandeja y
  respuestas manuales siguen disponibles. Este kill switch backend debe estar
  en `true` para que el interruptor de la aplicación o una ventana de prueba
  individual puedan habilitar el bot.
- `app_settings.ai_enabled=false`: no se llama a OpenAI aunque la automatización
  general esté activa. Toda asistencia requiere además el kill switch backend
  `OPENAI_ADMINISTRATIVE_ENABLED=true`. Las respuestas administrativas y los
  comprobantes usan `gpt-5.6-luna`; el audio usa `gpt-transcribe`.
- La lectura de audio, imagen o PDF requiere también
  `app_settings.ai_media_enabled=true`. Por lo tanto, el comprobante automático
  sólo funciona con `WHATSAPP_AUTOMATIONS_ENABLED`, `ai_enabled`,
  `ai_media_enabled` y `OPENAI_ADMINISTRATIVE_ENABLED` activos. Si falla alguno,
  el archivo no se interpreta y queda para revisión manual.
- Las respuestas de horarios/ubicación sólo envían una pregunta canónica, los
  datos estructurados del consultorio y un identificador seudónimo. Para un
  comprobante se envía el adjunto necesario para transcribir sus datos. Las
  solicitudes a Responses usan `store=false`. Esto evita estado de aplicación
  en Responses, pero no sustituye Zero Data Retention: por defecto el proveedor
  puede conservar registros de prevención de abuso hasta 30 días. Las notas de
  voz usan `/v1/audio/transcriptions`, para el que la tabla vigente del proveedor
  indica que no hay retención de estado de aplicación ni de logs de prevención
  de abuso.
- `WHATSAPP_TEST_MODE=true`: todo destinatario debe aparecer en
  `WHATSAPP_TEST_ALLOWED_NUMBERS`, incluidas respuestas manuales y recordatorios.
- Las ventanas de prueba por conversación no crean ni habilitan recordatorios y
  no intervienen en sus claims. Los reminders conservan sus gates existentes.
- `Menú`, `inicio` o `volver al menú` reinician el flujo sin escribir cambios
  críticos.
