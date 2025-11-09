import { useCallback, useEffect, useRef, useState } from 'react';

const LOG_PREFIX = '[CEB][FloatingButton]';

export default function App() {
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const didMoveRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);
  const dragStartPointerYRef = useRef<number>(0);
  const dragStartTopRef = useRef<number>(0);
  const [buttonTop, setButtonTop] = useState<number>(() => Math.max(80, Math.round(window.innerHeight / 2 - 32)));
  const [hidden, setHidden] = useState<boolean>(false);
  const [iconUrl] = useState<string>(() => {
    try {
      return chrome.runtime.getURL('icon-64.png');
    } catch {
      return '';
    }
  });

  const [selecting, setSelecting] = useState<boolean>(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [selectionRect, setSelectionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(
    null,
  );

  type UILocale = 'en' | 'ru' | 'de' | 'es' | 'fr' | 'pt' | 'uk' | 'tr' | 'zh';
  const [uiLocale, setUiLocale] = useState<UILocale>('en');
  const T = {
    en: {
      openSidePanel: 'Open side panel',
      selectionAria: 'Selection area for screenshot',
      selectionHelp: 'ESC — cancel · Enter/Double click — accept',
    },
    ru: {
      openSidePanel: 'Открыть боковую панель',
      selectionAria: 'Выделение области для скриншота',
      selectionHelp: 'ESC — отмена · Enter/Двойной клик — принять',
    },
    de: {
      openSidePanel: 'Seitenleiste öffnen',
      selectionAria: 'Auswahlbereich für Screenshot',
      selectionHelp: 'ESC — Abbrechen · Enter/Doppelklick — Bestätigen',
    },
    fr: {
      openSidePanel: 'Ouvrir le panneau latéral',
      selectionAria: 'Zone de sélection pour la capture',
      selectionHelp: 'ESC — annuler · Entrée/Double‑clic — valider',
    },
    es: {
      openSidePanel: 'Abrir panel lateral',
      selectionAria: 'Área de selección para captura',
      selectionHelp: 'ESC — cancelar · Enter/Doble clic — aceptar',
    },
    pt: {
      openSidePanel: 'Abrir painel lateral',
      selectionAria: 'Área de seleção para captura de tela',
      selectionHelp: 'ESC — cancelar · Enter/Clique duplo — confirmar',
    },
    uk: {
      openSidePanel: 'Відкрити бокову панель',
      selectionAria: 'Область виділення для скриншота',
      selectionHelp: 'ESC — скасувати · Enter/Подвійний клік — прийняти',
    },
    tr: {
      openSidePanel: 'Kenar paneli aç',
      selectionAria: 'Ekran görüntüsü için seçim alanı',
      selectionHelp: 'ESC — iptal · Enter/Çift tık — onayla',
    },
    zh: {
      openSidePanel: '打开侧边面板',
      selectionAria: '截图选择区域',
      selectionHelp: 'ESC — 取消 · Enter/双击 — 确认',
    },
  } as const;
  const t = T[uiLocale];

  useEffect(() => {
    console.log(`${LOG_PREFIX} mounted`);
    // Load initial locale
    chrome.storage?.local.get(['uiLocale']).then(store => {
      const v = store?.uiLocale as UILocale | undefined;
      const allowed: ReadonlyArray<UILocale> = ['en', 'ru', 'de', 'es', 'fr', 'pt', 'uk', 'tr', 'zh'] as const;
      setUiLocale(allowed.includes(v as UILocale) ? (v as UILocale) : 'en');
    });
    // Listen for locale changes
    const onStorageChanged = (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string): void => {
      if (areaName === 'local' && changes['uiLocale']) {
        const v = changes['uiLocale'].newValue as UILocale | undefined;
        const allowed: ReadonlyArray<UILocale> = ['en', 'ru', 'de', 'es', 'fr', 'pt', 'uk', 'tr', 'zh'] as const;
        setUiLocale(allowed.includes(v as UILocale) ? (v as UILocale) : 'en');
      }
    };
    chrome.storage?.onChanged.addListener(onStorageChanged);
    const onMessage = (message: unknown) => {
      const msg = message as { type?: string; isOpen?: boolean };
      if (msg?.type === 'SIDE_PANEL_OPENED') {
        console.debug(`${LOG_PREFIX} received SIDE_PANEL_OPENED`);
        setHidden(true);
      } else if (msg?.type === 'SIDE_PANEL_CLOSED') {
        console.debug(`${LOG_PREFIX} received SIDE_PANEL_CLOSED`);
        setHidden(false);
      } else if (msg?.type === 'SIDE_PANEL_STATE') {
        console.debug(`${LOG_PREFIX} received SIDE_PANEL_STATE`, msg);
        setHidden(Boolean(msg.isOpen));
      } else if (msg?.type === 'BEGIN_SELECTION') {
        console.debug(`${LOG_PREFIX} received BEGIN_SELECTION`);
        setSelecting(true);
        setSelectionStart(null);
        setSelectionRect(null);
        try {
          chrome.runtime.sendMessage({ type: 'SCREENSHOT_OVERLAY_STARTED' });
        } catch {
          // ignore
        }
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    chrome.runtime.sendMessage({ type: 'IS_SIDE_PANEL_OPEN' }).catch(() => undefined);
    return () => {
      console.log(`${LOG_PREFIX} unmounted`);
      chrome.runtime.onMessage.removeListener(onMessage);
      chrome.storage?.onChanged.removeListener(onStorageChanged);
    };
  }, []);

  // Keep button within viewport bounds on resize
  useEffect(() => {
    const handleResize = () => {
      const buttonHeight = buttonRef.current?.offsetHeight ?? 64;
      const maxTop = Math.max(0, window.innerHeight - buttonHeight);
      setButtonTop(prev => Math.min(Math.max(0, prev), maxTop));
      console.debug(`${LOG_PREFIX} resize`, { buttonHeight, maxTop });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      // Begin drag immediately on press
      isDraggingRef.current = true;
      didMoveRef.current = false;
      suppressClickRef.current = false;
      dragStartPointerYRef.current = event.clientY;
      dragStartTopRef.current = buttonTop;
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      console.debug(`${LOG_PREFIX} pointerDown`, {
        clientY: event.clientY,
        startTop: dragStartTopRef.current,
      });
    },
    [buttonTop],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    if (!isDraggingRef.current) return;
    const buttonHeight = buttonRef.current?.offsetHeight ?? 64;
    const deltaY = event.clientY - dragStartPointerYRef.current;
    const nextTopUnbounded = dragStartTopRef.current + deltaY;
    const minTop = 0;
    const maxTop = Math.max(0, window.innerHeight - buttonHeight);
    const clamped = Math.min(Math.max(minTop, nextTopUnbounded), maxTop);
    if (Math.abs(deltaY) > 1) didMoveRef.current = true;
    setButtonTop(clamped);
  }, []);

  const endPointerSequence = useCallback(
    (event: { pointerId?: number; clientY?: number; currentTarget?: EventTarget | null }) => {
      if (isDraggingRef.current && didMoveRef.current) {
        suppressClickRef.current = true;
      }
      isDraggingRef.current = false;
      (event.currentTarget as HTMLElement | undefined)?.releasePointerCapture?.(event.pointerId as number);
      console.debug(`${LOG_PREFIX} pointerEnd`, {
        clientY: event.clientY,
        finalTop: buttonTop,
        suppressed: suppressClickRef.current,
      });
      // reset move flag after sequence ends
      didMoveRef.current = false;
    },
    [buttonTop],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      endPointerSequence({
        pointerId: event.pointerId,
        clientY: event.clientY,
        currentTarget: event.currentTarget,
      });
    },
    [endPointerSequence],
  );

  const onPointerCancel = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      endPointerSequence({
        pointerId: event.pointerId,
        clientY: event.clientY,
        currentTarget: event.currentTarget,
      });
    },
    [endPointerSequence],
  );

  const onClick = useCallback(() => {
    // If we just dragged, skip the click action to avoid accidental toggles
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      console.debug(`${LOG_PREFIX} click suppressed after drag`);
      return;
    }
    console.debug(`${LOG_PREFIX} click -> sending OPEN_SIDE_PANEL message`);
    chrome.runtime
      .sendMessage({ type: 'OPEN_SIDE_PANEL' })
      .then(() => console.debug(`${LOG_PREFIX} message sent successfully`))
      .catch(error => console.error(`${LOG_PREFIX} sendMessage error`, error));
  }, []);

  // Selection overlay interactions (fixed to viewport)
  const onOverlayMouseDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    setSelectionStart({ x: event.clientX, y: event.clientY });
    setSelectionRect({ x: event.clientX, y: event.clientY, width: 0, height: 0 });
  }, []);

  const onOverlayMouseMove = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      if (!selectionStart) return;
      const x1 = selectionStart.x;
      const y1 = selectionStart.y;
      const x2 = event.clientX;
      const y2 = event.clientY;
      const left = Math.min(x1, x2);
      const top = Math.min(y1, y2);
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);
      setSelectionRect({ x: left, y: top, width, height });
    },
    [selectionStart],
  );

  const finishSelection = useCallback(() => {
    if (!selectionRect) {
      setSelecting(false);
      return;
    }
    const bounds = { ...selectionRect, dpr: window.devicePixelRatio || 1 };
    console.debug(`${LOG_PREFIX} finishSelection -> sending SCREENSHOT_SELECTION`, bounds);
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_SELECTION', bounds });
    setSelecting(false);
    setSelectionStart(null);
    setSelectionRect(null);
  }, [selectionRect]);

  const cancelSelection = useCallback(() => {
    console.debug(`${LOG_PREFIX} cancelSelection`);
    setSelecting(false);
    setSelectionStart(null);
    setSelectionRect(null);
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
  }, []);

  const onOverlayKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelSelection();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        finishSelection();
      }
    },
    [cancelSelection, finishSelection],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancelSelection();
      if (e.key === 'Enter' && selecting) finishSelection();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancelSelection, finishSelection, selecting]);

  if (hidden && !selecting) return null;

  return (
    <>
      {!hidden && (
        <button
          ref={buttonRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onDragStart={e => e.preventDefault()}
          draggable={false}
          onClick={onClick}
          style={{
            position: 'fixed',
            top: `${buttonTop}px`,
            right: 0,
            zIndex: 2147483647,
            width: '32px',
            height: '64px',
          }}
          className={[
            'select-none',
            // width/height also set inline in style to avoid site CSS/Tailwind variance
            'rounded-l-full',
            'overflow-hidden',
            'bg-gradient-to-br',
            'from-violet-600',
            'to-violet-500',
            'shadow-xl',
            'ring-2',
            'ring-white/60',
            'backdrop-blur-[2px]',
            'hover:from-violet-500',
            'hover:to-violet-500',
            'active:scale-[0.98]',
            'cursor-grab',
            'flex items-center justify-center',
            'relative',
            'touch-none',
          ].join(' ')}
          aria-label={t.openSidePanel}
          title={t.openSidePanel}>
          {/* subtle corner light to match rounded corner style */}
          <span
            className="pointer-events-none absolute -inset-1 right-0 opacity-40 blur-2xl"
            style={{ background: 'radial-gradient(120px 60px at 10% 50%, rgba(255,255,255,0.35), transparent 70%)' }}
          />
          {/* icon */}
          {iconUrl ? (
            <span className="pointer-events-none flex select-none items-center justify-center rounded-full bg-white/15 p-[3px] ring-1 ring-white/20">
              <img
                src={iconUrl}
                alt="app"
                className="h-[24px] w-[24px] rounded-md"
                style={{ width: '24px', height: '24px' }}
                draggable={false}
              />
            </span>
          ) : (
            <span className="text-xl text-white">☰</span>
          )}
        </button>
      )}

      {selecting && (
        <div
          role="button"
          aria-label={t.selectionAria}
          tabIndex={0}
          onKeyDown={onOverlayKeyDown}
          onMouseDown={onOverlayMouseDown}
          onMouseMove={onOverlayMouseMove}
          onMouseUp={finishSelection}
          onDoubleClick={finishSelection}
          style={{ position: 'fixed', inset: 0, zIndex: 2147483646, cursor: 'crosshair' }}>
          {!selectionRect && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.8)' }} />}
          {selectionRect && (
            <div
              style={{
                position: 'absolute',
                left: `${selectionRect.x}px`,
                top: `${selectionRect.y}px`,
                width: `${selectionRect.width}px`,
                height: `${selectionRect.height}px`,
                boxShadow: '0 0 0 9999px rgba(0,0,0,0.8)',
                outline: '2px solid #7c3aed',
                borderRadius: '4px',
                background: 'transparent',
              }}
            />
          )}
          <div
            style={{
              position: 'fixed',
              left: 12,
              bottom: 12,
              padding: '6px 10px',
              borderRadius: 6,
              fontSize: 12,
              color: '#fff',
              background: 'rgba(17,24,39,0.85)',
            }}>
            {t.selectionHelp}
          </div>
        </div>
      )}
    </>
  );
}
