-- Importar los turnos de la agenda aunque el título no traiga teléfono.
--
-- Gisela escribe la mayoría de sus turnos como "Nombre Apellido TF IOMA", sin
-- celular, así que exigir teléfono para crear la ficha dejaba esos turnos fuera
-- de la agenda de la aplicación. La protección real contra duplicados no es el
-- teléfono sino el nombre: `convert_google_calendar_patient_import` ya rechaza
-- crear una ficha si existe otra con el mismo nombre, y sigue haciéndolo.
--
-- Una ficha así no tiene forma de recibir WhatsApp, y está bien: es la ficha de
-- papel de siempre. Los envíos siguen fallando cerrado —sin identidad no hay
-- destinatario ni consentimiento— así que nadie recibe un mensaje por esto.

-- Una ficha administrativa puede no tener identidad de WhatsApp. Quien sí la
-- necesita es el webhook, que resuelve el contacto por teléfono o BSUID antes
-- de crear una conversación.
alter table public.contacts
  drop constraint contacts_whatsapp_identity_check;

comment on column public.contacts.phone_e164 is
  'Celular en E.164. Puede faltar en una ficha cargada desde la agenda de Google o gestionada por otro contacto.';

do $migration$
declare
  target regprocedure := 'public.convert_google_calendar_patient_import(text,uuid,text,text,public.patient_coverage,uuid,uuid,timestamptz,text,public.orthodontic_visit_type,boolean,boolean,bigint,text,uuid,text,timestamptz)';
  prior_definition text;
  patched_definition text;
  required_marker text := E'    if clean_phone is null then\n      raise exception ''PATIENT_PHONE_REQUIRED'' using errcode = ''P0001'';\n    end if;\n    select * into contact_row from public.contacts where phone_e164 = clean_phone for update;\n    if found and public.google_calendar_patient_name_key(contact_row.name) <> name_key then\n      raise exception ''CONTACT_IDENTITY_CONFLICT'' using errcode = ''23514'';\n    end if;';
  optional_marker text := E'    if clean_phone is not null then\n      select * into contact_row from public.contacts where phone_e164 = clean_phone for update;\n      if found and public.google_calendar_patient_name_key(contact_row.name) <> name_key then\n        raise exception ''CONTACT_IDENTITY_CONFLICT'' using errcode = ''23514'';\n      end if;\n    end if;';
begin
  prior_definition := pg_get_functiondef(target);
  patched_definition := replace(
    prior_definition,
    required_marker,
    optional_marker
  );
  if patched_definition = prior_definition
    or position(required_marker in patched_definition) > 0
    or position(optional_marker in prior_definition) > 0
  then
    raise exception 'CALENDAR_PATIENT_PHONE_DEFINITION_DRIFT: %', target;
  end if;
  execute patched_definition;
end;
$migration$;
