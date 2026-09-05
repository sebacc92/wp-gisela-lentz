import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const manualDrawer = () =>
  source("src/components/appointments/ManualAppointmentDrawer.tsx");
const rescheduleDrawer = () =>
  source("src/components/appointments/RescheduleAppointmentDrawer.tsx");
const convertDrawer = () =>
  source("src/components/appointments/ConvertBlockDrawer.tsx");
const existingAppointmentDrawer = () =>
  source("src/components/appointments/AppointmentDrawer.tsx");
const agendaPage = () => source("src/routes/app/appointments/index.tsx");

test("crear un turno diferencia un fallo de carga de una lista vacía", () => {
  const drawer = manualDrawer();

  assert.match(drawer, /patientLoadError = true/);
  assert.match(drawer, /patientReloadVersion\.value \+= 1/);
  assert.match(drawer, /No pudimos cargar los pacientes/);
  assert.match(drawer, /slotLoadError = true/);
  assert.match(drawer, /slotReloadVersion\.value \+= 1/);
  assert.match(drawer, /El día no está\s+confirmado como disponible/);
});

test("reprogramar conserva el turno y permite reintentar si fallan los horarios", () => {
  const drawer = rescheduleDrawer();

  assert.match(drawer, /state\.loadError = true/);
  assert.match(drawer, /slotReloadVersion\.value \+= 1/);
  assert.match(drawer, /El turno actual sigue sin\s+cambios/);
  assert.match(drawer, /state\.loading \|\|\s+state\.loadError/);
});

test("convertir un bloqueo no confunde pacientes inaccesibles con una lista vacía", () => {
  const drawer = convertDrawer();

  assert.match(drawer, /error: patientsError/);
  assert.match(drawer, /if \(patientsError\) throw patientsError/);
  assert.match(drawer, /state\.loadError = true/);
  assert.match(drawer, /patientReloadVersion\.value \+= 1/);
  assert.match(drawer, /El bloqueo sigue ocupando el\s+horario/);
  assert.match(drawer, /!state\.loadError/);
  assert.match(drawer, /selectedPatient\?\.coverage/);
});

test("las mutaciones de los drawers rechazan doble envío y liberan sus bloqueos", () => {
  assert.match(
    manualDrawer(),
    /if \(saving\.value \|\| savingCoverage\.value\) return/,
  );
  assert.match(
    rescheduleDrawer(),
    /if \(saving\.value \|\| savingCoverage\.value\) return/,
  );
  assert.match(convertDrawer(), /if \(saving\.value \|\| !ready\) return/);

  for (const drawer of [manualDrawer(), rescheduleDrawer(), convertDrawer()]) {
    assert.match(drawer, /saving\.value = true/);
    assert.match(drawer, /finally \{\s+saving\.value = false/);
  }

  for (const drawer of [manualDrawer(), rescheduleDrawer()]) {
    assert.match(
      drawer,
      /if \((?:saving\.value \|\| )?savingCoverage\.value\) return/,
    );
    assert.match(drawer, /finally \{\s+savingCoverage\.value = false/);
  }
});

test("cambiar paciente o cobertura invalida el horario de inmediato", () => {
  const manual = manualDrawer();
  const reschedule = rescheduleDrawer();

  assert.match(
    manual,
    /selectedCoverage\.value = coverage;\s+selectedStartsAt\.value = ""/,
  );
  assert.match(
    manual,
    /patient\.coverage \?\? "";\s+selectedStartsAt\.value = ""/,
  );
  assert.match(
    reschedule,
    /savingCoverage\.value = true;\s+selectedStartsAt\.value = ""/,
  );
  assert.match(
    reschedule,
    /state\.loadError \|\|\s+saving\.value \|\|\s+savingCoverage\.value/,
  );
});

test("una respuesta perdida no invita a repetir una mutación incierta", () => {
  for (const drawer of [manualDrawer(), rescheduleDrawer(), convertDrawer()]) {
    assert.match(drawer, /No pudimos confirmar si/);
    assert.match(drawer, /revisá la agenda antes de volver a intentar/);
  }

  assert.doesNotMatch(convertDrawer(), /No se hicieron cambios; intentá/);
  assert.doesNotMatch(
    manualDrawer(),
    /No pudimos guardar el turno\. Intentá nuevamente/,
  );
});

test("los clicks dentro de los drawers de Agenda no cierran el formulario", () => {
  for (const drawer of [
    manualDrawer(),
    rescheduleDrawer(),
    convertDrawer(),
    existingAppointmentDrawer(),
    agendaPage(),
  ]) {
    assert.match(drawer, /stoppropagation:click/);
  }
});
