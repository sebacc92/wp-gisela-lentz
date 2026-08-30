# Odontograma

El odontograma es el único dato de salud del sistema. El resto de la aplicación
es administrativa, así que este módulo no se apoya en sus reglas: tiene tabla,
permisos y auditoría propios.

## Reglas que lo definen

1. **Sólo ADMIN.** El rol `OPERADOR` gestiona turnos y mensajes y no lo ve, ni
   siquiera de lectura. No hay política de lectura para ese rol, así que un
   error en la interfaz no lo expone.
2. **Append-only.** Cada asiento es el estado de una pieza en un momento. Una
   corrección agrega un asiento nuevo; el anterior queda. No existen permisos
   de `UPDATE` ni `DELETE` para ningún rol autenticado, ni políticas que los
   habiliten, así que la inmutabilidad no depende de que una política esté bien
   escrita. La ley 26.529 declara inviolable la historia clínica, y un registro
   que se puede pisar no lo es.
3. **Fuera del alcance de la automatización.** El bot de WhatsApp nunca lee ni
   envía estos datos, y no hay ningún flujo que los exponga al paciente.
4. **Fechado por el servidor.** `recorded_at` lo pone un trigger con
   `clock_timestamp()`. Una cronología clínica que fija el cliente no sirve como
   registro.
5. **Auditado.** Cada asiento aceptado deja una entrada en `audit_logs`. Un
   asiento rechazado por una restricción no deja rastro.

## Modelo

`odontogram_entries` guarda un asiento por pieza y momento:

- `tooth`: numeración FDI. Permanentes `11-18`, `21-28`, `31-38`, `41-48`;
  temporarias `51-55`, `61-65`, `71-75`, `81-85`. La dentición temporal no es
  opcional: Gisela hace ortopedia y ortodoncia.
- `condition`: estado de la pieza entera.
- `surfaces`: objeto con las caras afectadas. Sólo admite hallazgos
  localizables — caries, obturado, sellante, fracturado — y sólo si la pieza
  está. Una ausencia, un implante, una prótesis o una pieza sana no tienen
  caras que describir, y un check lo impide.
- `entry_sequence`: identidad monotónica. Define qué asiento está vigente. No se
  usa la fecha para eso porque `now()` devuelve la hora de la transacción y dos
  asientos consecutivos la comparten.

La vista `odontogram_current` expone el último asiento de cada pieza con
`security_invoker`, así que respeta las mismas políticas que la tabla.

## Caras

La cara interna se llama palatina en el maxilar superior y lingual en el
inferior. Es la misma cara, así que se guarda con un único valor
`palatina_lingual` y se nombra según la arcada al mostrarla.

## Qué falta

- Imprimir o exportar la ficha de un paciente.
- Registrar varias piezas en una sola acción, para una revisión completa.
- Vincular un asiento con el turno en el que se hizo.
