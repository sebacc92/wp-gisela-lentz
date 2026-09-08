# Revisión del título de un turno importado

Un turno importado conserva el evento original de Google. Cambiar su título
puede generar `metadata_changed`, pero «Restaurar desde la agenda» no corresponde:
la aplicación no escribe sobre esos eventos.

La revisión administrativa relee únicamente ese evento en Google, muestra el
título guardado y el actual, y permite aceptar el texto sólo si identifica sin
ambigüedad al mismo paciente y conserva los datos operativos. La confirmación
revalida el ETag visto por la persona. Nunca cambia el paciente, cobertura,
servicio, horario ni estado del turno, ni envía mensajes o modifica Google.

Una anotación administrativa final como `seña 10` puede conservarse como texto
tras esta revisión explícita. No se interpreta el importe ni se registra un
pago, comprobante o confirmación de seña. Esta tolerancia no modifica el parser
de importación automática ni la política de reservas.

`accept_google_calendar_imported_title_review` sólo admite `service_role`; el
endpoint debe autenticar a un ADMIN y comprobar el evento remoto antes de llamar.
SQL vuelve a verificar al ADMIN activo, conexión, generación y epoch actuales, fuente
importada, conflicto pendiente, título original, ETag y versiones del turno y
contacto. Si hay una sincronización inbound en curso, incluso con lease vencido
sin liberar, exige reintentar después de su finalización. Una modificación
concurrente invalida la revisión y requiere cargarla de nuevo.

La aceptación actualiza únicamente el título de referencia y snapshot de Google,
resuelve el conflicto y registra la decisión con IDs, sin títulos ni credenciales
en el log. El trigger existente de disponibilidad avisa a la interfaz. La próxima
sincronización reconoce el nuevo título de referencia sin reabrir el conflicto.
