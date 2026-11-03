import { useState } from "react";

// 주간·월간 거리 막대그래프 (단일 계열). 막대를 누르면 그 기간 값이 위에 표시된다.
// 단일 계열이라 범례는 없고 제목이 이름 역할을 한다. 스크린리더용 표를 함께 둔다.

const HEIGHT = 132;
const TOP = 26;
const BOTTOM = 22;

export default function BarChart({ data, formatValue, caption }) {
  const [selected, setSelected] = useState(data.length - 1);
  const max = Math.max(...data.map((d) => d.value), 1);
  const n = data.length;
  const plot = HEIGHT - TOP - BOTTOM;
  const index = Math.min(selected, n - 1);

  return (
    <figure className="bar-chart">
      <svg viewBox={`0 0 ${n * 40} ${HEIGHT}`} role="img" aria-label={caption}>
        <line x1="0" x2={n * 40} y1={HEIGHT - BOTTOM} y2={HEIGHT - BOTTOM} className="bar-chart__base" />
        {data.map((d, i) => {
          const h = d.value > 0 ? Math.max((d.value / max) * plot, 3) : 0;
          const x = i * 40 + 11;
          const y = HEIGHT - BOTTOM - h;
          const active = i === index;
          return (
            <g key={d.key} onClick={() => setSelected(i)} className="bar-chart__hit">
              {/* 손가락으로 누르기 쉽게 막대보다 넓은 투명 영역 */}
              <rect x={i * 40} y={0} width={40} height={HEIGHT} fill="transparent" />
              {h > 0 && (
                <path
                  d={roundedTop(x, y, 18, h, 4)}
                  className={active ? "bar-chart__bar is-active" : "bar-chart__bar"}
                />
              )}
              <text x={i * 40 + 20} y={HEIGHT - 6} className={active ? "bar-chart__label is-active" : "bar-chart__label"}>
                {d.label}
              </text>
              {active && (
                <text x={clamp(i * 40 + 20, 26, n * 40 - 26)} y={Math.max(y - 8, 14)} className="bar-chart__value">
                  {formatValue(d.value)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      <figcaption className="sr-only">
        <table>
          <caption>{caption}</caption>
          <tbody>
            {data.map((d) => (
              <tr key={d.key}>
                <th>{d.fullLabel || d.label}</th>
                <td>{formatValue(d.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </figcaption>
    </figure>
  );
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// 아래는 기준선에 붙고 위쪽 두 모서리만 둥근 막대
function roundedTop(x, y, w, h, r) {
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}
