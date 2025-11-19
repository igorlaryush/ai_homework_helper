import { useCallback, useEffect, useRef, useState } from 'react';

const LOG_PREFIX = '[CEB][FloatingButton]';

export default function App() {
  const buttonRef = useRef<HTMLDivElement | null>(null);
  const isDraggingRef = useRef<boolean>(false);
  const didMoveRef = useRef<boolean>(false);
  const suppressClickRef = useRef<boolean>(false);
  const dragStartPointerYRef = useRef<number>(0);
  const dragStartTopRef = useRef<number>(0);
  const autoSendRef = useRef<boolean>(false);
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

  // Drag handling via window listeners to avoid pointer capture click issues
  useEffect(() => {
    const onWindowPointerMove = (event: PointerEvent) => {
      if (!isDraggingRef.current) return;
      
      const buttonHeight = 64; // Approx height
      const deltaY = event.clientY - dragStartPointerYRef.current;
      const nextTopUnbounded = dragStartTopRef.current + deltaY;
      const minTop = 0;
      const maxTop = Math.max(0, window.innerHeight - buttonHeight);
      const clamped = Math.min(Math.max(minTop, nextTopUnbounded), maxTop);

      if (Math.abs(deltaY) > 2) {
        didMoveRef.current = true;
        suppressClickRef.current = true;
      }
      setButtonTop(clamped);
    };

    const onWindowPointerUp = (event: PointerEvent) => {
      if (!isDraggingRef.current) return;
      
      isDraggingRef.current = false;
      // Delay clearing suppressClickRef slightly to ensure onClick fires and sees it
      setTimeout(() => {
        suppressClickRef.current = false;
        didMoveRef.current = false;
      }, 50);
      
      console.debug(`${LOG_PREFIX} pointerEnd (window)`, {
        finalTop: buttonTop,
        suppressed: suppressClickRef.current,
      });
    };

    window.addEventListener('pointermove', onWindowPointerMove);
    window.addEventListener('pointerup', onWindowPointerUp);
    window.addEventListener('pointercancel', onWindowPointerUp);
    
    return () => {
      window.removeEventListener('pointermove', onWindowPointerMove);
      window.removeEventListener('pointerup', onWindowPointerUp);
      window.removeEventListener('pointercancel', onWindowPointerUp);
    };
  }, [buttonTop]);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // Start drag
      isDraggingRef.current = true;
      didMoveRef.current = false;
      suppressClickRef.current = false;
      dragStartPointerYRef.current = event.clientY;
      dragStartTopRef.current = buttonTop;
      
      // Do NOT capture pointer to allow click events to propagate to children normally
      // (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
      
      console.debug(`${LOG_PREFIX} pointerDown`, {
        clientY: event.clientY,
        startTop: dragStartTopRef.current,
      });
    },
    [buttonTop],
  );

  const onMainClick = useCallback((e: React.MouseEvent) => {
    // If we just dragged, skip the click action
    if (suppressClickRef.current) {
      console.debug(`${LOG_PREFIX} click suppressed after drag`);
      return;
    }
    e.stopPropagation();
    
    // Send explicit open/close command based on current visibility state
    // Note: 'hidden' means the BUTTON is hidden (which happens when panel is open). 
    // Actually, I disabled hiding the button.
    // BUT 'hidden' state is still updated by SIDE_PANEL_OPENED/CLOSED messages.
    // So: hidden=true means Panel is OPEN. hidden=false means Panel is CLOSED.
    const isPanelOpen = hidden;
    const type = isPanelOpen ? 'CLOSE_SIDE_PANEL' : 'OPEN_SIDE_PANEL';
    
    console.debug(`${LOG_PREFIX} click -> sending ${type}`);
    chrome.runtime
      .sendMessage({ type })
      .then(() => console.debug(`${LOG_PREFIX} message sent successfully`))
      .catch(error => console.error(`${LOG_PREFIX} sendMessage error`, error));
  }, [hidden]);

  const onScissorsClick = useCallback((e: React.MouseEvent) => {
    if (suppressClickRef.current) {
      return;
    }
    e.stopPropagation();
    console.debug(`${LOG_PREFIX} onScissorsClick`);
    autoSendRef.current = true;
    setSelecting(true);
    setSelectionStart(null);
    setSelectionRect(null);
    try {
      chrome.runtime.sendMessage({ type: 'SCREENSHOT_OVERLAY_STARTED' });
    } catch {
      // ignore
    }
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
    chrome.runtime.sendMessage({ 
      type: 'SCREENSHOT_SELECTION', 
      bounds,
      autoSend: autoSendRef.current 
    });
    setSelecting(false);
    setSelectionStart(null);
    setSelectionRect(null);
    autoSendRef.current = false;
    // Send OPEN_SIDE_PANEL message with a slight delay to ensure background script handles it
    // This is a fallback in case the background script's open() fails in the capture callback
    setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'OPEN_SIDE_PANEL' }).catch(() => undefined);
    }, 500);
  }, [selectionRect]);

  const cancelSelection = useCallback(() => {
    console.debug(`${LOG_PREFIX} cancelSelection`);
    setSelecting(false);
    setSelectionStart(null);
    setSelectionRect(null);
    autoSendRef.current = false;
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

  // Always render the button to ensure it's visible
  // if (hidden && !selecting) return null;

  return (
    <>
      {/* Button Container */}
      {(
        <div
          ref={buttonRef}
          onPointerDown={onPointerDown}
          // onPointerMove={onPointerMove} // handled by window listener
          // onPointerUp={onPointerUp} // handled by window listener
          // onPointerCancel={onPointerCancel} // handled by window listener
          onDragStart={e => e.preventDefault()}
          draggable={false}
          style={{
            position: 'fixed',
            top: `${buttonTop}px`,
            right: 0,
            zIndex: 2147483647,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            paddingLeft: '12px', // Hit area padding
          }}
          className="select-none touch-none"
          aria-label={t.openSidePanel}>
          
          {/* Scissors Button (Circle) */}
          <div
            role="button"
            onClick={onScissorsClick}
            className="group relative mb-2 flex h-[36px] w-[36px] cursor-pointer items-center justify-center rounded-full bg-gray-900 shadow-xl ring-1 ring-white/20 transition-transform hover:scale-110 active:scale-95"
            title="Screenshot">
            {/* subtle glow */}
            <span
              className="pointer-events-none absolute inset-0 rounded-full opacity-0 blur-md transition-opacity group-hover:opacity-50"
              style={{ background: 'radial-gradient(circle at center, rgba(124,58,237,0.6), transparent 70%)' }}
            />
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="6" cy="6" r="3"/>
              <path d="M8.12 8.12 12 12"/>
              <path d="M20 4 8.12 15.88"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M14.8 14.8 20 20"/>
            </svg>
          </div>

          {/* Main Button (Rectangle with rounded left corners) */}
          <div
            role="button"
            onClick={onMainClick}
            style={{
              width: '32px',
              height: '48px',
              borderTopLeftRadius: '16px',
              borderBottomLeftRadius: '16px',
            }}
            className={[
              'flex items-center justify-center',
              'overflow-hidden',
              'bg-transparent',
              'shadow-xl',
              'ring-2',
              'ring-violet-600',
              'backdrop-blur-[2px]',
              'cursor-grab',
              'relative',
            ].join(' ')}
            title={t.openSidePanel}>
            {/* subtle corner light */}
            <span
              className="pointer-events-none absolute -inset-1 right-0 opacity-40 blur-2xl"
              style={{ background: 'radial-gradient(120px 60px at 10% 50%, rgba(255,255,255,0.35), transparent 70%)' }}
            />
            {iconUrl ? (
              <span className="pointer-events-none flex select-none items-center justify-center rounded-md bg-white/15 p-[3px] ring-1 ring-white/20">
                <img
                  src={iconUrl}
                  alt="app"
                  className="h-[24px] w-[24px] rounded-sm"
                  style={{ width: '24px', height: '24px' }}
                  draggable={false}
                />
              </span>
            ) : (
              <span className="text-xl text-white">☰</span>
            )}
          </div>
        </div>
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
