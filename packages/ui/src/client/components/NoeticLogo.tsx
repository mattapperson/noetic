/**
 * Noetic Logo Component
 * SVG logo based on the favicon design
 */

import type React from 'react';

interface LogoProps {
  size?: number;
  className?: string;
}

export const NoeticLogo: React.FC<LogoProps> = ({ size = 64, className = '' }) => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      role="img"
      aria-label="Noetic logo"
    >
      <title>Noetic Logo</title>
      <rect width="100" height="100" rx="12" fill="#050505" />
      <text
        x="50"
        y="68"
        fontFamily="monospace"
        fontSize="48"
        fontWeight="700"
        fill="#39ff14"
        textAnchor="middle"
      >
        N
      </text>
    </svg>
  );
};

export default NoeticLogo;
