import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import './OnboardingTour.css';

type TourStep = {
  id: string;
  selector: string;
  title: string;
  content: string;
};

type HighlightRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type OnboardingTourProps = {
  steps: TourStep[];
  open: boolean;
  onClose: () => void;
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const OnboardingTour = ({ steps, open, onClose }: OnboardingTourProps) => {
  const [index, setIndex] = useState<number>(0);
  const [rect, setRect] = useState<HighlightRect | null>(null);
  const [notFound, setNotFound] = useState<boolean>(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const [cardSize, setCardSize] = useState<{ width: number; height: number }>({ width: 320, height: 140 });

  const total = steps.length;
  const current = steps[clamp(index, 0, Math.max(0, total - 1))];

  const computeRect = useCallback(() => {
    if (!open || !current) return;
    const el = document.querySelector(current.selector) as HTMLElement | null;
    if (!el) {
      setRect(null);
      setNotFound(true);
      return;
    }
    const r = el.getBoundingClientRect();
    const padding = 8;
    setRect({
      x: Math.max(0, r.left - padding),
      y: Math.max(0, r.top - padding),
      width: Math.min(window.innerWidth, r.width + padding * 2),
      height: Math.min(window.innerHeight, r.height + padding * 2),
    });
    setNotFound(false);
  }, [open, current]);

  useLayoutEffect(() => {
    computeRect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, open]);

  // Measure card size to position without overflow
  useLayoutEffect(() => {
    if (!open) return;
    const node = cardRef.current;
    if (!node) return;
    const update = () => {
      const w = node.offsetWidth || 320;
      const h = node.offsetHeight || 140;
      setCardSize({ width: w, height: h });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(node);
    return () => {
      ro.disconnect();
    };
  }, [open, index, current]);

  useEffect(() => {
    if (!open) return;
    const onResize = () => computeRect();
    const onScroll = () => computeRect();
    window.addEventListener('resize', onResize, { passive: true });
    window.addEventListener('scroll', onScroll, { passive: true });
    const id = window.setInterval(computeRect, 250);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll);
      window.clearInterval(id);
    };
  }, [open, computeRect]);

  useEffect(() => {
    if (!open) {
      setIndex(0);
      setRect(null);
      setNotFound(false);
    }
  }, [open]);

  const next = useCallback(() => {
    if (index + 1 >= total) {
      onClose();
    } else {
      setIndex(v => Math.min(v + 1, total - 1));
    }
  }, [index, total, onClose]);

  const prev = useCallback(() => {
    setIndex(v => Math.max(0, v - 1));
  }, []);

  const styleVars = useMemo(() => {
    if (!rect) return {};
    return {
      '--tour-x': `${rect.x}px`,
      '--tour-y': `${rect.y}px`,
      '--tour-w': `${rect.width}px`,
      '--tour-h': `${rect.height}px`,
    } as CSSProperties;
  }, [rect]);

  if (!open) return null;

  const isFirst = index === 0;
  const isLast = index === total - 1;

  // Compute card position clamped within viewport
  const margin = 8;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 0;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 0;
  const cardW = Math.min(cardSize.width, Math.max(200, vw - margin * 2));
  const cardH = Math.min(cardSize.height, Math.max(100, vh - margin * 2));
  let leftPx = margin;
  let topPx = margin;
  if (rect) {
    const preferredLeft = rect.x + rect.width / 2 - cardW / 2;
    leftPx = clamp(preferredLeft, margin, Math.max(margin, vw - margin - cardW));
    const preferredTopBelow = rect.y + rect.height + 12;
    // Prefer below; if not enough space, try above
    if (preferredTopBelow + cardH <= vh - margin) {
      topPx = preferredTopBelow;
    } else {
      const preferredTopAbove = rect.y - 12 - cardH;
      topPx = clamp(preferredTopAbove, margin, Math.max(margin, vh - margin - cardH));
    }
  }

  return (
    <div ref={containerRef} className="ob-tour-overlay" role="dialog" aria-modal="true">
      {/* Dim background */}
      <div className="ob-tour-backdrop" />

      {/* Highlight box */}
      {rect && <div className="ob-tour-highlight" style={styleVars} aria-hidden="true" />}

      {/* Tooltip card */}
      <div
        ref={cardRef}
        className="ob-tour-card"
        style={{
          top: topPx,
          left: leftPx,
          maxWidth: `${Math.floor(vw - margin * 2)}px`,
          maxHeight: `${Math.floor(vh - margin * 2)}px`,
        }}>
        <div className="ob-tour-steps">
          Step {Math.min(index + 1, total)} of {total}
        </div>
        <div className="ob-tour-title">{current?.title ?? 'Tip'}</div>
        <div className="ob-tour-content">
          {notFound ? 'Element not found on screen. Navigate to the relevant view and press Next.' : current?.content}
        </div>
        <div className="ob-tour-actions">
          <button className="ob-tour-btn" onClick={onClose}>
            Skip
          </button>
          <div className="ob-tour-spacer" />
          <button className="ob-tour-btn" onClick={prev} disabled={isFirst}>
            Back
          </button>
          <button className="ob-tour-btn ob-tour-primary" onClick={next}>
            {isLast ? 'Done' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default OnboardingTour;
export type { TourStep };
