# Flujo de automatización

La automatización y todos los cambios de turnos son deterministas. Cada
conversación tiene una fila durable en `automation_sessions`; los cambios
críticos se confirman contra Postgres y no dependen de un modelo. Existe una
asistencia opcional y acotada para redactar únicamente horarios o ubicación.

```text
idle
 ├─ Sacar turno ─► collecting_patient_profile (sólo datos faltantes)
 │                  └─ perfil completo ─► selecting_service
 │                  └─ servicio ─► selecting_slot
 │                                   └─ horario ─► confirming_appointment
 │                                                    ├─ confirmar ─► pre-reserva + mensaje de seña
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
 └─ Hablar con Gisela ─► human_handoff
```

Estados adicionales:

- `out_of_hours`: envía una sola respuesta configurable y no vuelve a responder
  durante el cooldown.
- `human_handoff`: deja `automation_mode=manual` y `needs_human=true`.
- una urgencia marca además `priority=true`, envía un aviso administrativo
  configurable y no ofrece diagnóstico ni tratamiento.

## Perfil y reserva

1. El remitente de WhatsApp ya aporta el teléfono principal. El bot recopila de
   forma determinista nombre, paciente anterior y cobertura, y pregunta sólo lo
   que falta.
2. Se muestran únicamente servicios activos; el servicio expresa el motivo.
3. IOMA usa inicialmente 30 minutos y Particular 60. Ambos valores se leen de
   configuración y `get_available_slots_for_coverage` los aplica realmente.
4. Al confirmar el horario, `create_service_appointment` toma un lock, vuelve a
   validar y recién entonces crea una pre-reserva temporal.
5. Sólo después de crearla se envía el mensaje configurable con monto, alias y
   titular. El turno continúa en “Esperando seña”.
6. Una imagen/documento recibido durante la reserva pasa a “Comprobante
   recibido” y a revisión humana. Nunca se valida el pago automáticamente.
7. Si otro pedido ocupó el horario, se informa de forma simple y se ofrecen
   alternativas.

La aprobación ocurre exclusivamente cuando una persona toca **Confirmar seña**.
Un comprobante tardío se guarda y deriva a revisión, pero nunca revive ni
confirma una reserva vencida.

## Reprogramación y cancelación

- Sólo se consultan reservas/turnos futuros activos del mismo contacto.
- Si hay varios, el paciente debe seleccionar uno.
- El turno original se conserva hasta confirmar el nuevo horario.
- Una cancelación siempre requiere confirmación inequívoca.
- Los botones de un recordatorio validan que el turno siga activo y pertenezca al
  contacto antes de cambiarlo.

## Atención humana y urgencias

- Una respuesta manual pausa el bot antes del envío externo.
- `Reanudar automatización` limpia `needs_human` y la prioridad ya atendida.
- Después de dos entradas inválidas, el bot deriva a Gisela.
- Imágenes y documentos pasan a revisión humana. Si existe una pre-reserva
  vigente se asocian como posible comprobante, sin OCR ni validación automática.
- Palabras de urgencia, dolor intenso, sangrado, emergencia, accidente o trauma
  marcan prioridad y detienen el flujo de reserva.
- La conversación prioritaria queda visible en rojo en la bandeja.

## Fuera de horario

La comprobación usa la zona horaria configurada, franjas semanales y excepciones.
Un bloqueo vigente prevalece sobre el horario habitual; una apertura excepcional
puede habilitarlo. El cooldown evita repetir el aviso ante cada mensaje.

## Controles globales

- `WHATSAPP_AUTOMATIONS_ENABLED=false`: no se invoca el bot ni se despachan
  handoffs, respuestas urgentes o recordatorios automáticos. Webhook, bandeja y
  respuestas manuales siguen disponibles.
- `app_settings.ai_enabled=false`: no se llama a OpenAI aunque la automatización
  general esté activa. Además requiere el kill switch backend
  `OPENAI_ADMINISTRATIVE_ENABLED=true`. Cuando los tres controles están activos,
  sólo se envía una pregunta canónica sobre horarios/ubicación, los datos
  estructurados del consultorio y un identificador seudónimo; nunca el texto
  original ni datos del paciente. La solicitud usa `store=false` y el modelo
  fijo `gpt-5.6-luna`.
- `WHATSAPP_TEST_MODE=true`: todo destinatario debe aparecer en
  `WHATSAPP_TEST_ALLOWED_NUMBERS`, incluidas respuestas manuales y recordatorios.
- `Menú`, `inicio` o `volver al menú` reinician el flujo sin escribir cambios
  críticos.
