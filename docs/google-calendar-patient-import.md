# Turnos de pacientes creados en Google Calendar

La sincronización reconoce títulos con nombre completo, `TF` (tiene ficha) o
`1ra vez`, celular y cobertura (`Particular` o `IOMA`). Por ejemplo:

- `Rivas Matias TF Particular`: puede vincularse a un paciente existente si el
  nombre completo coincide de manera única, aunque esté en orden apellido/nombre.
- `Perez Ana 1ra vez 2235550126 IOMA`: permite crear el paciente junto con el turno.
- `Miércoles 9:30 a 12 hs` o `Evento sin título`: siguen siendo bloqueos, no pacientes.

También se leen las abreviaturas que usa la agenda a mano: `PART` o `partic` por
Particular, y las anotaciones de cobro —`dio seña`, `no cobrar`— o un número
suelto de pocos dígitos, que se descartan del nombre en vez de ensuciarlo. El
título completo queda igual en la nota interna del turno. Un número largo que no
sea un teléfono válido sigue pidiendo revisión, porque puede ser uno cortado.

En la pantalla de Turnos, los bloqueos que parecen un turno escrito a mano se
listan primero y muestran el nombre reconocido, para no buscarlos entre los
bloqueos reales. Convertirlos no modifica nada en Google.

`TF` no identifica un tratamiento ni una visita de ortodoncia. Si no hay un
servicio escrito, se utiliza únicamente una opción activa inequívoca de Consulta.
Tratamientos ambiguos, nombres incompletos, homónimos, datos contradictorios,
teléfonos compartidos por otra persona o coberturas faltantes requieren revisión.
No se completa un teléfono ni una cobertura por suposición.

## Importación automática y conversión manual

El reconocimiento automático corre después de una sincronización entrante
completa y confirmada, dentro de la cobertura vigente y para eventos futuros,
individuales y con horario. No corre durante la vista previa ni la importación
inicial de bloqueos. Los eventos pendientes se vuelven a evaluar en próximas
sincronizaciones.

El panel **Convertir en turno** permite elegir un paciente existente o crear uno
nuevo sin salir del panel, precargando lo que se reconoce en el título. Abrir o
cancelar el panel no crea pacientes. El alta/vínculo del paciente y la creación
del turno ocurren en una única transacción; los reintentos no duplican el turno.

Se conserva el inicio y el final originales. Como el profesional ya dio ese
turno, se registra confirmado, sin crear una reserva que venza ni pedir una seña
retroactiva. Esto no registra un pago. Se siguen comprobando colisiones y que la
observación del calendario esté vigente.

## El evento original sigue siendo la fuente

No se borra ni se reemplaza el evento de Google, ni se exporta una segunda copia.
La importación no envía mensajes al paciente. El turno queda sujeto a las reglas
habituales de recordatorios de la aplicación, si están habilitadas.

Los cambios de horario y las cancelaciones de estos turnos se realizan en Google
Calendar; la aplicación muestra su procedencia y bloquea esas acciones locales.
La asistencia puede registrarse en la aplicación. Cambios posteriores observados
en Google generan una revisión explícita antes de modificar el turno vinculado.
La ausencia de un evento en una consulta acotada por fechas no se interpreta como
cancelación: puede haberse movido fuera de esa ventana.

El resumen de sincronización muestra cantidades de turnos reconocidos y eventos
de pacientes que requieren completar datos, sin incluir nombres o teléfonos.

## Publicación y verificaciones

Las migraciones `20260907160000_google_calendar_patient_import.sql` y
`20260907170000_google_calendar_patient_import_guard_convergence.sql`, la función
`process-calendar-sync` y el frontend deben publicarse coordinadamente, con las
migraciones primero. La segunda completa las protecciones si se había aplicado
una copia anterior de la primera. Este documento describe el cambio de código;
no acredita una publicación en producción.

Pruebas: parser y vinculación por identidad, importador con clientes simulados,
contratos del panel, orquestación de sincronización y la suite SQL
`supabase/tests/google_calendar_patient_import.sql`. Todas se pueden ejecutar sin
escribir en Google ni enviar mensajes reales.
