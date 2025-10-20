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
    webAccess: 'Web Access',
    webOn: 'On',
    webOff: 'Off',
    model: 'Model',
    model_quick: 'Quick – fast & lightweight',
    model_deep: 'Deep – accurate & heavy',
    nav_ask: 'Ask AI',
    nav_read: 'Read',
    nav_write: 'Write',
    comingSoon: 'Coming soon',
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
    webAccess: 'Доступ к вебу',
    webOn: 'Вкл',
    webOff: 'Выкл',
    model: 'Модель',
    model_quick: 'Быстрая — лёгкая и оперативная',
    model_deep: 'Глубокая — точная, но тяжелее',
    nav_ask: 'Ask AI',
    nav_read: 'Read',
    nav_write: 'Write',
    comingSoon: 'Скоро будет',
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
  webAccess: 'webAccessEnabled',
  llmModel: 'llmModel',
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
  const [historySheetOpen, setHistorySheetOpen] = useState<boolean>(false);
  const [webPopoverOpen, setWebPopoverOpen] = useState<boolean>(false);
  const [webAccessEnabled, setWebAccessEnabled] = useState<boolean>(false);
  const [modelPopoverOpen, setModelPopoverOpen] = useState<boolean>(false);
  const [llmModel, setLlmModel] = useState<'quick' | 'deep'>('quick');

  const [uiLocale, setUiLocale] = useState<'en' | 'ru'>('en');
  const [langOpen, setLangOpen] = useState<boolean>(false);
  const [mode, setMode] = useState<'ask' | 'read' | 'write'>('ask');

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageActiveTimeoutRef = useRef<number | undefined>(undefined);
  const fileActiveTimeoutRef = useRef<number | undefined>(undefined);

  const t = UI_I18N[uiLocale];

  // Load persisted locale, chats and toggles
  useEffect(() => {
    chrome.storage?.local
      .get([STORAGE_KEYS.threads, STORAGE_KEYS.activeId, 'uiLocale', STORAGE_KEYS.webAccess, STORAGE_KEYS.llmModel])
      .then(store => {
        const v = store?.uiLocale as 'en' | 'ru' | undefined;
        const localeForInit: 'en' | 'ru' = v === 'ru' ? 'ru' : 'en';
        if (v === 'en' || v === 'ru') setUiLocale(v);

        const web = store?.[STORAGE_KEYS.webAccess] as boolean | undefined;
        if (typeof web === 'boolean') setWebAccessEnabled(web);

        const model = store?.[STORAGE_KEYS.llmModel] as 'quick' | 'deep' | undefined;
        if (model === 'quick' || model === 'deep') setLlmModel(model);

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

  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.threads]: threads, [STORAGE_KEYS.activeId]: activeId });
  }, [threads, activeId]);
  useEffect(() => {
    void chrome.storage?.local.set({ uiLocale });
  }, [uiLocale]);
  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.webAccess]: webAccessEnabled });
  }, [webAccessEnabled]);
  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.llmModel]: llmModel });
  }, [llmModel]);

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

  // UI components: right vertical toolbar
  const RightToolbar = () => (
    <div
      className={cn(
        'flex w-16 flex-col items-center gap-4 border-l p-2',
        isLight ? 'border-slate-300 bg-slate-100' : 'border-slate-700 bg-slate-900',
      )}>
      {/* Ask AI */}
      <button
        onClick={() => setMode('ask')}
        aria-pressed={mode === 'ask'}
        className={cn(
          'group flex h-10 w-10 items-center justify-center rounded-lg ring-1 transition-colors',
          mode === 'ask'
            ? isLight
              ? 'bg-violet-600 text-white ring-violet-500'
              : 'bg-violet-600 text-white ring-violet-400'
            : isLight
              ? 'bg-slate-200 text-gray-900 ring-black/10 hover:bg-slate-300'
              : 'bg-slate-700 text-white ring-white/10 hover:bg-slate-600',
        )}
        title={t.nav_ask}
        aria-label={t.nav_ask}>
        {/* star-like */}
        <svg aria-hidden="true" width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2l1.8 4.6L18 8.5l-4.2 2 1 4.7L12 13.7 9.2 15.2l1-4.7L6 8.5l4.2-1.9L12 2z" />
        </svg>
      </button>
      <div className={cn('mt-1 text-center text-[10px] font-semibold', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {t.nav_ask}
      </div>

      {/* Read */}
      <button
        onClick={() => setMode('read')}
        aria-pressed={mode === 'read'}
        className={cn(
          'group mt-3 flex h-10 w-10 items-center justify-center rounded-lg ring-1 transition-colors',
          mode === 'read'
            ? isLight
              ? 'bg-violet-600 text-white ring-violet-500'
              : 'bg-violet-600 text-white ring-violet-400'
            : isLight
              ? 'bg-slate-200 text-gray-900 ring-black/10 hover:bg-slate-300'
              : 'bg-slate-700 text-white ring-white/10 hover:bg-slate-600',
        )}
        title={t.nav_read}
        aria-label={t.nav_read}>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M3 19V6a2 2 0 0 1 2-2h6v17H5a2 2 0 0 1-2-2z" />
          <path d="M13 21V4h6a2 2 0 0 1 2 2v13" />
        </svg>
      </button>
      <div className={cn('mt-1 text-center text-[10px] font-semibold', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {t.nav_read}
      </div>

      {/* Write */}
      <button
        onClick={() => setMode('write')}
        aria-pressed={mode === 'write'}
        className={cn(
          'group mt-3 flex h-10 w-10 items-center justify-center rounded-lg ring-1 transition-colors',
          mode === 'write'
            ? isLight
              ? 'bg-violet-600 text-white ring-violet-500'
              : 'bg-violet-600 text-white ring-violet-400'
            : isLight
              ? 'bg-slate-200 text-gray-900 ring-black/10 hover:bg-slate-300'
              : 'bg-slate-700 text-white ring-white/10 hover:bg-slate-600',
        )}
        title={t.nav_write}
        aria-label={t.nav_write}>
        <svg
          aria-hidden="true"
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
        </svg>
      </button>
      <div className={cn('mt-1 text-center text-[10px] font-semibold', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {t.nav_write}
      </div>
    </div>
  );

  return (
    <div className={cn('App', 'text-left', isLight ? 'bg-slate-50' : 'bg-gray-800')}>
      <div className={cn('relative flex h-full flex-col', isLight ? 'text-gray-900' : 'text-gray-100')}>
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
                    <span className="flex-1">{t.lang_en}</span>
                    {uiLocale === 'en' && <span aria-hidden>✓</span>}
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
                    <span className="flex-1">{t.lang_ru}</span>
                    {uiLocale === 'ru' && <span aria-hidden>✓</span>}
                  </button>
                </div>
              )}
            </div>

            {/* History button moved remains here */}
            <button
              onClick={() => setHistorySheetOpen(true)}
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
          </div>
        </div>

        {/* Main content area: chat + external right sidebar */}
        <div className="relative flex h-full">
          {/* Scrollable content area */}
          <div ref={messagesContainerRef} className="h-full flex-1 overflow-y-auto px-3 py-3">
            {mode === 'ask' ? (
              <div className="flex flex-col gap-3">
                {messages.map(m => (
                  <div key={m.id} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                    {m.type === 'text' ? (
                      <div
                        className={cn(
                          'max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-left shadow-sm',
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
            ) : (
              <div className="flex h-full items-center justify-center">
                <div className="text-sm opacity-70">{t.comingSoon}</div>
              </div>
            )}
          </div>

          {/* External right sidebar takes full height */}
          <RightToolbar />
        </div>

        {/* Toolbar row (new chat, actions, selectors) remains below ... */}
        {/* existing tools and composer remain unchanged; composer shows only for Ask mode */}
        <div className="border-t border-slate-200 px-3 py-1 dark:border-slate-700">
          <div className="flex items-center gap-2">
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

            {/* Model selector popover */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setModelPopoverOpen(false);
              }}>
              <button
                onClick={() => setModelPopoverOpen(v => !v)}
                title={t.model}
                aria-label={t.model}
                aria-haspopup="dialog"
                aria-expanded={modelPopoverOpen}
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
                  <path d="M12 2c-3 0-5 2-5 5v1H6a4 4 0 0 0 0 8h1v1c0 3 2 5 5 5s5-2 5-5v-1h1a4 4 0 0 0 0-8h-1V7c0-3-2-5-5-5z" />
                </svg>
                <span
                  className={cn(
                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                    'group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}>
                  {t.model}
                </span>
              </button>
              {modelPopoverOpen && (
                <div
                  className={cn(
                    'absolute bottom-full right-0 z-20 mb-2 w-48 rounded-md border p-2 text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  <div className="mb-2 font-medium">{t.model}</div>
                  <button
                    onClick={() => {
                      setLlmModel('quick');
                      setModelPopoverOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2 py-1 hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      llmModel === 'quick' ? 'font-semibold' : undefined,
                    )}
                    aria-pressed={llmModel === 'quick'}>
                    <span>{t.model_quick}</span>
                    {llmModel === 'quick' && <span aria-hidden>✓</span>}
                  </button>
                  <button
                    onClick={() => {
                      setLlmModel('deep');
                      setModelPopoverOpen(false);
                    }}
                    className={cn(
                      'mt-1 flex w-full items-center justify-between rounded px-2 py-1 hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      llmModel === 'deep' ? 'font-semibold' : undefined,
                    )}
                    aria-pressed={llmModel === 'deep'}>
                    <span>{t.model_deep}</span>
                    {llmModel === 'deep' && <span aria-hidden>✓</span>}
                  </button>
                </div>
              )}
            </div>

            {/* Web Access toggle popover */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setWebPopoverOpen(false);
              }}>
              <button
                onClick={() => setWebPopoverOpen(v => !v)}
                title={t.webAccess}
                aria-label={t.webAccess}
                aria-haspopup="dialog"
                aria-expanded={webPopoverOpen}
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
                  <path d="M2 12h20" />
                  <path d="M12 2a10 10 0 0 1 0 20a10 10 0 0 1 0-20z" />
                  <path d="M2 12a10 5 0 0 0 20 0a10 5 0 0 0-20 0z" />
                </svg>
                <span
                  className={cn(
                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                    'group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}>
                  {t.webAccess}
                </span>
              </button>
              {webPopoverOpen && (
                <div
                  className={cn(
                    'absolute bottom-full right-0 z-20 mb-2 w-44 rounded-md border p-2 text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  <div className="mb-2 font-medium">{t.webAccess}</div>
                  <button
                    onClick={() => {
                      setWebAccessEnabled(true);
                      setWebPopoverOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-center justify-between rounded px-2 py-1 hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      webAccessEnabled ? 'font-semibold' : undefined,
                    )}
                    aria-pressed={webAccessEnabled}>
                    <span>{t.webOn}</span>
                    {webAccessEnabled && <span aria-hidden>✓</span>}
                  </button>
                  <button
                    onClick={() => {
                      setWebAccessEnabled(false);
                      setWebPopoverOpen(false);
                    }}
                    className={cn(
                      'mt-1 flex w-full items-center justify-between rounded px-2 py-1 hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                      !webAccessEnabled ? 'font-semibold' : undefined,
                    )}
                    aria-pressed={!webAccessEnabled}>
                    <span>{t.webOff}</span>
                    {!webAccessEnabled && <span aria-hidden>✓</span>}
                  </button>
                </div>
              )}
            </div>

            {/* History button opens bottom sheet */}
            <button
              onClick={() => setHistorySheetOpen(true)}
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
        {mode === 'ask' && (
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
        )}
      </div>

      {/* History bottom sheet */}
      {historySheetOpen && (
        <div className="fixed inset-0 z-30" role="dialog" aria-modal="true">
          <div
            className="absolute inset-0 bg-black/40"
            role="button"
            tabIndex={0}
            aria-label="Close overlay"
            onClick={() => setHistorySheetOpen(false)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setHistorySheetOpen(false);
              }
            }}
          />
          <div
            className={cn(
              'absolute bottom-0 left-0 right-0 max-h-[70%] overflow-hidden rounded-t-xl border-t shadow-xl',
              isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
            )}>
            <div
              className={cn(
                'flex items-center justify-between border-b px-4 py-2',
                isLight ? 'border-slate-200' : 'border-slate-700',
              )}>
              <div className="font-semibold">{t.history}</div>
              <button
                onClick={() => setHistorySheetOpen(false)}
                className={cn('rounded px-2 py-1 text-sm', isLight ? 'hover:bg-slate-100' : 'hover:bg-slate-700')}
                aria-label="Close">
                ✕
              </button>
            </div>
            <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
              {sortedThreads.length === 0 ? (
                <div className="px-3 py-2 opacity-60">{t.noChats}</div>
              ) : (
                sortedThreads.map(th => (
                  <button
                    key={th.id}
                    onClick={() => {
                      activateThread(th.id);
                      setHistorySheetOpen(false);
                    }}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-700',
                      activeId === th.id ? 'font-semibold' : undefined,
                    )}>
                    <div className="flex-1 truncate">
                      <div className="truncate">{th.title || (uiLocale === 'ru' ? 'Без названия' : 'Untitled')}</div>
                    </div>
                    <div className="ml-2 whitespace-nowrap text-xs opacity-70">
                      {new Date(th.updatedAt).toLocaleString()}
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
