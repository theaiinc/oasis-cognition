import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ZoomIn, ZoomOut, Maximize, RefreshCw } from 'lucide-react';

export interface NodeDragApi {
  /** Current x,y offset for this node id (added to its base layout position). */
  offsetOf(id: string): { dx: number; dy: number };
  /** Returns a mousedown handler; attach to a node's interactive element. */
  startDrag(id: string): (e: React.MouseEvent) => void;
  /** True while a node is being dragged. */
  isDragging: boolean;
}

interface Props {
  /** Natural width of the SVG content layout. */
  contentWidth: number;
  /** Natural height of the SVG content layout. */
  contentHeight: number;
  /** CSS height of the viewport container (the visible window). */
  height?: number;
  className?: string;
  /** Render-prop receives the drag api so node groups can attach handlers. */
  children: (api: NodeDragApi) => ReactNode;
}

type DragState =
  | { kind: 'pan'; startX: number; startY: number; origPan: { x: number; y: number } }
  | { kind: 'node'; id: string; startX: number; startY: number; origOffset: { dx: number; dy: number } }
  | null;

const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;

export function InteractiveSvgViewport({ contentWidth, contentHeight, height = 320, className, children }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [nodeOffsets, setNodeOffsets] = useState<Record<string, { dx: number; dy: number }>>({});
  const [dragKind, setDragKind] = useState<'pan' | 'node' | null>(null);
  const dragRef = useRef<DragState>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  zoomRef.current = zoom;
  panRef.current = pan;

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el || contentWidth === 0 || contentHeight === 0) return;
    const vw = el.clientWidth;
    const vh = el.clientHeight;
    const margin = 16;
    const sx = (vw - margin * 2) / contentWidth;
    const sy = (vh - margin * 2) / contentHeight;
    const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(sx, sy, 1)));
    setZoom(z);
    setPan({
      x: (vw - contentWidth * z) / 2,
      y: (vh - contentHeight * z) / 2,
    });
  }, [contentWidth, contentHeight]);

  // Fit on mount and when content size changes meaningfully.
  useLayoutEffect(() => {
    fit();
  }, [fit]);

  // Wheel zoom: attach as non-passive so we can preventDefault and avoid scroll-jacking the parent ScrollArea.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const z = zoomRef.current;
      const p = panRef.current;
      const factor = Math.exp(-e.deltaY * 0.0015);
      const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
      // Keep the world point under the cursor stationary.
      const newPan = {
        x: px - ((px - p.x) * nz) / z,
        y: py - ((py - p.y) * nz) / z,
      };
      setZoom(nz);
      setPan(newPan);
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, []);

  // Global mousemove/mouseup so a drag continues even when the cursor leaves the SVG.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'pan') {
        setPan({ x: d.origPan.x + (e.clientX - d.startX), y: d.origPan.y + (e.clientY - d.startY) });
      } else {
        const z = zoomRef.current;
        const dx = (e.clientX - d.startX) / z;
        const dy = (e.clientY - d.startY) / z;
        setNodeOffsets((o) => ({ ...o, [d.id]: { dx: d.origOffset.dx + dx, dy: d.origOffset.dy + dy } }));
      }
    };
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setDragKind(null);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onPanStart = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, origPan: panRef.current };
    setDragKind('pan');
  }, []);

  const offsetOf = useCallback(
    (id: string) => nodeOffsets[id] ?? { dx: 0, dy: 0 },
    [nodeOffsets],
  );
  const startDrag = useCallback(
    (id: string) => (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      const orig = nodeOffsets[id] ?? { dx: 0, dy: 0 };
      dragRef.current = { kind: 'node', id, startX: e.clientX, startY: e.clientY, origOffset: orig };
      setDragKind('node');
    },
    [nodeOffsets],
  );

  const api: NodeDragApi = {
    offsetOf,
    startDrag,
    isDragging: dragKind === 'node',
  };

  return (
    <div
      ref={containerRef}
      className={`relative rounded-lg border border-slate-800 bg-slate-950 overflow-hidden ${className ?? ''}`}
      style={{ height }}
    >
      <div className="absolute top-1.5 right-1.5 z-10 flex flex-col gap-1 bg-slate-900/80 backdrop-blur rounded-md p-1 border border-slate-700/60">
        <button
          type="button"
          title="Zoom in"
          onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * 1.2))}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <ZoomIn className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Zoom out"
          onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / 1.2))}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <ZoomOut className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Fit to view"
          onClick={fit}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <Maximize className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          title="Reset (clear node moves & view)"
          onClick={() => {
            setNodeOffsets({});
            fit();
          }}
          className="p-1 rounded text-slate-400 hover:text-white hover:bg-slate-800"
        >
          <RefreshCw className="w-3.5 h-3.5" />
        </button>
      </div>
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        onMouseDown={onPanStart}
        style={{ cursor: dragKind === 'pan' ? 'grabbing' : 'grab', display: 'block', touchAction: 'none' }}
      >
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>{children(api)}</g>
      </svg>
      <div className="absolute bottom-1 left-2 text-[9px] text-slate-600 select-none pointer-events-none">
        {Math.round(zoom * 100)}% · drag to pan · scroll to zoom · drag a node to move it
      </div>
    </div>
  );
}
