# Demo controlada de WhatsApp

Esta guía usa un número Cloud API de prueba como **A** y un teléfono propio
incluido en la allowlist como **B**. No conecta el número real de Gisela, no hace
campañas y no habilita recordatorios proactivos.

## 0. Condiciones de inicio

- Supabase y Vercel están vinculados a proyectos nuevos.
- `node scripts/assert-deployment-target.mjs` termina correctamente.
- Migraciones y Edge Functions están desplegadas en ese Supabase.
- El callback usa `NUEVO_PROJECT_REF`, nunca una URL copiada de otro producto.
- B está expresado en E.164 dentro de `WHATSAPP_TEST_ALLOWED_NUMBERS`.
- `WHATSAPP_TEST_MODE=true`.
- `WHATSAPP_AUTOMATIONS_ENABLED=false`.
- No existe cron de recordatorios activo.

Entrar a la aplicación y revisar:

1. **Configuración → Consultorio:** no inventar teléfono, email o dirección.
2. **Configuración → Horarios:** cargar una franja de prueba que incluya días y
   horas futuras.
3. **Configuración → Turnos y servicios:** verificar servicios, duración, buffer
   y anticipación mínima.
4. **Configuración → WhatsApp → Verificar conexión:** debe mostrar el número A y
   la WABA correcta. Detenerse ante calidad roja, pausa o inconsistencia.

## 1. Webhook e inbox con automatización apagada

Desde B enviar a A:

```text
Hola, quiero sacar un turno
```

Comprobar:

- aparece un solo paciente con el teléfono B normalizado;
- aparece una sola conversación y un solo mensaje;
- el contador sin leer aumenta;
- no se envía ninguna respuesta automática;
- Agenda y Pacientes siguen operativos.

Abrir la conversación, pulsar **Pausar automatización** si aún figura activa y
responder manualmente. El mensaje debe llegar una sola vez; al abrirlo en B, el
estado debe avanzar de `sent` a `delivered` y eventualmente `read`.

## 2. Test mode

Conservar B en la allowlist y verificar que la respuesta anterior fue permitida.
Para probar el bloqueo, usar sólo otro teléfono propio de prueba, crear/recibir su
conversación y quitarlo temporalmente de `WHATSAPP_TEST_ALLOWED_NUMBERS`.

Al intentar responder:

- no debe llegar ningún mensaje;
- la UI debe mostrar un error simple;
- Meta Graph no debe ser invocado;
- `audit_logs` debe contener `whatsapp.test_mode_blocked` sin número, texto ni
  token.

Volver a dejar una allowlist mínima y conocida. Nunca probar el bloqueo usando el
teléfono de un paciente real.

## 3. Reserva automática completa

Confirmar que B está permitido y cambiar en Supabase:

```env
WHATSAPP_AUTOMATIONS_ENABLED=true
```

Cerrar o reanudar de forma controlada la conversación de B y enviar `Menú`. Luego
recorrer:

1. **Sacar un turno**.
2. Elegir un servicio.
3. Elegir uno de los horarios ofrecidos.
4. Confirmar.

Comprobar:

- el horario estaba dentro de la agenda configurada;
- el turno conserva servicio y duración;
- aparece en Agenda, Inicio y la ficha del paciente;
- B recibe fecha, hora y servicio, sin presentar a Gisela como una profesional
  ajena a quien escribe;
- un segundo intento simultáneo sobre el mismo slot recibe una alternativa y no
  crea solapamiento.

## 4. Reprogramar y cancelar

Desde B:

- elegir **Reprogramar turno**, seleccionar el turno y un horario nuevo;
- comprobar que el turno original no cambia hasta la confirmación final;
- confirmar y verificar el nuevo horario en Agenda;
- elegir **Cancelar turno** y responder primero con texto ambiguo: no debe
  cancelarse;
- confirmar inequívocamente y comprobar estado `Cancelado` y slot liberado.

## 5. Atención manual

Reactivar el bot, enviar `Quiero hablar con Gisela` y comprobar:

- `automation_mode=manual`;
- `needs_human=true`;
- el chip muestra **Atención manual**;
- mensajes posteriores no generan respuestas del bot.

Responder desde la plataforma. El backend reclama el modo manual antes de llamar
a Meta, por lo que no debe aparecer una respuesta paralela automática.

## 6. Urgencia y fuera de horario

En otra conversación propia con automatización activa, enviar:

```text
Tengo dolor intenso y sangrado
```

Debe ocurrir una sola vez:

- respuesta administrativa configurable, sin diagnóstico ni tratamiento;
- conversación marcada **Atención prioritaria**;
- automatización pausada;
- pase a atención manual prioritaria.

Para fuera de horario, configurar un mensaje y una franja que deje el momento de
prueba fuera. El primer mensaje recibe el aviso; mensajes sucesivos durante el
cooldown no deben repetirlo. Un bloqueo excepcional debe prevalecer sobre una
franja semanal.

## 7. Consentimiento y recordatorios

Desde B enviar exactamente:

```text
Acepto recibir recordatorios de turnos
```

Verificar que se registra el opt-in. Luego enviar `BAJA` y comprobar que pausa el
bot, cancela recordatorios pendientes y bloquea mensajes proactivos. Un mensaje
nuevo de B puede abrir una ventana de respuesta, pero no recupera por sí solo el
consentimiento para recordatorios.

No probar un recordatorio real hasta que su plantilla figure
`APPROVED / UTILITY`, Health esté correcto y el cron use el secreto esperado.

## 8. Comprobación técnica

En el SQL Editor del proyecto nuevo:

```sql
select action, entity_type, entity_id, metadata, created_at
from public.audit_logs
order by created_at desc
limit 30;

select direction, type, status, idempotency_key,
       whatsapp_message_id, created_at
from public.messages
order by created_at desc
limit 30;

select external_event_id, event_type, status, error, processed_at
from public.webhook_events
order by created_at desc
limit 30;

select idempotency_key, count(*)
from public.messages
where idempotency_key is not null
group by idempotency_key
having count(*) > 1;
```

La última consulta debe devolver cero filas. Los logs no deben contener access
tokens, secrets, payloads completos ni teléfonos impresos por el control de test
mode.

## 9. Cierre seguro

Al terminar:

```env
WHATSAPP_AUTOMATIONS_ENABLED=false
WHATSAPP_TEST_MODE=true
```

Mantener recordatorios apagados y revisar que no se haya creado un cron. Ante un
duplicado, firma inválida, evento de otra WABA, calidad roja o destinatario
inesperado, detener la prueba y revisar configuración antes de reintentar.
