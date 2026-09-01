# Onboarding presencial de Gisela Lentz

Este documento es el runbook para la visita presencial. Está escrito para
evitar decisiones improvisadas: una persona no técnica puede completar sus
pasos sin compartir credenciales, y la persona técnica sabe cuándo detenerse.

> Última auditoría: 26 de agosto de 2026. Confirmar nuevamente el estado de
> Meta en pantalla el día de la visita: Meta no puede auditarse desde este
> repositorio ni desde Supabase.

## Regla de seguridad para toda la visita

- Gisela nunca comparte su contraseña de Facebook, códigos de 2FA, códigos de
  recuperación ni claves de WhatsApp.
- No copiar ni pegar tokens, códigos de autorización, claves de aplicación ni
  valores de Vault en chats, documentos, correo, terminal o paneles.
- Si Meta propone **migrar**, **registrar de nuevo** o **desconectar** el número
  de WhatsApp Business en vez de conectarlo con la app existente, detenerse y
  revisar. Para este caso se busca Coexistence: el número debe seguir usando
  WhatsApp Business App.
- Mantener las automatizaciones apagadas y el modo de prueba activo durante la
  conexión y las pruebas iniciales. No habilitar recordatorios ni envíos
  proactivos ese día.

## Foto actual confirmada

### Ya está listo

- Supabase `qcthvykjlwqdrmpkxisc` (`gisela-lentz-wp`) está saludable; todas las
  migraciones hasta `20260826170000_whatsapp_embedded_signup.sql` están
  aplicadas.
- El frontend que sigue productivo hasta el cutover —y se conservará como
  rollback— está disponible en `https://gisela-lentz-wp.vercel.app`; el origen
  canónico previsto es `https://giselalentz.com.ar`.
- Están activas las Functions de WhatsApp: recepción, envío, media,
  automatización, Embedded Signup, procesadores de Coexistence y recovery.
- El recovery de Coexistence y de la outbox de automatización tiene exactamente
  dos tareas periódicas activas, ambas cada minuto, sin trabajo pendiente ni
  leases vencidos.
- Embedded Signup está preparado, protegido por rol ADMIN y por un flag del
  servidor. La app usa credenciales por cuenta después de Coexistence y no
  expone el token de negocio al navegador.
- El webhook procesa mensajes normales, historial, sincronización de la app,
  ecos de mensajes manuales y actualizaciones de cuenta. Los ecos manuales
  pasan la conversación a atención humana sin volver a enviar el mensaje.

### Estado seguro actual antes del número real

- No hay cuenta Coexistence, WABA real, contacto, conversación, mensaje,
  turno, evento ni trabajo de sincronización de Gisela en la base.
- Hay dos intentos anteriores de Embedded Signup cancelados por Meta. Ambos son
  terminales, no contienen código ni token y no bloquean un intento nuevo.
- Los envíos globales están pausados y la integración figura incompleta: es la
  postura segura prevista antes de conectar el número real.
- Las automatizaciones están apagadas y el modo de prueba debe conservarse
  activo durante las pruebas de la visita.

### Cambios locales pendientes de un despliegue autorizado

- Este checklist y el nuevo **Manual** están implementados localmente, pero no
  fueron desplegados por esta tarea. Para que el Manual aparezca en producción
  deben publicarse **juntos** el frontend y las Functions
  `whatsapp-embedded-signup` y `google-calendar-status`, que incorporan sus
  resúmenes sanitizados `manual_status`.
- Hasta ese despliegue controlado, el Manual no debe usarse como evidencia del
  estado remoto. Este archivo versionado sigue siendo la guía presencial.
- **Orden obligatorio del despliegue: primero Supabase, después Vercel.**
  Configuración → Mensajes automáticos guarda `ai_enabled`,
  `ai_media_enabled` y `ai_model`, y el flujo de Embedded Signup depende de la
  cuota configurable y de la validación de BSUID. Promover el frontend a
  producción antes de aplicar las migraciones pendientes rompe esas pantallas
  contra una base sin esas columnas.
- El resumen de Google Calendar del Manual requiere además que exista la
  Function `google-calendar-status`. Hoy esa Function no está desplegada en la
  producción de Gisela; el Manual la marcará como no comprobable hasta que se
  complete la preparación técnica separada de Calendar.

### No se puede confirmar sin mirar Meta

- Que la app de Meta tenga el callback de producción correcto.
- Que estén suscriptos `messages`, `history`, `smb_app_state_sync`,
  `smb_message_echoes` y `account_update`.
- Que la app tenga los permisos/Advanced Access requeridos para WhatsApp.
- Que el Portfolio comercial, la WABA y el número de Gisela estén listos para
  el flujo de Coexistence.

## Bloqueantes que hay que resolver antes de habilitar automatización

1. **Los horarios reales todavía no están aplicados en producción.** La
   migración `20260829120000_gisela_lentz_operational_configuration.sql` carga
   el horario semanal de Gisela, los feriados nacionales y sus motivos de
   atención, pero sigue pendiente de `supabase db push`. Hasta ese push la base
   productiva tiene cero franjas y cualquier mensaje automatizado se trataría
   como fuera de horario. Revisar el horario en pantalla después de aplicarla y
   antes de activar respuestas automáticas.
2. **Google Calendar no está preparado.** Las Functions, secrets y cron de
   Calendar no están desplegados/configurados. No intentar conectar Google
   durante el onboarding de WhatsApp; es una tarea técnica separada.
3. **Las plantillas locales no están verificadas en Meta.** No habilitar
   recordatorios ni mensajes proactivos hasta que las plantillas requeridas
   estén aprobadas como `UTILITY`, el número tenga calidad adecuada y exista
   consentimiento documentado.
4. **No hay recuperación de contraseña desde la interfaz.** Hasta implementar
   ese flujo, una administradora o Sebastián debe resolver un acceso perdido.

## A. Lo que hace Gisela

### Antes de abrir la plataforma

1. Tener el teléfono principal, cargado, con **WhatsApp Business App**
   funcionando y acceso al número que se quiere conservar.
2. Tener una cuenta personal de Facebook de la que sea dueña. Si no existe,
   crearla ella misma; no usar una cuenta compartida.
3. Activar autenticación de dos factores en Facebook. Guardar los códigos de
   recuperación en un lugar privado de Gisela, nunca en este proyecto.
4. Confirmar si ya tiene un Portfolio comercial en Meta. Si no lo tiene, crear
   uno con sus datos reales y del que ella sea la propietaria.
5. Preparar los datos que quiera cargar o confirmar:
   - teléfono público del consultorio;
   - email público del consultorio;
   - logo;
   - dirección y referencia para pacientes;
   - días, franjas horarias y feriados/bloqueos;
   - duración para IOMA y Particular;
   - monto, alias y titular de la seña;
   - textos de horarios, urgencias y atención fuera de horario;
   - quiénes deben conservar acceso a la plataforma.

### Durante la conexión de WhatsApp

1. Ingresar al panel con la cuenta administrativa de Gisela. Verificar que sea
   la cuenta ADMIN correcta; no usar una cuenta de operador para iniciar la
   conexión.
2. Ir a **Configuración → Estado de WhatsApp**.
3. Leer el aviso de seguridad y elegir **Conectar WhatsApp Business con
   Coexistence**.
4. Decidir expresamente si quiere pedir el historial disponible de la app:
   - marcar la opción sólo si acepta importarlo;
   - dejarla desmarcada si no quiere importarlo ahora.
5. En la ventana oficial de Facebook, iniciar sesión ella misma, aprobar sólo
   los permisos mostrados para su Portfolio y seleccionar sus activos reales.
6. Seleccionar el número que ya usa en WhatsApp Business App únicamente si la
   pantalla confirma que seguirá usando la app junto con la plataforma.
7. Si Meta pide confirmar desde WhatsApp Business App o escanear un QR, Gisela
   hace esa confirmación en su teléfono. No reemplazarla por un registro Cloud
   API convencional, ni elegir una opción que migre o desconecte el número.
8. No copiar ningún código mostrado por Facebook y no compartir pantalla con
   terceros que no sean necesarios para la asistencia presencial.

**✅ No continuar hasta que** el panel vuelva a mostrar que la conexión fue
recibida y se está validando. Cerrar el popup no prueba que la conexión haya
terminado.

### Después de la conexión

1. Esperar a que el panel de WhatsApp muestre los estados de conexión y
   sincronización. No abrir un segundo intento mientras haya una conexión en
   curso.
2. Revisar que los mensajes y/o contactos aparezcan sólo si se aceptó la
   sincronización correspondiente.
3. Hacer una prueba con el número de prueba autorizado por Sebastián, nunca con
   un paciente real sin avisarle.
4. Confirmar visualmente que el mensaje aparece en **Mensajes** y que no se
   envió una respuesta automática inesperada.

## B. Lo que hace Sebastián

### Preflight técnico antes de la visita

1. Confirmar que la producción correcta sigue siendo
   `qcthvykjlwqdrmpkxisc` / `gisela-lentz-wp` y que no hay migraciones
   pendientes.
2. Verificar que las Functions de WhatsApp estén `ACTIVE`, el frontend
   productivo esté listo y los dos recovery jobs respondan correctamente.
3. Verificar por nombre, nunca por valor, que existen los secretos requeridos
   para Meta, Coexistence, recovery y modo seguro. No rotar ninguno sin un
   motivo comprobado.
4. Confirmar que `WHATSAPP_EMBEDDED_SIGNUP_ENABLED` está explícitamente en
   `true`. Este flag no es un token, pero el servidor rechaza el inicio si está
   apagado. Si no se puede comprobar, no abrir el popup ni cambiar el flag de
   improviso.
5. Confirmar en el panel de Meta:
   - callback HTTPS:
     `https://qcthvykjlwqdrmpkxisc.supabase.co/functions/v1/whatsapp-webhook`;
   - verify token configurado sin exponerlo;
   - campos de webhook `messages`, `history`, `smb_app_state_sync`,
     `smb_message_echoes` y `account_update`;
   - permisos/Advanced Access requeridos por la app de Meta;
   - configuración de Embedded Signup v4 asociada a la misma Meta App.

**✅ No continuar hasta que** el callback, los cinco campos, los permisos y la
configuración v4 coincidan con esta lista. El resultado esperado es que Meta
muestre la suscripción activa y que el panel conserve el botón de Coexistence.

6. No modificar una suscripción de Meta a ciegas. Primero comparar lo que se
   ve en pantalla con la lista anterior y registrar la diferencia sin copiar
   identificadores sensibles.
7. Confirmar que Gisela es la única ADMIN que debe iniciar la conexión y
   revisar los dos accesos de operador existentes.
8. Mantener:
   - automatizaciones apagadas;
   - modo de prueba activo;
   - envíos globales pausados hasta terminar la revisión posterior;
   - recordatorios apagados.

### Configuración en el panel junto a Gisela

1. Ir a **Configuración → Datos del consultorio** y completar/revisar teléfono,
   email, logo, dirección y textos generales sólo con datos confirmados.
2. Ir a **Configuración → Días y horarios** y cargar las franjas reales. Crear
   los bloqueos de días no laborables conocidos.
3. Ir a **Configuración → Turnos y servicios**. Validar servicios activos y
   sus motivos; confirmar duraciones IOMA/Particular.
4. Ir a **Configuración → WhatsApp y reservas**. Revisar monto, alias, titular,
   plazo de seña, buffer y antelación. No guardar un alias o importe que Gisela
   no haya confirmado.
5. Ir a **Configuración → Mensajes automáticos**. Revisar texto de urgencias y
   fuera de horario. Mantener desactivadas las automatizaciones y la lectura de
   medios con IA al terminar.
6. Usar **Estado de WhatsApp** sólo para el onboarding y la comprobación segura;
   no tocar el botón de verificación de conexión como sustituto de la revisión
   de Embedded Signup.

### Flujo técnico de Embedded Signup

1. Confirmar que no hay otro intento activo ni una cuenta parcial en el panel.
2. Pedirle a Gisela que haga clic y complete el popup oficial. No iniciar sesión
   como ella ni pedirle sus credenciales.
3. Esperar el resultado en el panel. El sistema recopila los activos desde el
   flujo oficial; no pedir ni copiar manualmente WABA ID, Phone Number ID ni
   token.
4. Revisar el estado de la cuenta y de la sincronización. Si se informa una
   desconexión o atención requerida, detenerse y no intentar una segunda
   conexión sobre el mismo número.
5. Confirmar con una prueba controlada:
   - inbound desde un número de prueba autorizado;
   - visualización en la bandeja;
   - mensaje enviado manualmente desde WhatsApp Business App y reflejado sin
     un nuevo envío automático;
   - si se aceptó historial, avance de importación sin automatizaciones;
   - procesadores de recovery sin backlog/error.
6. No habilitar automatizaciones, recordatorios ni modo producción en esta
   misma sesión salvo autorización expresa posterior.

**✅ No continuar hasta que** el panel muestre una cuenta conectada, sin
atención requerida y sin un intento paralelo. El resultado esperado de la
prueba controlada es recepción visible en la bandeja y un eco manual reflejado
una sola vez, sin respuesta automática ni envío saliente desde el panel.

## C. Lo que hace automáticamente la plataforma

Durante Embedded Signup la plataforma:

1. Comprueba que la usuaria sea ADMIN y que el flag del servidor permita
   iniciar el flujo.
2. Crea un único intento breve con estado y nonce aleatorios. Si el popup se
   cancela, vence o se duplica, no reutiliza la sesión.
3. Recibe el resultado de Facebook sólo desde el origen esperado y valida el
   orden de los callbacks.
4. Intercambia y valida el token del negocio en el servidor. El token se guarda
   en Vault y nunca se entrega al navegador.
5. Comprueba que los activos devueltos pertenecen a la conexión iniciada.
6. Guarda la cuenta, suscribe la app cuando corresponde y encola las tareas de
   sincronización con leases, idempotencia, backoff y recovery.
7. Recibe mensajes normales, historial, estado de la app y ecos manuales. Un
   eco de la app pausa la automatización de esa conversación antes de que pueda
   generarse otra respuesta.
8. Conserva contactos, conversaciones e historial si un token necesita
   reconexión; no borra datos por una falla de token.

## Matriz de configuración funcional

Los valores sensibles no se imprimen aquí. “Configurado” significa que existe
un valor o estructura; no reemplaza la validación presencial de Gisela.

| Configuración                               | Valor actual confirmado                                                        | Requerido                         | Quién lo define                  | Dónde se configura                             | Pendiente                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------- | -------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------- |
| Proyecto / base                             | Producción saludable y migraciones al día                                      | Sí                                | Sebastián                        | Supabase                                       | No                                                                           |
| Frontend                                    | Producción lista                                                               | Sí                                | Sebastián                        | Vercel                                         | No                                                                           |
| Cuenta personal de Facebook                 | No auditable desde el repositorio                                              | Sí para el flujo                  | Gisela                           | Facebook                                       | **PREGUNTAR A GISELA**; debe ser una cuenta propia, no compartida            |
| 2FA de Facebook                             | No auditable desde el repositorio                                              | Sí                                | Gisela                           | Seguridad de Facebook                          | **PREGUNTAR A GISELA**; no compartir códigos                                 |
| Portfolio comercial de Meta                 | No auditable desde el repositorio                                              | Sí                                | Gisela, acompañada por Sebastián | Meta Business Suite                            | **PREGUNTAR A GISELA**; confirmar propiedad y datos reales                   |
| App de Meta / configuración Embedded Signup | IDs públicos configurados en producción; estado de Meta no auditable desde acá | Sí                                | Sebastián                        | Meta for Developers                            | Confirmar configuración v4 y permisos en pantalla                            |
| Flag de Embedded Signup                     | Activo en la última auditoría; el servidor falla cerrado si está apagado       | Sí                                | Sebastián                        | Secret/configuración del servidor              | Reconfirmar `WHATSAPP_EMBEDDED_SIGNUP_ENABLED=true` antes del popup          |
| Permisos de Meta                            | No auditable desde el repositorio                                              | Sí                                | Sebastián + Gisela               | Meta for Developers                            | Confirmar Advanced Access de WhatsApp antes de conectar                      |
| Callback y campos de webhook                | Código y endpoint listos; suscripción de Meta no auditable desde acá           | Sí                                | Sebastián                        | Meta for Developers                            | Confirmar callback y los cinco campos antes de iniciar                       |
| WABA y Phone Number ID                      | No existe uno real asociado todavía                                            | Sí después del flujo              | Plataforma + Gisela              | Embedded Signup                                | No copiar manualmente; validar en el panel al terminar                       |
| Suscripción de la app a la WABA             | No hay cuenta para suscribir                                                   | Sí                                | Plataforma                       | Después de Embedded Signup                     | Automática; comprobar estado `Suscripta` en el panel                         |
| Sincronización de contactos                 | No hay cuenta para solicitarla                                                 | Sí                                | Plataforma                       | Después de Embedded Signup                     | Automática; comprobar avance sin repetir el intento                          |
| Historial de WhatsApp Business              | No solicitado todavía                                                          | Opcional                          | Gisela                           | Popup de conexión                              | **PREGUNTAR A GISELA**; la decisión queda registrada                         |
| Token de negocio                            | No existe token de una cuenta real                                             | Sí después del flujo              | Plataforma                       | Vault del servidor                             | Automático; nunca copiar, descargar ni mostrar                               |
| Recovery de Coexistence                     | Dos tareas periódicas activas y sin backlog                                    | Sí                                | Plataforma                       | Supabase                                       | No; revisar sólo el resumen sanitizado                                       |
| Cuenta ADMIN                                | 1 ADMIN activo; 2 OPERADOR activos                                             | Sí                                | Gisela + Sebastián               | Configuración → Personas con acceso / Supabase | **PREGUNTAR A GISELA** quién debe conservar ADMIN                            |
| Datos del consultorio                       | Nombre, subtítulo y dirección cargados; teléfono, email y logo vacíos          | Sí                                | Gisela                           | Configuración → Datos del consultorio          | **PREGUNTAR A GISELA**                                                       |
| Zona horaria                                | America/Argentina/Buenos_Aires                                                 | Sí                                | Gisela                           | Configuración → Datos del consultorio          | **PREGUNTAR A GISELA** si corresponde confirmarla                            |
| Profesional                                 | 1 profesional activo                                                           | Sí                                | Gisela                           | Configuración → Turnos y servicios             | **PREGUNTAR A GISELA** nombre/especialidad                                   |
| Servicios                                   | 7 activos                                                                      | Sí                                | Gisela                           | Configuración → Turnos y servicios             | **PREGUNTAR A GISELA** lista y orden                                         |
| Horarios                                    | 0 franjas activas                                                              | **Sí, bloqueante**                | Gisela                           | Configuración → Días y horarios                | **CARGAR ANTES DE AUTOMATIZAR**                                              |
| Bloqueos / feriados                         | 0 futuros                                                                      | Según agenda                      | Gisela                           | Configuración → Días y horarios                | **PREGUNTAR A GISELA**                                                       |
| IOMA                                        | Duración 30 min                                                                | Sí                                | Gisela                           | Configuración → WhatsApp y reservas            | **PREGUNTAR A GISELA**; es sólo clasificación local, no integración con IOMA |
| Particular                                  | Duración 60 min                                                                | Sí                                | Gisela                           | Configuración → WhatsApp y reservas            | **PREGUNTAR A GISELA**                                                       |
| Antelación mínima                           | 60 min                                                                         | Sí                                | Gisela                           | Configuración → WhatsApp y reservas            | **PREGUNTAR A GISELA**                                                       |
| Buffer entre turnos                         | 0 min                                                                          | Según criterio                    | Gisela                           | Configuración → WhatsApp y reservas            | **PREGUNTAR A GISELA**                                                       |
| Seña                                        | Activa; monto, alias, titular, plazo y textos cargados                         | Sí si se usa seña                 | Gisela                           | Configuración → WhatsApp y reservas            | **PREGUNTAR A GISELA** cada dato real                                        |
| Comprobantes                                | Código local: IA transcribe; regla fija; sin validación bancaria               | Sí                                | Gisela                           | Bandeja / Agenda                               | Desplegar y probar: válido, inválido y tardío                                |
| Fuera de horario                            | Activo y con texto                                                             | Sí                                | Gisela                           | Configuración → Mensajes automáticos           | **PREGUNTAR A GISELA**; requiere horarios activos                            |
| Urgencias                                   | Texto configurado                                                              | Sí                                | Gisela                           | Configuración → Mensajes automáticos           | **PREGUNTAR A GISELA**                                                       |
| Información general                         | Vacía                                                                          | Opcional                          | Gisela                           | Configuración → Mensajes automáticos           | **PREGUNTAR A GISELA**                                                       |
| Automatizaciones                            | Apagadas                                                                       | Apagadas en onboarding            | Sebastián                        | Secret del servidor                            | Mantener apagadas                                                            |
| Modo prueba                                 | Activo                                                                         | Activo en pruebas                 | Sebastián                        | Secret del servidor                            | Mantener hasta autorización posterior                                        |
| Números de prueba                           | No se documentan ni muestran                                                   | Sí para probar envíos             | Sebastián                        | Secret del servidor                            | Confirmar allowlist segura                                                   |
| WhatsApp / Coexistence                      | Código y Functions listos; no hay cuenta real conectada                        | Sí                                | Gisela + Sebastián               | Configuración → Estado de WhatsApp / Meta      | Completar presencialmente                                                    |
| Pausa de envíos                             | Activa por seguridad                                                           | Sí durante onboarding             | Sebastián                        | Estado de WhatsApp / configuración de servidor | No levantar durante la visita sin autorización posterior                     |
| Plantillas Meta                             | 5 plantillas v3 con voz institucional, deshabilitadas y sin verificar          | Antes de proactivos               | Sebastián + Gisela               | Meta + Plantillas                              | Aprobar en Meta antes de habilitarlas                                        |
| Consentimiento                              | No hay consentimientos                                                         | Antes de recordatorios/proactivos | Gisela + Sebastián               | Procedimiento operativo                        | Definir evidencia y texto                                                    |
| Recordatorio 24h / 2h                       | Ambos apagados; sin cron de recordatorios                                      | Opcional posterior                | Gisela + Sebastián               | Configuración + cron técnico                   | No habilitar todavía                                                         |
| Atención personal de Gisela                 | Disponible por conversación; los ecos manuales pausan el bot                   | Sí                                | Gisela                           | Bandeja → conversación                         | Capacitar y probar `Pausar bot` / `Reactivar bot`                            |
| Mensajes y recepción                        | Functions preparadas; sin número real ni tráfico                               | Sí                                | Plataforma + Gisela              | Bandeja / webhook                              | Probar sólo en modo seguro después de conectar                               |
| Archivos y comprobantes                     | Código local: imagen/PDF en `waiting_deposit` puede autoconfirmar              | Sí si se reciben comprobantes     | Gisela                           | Bandeja / Agenda                               | Fallos a revisión; sin verificación bancaria                                 |
| Google Calendar                             | No configurado, sin Functions ni cron remoto                                   | Opcional posterior                | Sebastián + Gisela               | Google Cloud + Supabase + Configuración        | **BLOQUEADO HASTA PREPARACIÓN TÉCNICA**                                      |
| Recuperación de contraseña                  | No existe en la interfaz                                                       | Recomendado                       | Sebastián                        | Supabase Auth + frontend                       | Implementar antes de delegar completamente                                   |

## Orden presencial exacto

1. Llegar, revisar que Gisela tenga teléfono, WhatsApp Business, Facebook y 2FA
   disponibles.
2. Confirmar antes de empezar que el despliegue autorizado del Manual y de
   ambas proyecciones `manual_status` ya estén en producción. Si todavía no lo
   está, detener el uso del Manual en la UI y seguir este archivo versionado
   hasta realizar ese despliegue controlado.
3. Confirmar que la plataforma dice que WhatsApp todavía no está conectado y
   que la atención automática sigue detenida.
4. Revisar y guardar datos del consultorio, servicios, duraciones, seña y,
   sobre todo, horarios reales.
5. Revisar en Meta el callback, los campos de webhook, permisos y configuración
   v4; detenerse ante cualquier diferencia no explicada.
6. Volver a **Configuración → Estado de WhatsApp** y elegir conectar con
   Coexistence.
7. Gisela completa el popup oficial y decide explícitamente sobre historial.
8. Esperar validación y sincronización; no repetir ni abrir otro popup.
9. Verificar en el panel que la cuenta esté conectada o que se muestre un aviso
   claro de atención. Si hay atención requerida, detenerse.
10. En modo prueba, hacer los checks de recepción, eco manual, historial (si
    fue aceptado) y recovery sin usar pacientes reales.
11. Confirmar que no hubo respuestas automáticas, recordatorios ni envíos
    inesperados.
12. Dejar automatizaciones apagadas, modo prueba activo y envíos bajo la pausa
    de seguridad hasta una autorización posterior.

**✅ No continuar a la fase de envíos hasta que** la prueba de recepción, eco
manual, sincronización aceptada y recovery estén correctos. El resultado de
esta visita, con la pausa conservada, es **Coexistence conectado e inbound
validado**; todavía no es una validación de envíos de producción.

> Con la pausa de envíos activa se valida recepción, sincronización y el eco
> manual de la app, pero no se habilita el envío desde el panel. Levantar esa
> pausa es una etapa posterior, explícitamente autorizada, después de revisar
> las pruebas y las reglas de operación.

Sólo después de una autorización separada para levantar la pausa de envíos, un
test saliente controlado desde el panel y la comprobación de que no hay efectos
inesperados, se puede afirmar:

> ✅ WhatsApp real de Gisela conectado y sistema operativo.

## Preguntas para Gisela

1. ¿Querés importar el historial disponible de WhatsApp Business ahora, más
   adelante o nunca?
2. ¿Cuáles son los días, franjas y excepciones reales de atención?
3. ¿Seguimos usando IOMA 30 minutos y Particular 60 minutos?
4. ¿Cuál es el importe real de la seña, alias, titular y plazo para pagarla?
5. ¿Qué teléfono, email, dirección y logo deben ser públicos?
6. ¿Qué servicios deben quedar activos y cómo los explicarías a un paciente?
7. ¿Qué mensaje querés para fuera de horario y qué casos deben considerarse
   urgentes?
8. ¿Quiénes necesitan acceso? ¿Quién debe conservar rol ADMIN?
9. ¿Querés Google Calendar? Si sí, ¿qué cuenta de Google es la propietaria?
10. ¿Cuándo querés revisar y, eventualmente, activar automatizaciones,
    plantillas aprobadas y recordatorios?
11. Después de una prueba controlada, ¿quién autoriza que se levante la pausa
    de envíos para operar en vivo? Sin esa decisión, el número puede quedar
    conectado pero no enviará mensajes desde la plataforma.

## Referencia técnica para Sebastián

- Manual de uso dentro de la app: `/app/manual` (requiere ADMIN; pendiente de
  desplegar junto con esta documentación local).
- Manual de Coexistence: [whatsapp-coexistence.md](whatsapp-coexistence.md).
- Embedded Signup y ciclo de token: [whatsapp-embedded-signup.md](whatsapp-embedded-signup.md).
- Recovery: [whatsapp-recovery.md](whatsapp-recovery.md).
- Google Calendar: [google-calendar-setup.md](google-calendar-setup.md).
- Señas, cobertura y turnos: [reservas-y-senas.md](reservas-y-senas.md).

### Alcance y arquitectura

- El navegador sólo recibe IDs públicos de Embedded Signup y resúmenes
  sanitizados de estado. No recibe el token de negocio ni un App Access Token.
- `whatsapp-embedded-signup` acepta el inicio sólo para ADMIN y con el flag del
  servidor habilitado. Después del flujo, la cuenta, WABA y número se validan
  en el servidor; la credencial de negocio se guarda en Vault.
- `process-whatsapp-coexistence` se encarga de suscribir la app y de solicitar
  datos de la app: confirma la suscripción por `/{WABA_ID}/subscribed_apps` y
  solicita la sincronización por `/{PHONE_NUMBER_ID}/smb_app_data`, siempre
  server-side y con el token de negocio de esa cuenta. El navegador nunca llama
  esos endpoints. `process-whatsapp-automation-outbox` recupera entregas de
  automatización. Ambos usan leases, idempotencia y backoff.
- `whatsapp-webhook` recibe los eventos de Meta; `whatsapp-media` descarga
  archivos con la credencial de la cuenta correcta; `whatsapp-send` y los
  procesadores resuelven credenciales por cuenta y fallan cerrados. Durante
  `waiting_deposit`, la IA sólo transcribe los datos visibles de una imagen o
  PDF; una regla fija exige legibilidad, monto exacto y alias o titular antes de
  confirmar. Moneda, fecha e identificador de operación son auxiliares y no
  bloquean la confirmación. Los fallos y comprobantes tardíos pasan a revisión
  manual.
- La agenda de la plataforma es la fuente de verdad. Google Calendar, cuando
  se prepare, será una copia privada secundaria y no una fuente de turnos.

### Secretos y configuración técnica: nombres solamente

Los valores nunca se leen, copian ni muestran. Los nombres que pueden requerir
revisión controlada son:

- `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN`;
- `WHATSAPP_COEXISTENCE_INTERNAL_SECRET`,
  `WHATSAPP_COEXISTENCE_RECOVERY_SECRET`,
  `WHATSAPP_AUTOMATION_OUTBOX_RECOVERY_SECRET`, `AUTOMATION_INTERNAL_SECRET`;
- `REMINDER_CRON_SECRET`, `GOOGLE_CALENDAR_CLIENT_SECRET`,
  `GOOGLE_CALENDAR_CRON_SECRET`;
- valores de seguridad operativa como `WHATSAPP_EMBEDDED_SIGNUP_ENABLED`,
  `WHATSAPP_AUTOMATIONS_ENABLED`, `OPENAI_ADMINISTRATIVE_ENABLED`,
  `WHATSAPP_TEST_MODE` y la allowlist de prueba.

La autoconfirmación de comprobantes requiere `ai_enabled=true`,
`ai_media_enabled=true`, `OPENAI_ADMINISTRATIVE_ENABLED=true` y la
automatización global activa. Guarda hash, lectura, política y auditoría con
idempotencia. No prueba autenticidad: se acepta el riesgo de falsificación y
Gisela puede cancelar manualmente el turno después de revisarlo.

Los IDs públicos y las variables legacy se mantienen documentados en
[`.env.example`](../.env.example). La existencia de una cuenta Coexistence
impide usar el token legacy para esa cuenta.

### Diagnóstico seguro

1. Confirmar primero el resumen de estado del panel y los jobs de recovery; no
   hacer un envío de prueba como diagnóstico por defecto.
2. Si WhatsApp marca atención requerida, mantener `sending_paused`, conservar
   datos importados y revisar el evento de desconexión/validez de token con
   logs sanitizados.
3. Si no llega un evento, verificar en Meta el callback, verify token, campos
   suscriptos, permisos y la suscripción de la app a la WABA. No volver a
   conectar el número para “probar”.
4. Si Calendar falla, confirmar primero el turno en la agenda; no crear ni
   borrar eventos manuales hasta revisar el estado de sincronización.
5. Si una tarea queda pendiente, usar el procesador de recovery existente y
   revisar lease/backoff; nunca manipular filas o secretos a mano en
   producción.

### Rotación y recuperación

- No rotar secretos ni la credencial de negocio durante un onboarding activo o
  un incidente sin un plan aprobado.
- Ante una credencial de negocio inválida, la plataforma debe pausar envíos y
  pedir reconexión; no debe borrar contactos, conversaciones ni historial.
- Toda rotación requiere autorización, reemplazo server-side, validación
  controlada, observación de recovery y registro de la operación sin valores
  sensibles. Si algo falla, se detiene antes de ampliar el cambio.

No existe hoy un rol exclusivo de desarrollo: la información técnica queda en
este runbook versionado, no en el Manual visible a las administradoras. Los
secretos se documentan sólo por nombre; sus valores nunca se agregan a
Markdown, la interfaz, commits, logs ni tickets.
