import '@src/SidePanel.css';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner } from '@extension/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// Simple UI translations for the side panel (local only)
const UI_I18N = {
  en: {
    title: 'LLM Chat',
    uiOnly: 'UI only',
    toggleTheme: 'Toggle theme',
    screenshot: 'Screenshot',
    uploadImage: 'Upload image',
    uploadFile: 'Upload file',
    newChat: 'New chat',
    removeAttachment: 'Remove attachment',
    placeholder: 'Type a message... (Enter — send, Shift+Enter — new line)',
    uiNote: 'UI only. No LLM connected.',
    langButton: 'Language',
    lang_en: 'English (English)',
    lang_ru: 'Russian (Русский)',
    history: 'History',
    noChats: 'No chats yet',
    send: 'Send',
  },
  ru: {
    title: 'LLM Чат',
    uiOnly: 'Только UI',
    toggleTheme: 'Сменить тему',
    screenshot: 'Скриншот',
    uploadImage: 'Загрузить изображение',
    uploadFile: 'Загрузить файл',
    newChat: 'Новый чат',
    removeAttachment: 'Удалить вложение',
    placeholder: 'Введите сообщение... (Enter — отправить, Shift+Enter — новая строка)',
    uiNote: 'Только UI. Подключение LLM не выполнено.',
    langButton: 'Язык',
    lang_en: 'English (English)',
    lang_ru: 'Russian (Русский)',
    history: 'История',
    noChats: 'Чатов пока нет',
    send: 'Отправить',
  },
} as const;

type ChatMessage =
  | { id: string; role: 'user' | 'assistant'; type: 'text'; content: string }
  | { id: string; role: 'user' | 'assistant'; type: 'image'; dataUrl: string }
  | { id: string; role: 'user' | 'assistant'; type: 'file'; name: string; size: number; mime: string };

type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
};

type Attachment =
  | { id: string; kind: 'image'; dataUrl: string }
  | { id: string; kind: 'file'; name: string; size: number; mime: string };

const MAX_TEXTAREA_PX = 160; // Tailwind max-h-40

const cropImageDataUrl = async (
  sourceDataUrl: string,
  bounds: { x: number; y: number; width: number; height: number; dpr: number },
): Promise<string> => {
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
  return canvas.toDataURL('image/png');
};

const initialAssistant: ChatMessage = {
  id: 'm-hello',
  role: 'assistant',
  type: 'text',
  content: 'Привет! Это демонстрационный UI чата. Подключения LLM здесь нет.',
};

const STORAGE_KEYS = {
  threads: 'chatThreads',
  activeId: 'activeChatId',
} as const;

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [screenshotActive, setScreenshotActive] = useState<boolean>(false);
  const [imageActive, setImageActive] = useState<boolean>(false);
  const [fileActive, setFileActive] = useState<boolean>(false);
  const [newChatActive, setNewChatActive] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageActiveTimeoutRef = useRef<number | undefined>(undefined);
  const fileActiveTimeoutRef = useRef<number | undefined>(undefined);

  const [uiLocale, setUiLocale] = useState<'en' | 'ru'>('en');
  const [langOpen, setLangOpen] = useState<boolean>(false);
  const t = UI_I18N[uiLocale];

  // Load persisted locale and chats
  useEffect(() => {
    chrome.storage?.local.get([STORAGE_KEYS.threads, STORAGE_KEYS.activeId, 'uiLocale']).then(store => {
      const v = store?.uiLocale as 'en' | 'ru' | undefined;
      const localeForInit: 'en' | 'ru' = v === 'ru' ? 'ru' : 'en';
      if (v === 'en' || v === 'ru') setUiLocale(v);

      const loadedThreads = (store?.[STORAGE_KEYS.threads] as ChatThread[] | undefined) ?? [];
      const loadedActive = (store?.[STORAGE_KEYS.activeId] as string | undefined) ?? '';

      if (loadedThreads.length === 0) {
        const id = `chat-${Date.now()}`;
        const initial: ChatThread = {
          id,
          title: localeForInit === 'ru' ? 'Новый чат' : 'New chat',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [initialAssistant],
        };
        setThreads([initial]);
        setActiveId(id);
        setMessages(initial.messages);
      } else {
        setThreads(loadedThreads);
        const useId =
          loadedActive && loadedThreads.some(c => c.id === loadedActive) ? loadedActive : loadedThreads[0].id;
        setActiveId(useId);
        const active = loadedThreads.find(c => c.id === useId)!;
        setMessages(active.messages);
      }
    });
  }, []);

  // Persist threads and active id
  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.threads]: threads, [STORAGE_KEYS.activeId]: activeId });
  }, [threads, activeId]);

  useEffect(() => {
    void chrome.storage?.local.set({ uiLocale });
  }, [uiLocale]);

  const canSend = useMemo(() => input.trim().length > 0 || attachments.length > 0, [input, attachments]);

  // Scroll to bottom when messages change
  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  // Auto-resize textarea
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = '0px';
    const next = Math.min(el.scrollHeight, MAX_TEXTAREA_PX);
    el.style.height = `${next}px`;
  }, [input, attachments.length]);

  const upsertActiveThread = useCallback(
    (updater: (thread: ChatThread) => ChatThread) => {
      setThreads(prev => prev.map(t => (t.id === activeId ? updater(t) : t)));
    },
    [activeId],
  );

  const handleSend = useCallback(() => {
    if (!canSend) return;

    const out: ChatMessage[] = [];
    const userText = input.trim();
    if (userText) out.push({ id: `user-${Date.now()}`, role: 'user', type: 'text', content: userText });
    for (const a of attachments) {
      if (a.kind === 'image') out.push({ id: `img-${a.id}`, role: 'user', type: 'image', dataUrl: a.dataUrl });
      else out.push({ id: `file-${a.id}`, role: 'user', type: 'file', name: a.name, size: a.size, mime: a.mime });
    }

    if (out.length > 0) {
      setMessages(prev => [...prev, ...out]);
      upsertActiveThread(thread => ({
        ...thread,
        title:
          thread.title && thread.title !== 'New chat' && thread.title !== 'Новый чат'
            ? thread.title
            : userText
              ? userText.slice(0, 40)
              : thread.title,
        updatedAt: Date.now(),
        messages: [...thread.messages, ...out],
      }));
    }

    setInput('');
    setAttachments([]);

    const assistantMsg: ChatMessage = {
      id: `assistant-${Date.now() + 1}`,
      role: 'assistant',
      type: 'text',
      content:
        uiLocale === 'ru'
          ? 'Сообщение принято (UI демо). Здесь будет ответ LLM.'
          : 'Message received (UI demo). LLM response goes here.',
    };
    setMessages(prev => [...prev, assistantMsg]);
    upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now(), messages: [...thread.messages, assistantMsg] }));

    queueMicrotask(() => inputRef.current?.focus());
  }, [canSend, input, attachments, uiLocale, upsertActiveThread]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const requestScreenshot = useCallback(() => {
    setScreenshotActive(true);
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_REQUEST' }).catch(() => setScreenshotActive(false));
  }, []);

  const onClickUploadImage = useCallback(() => {
    setImageActive(true);
    if (imageActiveTimeoutRef.current !== undefined) window.clearTimeout(imageActiveTimeoutRef.current);
    imageActiveTimeoutRef.current = window.setTimeout(() => setImageActive(false), 2000);
    imageInputRef.current?.click();
  }, []);

  const onImagesSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (imageActiveTimeoutRef.current !== undefined) {
      window.clearTimeout(imageActiveTimeoutRef.current);
      imageActiveTimeoutRef.current = undefined;
    }
    setImageActive(false);

    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      const reader = new FileReader();
      reader.onload = () =>
        setAttachments(prev => [
          ...prev,
          { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl: String(reader.result ?? '') },
        ]);
      reader.readAsDataURL(file);
    }
    event.target.value = '';
  }, []);

  const onClickUploadFile = useCallback(() => {
    setFileActive(true);
    if (fileActiveTimeoutRef.current !== undefined) window.clearTimeout(fileActiveTimeoutRef.current);
    fileActiveTimeoutRef.current = window.setTimeout(() => setFileActive(false), 2000);
    fileInputRef.current?.click();
  }, []);

  const onFilesSelected = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    if (fileActiveTimeoutRef.current !== undefined) {
      window.clearTimeout(fileActiveTimeoutRef.current);
      fileActiveTimeoutRef.current = undefined;
    }
    setFileActive(false);

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

  const createNewChat = useCallback(() => {
    const id = `chat-${Date.now()}`;
    const thread: ChatThread = {
      id,
      title: uiLocale === 'ru' ? 'Новый чат' : 'New chat',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [initialAssistant],
    };
    setThreads(prev => [thread, ...prev]);
    setActiveId(id);
    setMessages(thread.messages);
    setInput('');
    setAttachments([]);
  }, [uiLocale]);

  const onNewChat = useCallback(() => {
    setNewChatActive(true);
    createNewChat();
    queueMicrotask(() => inputRef.current?.focus());
    window.setTimeout(() => setNewChatActive(false), 300);
  }, [createNewChat]);

  // Handle screenshot results
  useEffect(() => {
    const onMessage = async (message: unknown) => {
      const msg = message as {
        type?: string;
        dataUrl?: string;
        bounds?: { x: number; y: number; width: number; height: number; dpr: number };
      };
      if (msg?.type === 'SCREENSHOT_CAPTURED' && msg.dataUrl && msg.bounds) {
        try {
          const cropped = await cropImageDataUrl(msg.dataUrl, msg.bounds);
          setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl: cropped }]);
        } catch {
          // ignore
        } finally {
          setScreenshotActive(false);
        }
      }
      if (msg?.type === 'SCREENSHOT_CANCELLED') setScreenshotActive(false);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const removeAttachment = useCallback((id: string) => setAttachments(prev => prev.filter(a => a.id !== id)), []);

  // Switch thread
  const activateThread = useCallback(
    (id: string) => {
      setActiveId(id);
      const found = threads.find(t => t.id === id);
      if (found) setMessages(found.messages);
      setInput('');
      setAttachments([]);
    },
    [threads],
  );

  const sortedThreads = useMemo(() => [...threads].sort((a, b) => b.updatedAt - a.updatedAt), [threads]);

  return (
    <div className={cn('App', 'text-left', isLight ? 'bg-slate-50' : 'bg-gray-800')}>
      <div className={cn('flex h-full flex-col', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold">{t.title}</div>
            <div className="text-xs opacity-70">{t.uiOnly}</div>
          </div>
          <div className="relative flex items-center gap-2">
            {/* Theme toggle */}
            <button
              onClick={exampleThemeStorage.toggle}
              title={t.toggleTheme}
              aria-label={t.toggleTheme}
              className={cn(
                'mt-0 inline-flex h-8 w-8 items-center justify-center rounded-full border text-lg transition-colors',
                isLight
                  ? 'border-slate-300 bg-white text-amber-500 hover:bg-slate-50'
                  : 'border-slate-600 bg-slate-700 text-amber-300 hover:bg-slate-600',
              )}>
              <span aria-hidden="true">{isLight ? '🌙' : '☀️'}</span>
            </button>

            {/* Language selector */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setLangOpen(false);
              }}>
              <button
                onClick={() => setLangOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={langOpen}
                title={t.langButton}
                aria-label={t.langButton}
                className={cn(
                  'inline-flex h-8 w-8 items-center justify-center rounded-full border text-base transition-colors',
                  isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                )}>
                <span aria-hidden="true">🌐</span>
              </button>
              {langOpen && (
                <div
                  className={cn(
                    'absolute right-0 z-20 mt-2 w-48 overflow-hidden rounded-md border text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  <button
                    onClick={() => {
                      setUiLocale('en');
                      setLangOpen(false);
                    }}
                    role="option"
                    aria-selected={uiLocale === 'en'}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      uiLocale === 'en' ? 'font-semibold' : undefined,
                    )}>
                    <span>🇺🇸</span>
                    <span>{t.lang_en}</span>
                  </button>
                  <button
                    onClick={() => {
                      setUiLocale('ru');
                      setLangOpen(false);
                    }}
                    role="option"
                    aria-selected={uiLocale === 'ru'}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      uiLocale === 'ru' ? 'font-semibold' : undefined,
                    )}>
                    <span>🇷🇺</span>
                    <span>{t.lang_ru}</span>
                  </button>
                </div>
              )}
            </div>
          </div>
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
                'group relative inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                screenshotActive
                  ? isLight
                    ? 'border-violet-500 bg-violet-100 text-violet-700'
                    : 'border-violet-400 bg-violet-700/40 text-violet-200'
                  : isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title={t.screenshot}
              aria-pressed={screenshotActive}
              aria-label={t.screenshot}>
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round">
                <rect x="3" y="7" width="18" height="14" rx="2" />
                <circle cx="12" cy="14" r="4" />
                <path d="M9 7l1.5-2h3L15 7" />
              </svg>
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}>
                {t.screenshot}
              </span>
            </button>

            <button
              onClick={onClickUploadImage}
              className={cn(
                'group relative inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                imageActive
                  ? isLight
                    ? 'border-violet-500 bg-violet-100 text-violet-700'
                    : 'border-violet-400 bg-violet-700/40 text-violet-200'
                  : isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title={t.uploadImage}
              aria-pressed={imageActive}
              aria-label={t.uploadImage}>
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round">
                <rect x="3" y="5" width="18" height="14" rx="2" />
                <circle cx="8" cy="9" r="1.5" />
                <path d="M21 16l-5-5-4 4-3-3-6 6" />
              </svg>
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}>
                {t.uploadImage}
              </span>
            </button>

            <button
              onClick={onClickUploadFile}
              className={cn(
                'group relative inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                fileActive
                  ? isLight
                    ? 'border-violet-500 bg-violet-100 text-violet-700'
                    : 'border-violet-400 bg-violet-700/40 text-violet-200'
                  : isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title={t.uploadFile}
              aria-pressed={fileActive}
              aria-label={t.uploadFile}>
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M14 2v6h6" />
                <path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
              </svg>
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}>
                {t.uploadFile}
              </span>
            </button>

            {/* History selector placed before New Chat */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setHistoryOpen(false);
              }}>
              <button
                onClick={() => setHistoryOpen(v => !v)}
                aria-haspopup="listbox"
                aria-expanded={historyOpen}
                title={t.history}
                aria-label={t.history}
                className={cn(
                  'group relative inline-flex h-8 w-8 items-center justify-center rounded-md border text-base transition-colors',
                  isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                )}>
                <svg
                  aria-hidden="true"
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l4 4" />
                </svg>
                <span
                  className={cn(
                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                    'group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}>
                  {t.history}
                </span>
              </button>
              {historyOpen && (
                <div
                  className={cn(
                    'absolute z-20 mt-2 w-64 overflow-hidden rounded-md border text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  {sortedThreads.length === 0 ? (
                    <div className="px-3 py-2 opacity-60">{t.noChats}</div>
                  ) : (
                    sortedThreads.map(th => (
                      <button
                        key={th.id}
                        onClick={() => {
                          activateThread(th.id);
                          setHistoryOpen(false);
                        }}
                        role="option"
                        aria-selected={activeId === th.id}
                        className={cn(
                          'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                          activeId === th.id ? 'font-semibold' : undefined,
                        )}>
                        <span className="truncate">
                          {th.title || (uiLocale === 'ru' ? 'Без названия' : 'Untitled')}
                        </span>
                        <span className="ml-auto text-xs opacity-60">
                          {new Date(th.updatedAt).toLocaleTimeString()}
                        </span>
                      </button>
                    ))
                  )}
                </div>
              )}
            </div>

            <button
              onClick={onNewChat}
              className={cn(
                'group relative inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors',
                newChatActive
                  ? isLight
                    ? 'border-violet-500 bg-violet-100 text-violet-700'
                    : 'border-violet-400 bg-violet-700/40 text-violet-200'
                  : isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
              )}
              title={t.newChat}
              aria-pressed={newChatActive}
              aria-label={t.newChat}>
              <svg
                aria-hidden="true"
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}>
                {t.newChat}
              </span>
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
                    aria-label={t.removeAttachment}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="relative">
            <textarea
              ref={inputRef}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              rows={1}
              placeholder={t.placeholder}
              className={cn(
                'max-h-40 min-h-[40px] w-full resize-none rounded-md border px-3 py-2 pr-12 text-sm outline-none',
                isLight
                  ? 'border-slate-300 bg-white text-gray-900 focus:border-violet-500 focus:ring-1 focus:ring-violet-500'
                  : 'border-slate-600 bg-slate-700 text-gray-100 focus:border-violet-400 focus:ring-1 focus:ring-violet-400',
              )}
            />
            <button
              onClick={handleSend}
              disabled={!canSend}
              className={cn(
                'group absolute bottom-2 right-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-sm shadow-sm transition-colors',
                canSend ? 'bg-violet-600 text-white hover:bg-violet-700' : 'bg-gray-400 text-white opacity-60',
              )}
              title={t.send}
              aria-label={t.send}>
              <svg
                aria-hidden="true"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round">
                <path d="M22 2L11 13" />
                <path d="M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
              <span
                className={cn(
                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                )}>
                {t.send}
              </span>
            </button>
          </div>
          <div className="mt-1 text-xs opacity-70">{t.uiNote}</div>
        </div>
      </div>
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
