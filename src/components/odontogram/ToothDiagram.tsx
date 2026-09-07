import { component$ } from "@qwik.dev/core";
import {
  CONDITION_LABELS,
  surfaceLabel,
  type OdontogramEntry,
  type ToothCondition,
} from "~/lib/odontogram";
import {
  NOTATION_COLORS,
  conditionNotation,
  hasUnlocalizedFinding,
  toothDiagramFaces,
} from "~/lib/odontogram-notation";

/** La misma notación se usa en la guía, los asientos y el borrador. */
export const ConditionSymbol = component$<{ condition: ToothCondition }>(
  ({ condition }) => {
    const notation = conditionNotation(condition);
    const color = NOTATION_COLORS[notation.tone];
    return (
      <svg
        class={`odontogram-condition-symbol symbol-${notation.symbol}`}
        viewBox="0 0 24 24"
        width="24"
        height="24"
        aria-hidden="true"
        fill="none"
      >
        {notation.symbol === "caries" && (
          <path d="M5 5H19V19H5Z" fill={color} />
        )}
        {notation.symbol === "restoration" && (
          <circle cx="12" cy="12" r="8" stroke={color} stroke-width="2.5" />
        )}
        {notation.symbol === "extraction" && (
          <path d="M3 8H21M3 16H21" stroke={color} stroke-width="2.5" />
        )}
        {notation.symbol === "missing" && (
          <path d="M4 4L20 20M20 4L4 20" stroke={color} stroke-width="2.5" />
        )}
      </svg>
    );
  },
);

export const ToothDiagram = component$<{
  tooth: number;
  condition?: ToothCondition;
  surfaces?: OdontogramEntry["surfaces"];
  showSurfaceLabels?: boolean;
  decorative?: boolean;
}>((props) => {
  const faces = toothDiagramFaces(props.tooth, props.surfaces);
  const notation = conditionNotation(props.condition);
  const unlocalized = hasUnlocalizedFinding(props.condition, props.surfaces);
  const generalLabel =
    props.condition === "caries"
      ? "Caries sin caras especificadas"
      : "Obturación sin caras especificadas";
  const description = [
    `Pieza ${props.tooth}: ${props.condition ? CONDITION_LABELS[props.condition] : "Sin registrar"}`,
    ...faces
      .filter((face) => face.condition)
      .map(
        (face) =>
          `${surfaceLabel(props.tooth, face.surface)}: ${CONDITION_LABELS[face.condition!]}`,
      ),
    ...(unlocalized ? [generalLabel] : []),
  ].join(". ");

  return (
    <span
      class={{ "tooth-diagram": true, "has-general-finding": unlocalized }}
      role={props.decorative ? undefined : "img"}
      aria-label={props.decorative ? undefined : description}
      aria-hidden={props.decorative || undefined}
    >
      <svg
        class="tooth-diagram-map"
        viewBox="0 0 100 100"
        width="100"
        height="100"
        aria-hidden="true"
      >
        {faces.map((face) => (
          <g
            key={face.surface}
            data-surface={face.surface}
            data-condition={face.condition ?? "none"}
          >
            <polygon
              points={face.points}
              fill={
                face.condition === "caries"
                  ? NOTATION_COLORS.blue
                  : face.condition && face.condition !== "obturado"
                    ? "#eef0f2"
                    : "#fff"
              }
              stroke={NOTATION_COLORS.neutral}
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            {face.condition === "obturado" && (
              <circle
                class="tooth-mark-restoration"
                cx={face.cx}
                cy={face.cy}
                r={face.surface === "oclusal" ? 13 : 7.5}
                fill="none"
                stroke={NOTATION_COLORS.red}
                stroke-width="3.5"
              />
            )}
            {(props.showSurfaceLabels ||
              (face.condition &&
                !["caries", "obturado"].includes(face.condition))) && (
              <text
                x={face.cx}
                y={face.cy}
                text-anchor="middle"
                dominant-baseline="central"
                fill={
                  face.condition === "caries" ? "#fff" : NOTATION_COLORS.neutral
                }
                font-size={props.showSurfaceLabels ? "8" : "13"}
                font-family="sans-serif"
                font-weight="700"
              >
                {props.showSurfaceLabels
                  ? surfaceLabel(props.tooth, face.surface).slice(0, 1)
                  : CONDITION_LABELS[face.condition!].slice(0, 1)}
              </text>
            )}
          </g>
        ))}
        {notation.symbol === "extraction" && (
          <g class="tooth-mark-extraction" fill="none">
            <path d="M5 40H95M5 60H95" stroke="#fff" stroke-width="8" />
            <path
              d="M5 40H95M5 60H95"
              stroke={NOTATION_COLORS.blue}
              stroke-width="5"
            />
          </g>
        )}
        {notation.symbol === "missing" && (
          <g class="tooth-mark-missing" fill="none">
            <path d="M5 5L95 95M95 5L5 95" stroke="#fff" stroke-width="8" />
            <path
              d="M5 5L95 95M95 5L5 95"
              stroke={NOTATION_COLORS.blue}
              stroke-width="5"
            />
          </g>
        )}
      </svg>
      {unlocalized && props.condition && (
        <span class="tooth-diagram-general" title={generalLabel}>
          <ConditionSymbol condition={props.condition} />
          <span>General</span>
        </span>
      )}
    </span>
  );
});
