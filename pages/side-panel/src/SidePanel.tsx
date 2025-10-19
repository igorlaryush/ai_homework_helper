import '@src/SidePanel.css';
import { t } from '@extension/i18n';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner, ToggleButton } from '@extension/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type ChatMessage =
  | {
      id: string;
      role: 'user' | 'assistant';
      type: 'text';
      content: string;
    }
  | {
      id: string;
      role: 'user' | 'assistant';
      type: 'image';
      dataUrl: string;
    }
  | {
      id: string;
      role: 'user' | 'assistant';
      type: 'file';
      name: string;
      size: number;
      mime: string;
    };

type Attachment =
  | { id: string; kind: 'image'; dataUrl: string }
  | { id: string; kind: 'file'; name: string; size: number; mime: string };

const MAX_TEXTAREA_PX = 160; // Tailwind max-h-40
const LOG_PREFIX = '[CEB][SidePanelChat]';

const cropImageDataUrl = async (
  sourceDataUrl: string,
  bounds: { x: number; y: number; width: number; height: number; dpr: number },
): Promise<string> => {
  console.debug(`${LOG_PREFIX} crop start`, bounds);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = sourceDataUrl;
  });

  const sx = Math.max(0, Math.floor(bounds.x * bounds.dpr));
  const sy = Math.max(0, Math.floor(bounds.y * bounds.dpr));
  const sw = Math.max(1, Math.floor(bounds.width * bounds.dpr));
  const sh = Math.max(1, Math.floor(bounds.height * bounds.dpr));

  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('No 2D context');
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const out = canvas.toDataURL('image/png');
  console.debug(`${LOG_PREFIX} crop done`, { width: sw, height: sh, outLen: out.length });
  return out;
};

const initialAssistant: ChatMessage = {
  id: 'm-hello',
  role: 'assistant',
  type: 'text',
  content: 'Привет! Это демонстрационный UI чата. Подключения к LLM здесь нет.',
};

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);

  const [messages, setMessages] = useState<ChatMessage[]>(() => [initialAssistant]);
  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [screenshotActive, setScreenshotActive] = useState<boolean>(false);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const canSend = useMemo(() => input.trim().length > 0 || attachments.length > 0, [input, attachments]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea on content change
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${next}px`;
  }, [input, attachments.length]);

  const handleSend = useCallback(() => {
    if (!canSend) return;

    // Aggregate user message: text + attachments (images/files)
    const out: ChatMessage[] = [];
    if (input.trim()) {
      out.push({ id: `user-${Date.now()}`, role: 'user', type: 'text', content: input.trim() });
    }
    for (const a of attachments) {
      if (a.kind === 'image') {
        out.push({ id: `img-${a.id}`, role: 'user', type: 'image', dataUrl: a.dataUrl });
      } else {
        out.push({ id: `file-${a.id}`, role: 'user', type: 'file', name: a.name, size: a.size, mime: a.mime });
      }
    }
    if (out.length > 0) setMessages(prev => [...prev, ...out]);

    // Clear composer
    setInput('');
    setAttachments([]);

    // Demo assistant reply
    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now() + 1}`,
      role: 'assistant',
      type: 'text',
      content: 'Сообщение принято (UI демо). Здесь будет ответ LLM.',
    };
    setMessages(prev => [...prev, assistantMsg]);

    queueMicrotask(() => inputRef.current?.focus());
  }, [canSend, input, attachments]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Screenshot flow: request selection, mark pressed, then receive capture and add to attachments
  const requestScreenshot = useCallback(() => {
    console.debug(`${LOG_PREFIX} requestScreenshot -> sending SCREENSHOT_REQUEST`);
    setScreenshotActive(true);
    chrome.runtime
      .sendMessage({ type: 'SCREENSHOT_REQUEST' })
      .then(() => console.debug(`${LOG_PREFIX} SCREENSHOT_REQUEST sent`))
      .catch(error => {
        setScreenshotActive(false);
        console.error(`${LOG_PREFIX} SCREENSHOT_REQUEST error`, error);
      });
  }, []);

  // Upload image
  const onClickUploadImage = useCallback(() => imageInputRef.current?.click(), []);
  const onImagesSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl }]);
      };
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  }, []);

  // Upload file (any type)
  const onClickUploadFile = useCallback(() => fileInputRef.current?.click(), []);
  const onFilesSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setAttachments(prev => [
      ...prev,
      ...files.map((f, idx) => ({
        id: `${Date.now()}-${prev.length + idx}`,
        kind: 'file' as const,
        name: f.name,
        size: f.size,
        mime: f.type || 'application/octet-stream',
      })),
    ]);
    event.target.value = '';
  }, []);

  // New chat
  const onNewChat = useCallback(() => {
    setMessages([initialAssistant]);
    setInput('');
    setAttachments([]);
    setScreenshotActive(false);
    queueMicrotask(() => inputRef.current?.focus());
  }, []);

  useEffect(() => {
    const onMessage = async (message: unknown) => {
      const msg = message as {
        type?: string;
        dataUrl?: string;
        bounds?: { x: number; y: number; width: number; height: number; dpr: number };
      };
      if (msg?.type === 'SCREENSHOT_CAPTURED') {
        console.debug(`${LOG_PREFIX} SCREENSHOT_CAPTURED`, { hasData: Boolean(msg.dataUrl), bounds: msg.bounds });
      }
      if (msg?.type === 'SCREENSHOT_CAPTURED' && msg.dataUrl && msg.bounds) {
        try {
          const cropped = await cropImageDataUrl(msg.dataUrl, msg.bounds);
          setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl: cropped }]);
          console.debug(`${LOG_PREFIX} attachment added`, { len: cropped.length });
        } catch (err) {
          console.error('[SidePanel] crop error', err);
        } finally {
          setScreenshotActive(false);
        }
      }
      if (msg?.type === 'SCREENSHOT_CANCELLED') {
        console.debug(`${LOG_PREFIX} SCREENSHOT_CANCELLED`);
        setScreenshotActive(false);
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
  }, []);

  return (
    <div className={cn('App', 'text-left', isLight ? 'bg-slate-50' : 'bg-gray-800')}>
      <div className={cn('flex h-full flex-col', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold">LLM Chat</div>
            <div className="text-xs opacity-70">UI only</div>
          </div>
          <ToggleButton onClick={exampleThemeStorage.toggle} className={'mt-0'}>
            {t('toggleTheme')}
          </ToggleButton>
        </div>

        {/* Messages */}
        <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-3 py-3">
          <div className="flex flex-col gap-3">
            {messages.map(m => (
              <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.type === 'text' ? (
                  <div
                    className={cn(
                      'max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 shadow-sm',
                      m.role === 'user'
                        ? 'bg-violet-600 text-white'
                        : isLight
                          ? 'bg-white text-gray-900 ring-1 ring-black/5'
                          : 'bg-slate-700 text-gray-100 ring-1 ring-white/10',
                    )}>
                    {m.content}
                  </div>
                ) : m.type === 'image' ? (
                  <div
                    className={cn(
                      'max-w-[80%] overflow-hidden rounded-2xl shadow-sm ring-1',
                      isLight ? 'ring-black/5' : 'ring-white/10',
                    )}>
                    <img src={m.dataUrl} alt="screenshot" className="block max-w-full" />
                  </div>
                ) : (
                  <div
                    className={cn(
                      'max-w-[80%] rounded-2xl shadow-sm ring-1',
                      isLight ? 'bg-white text-gray-900 ring-black/5' : 'bg-slate-700 text-gray-100 ring-white/10',
                    )}>
                    <div className="flex items-center gap-2 px-3 py-2 text-sm">
                      <span>📎</span>
                      <span className="font-medium">{m.name}</span>
                      <span className="opacity-60">({Math.ceil(m.size / 1024)} KB)</span>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Toolbar */}
        <div className="border-t border-slate-200 px-3 py-1 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <button
              onClick={requestScreenshot}
              className={cn(
                'inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                screenshotActive
                  ? isLight
                    ? 'border-violet-500 bg-violet-100 text-violet-700'
                    : 'border-violet-400 bg-violet-700/40 text-violet-200'
                  : isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title={screenshotActive ? 'Режим скриншота активен' : 'Сделать скриншот'}
              aria-pressed={screenshotActive}
              aria-label="Сделать скриншот">
              🖼️ Скриншот
            </button>

            <button
              onClick={onClickUploadImage}
              className={cn(
                'inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                isLight
                  ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                  : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title="Загрузить изображение"
              aria-label="Загрузить изображение">
              🖼️+ Изображение
            </button>

            <button
              onClick={onClickUploadFile}
              className={cn(
                'inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                isLight
                  ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                  : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title="Загрузить файл"
              aria-label="Загрузить файл">
              📎 Файл
            </button>

            <button
              onClick={onNewChat}
              className={cn(
                'inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                isLight
                  ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                  : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title="Новый чат"
              aria-label="Новый чат">
              🆕 Новый чат
            </button>

            {/* Hidden inputs */}
            <input
              ref={imageInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={onImagesSelected}
            />
            <input ref={fileInputRef} type="file" multiple className="hidden" onChange={onFilesSelected} />
          </div>
        </div>

        {/* Composer */}
        <div className="border-t border-slate-200 px-3 py-2 dark:border-slate-700">
          {/* Attachments previews */}
          {attachments.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {attachments.map(a => (
                <div
                  key={a.id}
                  className="group relative inline-block overflow-hidden rounded-md ring-1 ring-black/10 dark:ring-white/10">
                  {a.kind === 'image' ? (
                    <img
                      src={(a as Extract<Attachment, { kind: 'image' }>).dataUrl}
                      alt="attachment"
                      className="block h-16 w-16 object-cover"
                    />
                  ) : (
                    <div
                      className={cn(
                        'flex h-16 w-48 items-center gap-2 truncate px-2 text-sm',
                        isLight ? 'bg-white text-gray-900' : 'bg-slate-700 text-gray-100',
                      )}>
                      <span>📎</span>
                      <span className="truncate">{(a as Extract<Attachment, { kind: 'file' }>).name}</span>
                      <span className="opacity-60">
                        ({Math.ceil((a as Extract<Attachment, { kind: 'file' }>).size / 1024)} KB)
                      </span>
                    </div>
                  )}
                  <button
                    onClick={() => removeAttachment(a.id)}
                    className="absolute right-0 top-0 m-1 hidden rounded bg-black/60 px-1 py-0.5 text-xs text-white group-hover:block"
                    aria-label="Удалить вложение">
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={'Введите сообщение... (Enter — отправить, Shift+Enter — новая строка)'}
              className={cn(
                'max-h-40 min-h-[40px] flex-1 resize-none rounded-md border px-3 py-2 text-sm outline-none',
                isLight
                  ? 'border-slate-300 bg-white text-gray-900 focus:border-violet-500 focus:ring-1 focus:ring-violet-500'
                  : 'border-slate-600 bg-slate-700 text-gray-100 focus:border-violet-400 focus:ring-1 focus:ring-violet-400',
              )}
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                'select-none rounded-md px-3 py-2 text-sm font-medium shadow-sm transition-colors',
                canSend ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-gray-400 text-white opacity-60',
              )}
              aria-label="Send message">
              Отправить
            </button>
          </div>
          <div className="mt-1 text-xs opacity-70">Только UI. Подключение LLM не выполнено.</div>
        </div>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
