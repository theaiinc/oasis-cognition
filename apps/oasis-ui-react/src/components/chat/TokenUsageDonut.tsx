import React from 'react';
import type { ContextBudget } from '../../lib/types';

interface TokenUsageDonutProps {
  budget: ContextBudget;
  size?: number;
}

const COLORS: Record<string, string> = {
  system_prompt: '#6366f1',
  tool_results: '#f59e0b',
  memory_rules: '#10b981',
  user_request: '#3b82f6',
  knowledge_summary: '#8b5cf6',
  free_thoughts: '#ec4899',
  validated_thoughts: '#f97316',
  upfront_plan: '#14b8a6',
  walls: '#ef4444',
  observer_feedback: '#a855f7',
  tool_digest: '#eab308',
  chat_history: '#06b6d4',
  closing: '#6b7280',
  user_message: '#3b82f6',
};

function getColor(key: string): string {
  return COLORS[key] || '#9ca3af';
}

/**
 * Compact donut chart showing context window utilization.
 * Renders inline SVG — no external dependencies.
 */
export const TokenUsageDonut: React.FC<TokenUsageDonutProps> = ({ budget, size = 48 }) => {
  const { input_budget, input_used, breakdown } = budget;
  if (!input_budget || input_budget <= 0) return null;

  const usedPct = Math.min(100, (input_used / input_budget) * 100);
  const remainingPct = 100 - usedPct;

  // Build segments from breakdown
  const segments = Object.entries(breakdown)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  const r = size / 2;
  const strokeWidth = size * 0.18;
  const radius = r - strokeWidth / 2;
  const circumference = 2 * Math.PI * radius;

  // Build arc segments
  let offset = 0;
  const arcs = segments.map(([key, tokens]) => {
    const pct = (tokens / input_budget) * 100;
    const dashLen = (pct / 100) * circumference;
    const dashOffset = circumference - offset;
    offset += dashLen;
    return { key, pct, dashLen, dashOffset, color: getColor(key) };
  });

  // Status color based on usage
  const statusColor = usedPct > 90 ? '#ef4444' : usedPct > 70 ? '#f59e0b' : '#10b981';
  const label = `${Math.round(remainingPct)}%`;

  // Tooltip text
  const tooltipLines = [
    `Context: ${(input_used).toLocaleString()} / ${(input_budget).toLocaleString()} tokens (${Math.round(usedPct)}% used)`,
    '',
    ...segments.map(([key, tokens]) => {
      const pct = ((tokens / input_budget) * 100).toFixed(1);
      return `  ${key}: ${tokens.toLocaleString()} (${pct}%)`;
    }),
  ];
  const tooltipText = tooltipLines.join('\n');

  return (
    <div
      style={{ position: 'relative', width: size, height: size, display: 'inline-block', cursor: 'help' }}
      title={tooltipText}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {/* Background circle (remaining) */}
        <circle
          cx={r}
          cy={r}
          r={radius}
          fill="none"
          stroke="#1e293b"
          strokeWidth={strokeWidth}
        />
        {/* Segments */}
        {arcs.map((arc) => (
          <circle
            key={arc.key}
            cx={r}
            cy={r}
            r={radius}
            fill="none"
            stroke={arc.color}
            strokeWidth={strokeWidth}
            strokeDasharray={`${arc.dashLen} ${circumference - arc.dashLen}`}
            strokeDashoffset={arc.dashOffset}
            strokeLinecap="butt"
            transform={`rotate(-90 ${r} ${r})`}
            style={{ transition: 'stroke-dasharray 0.5s ease, stroke-dashoffset 0.5s ease' }}
          />
        ))}
      </svg>
      {/* Center label */}
      <div
        style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          fontSize: size * 0.22,
          fontWeight: 700,
          color: statusColor,
          lineHeight: 1,
          textAlign: 'center',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </div>
    </div>
  );
};
