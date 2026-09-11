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

La cara central sigue el mismo criterio: se guarda siempre como `oclusal`,
pero se muestra como **oclusal** en premolares y molares y como **incisal** en
incisivos y caninos, que anatómicamente tienen borde incisal y no cara
oclusal. Las piezas anteriores son las posiciones 1 a 3 de cada cuadrante FDI
(`isAnteriorTooth`). El valor guardado no cambia: sólo cambia el rótulo, igual
que con palatina/lingual.

## Colores y símbolos de la ficha de Gisela

La representación sigue la referencia proporcionada por Gisela para su
consultorio. No se presenta como un formato universal ni como una ficha de
facturación homologada por una obra social.

| Registro            | Representación                           |
| ------------------- | ---------------------------------------- |
| Caries              | Marca azul                               |
| Obturación          | Círculo rojo                             |
| Extracción indicada | Dos líneas horizontales paralelas azules |
| Pieza ausente       | Cruz azul                                |

Las piezas muestran un esquema de cinco caras. Un hallazgo localizado se
marca en la cara expresamente registrada: relleno azul para caries y círculo
rojo para obturación. Cuando ese hallazgo no tiene caras especificadas, se
dibuja sobre la pieza completa: un marco cuadrado azul para caries o un círculo
rojo grande para obturación. Ese contorno indica un hallazgo general, sin
atribuirlo a ninguna cara. Una caries oclusal y una obturación distal pueden
verse simultáneamente, al igual que una caries general y una obturación distal.

## Plan de tratamiento

`treatment_plan_items` es **presupuesto, no historia clínica**. Registra qué se
piensa hacer, cuánto sale y en qué estado está (pendiente, en curso, hecho,
cancelado). Por eso, a diferencia del odontograma, sí admite modificación y
borrado.

Marcar un ítem como hecho **no** escribe nada en el odontograma: el hallazgo
clínico lo registra la profesional aparte. El verde de "en curso" pertenece a
este vocabulario de avance y no altera la convención de colores de la ficha.

La selección múltiple de piezas agrega **un asiento por pieza**, igual que si
se cargaran de a una: no es una edición masiva, porque la ficha sigue siendo
append-only. Los atajos de teclado sólo fijan la condición; aplicarla exige el
botón y su confirmación.

## Orientación

La orientación mantiene la vista de frente al paciente: mesial apunta hacia
la línea media; vestibular queda hacia fuera de la arcada; palatina arriba y
lingual abajo quedan hacia dentro. La numeración FDI no cambia.

Las demás condiciones conservan su nombre y se representan en tono neutro:
el registro actual no distingue si una corona, prótesis u otro tratamiento
está indicado o realizado, y el dibujo no debe inferirlo. Una pieza sin
registrar sigue distinguiéndose de una registrada como sana.

El cambio es de representación: no reemplaza registros clínicos anteriores.
La leyenda, el estado actual, la vista previa y el historial comparten la
misma notación.

## Uso de la ficha

- La vista permite alternar dentición permanente, temporaria y mixta. El selector
  «Ir a pieza» abre cualquier pieza sin tener que recorrer la arcada en móvil.
- Cada cara conserva su propio hallazgo; por ejemplo, caries oclusal y una
  obturación distal pueden coexistir. El resumen y el historial identifican
  esa diferencia. Los estados que no admiten caras siguen las restricciones de
  la base.
- El historial y el estado actual usan `entry_sequence`, igual que la vista de
  la base. La carga pagina por esa secuencia para no truncar fichas extensas.
- Cambiar de pieza, paciente o pantalla avisa si hay cambios sin guardar.
  Durante el guardado se bloquean los controles que podrían cambiar el
  destinatario del registro. El asiento confirmado por el servidor se incorpora
  al historial sin depender de una segunda consulta.
- Una carga fallida no muestra una ficha vacía editable: permite reintentar.
  Los permisos de ADMIN, el fechado del servidor y el modelo append-only se
  conservan.

## Qué falta

- Imprimir o exportar la ficha de un paciente.
- Registrar varias piezas en una sola acción, para una revisión completa.
- Vincular un asiento con el turno en el que se hizo.
