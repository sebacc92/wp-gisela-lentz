# Reservas, cobertura y señas

La agenda es la fuente de verdad. Con la automatización de Calendar activa,
Google Calendar refleja las pre-reservas nuevas creadas después de la activación
y actualiza ese mismo evento cuando el turno se confirma o cancela. Una conexión
por sí sola no garantiza que esos cambios se sincronicen automáticamente. La IA
transcribe los datos visibles del comprobante y una regla fija de la aplicación
decide si alcanza para confirmar la seña; no existe una verificación bancaria de
la transferencia.

## Flujo simple para Gisela

Gisela atiende únicamente por **IOMA** o de forma **Particular**. No se ofrecen
otras obras sociales. Si el paciente menciona otra cobertura, debe aceptar la
atención particular antes de registrarlo con esa opción.

1. El paciente queda identificado con nombre, WhatsApp, condición de paciente
   anterior y cobertura **IOMA** o **Particular**.
2. La cobertura calcula automáticamente la duración. Los valores iniciales son
   IOMA 30 minutos y Particular 60 minutos.
3. Al elegir un horario, Postgres crea una pre-reserva temporal en estado
   **Esperando seña**, guarda el monto, alias y titular vigentes y recién
   después envía esos mismos datos de transferencia.
4. Una imagen JPEG/PNG o un PDF recibido mientras la sesión está en
   `waiting_deposit` se asocia a esa pre-reserva. Fuera de ese estado no se
   interpreta automáticamente y pasa a revisión manual.
5. La IA sólo transcribe legibilidad, monto, moneda, fecha, alias o destino,
   titular e identificador de operación. No aprueba ni rechaza el pago.
6. Una regla fija exige que sea legible, que el monto coincida exactamente y
   que coincida el alias o el titular guardado en esa pre-reserva. Moneda, fecha
   e identificador de operación quedan como datos auxiliares y no bloquean la
   confirmación.
7. Si cumple, Postgres confirma el turno automáticamente y se envía la
   confirmación por WhatsApp. Si no cumple, no se puede leer, falla el
   procesamiento o llegó tarde, la conversación pasa a revisión manual.

El importe, alias, titular, minutos de reserva, duraciones y textos se editan en
**Configuración → WhatsApp y reservas**. Un OPERADOR puede verlos, pero sólo un
ADMIN puede modificarlos. Gisela conserva los controles manuales para confirmar
o cancelar un turno si al revisar el comprobante detecta un problema.

## Vencimiento y concurrencia

Una pre-reserva pendiente bloquea el horario hasta su vencimiento. La consulta
de disponibilidad ignora las que ya vencieron y la creación vuelve a comprobar
el rango dentro de una transacción y un lock por profesional. El constraint de
exclusión de Postgres sigue siendo la última barrera contra doble reserva.

Si el comprobante llega después del vencimiento, el mensaje se conserva y la
conversación queda para revisión humana. No se recrea la reserva, no se desplaza
a otro paciente y no se confirma automáticamente.

Si llegó antes del vencimiento pero la lectura terminó después, Postgres puede
recuperar y confirmar esa misma pre-reserva únicamente si el horario continúa
libre; nunca desplaza una reserva posterior.

Si el paciente reprograma una pre-reserva pendiente, se conservan el monto,
alias, titular y vencimiento que ya se le informaron. El flujo sigue esperando
el comprobante para el mismo turno, ahora en el nuevo horario.

El procesamiento bloquea la pre-reserva exacta y es idempotente por mensaje:
un reintento del webhook o del worker no vuelve a confirmar ni genera otra
decisión. Se conserva el hash SHA-256 del archivo, la lectura estructurada, la
versión de la regla aplicada, el resultado, el mensaje y el turno relacionados,
además del registro de auditoría. El hash sirve para trazabilidad técnica; no se
usa como barrera antifraude, no impide que se reenvíe el mismo archivo y no
demuestra que el comprobante sea auténtico.

## Mensajes y seguridad

- Las plantillas usan valores centralizados (`{deposit_amount}`,
  `{deposit_alias}`, `{deposit_holder}`, `{date}` y `{time}`).
- Los recordatorios sólo toman turnos confirmados. Con la automatización de
  Calendar activa, las pre-reservas nuevas posteriores a la activación también
  se reflejan como pendientes de seña y luego se actualizan sobre el mismo
  evento.
- `WHATSAPP_AUTOMATIONS_ENABLED=false` detiene también las respuestas de
  comprobante y vencimiento.
- La lectura automática requiere simultáneamente `app_settings.ai_enabled=true`,
  `app_settings.ai_media_enabled=true` y
  `OPENAI_ADMINISTRATIVE_ENABLED=true`. Si alguno está apagado, el adjunto queda
  para revisión manual. La automatización general también debe estar activa.
- `WHATSAPP_TEST_MODE=true` bloquea cualquier envío fuera de
  `WHATSAPP_TEST_ALLOWED_NUMBERS`.
- No hay Mercado Pago, Open Banking ni consulta al banco. La política acepta el
  riesgo de una captura editada o una transferencia falsa: se comprueban sólo
  los datos básicos visibles para priorizar una confirmación rápida. Gisela
  revisa después y puede cancelar manualmente el turno si corresponde.

## Operación segura inicial

Mantener las automatizaciones apagadas y el modo de prueba activo hasta validar
con números propios: alta de paciente, duración por cobertura, creación y
vencimiento de pre-reserva, comprobante válido con confirmación automática,
comprobante inválido o tardío con revisión manual, reintentos idempotentes,
cancelación manual y recordatorio.
