import { component$, type QRL } from "@qwik.dev/core";
import type { OrthodonticVisitType } from "~/lib/inbox-types";
import {
  ORTHODONTIC_VISIT_LABELS,
  orthodonticVisitType,
} from "~/lib/orthodontics";
import { Icon } from "../ui/Icon";

export const OrthodonticVisitPicker = component$<{
  value: OrthodonticVisitType | "";
  disabled?: boolean;
  onChange$: QRL<(value: OrthodonticVisitType | "") => void>;
}>((props) => (
  <label class="form-field">
    <span>Turno de ortodoncia</span>
    <div class="select-wrap">
      <select
        required
        value={props.value}
        disabled={props.disabled}
        onChange$={(_, element) =>
          props.onChange$(orthodonticVisitType(element.value) ?? "")
        }
      >
        <option value="" selected={!props.value}>
          Elegí una opción
        </option>
        {(Object.keys(ORTHODONTIC_VISIT_LABELS) as OrthodonticVisitType[]).map(
          (value) => (
            <option key={value} value={value} selected={props.value === value}>
              {ORTHODONTIC_VISIT_LABELS[value]}
            </option>
          ),
        )}
      </select>
      <Icon name="chevron-down" size={17} />
    </div>
    <small>
      {props.value === "in_treatment"
        ? "Este turno no requiere seña porque el paciente ya está en tratamiento de ortodoncia con Gisela."
        : props.value === "first_visit"
          ? "Para la primera visita se aplica la configuración habitual de seña."
          : "Indicá si es la primera visita de ortodoncia o si ya está en tratamiento con Gisela."}
    </small>
  </label>
));
