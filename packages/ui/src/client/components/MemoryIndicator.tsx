/**
 * Memory indicator component
 * Displays memory usage with color-coded badges
 */

import type React from 'react';
import { formatMemory, getMemoryColor, getMemoryLevel } from '../types/agent';

interface MemoryIndicatorProps {
  bytes: number;
  showTooltip?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const SIZE_STYLES = {
  sm: {
    padding: '2px 6px',
    fontSize: '10px',
    borderRadius: '2px',
  },
  md: {
    padding: '3px 8px',
    fontSize: '11px',
    borderRadius: '4px',
  },
  lg: {
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '4px',
  },
};

export const MemoryIndicator: React.FC<MemoryIndicatorProps> = ({
  bytes,
  showTooltip = true,
  size = 'sm',
}) => {
  const level = getMemoryLevel(bytes);
  const color = getMemoryColor(level);
  const label = formatMemory(bytes);
  const styles = SIZE_STYLES[size];

  const indicator = (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        padding: styles.padding,
        fontSize: styles.fontSize,
        fontWeight: 500,
        color,
        backgroundColor: `${color}20`, // 20% opacity
        border: `1px solid ${color}`,
        borderRadius: styles.borderRadius,
        fontFamily: 'monospace',
      }}
    >
      <span
        style={{
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          backgroundColor: color,
        }}
      />
      {label}
    </span>
  );

  if (!showTooltip) {
    return indicator;
  }

  return (
    <div
      style={{
        position: 'relative',
        display: 'inline-block',
      }}
      className="memory-indicator-wrapper"
    >
      {indicator}
      <div
        className="memory-tooltip"
        style={{
          position: 'absolute',
          bottom: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          padding: '6px 10px',
          backgroundColor: 'var(--noetic-tooltip-bg, #1e293b)',
          color: 'var(--noetic-tooltip-fg, #f1f5f9)',
          fontSize: '11px',
          borderRadius: '4px',
          whiteSpace: 'nowrap',
          opacity: 0,
          visibility: 'hidden',
          transition: 'opacity 0.2s, visibility 0.2s',
          zIndex: 100,
          pointerEvents: 'none',
          marginBottom: '4px',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
        }}
      >
        <div
          style={{
            fontWeight: 600,
            marginBottom: '2px',
          }}
        >
          Memory Usage
        </div>
        <div
          style={{
            color: '#94a3b8',
          }}
        >
          {formatMemory(bytes)} total trace size
        </div>
      </div>
      <style>{`
        .memory-indicator-wrapper:hover .memory-tooltip {
          opacity: 1;
          visibility: visible;
        }
      `}</style>
    </div>
  );
};

export default MemoryIndicator;
