# Reservas, cobertura y señas

La agenda es la fuente de verdad. Google Calendar es sólo un espejo de los
turnos confirmados y WhatsApp nunca decide si una transferencia es válida.

## Flujo simple para Gisela

1. El paciente queda identificado con nombre, WhatsApp, condición de paciente
   anterior y cobertura **IOMA** o **Particular**.
2. La cobertura calcula automáticamente la duración. Los valores iniciales son
   IOMA 30 minutos y Particular 60 minutos.
3. Al elegir un horario, Postgres crea una pre-reserva temporal en estado
   **Esperando seña**. Recién después se envían los datos de transferencia.
4. Una imagen o documento recibido a tiempo cambia la vista a **Comprobante
   recibido** y pausa el bot para que Gisela lo revise.
5. Gisela toca **Confirmar seña**. Esa acción registra usuario y hora, y recién
   entonces el turno queda **Confirmado**.

El importe, alias, titular, minutos de reserva, duraciones y textos se editan en
**Configuración → WhatsApp y reservas**. Un OPERADOR puede verlos, pero sólo un
ADMIN puede modificarlos.

## Vencimiento y concurrencia

Una pre-reserva pendiente bloquea el horario hasta su vencimiento. La consulta
de disponibilidad ignora las que ya vencieron y la creación vuelve a comprobar
el rango dentro de una transacción y un lock por profesional. El constraint de
exclusión de Postgres sigue siendo la última barrera contra doble reserva.

Si el comprobante llega después del vencimiento, el mensaje se conserva y la
conversación queda para revisión humana. No se recrea la reserva, no se desplaza
a otro paciente y no se confirma automáticamente.

## Mensajes y seguridad

- Las plantillas usan valores centralizados (`{deposit_amount}`,
  `{deposit_alias}`, `{deposit_holder}`, `{date}` y `{time}`).
- Los recordatorios y Google Calendar sólo toman turnos confirmados.
- `WHATSAPP_AUTOMATIONS_ENABLED=false` detiene también las respuestas de
  comprobante y vencimiento.
- `WHATSAPP_TEST_MODE=true` bloquea cualquier envío fuera de
  `WHATSAPP_TEST_ALLOWED_NUMBERS`.
- No hay Mercado Pago, Open Banking, OCR ni verificación automática de pagos.

## Operación segura inicial

Mantener las automatizaciones apagadas y el modo de prueba activo hasta validar
con números propios: alta de paciente, duración por cobertura, creación y
vencimiento de pre-reserva, comprobante, confirmación humana y recordatorio.
