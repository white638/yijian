import { useId } from "react";

export type FeatureIconName =
  | "add"
  | "outfit"
  | "calendar"
  | "packing"
  | "stats"
  | "assistant";

export function FeatureIcon({
  name,
  className = "",
}: {
  name: FeatureIconName;
  className?: string;
}) {
  const id = useId();
  const paint = (key: string) => `url(#${id}-${key})`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width="128"
      height="128"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={`feature-icon feature-icon--${name} ${className}`.trim()}
    >
      <defs>
        <linearGradient
          id={`${id}-blue`}
          x1="30"
          y1="22"
          x2="94"
          y2="105"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#B8E2FF" />
          <stop offset=".35" stopColor="#70B8FA" />
          <stop offset="1" stopColor="#3673DD" />
        </linearGradient>
        <linearGradient
          id={`${id}-blue-side`}
          x1="67"
          y1="28"
          x2="103"
          y2="107"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#688FEA" />
          <stop offset="1" stopColor="#3558AC" />
        </linearGradient>
        <linearGradient
          id={`${id}-lavender`}
          x1="32"
          y1="25"
          x2="91"
          y2="102"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#ECE7FF" />
          <stop offset=".42" stopColor="#BDB5F7" />
          <stop offset="1" stopColor="#8E8FE0" />
        </linearGradient>
        <linearGradient
          id={`${id}-purple-side`}
          x1="56"
          y1="32"
          x2="106"
          y2="109"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#A39EEA" />
          <stop offset="1" stopColor="#686BB7" />
        </linearGradient>
        <linearGradient
          id={`${id}-paper`}
          x1="26"
          y1="28"
          x2="90"
          y2="105"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFFFFF" />
          <stop offset=".56" stopColor="#F2F8FF" />
          <stop offset="1" stopColor="#D9E6F9" />
        </linearGradient>
        <linearGradient
          id={`${id}-coral`}
          x1="31"
          y1="33"
          x2="88"
          y2="104"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#FFD0B5" />
          <stop offset=".38" stopColor="#FFA18B" />
          <stop offset="1" stopColor="#E77565" />
        </linearGradient>
        <linearGradient
          id={`${id}-coral-side`}
          x1="79"
          y1="28"
          x2="103"
          y2="104"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#F29C87" />
          <stop offset="1" stopColor="#C85C57" />
        </linearGradient>
        <linearGradient
          id={`${id}-plus`}
          x1="66"
          y1="65"
          x2="106"
          y2="106"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#9ADFFF" />
          <stop offset=".42" stopColor="#57B5FB" />
          <stop offset="1" stopColor="#4382E6" />
        </linearGradient>
        <radialGradient id={`${id}-gold`} cx=".32" cy=".22" r=".81">
          <stop stopColor="#FFF8CE" />
          <stop offset=".35" stopColor="#FFDD76" />
          <stop offset=".78" stopColor="#F2B543" />
          <stop offset="1" stopColor="#D98D29" />
        </radialGradient>
        <radialGradient id={`${id}-pearl`} cx=".3" cy=".2" r=".9">
          <stop stopColor="#FFFFFF" />
          <stop offset=".55" stopColor="#EBF6FF" />
          <stop offset="1" stopColor="#A9C8F1" />
        </radialGradient>
        <linearGradient id={`${id}-shine`} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#FFFFFF" stopOpacity=".82" />
          <stop offset="1" stopColor="#FFFFFF" stopOpacity="0" />
        </linearGradient>
        <filter
          id={`${id}-ground`}
          x="0"
          y="80"
          width="128"
          height="48"
          filterUnits="userSpaceOnUse"
        >
          <feGaussianBlur stdDeviation="4" />
        </filter>
        <filter
          id={`${id}-depth`}
          x="0"
          y="0"
          width="128"
          height="128"
          filterUnits="userSpaceOnUse"
          colorInterpolationFilters="sRGB"
        >
          <feDropShadow
            dx="0"
            dy="4"
            stdDeviation="2.5"
            floodColor="#3F4D82"
            floodOpacity=".15"
          />
        </filter>
      </defs>

      <ellipse
        className="feature-icon__shadow"
        cx="65"
        cy="112"
        rx="37"
        ry="5"
        fill="#7787AA"
        opacity=".2"
        filter={paint("ground")}
      />

      <g className="feature-icon__object" filter={paint("depth")}>
        {name === "add" && (
          <>
            <path
              d="M30 30 79 20Q88 18 91 27L103 87Q105 96 96 98L45 109Q36 111 34 102L21 43Q19 34 30 30Z"
              fill={paint("blue-side")}
            />
            <path
              d="M26 27 76 17Q84 15 86 24L99 85Q101 94 92 96L41 106Q32 108 30 99L17 40Q15 30 26 27Z"
              fill={paint("paper")}
            />
            <path
              d="M29 34 73 25Q77 24 78 29L88 73Q89 77 84 78L41 87Q36 88 35 83L25 39Q24 35 29 34Z"
              fill={paint("blue")}
            />
            <path
              d="m32 69 12-20q2-3 5-1l17 15 9-13q2-3 4 0l9 23q1 4-4 5l-43 9q-5 1-6-4Z"
              fill="#E0EFFF"
            />
            <path
              d="m51 73 10-14 5 4 9-13q2-3 4 0l9 23q1 4-4 5l-32 7Z"
              fill="#B9D5F5"
            />
            <circle cx="65" cy="39" r="6" fill={paint("pearl")} />
            <path
              d="m26 28 49-10q6-1 8 4"
              stroke="white"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".85"
            />
            <g className="feature-icon__accent">
              <path
                d="M83 67h9q6 0 6 6v10h10q6 0 6 6v9q0 6-6 6H98v9q0 6-6 6h-9q-6 0-6-6v-9H67q-6 0-6-6v-9q0-6 6-6h10V73q0-6 6-6Z"
                fill={paint("blue-side")}
              />
              <path
                d="M79 63h9q6 0 6 6v10h10q6 0 6 6v9q0 6-6 6H94v9q0 6-6 6h-9q-6 0-6-6v-9H63q-6 0-6-6v-9q0-6 6-6h10V69q0-6 6-6Z"
                fill={paint("plus")}
              />
              <path
                d="M77 75v-6q0-2 3-2h7M62 84h12"
                stroke="#DFF5FF"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity=".8"
              />
            </g>
          </>
        )}

        {name === "outfit" && (
          <>
            <path
              d="m47 28-22 14q-5 3-2 8l9 17q2 4 7 2l5-3-3 36q0 6 6 7l37 5q7 1 8-6l3-36 6 4q4 2 7-2l11-16q3-5-2-8L94 34 76 31Z"
              fill={paint("purple-side")}
            />
            <path
              d="m43 21-22 14q-5 3-2 8l9 17q2 4 7 2l5-3-3 36q0 6 6 7l37 5q7 1 8-6l3-36 6 4q4 2 7-2l11-16q3-5-2-8L90 27 73 25Z"
              fill={paint("lavender")}
            />
            <path
              d="m43 21 5-2q12 8 25 1l17 7-8 10q-20 7-34-7Z"
              fill="#778BC9"
            />
            <path
              d="m48 19 3 1q11 5 22 0l9 4q-15 15-30 4Z"
              fill={paint("blue-side")}
            />
            <path
              d="M47 22q15 15 34 4"
              stroke="#F2EDFF"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="m24 38 18-11M43 90l1-27"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".45"
            />
            <path
              d="m40 59 3-15M91 65l-1-20"
              stroke="#8783CD"
              strokeWidth="2"
              opacity=".4"
            />
            <path
              d="m42 95 38 5"
              stroke="#DBD9FF"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".7"
            />
            <path d="m62 49 18 3-1 16q-10 6-18-2Z" fill={paint("blue")} />
            <path
              d="m63 51 14 2"
              stroke="#D9EFFF"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <g className="feature-icon__accent">
              <path
                d="m27 76 4 8 9 3-9 4-4 9-3-9-9-4 9-3Z"
                fill={paint("gold")}
              />
              <path
                d="m26 80 1 6 6 1-6 2-1 5-1-5-5-2 5-1Z"
                fill="#FFF4BE"
                opacity=".8"
              />
            </g>
          </>
        )}

        {name === "calendar" && (
          <>
            <path
              d="m32 30 60-9q10-1 10 10v68q0 8-9 10l-57 9q-9 1-9-8V42q0-10 5-12Z"
              fill={paint("blue-side")}
            />
            <path
              d="m28 25 60-9q10-1 10 10v68q0 8-9 10l-57 9q-9 1-9-8V37q0-10 5-12Z"
              fill={paint("paper")}
            />
            <path
              d="m28 25 60-9q10-1 10 10v23L23 60V37q0-10 5-12Z"
              fill={paint("blue")}
            />
            <path
              d="M27 37v-2q0-6 6-7l48-8"
              stroke="#D5EFFF"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity=".8"
            />
            <path
              d="m28 105 59-9q6-1 7-5"
              stroke="#BFCFE5"
              strokeWidth="1.5"
              opacity=".8"
            />
            <path
              d="M43 32V18q0-6 5-6t5 6v12"
              stroke="#365EAA"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              d="M72 28V14q0-6 5-6t5 6v12"
              stroke="#365EAA"
              strokeWidth="7"
              strokeLinecap="round"
            />
            <path
              d="M42 29V18q0-5 4-5M71 25V14q0-5 4-5"
              stroke="#D8E9FF"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <g fill="#A5BAD7" transform="skewY(-8)">
              <rect x="35" y="75" width="10" height="9" rx="2.5" />
              <rect x="53" y="75" width="10" height="9" rx="2.5" />
              <rect x="35" y="93" width="10" height="9" rx="2.5" />
              <rect x="53" y="93" width="10" height="9" rx="2.5" />
              <rect x="73" y="93" width="10" height="9" rx="2.5" />
            </g>
            <g className="feature-icon__accent">
              <path
                d="m74 61 9-1q5-1 5 4v8q0 4-4 5l-9 1q-5 1-5-4v-8q0-4 4-5Z"
                fill={paint("coral-side")}
              />
              <path
                d="m72 58 9-1q5-1 5 4v8q0 4-4 5l-9 1q-5 1-5-4v-8q0-4 4-5Z"
                fill={paint("coral")}
              />
              <path
                d="m73 62 7-1"
                stroke="#FFE5DA"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </g>
          </>
        )}

        {name === "packing" && (
          <g transform="rotate(-9 64 66)">
            <path
              d="M50 35V24q0-9 9-9h11q9 0 9 9v8"
              stroke="#6875A5"
              strokeWidth="8"
              strokeLinecap="round"
            />
            <path
              d="M49 30v-7q0-6 6-6h13"
              stroke="#C9D6F5"
              strokeWidth="3"
              strokeLinecap="round"
            />
            <rect
              x="36"
              y="99"
              width="11"
              height="17"
              rx="5.5"
              fill="#55648E"
            />
            <rect
              x="81"
              y="99"
              width="11"
              height="17"
              rx="5.5"
              fill="#55648E"
            />
            <path
              d="M42 31h44q16 0 16 16v44q0 17-16 17H42q-15 0-15-17V47q0-16 15-16Z"
              fill={paint("coral-side")}
            />
            <rect
              x="22"
              y="30"
              width="69"
              height="74"
              rx="16"
              fill={paint("coral")}
            />
            <path
              d="M28 60V48q0-12 12-12h26"
              stroke="#FFE2CF"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".8"
            />
            <path
              d="M88 49v39q0 11-9 13"
              stroke="#D56E61"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".65"
            />
            <path
              d="M43 52v31M59 52v31M75 52v31"
              stroke="#D7786D"
              strokeWidth="5"
              strokeLinecap="round"
              opacity=".45"
            />
            <path
              d="M41 51v30M57 51v30M73 51v30"
              stroke="#FFD4BF"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".8"
            />
            <g className="feature-icon__accent">
              <path
                d="m82 28 6 20"
                stroke="#6F7FAC"
                strokeWidth="3"
                strokeLinecap="round"
              />
              <rect
                x="77"
                y="45"
                width="23"
                height="30"
                rx="6"
                fill={paint("blue-side")}
                transform="rotate(12 88 60)"
              />
              <rect
                x="74"
                y="42"
                width="23"
                height="30"
                rx="6"
                fill={paint("paper")}
                transform="rotate(12 85 57)"
              />
              <circle cx="87" cy="48" r="2" fill="#8297C0" />
              <path
                d="m80 57 10 2m-11 4 7 1"
                stroke="#99ADD2"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </g>
          </g>
        )}

        {name === "stats" && (
          <>
            <path d="m18 74 20 6v27l-17-5q-3-1-3-4Z" fill={paint("blue")} />
            <path d="m38 80 10-7v26q0 3-3 5l-7 3Z" fill={paint("blue-side")} />
            <path d="m18 74 10-7 20 6-10 7Z" fill="#BCE8FF" />
            <path d="m47 51 22 7v53l-19-6q-3-1-3-4Z" fill={paint("lavender")} />
            <path
              d="m69 58 10-7v50q0 3-3 5l-7 5Z"
              fill={paint("purple-side")}
            />
            <path d="m47 51 10-7 22 7-10 7Z" fill="#E4DEFF" />
            <path d="m78 25 22 7v73l-19-6q-3-1-3-4Z" fill={paint("blue")} />
            <path d="m100 32 10-7v70q0 3-3 5l-7 5Z" fill={paint("blue-side")} />
            <path d="m78 25 10-7 22 7-10 7Z" fill="#B5DEFF" />
            <path
              d="M22 79v17M51 57v40M82 32v44"
              stroke="white"
              strokeWidth="2.5"
              strokeLinecap="round"
              opacity=".45"
            />
            <g className="feature-icon__accent">
              <ellipse
                cx="86"
                cy="111"
                rx="20"
                ry="5"
                fill="#806C66"
                opacity=".17"
              />
              <circle cx="85" cy="97" r="18" fill={paint("gold")} />
              <path
                d="M73 92q3-8 11-8"
                stroke="#FFF6C7"
                strokeWidth="3"
                strokeLinecap="round"
                opacity=".9"
              />
            </g>
          </>
        )}

        {name === "assistant" && (
          <>
            <g className="feature-icon__accent">
              <path
                d="M60 61h30q21 0 21 19v9q0 13-13 18l-1 12-14-10H65q-20 0-20-19v-9q0-20 15-20Z"
                fill={paint("purple-side")}
              />
              <path
                d="M57 56h30q21 0 21 19v9q0 13-13 18l-1 12-14-10H62q-20 0-20-19v-9q0-20 15-20Z"
                fill={paint("lavender")}
              />
              <path
                d="M77 96h5l8 6"
                stroke="#E5DDFF"
                strokeWidth="2.5"
                strokeLinecap="round"
                opacity=".65"
              />
            </g>
            <path
              d="M43 28h37q23 0 23 23v17q0 22-23 22H57l-20 14 1-16q-16-5-16-21V51q0-23 21-23Z"
              fill={paint("blue-side")}
            />
            <path
              d="M38 22h37q23 0 23 23v17q0 22-23 22H52L32 98l1-16q-16-5-16-21V45q0-23 22-23Z"
              fill={paint("blue")}
            />
            <path
              d="M23 48v-3q0-16 17-16h21"
              stroke="#D3EDFF"
              strokeWidth="3"
              strokeLinecap="round"
              opacity=".8"
            />
            <path
              d="M91 60q0 17-16 17H53"
              stroke="#427DD2"
              strokeWidth="2"
              strokeLinecap="round"
              opacity=".35"
            />
            <ellipse
              cx="38"
              cy="57"
              rx="6"
              ry="6.5"
              fill="#407FD0"
              opacity=".6"
            />
            <ellipse
              cx="59"
              cy="57"
              rx="6"
              ry="6.5"
              fill="#407FD0"
              opacity=".6"
            />
            <ellipse
              cx="80"
              cy="57"
              rx="6"
              ry="6.5"
              fill="#407FD0"
              opacity=".6"
            />
            <circle cx="37" cy="54" r="6" fill={paint("pearl")} />
            <circle cx="58" cy="54" r="6" fill={paint("pearl")} />
            <circle cx="79" cy="54" r="6" fill={paint("pearl")} />
          </>
        )}
      </g>
    </svg>
  );
}

export default FeatureIcon;
