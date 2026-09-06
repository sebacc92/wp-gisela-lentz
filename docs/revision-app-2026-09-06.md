# Revisión de la app interna · 6 de septiembre de 2026

El alcance de esta revisión es `/app`: agenda, Google Calendar, WhatsApp privado,
recordatorios y odontograma de Gisela Lentz. La landing pública no se modificó.

## Experiencia de uso

- Agenda con selección semanal, acceso a hoy y mañana, horarios de inicio y fin
  en formato de 24 horas, motivo de consulta y estado legible del turno.
- Bloqueos de Google desplegables, resumen del día y actualización al regresar
  a la app, al sincronizar y cada minuto mientras la página está visible.
- Protección contra respuestas de carga atrasadas al cambiar rápidamente de día.
- Inicio con acceso a mañana, fecha del próximo turno, hora de actualización y
  tarjetas compactas en móvil. Los mensajes sin leer ya no se presentan como
  mensajes necesariamente sin responder.
- Estado de Calendar con detalles desplegables y acciones de revisión. Un
  calendario desconectado o con errores sigue mostrando la advertencia.
- Recordatorios a pacientes separados del resumen privado para Gisela.
- Al crear un paciente junto con un turno, la ficha recién guardada se conserva
  si falla la reserva, para no duplicar el paciente al reintentar.

## Reservas y Google Calendar

Una reserva local o una respuesta exitosa del procesador no prueban que ese
turno esté en Google. El nuevo RPC `appointment_google_calendar_projection`
verifica el turno exacto, su intervalo, etapa, cuenta, calendario y generación.
La app vuelve a consultarlo después de solicitar una sincronización.

Si Google sigue pendiente, no se vuelve a crear el turno: la app conserva el
registro y muestra que falta verificar la sincronización. No se envía el pedido
de seña ni la confirmación automática desde estos flujos hasta verificar Google.
Esto también se aplica a la reprogramación y la conversión de bloqueos.

El backend vuelve a leer la ocupación remota antes de escribir cada evento,
incluyendo eventos recurrentes, de día completo y todas las páginas del
intervalo. Mantiene las barreras transaccionales de Postgres y las condiciones
de actualización del evento propio.

Google Calendar permite que otra persona cree un evento simultáneamente o
después de una reserva: su API no ofrece una transacción para bloquear todo un
intervalo junto con Postgres. La comprobación inmediata reduce esa carrera y
los conflictos posteriores necesitan revisión en la app. No se debe prometer
exclusión absoluta de cambios hechos directamente por otra persona en Google.

## Datos privados y recordatorio de Gisela

La autorización se basa en un único teléfono personal configurado en backend
y en la identidad recibida de un webhook firmado por Meta. El nombre del
contacto, sus datos editables o el contenido de un mensaje no otorgan acceso.
La identidad y la ventana se vuelven a comprobar antes del envío.

El resumen privado de las 21:00 usa Buenos Aires y requiere un mensaje entrante
válido dentro de las últimas 24 horas. Si falta esa ventana, se omite el envío;
no tiene alternativa mediante plantilla paga. La configuración y los requisitos
operativos están en [cumplimiento de WhatsApp](whatsapp-compliance.md).

El número personal no fue proporcionado durante esta revisión. No se inventó
ni se habilitó un destinatario. La activación en un entorno requiere configurar
ese número, los interruptores correspondientes y la invocación programada de
`process-reminders`.

## Odontograma

El estado vigente respeta `entry_sequence`, mantiene hallazgos diferentes por
cara y conserva el historial append-only. Una carga fallida bloquea la edición
en lugar de presentar una ficha vacía. Se protegen borradores y cambios de
paciente o pieza durante el guardado. El rol OPERADOR sigue sin acceso clínico.
Los detalles están en [odontograma](odontograma.md).

## Validación y aplicación

La revisión visual usa datos ficticios e intercepta las solicitudes de Supabase:
no envía WhatsApps ni escribe en un calendario real. Se revisan Inicio, Agenda,
Pacientes, Mensajes, Configuración y Odontograma en anchos de 360, 390, 768 y 1440 píxeles,
además de los formularios y la navegación por fechas.

Las pruebas de comportamiento cubren proyección pendiente, conflicto, respuesta
de sincronización perdida, ausencia de prueba de proyección y supresión de
mensajes antes de confirmar Google. Se conservan las pruebas existentes de
agenda, WhatsApp, privacidad y odontograma.

Resultado final: compilación cliente y servidor, tipado, lint y formato
aprobados; 561 pruebas Node y 89 pruebas Deno en la suite de automatización,
más la regresión adicional del cambio concurrente de etapa; 1.203 aserciones SQL
aprobadas en los 45 archivos de la suite completa. La revisión de navegador no
detectó desbordes horizontales ni excepciones JavaScript. Lint conserva avisos
de estilo existentes, sin errores.

Las pruebas generales que antes asumían reservas sin Calendar ahora preparan
una conexión sintética autorizada. La prueba de concurrencia restaura su
configuración y elimina sus datos temporales al terminar. Ambas migraciones
nuevas están aplicadas y registradas en la base local.

Los cambios necesitan aplicar las nuevas migraciones y desplegar las funciones
modificadas y la app en el entorno de Gisela. Esta revisión no despliega ni
activa automatizaciones en producción. Consultar las guías de
[Calendar](google-calendar-setup.md) y [WhatsApp](whatsapp-setup.md) para el
destino, las credenciales y la comprobación controlada posterior.
