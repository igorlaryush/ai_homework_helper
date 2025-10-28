import '@src/SidePanel.css';
import 'katex/dist/katex.min.css';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner } from '@extension/ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

const normalizeMathDelimiters = (input: string): string => {
  if (!input) return input;
  let output = input.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => `$$\n${inner}\n$$`);
  output = output.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => `$${inner}$`);
  const looksLikeMath = /(\\|\^|_|\\frac|\\sum|\\int|\\cdot|\\hat|\\vec|\\nabla|\\sqrt|\\begin|\\end|=)/;
  output = output.replace(/(^|\n)\s*\[\s*([\s\S]*?)\s*\]\s*(?=\n|$)/g, (m, start, inner) => {
    if (!looksLikeMath.test(inner)) return m;
    return `${start}$$\n${inner}\n$$`;
  });
  output = output.replace(/\[(.+?)\](?!\(|:)/g, (m, inner, offset) => {
    const before = output[offset - 3] + output[offset - 2] + output[offset - 1];
    if (before && (before.endsWith('[ ') || before.endsWith('[x') || before.endsWith('[X'))) return m;
    if (inner.includes('\n')) return m;
    if (!looksLikeMath.test(inner)) return m;
    return `$${inner}$`;
  });
  return output;
};

// Simple UI translations for the side panel (local only)
const UI_I18N = {
  en: {
    title: 'LLM Chat',
    uiOnly: 'UI only',
    toggleTheme: 'Toggle theme',
    screenshot: 'Screenshot',
    uploadImage: 'Upload image',
    uploadFile: 'Upload PDF',
    newChat: 'New chat',
    removeAttachment: 'Remove attachment',
    placeholder: 'Type a message... (Enter — send, Shift+Enter — new line)',
    uiNote: 'UI only. No LLM connected.',
    langButton: 'Language',
    lang_en: 'English (English)',
    lang_ru: 'Russian (Русский)',
    history: 'History',
    delete: 'Delete',
    edit: 'Edit',
    cancel: 'Cancel',
    deleteChat: 'Delete chat',
    confirmDeleteChat: 'Delete this chat?',
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
    apiKey: 'API Key',
    setApiKey: 'Set API Key',
    enterApiKey: 'Enter OpenAI API key (starts with sk-)',
    save: 'Save',
    clear: 'Clear',
    missingKey: 'API key is not set',
    read_drop_title: 'Click or drag files here to upload.',
    read_drop_sub1: 'Supported file types: PDF',
    read_drop_sub2: 'Maximum file size: 10MB.',
    read_recent: 'Recent Files:',
    read_view: 'View',
    read_delete: 'Delete',
    write_compose: 'Compose',
    write_revise: 'Revise',
    write_grammar: 'Grammar check',
    write_paraphrase: 'Paraphraser',
    write_format: 'Format',
    write_tone: 'Tone',
    write_length: 'Length',
    write_language: 'Language',
    write_generate: 'Generate Draft',
    write_ai_optimize: 'AI Optimize',
    write_regenerate: 'Regenerate',
    write_copy: 'Copy',
    write_result: 'Result',
    chip_auto: 'Auto',
    chip_essay: 'Essay',
    chip_article: 'Article',
    chip_email: 'Email',
    chip_message: 'Message',
    chip_comment: 'Comment',
    chip_blog: 'Blog',
    chip_formal: 'Formal',
    chip_professional: 'Professional',
    chip_funny: 'Funny',
    chip_casual: 'Casual',
    chip_short: 'Short',
    chip_medium: 'Medium',
    chip_long: 'Long',
    superAI: 'SuperAI',
  },
  ru: {
    title: 'LLM Чат',
    uiOnly: 'Только UI',
    toggleTheme: 'Сменить тему',
    screenshot: 'Скриншот',
    uploadImage: 'Загрузить изображение',
    uploadFile: 'Загрузить PDF',
    newChat: 'Новый чат',
    removeAttachment: 'Удалить вложение',
    placeholder: 'Введите сообщение... (Enter — отправить, Shift+Enter — новая строка)',
    uiNote: 'Только UI. Подключение LLM не выполнено.',
    langButton: 'Язык',
    lang_en: 'English (English)',
    lang_ru: 'Russian (Русский)',
    history: 'История',
    delete: 'Удалить',
    edit: 'Редактировать',
    cancel: 'Отмена',
    deleteChat: 'Удалить чат',
    confirmDeleteChat: 'Удалить этот чат?',
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
    apiKey: 'Ключ API',
    setApiKey: 'Указать ключ API',
    enterApiKey: 'Введите ключ OpenAI (начинается с sk-)',
    save: 'Сохранить',
    clear: 'Очистить',
    missingKey: 'Ключ API не установлен',
    read_drop_title: 'Нажмите или перетащите файлы сюда для загрузки.',
    read_drop_sub1: 'Поддерживаемые форматы: PDF',
    read_drop_sub2: 'Максимальный размер: 10MB.',
    read_recent: 'Недавние файлы:',
    read_view: 'Открыть',
    read_delete: 'Удалить',
    write_compose: 'Compose',
    write_revise: 'Revise',
    write_grammar: 'Проверка грамматики',
    write_paraphrase: 'Парафраз',
    write_format: 'Формат',
    write_tone: 'Тон',
    write_length: 'Длина',
    write_language: 'Язык',
    write_generate: 'Сгенерировать черновик',
    write_ai_optimize: 'AI Оптимизация',
    write_regenerate: 'Перегенерировать',
    write_copy: 'Копировать',
    write_result: 'Результат',
    chip_auto: 'Auto',
    chip_essay: 'Essay',
    chip_article: 'Article',
    chip_email: 'Email',
    chip_message: 'Message',
    chip_comment: 'Comment',
    chip_blog: 'Blog',
    chip_formal: 'Formal',
    chip_professional: 'Professional',
    chip_funny: 'Funny',
    chip_casual: 'Casual',
    chip_short: 'Short',
    chip_medium: 'Medium',
    chip_long: 'Long',
    superAI: 'SuperAI',
  },
} as const;

type ChatMessage =
  | { id: string; role: 'user' | 'assistant'; type: 'text'; content: string; batchId?: string }
  | { id: string; role: 'user' | 'assistant'; type: 'image'; dataUrl: string; batchId?: string }
  | {
      id: string;
      role: 'user' | 'assistant';
      type: 'file';
      name: string;
      size: number;
      mime: string;
      batchId?: string;
    };

type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  messages: ChatMessage[];
};

type Attachment =
  | { id: string; kind: 'image'; dataUrl: string }
  | { id: string; kind: 'file'; name: string; size: number; mime: string };

type ReadFileItem = {
  id: string;
  name: string;
  size: number;
  type: string;
  dataUrl: string; // data:application/pdf;base64,...
  addedAt: number;
};

const MAX_TEXTAREA_PX = 160; // Tailwind max-h-40
const MAX_PDF_BYTES = 10 * 1024 * 1024;

// Minimal types for OpenAI Responses API parsing
type ResponseAnnotation = { url?: string; title?: string };
type ResponseContent = { text?: string; annotations?: ResponseAnnotation[] };
type ResponseOutputItem = { type?: string; content?: ResponseContent[] };
type ResponsesResult = { id?: string; output?: ResponseOutputItem[]; output_text?: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Removed unused extractTextFromOutput to satisfy eslint no-unused-vars

const extractCitationsFromOutput = (output: unknown): { title?: string; url: string }[] => {
  const urls: { title?: string; url: string }[] = [];
  if (!Array.isArray(output)) return urls;
  for (const item of output) {
    if (!isRecord(item)) continue;
    const content = (item as ResponseOutputItem).content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      if (!isRecord(c)) continue;
      const anns = (c as ResponseContent).annotations;
      if (!Array.isArray(anns)) continue;
      for (const a of anns) if (a && typeof a.url === 'string') urls.push({ title: a.title, url: a.url });
    }
  }
  return urls;
};

// Streaming utilities for OpenAI Responses API (SSE)
type StreamCallbacks = {
  onDelta: (chunk: string) => void;
  onDone: (final: ResponsesResult | null) => void;
  onError: (error: unknown) => void;
};

const streamResponsesApi = async (
  { apiKey, body }: { apiKey: string; body: Record<string, unknown> },
  { onDelta, onDone, onError }: StreamCallbacks,
): Promise<void> => {
  try {
    const res = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'responses-2024-10-22',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
    });
    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      onError({ status: res.status, body: bodyText });
      return;
    }
    if (!res.body) throw new Error('No response body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalResult: ResponsesResult | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        if (block.length === 0) continue;
        // Parse SSE block
        const lines = block.split('\n');
        let eventName = '';
        const dataLines: string[] = [];
        for (const line of lines) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        const dataStr = dataLines.join('\n');
        if (!dataStr) continue;
        try {
          const data = JSON.parse(dataStr) as unknown;
          if (eventName.includes('output_text.delta')) {
            const piece =
              isRecord(data) && typeof (data as Record<string, unknown>).delta === 'string'
                ? String((data as Record<string, unknown>).delta)
                : '';
            if (piece) onDelta(piece);
          } else if (eventName === 'response.completed') {
            // Final full response object
            if (isRecord(data) && isRecord((data as Record<string, unknown>).response)) {
              finalResult = (data as { response: ResponsesResult }).response;
            }
          } else if (eventName === 'error') {
            onError(data);
          }
        } catch {
          // ignore bad JSON
        }
      }
    }
    onDone(finalResult);
  } catch (err) {
    onError(err);
  }
};

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

// Upload a file to OpenAI Files API and return file_id
const uploadFileToOpenAI = async ({ apiKey, file }: { apiKey: string; file: File }): Promise<string> => {
  const form = new FormData();
  form.append('file', file, file.name);
  // Use user_data for files that will be used as model inputs per OpenAI guidance
  form.append('purpose', 'user_data');

  const res = await fetch('https://api.openai.com/v1/files', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  });

  if (!res.ok) {
    let bodyText = '';
    try {
      bodyText = await res.text();
    } catch {
      // ignore
    }
    throw new Error(`File upload failed: ${res.status} ${bodyText}`);
  }
  const json = (await res.json()) as { id?: string };
  const id = typeof json.id === 'string' ? json.id : '';
  if (!id) throw new Error('Invalid file id from OpenAI Files API');
  return id;
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
  readRecent: 'readRecentFiles',
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
  const [apiKeyOpen, setApiKeyOpen] = useState<boolean>(false);
  const [apiKeyInput, setApiKeyInput] = useState<string>('');
  const [apiKeyMasked, setApiKeyMasked] = useState<string>('');
  const lastRequestRef = useRef<{ model: string; inputPayload: unknown; fileIds?: string[] } | null>(null);

  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

  const [uiLocale, setUiLocale] = useState<'en' | 'ru'>('en');
  const [langOpen, setLangOpen] = useState<boolean>(false);
  // Editing state for user messages
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  const [mode, setMode] = useState<'ask' | 'read' | 'write'>('ask');
  const [writeTab, setWriteTab] = useState<'compose' | 'revise' | 'grammar' | 'paraphrase'>('compose');
  const lastResponseIdRef = useRef<string | null>(null);

  // Write mode state
  const [writeComposeInput, setWriteComposeInput] = useState<string>('');
  const [writeFormat, setWriteFormat] = useState<
    'auto' | 'essay' | 'article' | 'email' | 'message' | 'comment' | 'blog'
  >('auto');
  const [writeTone, setWriteTone] = useState<'auto' | 'formal' | 'professional' | 'funny' | 'casual'>('auto');
  const [writeLength, setWriteLength] = useState<'auto' | 'short' | 'medium' | 'long'>('auto');
  const [writeLanguage, setWriteLanguage] = useState<string>('English');
  const [writeSuper, setWriteSuper] = useState<boolean>(false);
  const [writeComposeResult, setWriteComposeResult] = useState<string>('');

  const [writeReviseInput, setWriteReviseInput] = useState<string>('');
  const [writeReviseResult, setWriteReviseResult] = useState<string>('');

  const [writeGrammarInput, setWriteGrammarInput] = useState<string>('');
  const [writeGrammarResult, setWriteGrammarResult] = useState<string>('');

  const [writeParaphraseInput, setWriteParaphraseInput] = useState<string>('');
  const [writeParaphraseResult, setWriteParaphraseResult] = useState<string>('');

  // Read mode state
  const [readFiles, setReadFiles] = useState<ReadFileItem[]>([]);
  const [readDragging, setReadDragging] = useState<boolean>(false);
  const [readActiveId, setReadActiveId] = useState<string | null>(null);

  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageActiveTimeoutRef = useRef<number | undefined>(undefined);
  const fileActiveTimeoutRef = useRef<number | undefined>(undefined);
  const readFileInputRef = useRef<HTMLInputElement | null>(null);
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  // In-memory map of attachment id -> File object for uploads
  const attachmentFileMapRef = useRef<Record<string, File>>({});

  const t = UI_I18N[uiLocale];
  const headerTitle = mode === 'ask' ? t.title : mode === 'read' ? t.nav_read : t.nav_write;

  useEffect(() => {
    if (editingMessageId) {
      queueMicrotask(() => editingTextareaRef.current?.focus());
    }
  }, [editingMessageId]);

  // Avatars for assistant and user
  const BotAvatar = () => (
    <div
      className={cn(
        'grid h-8 w-8 shrink-0 place-items-center rounded-full',
        isLight ? 'bg-violet-100 text-violet-700' : 'bg-slate-700 text-violet-300',
      )}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3 2 8l10 5 7-3.5V15h2V8L12 3z" />
        <path d="M5 12v3.5A4.5 4.5 0 0 0 9.5 20h5A4.5 4.5 0 0 0 19 15.5V12l-7 3.5L5 12z" />
      </svg>
    </div>
  );
  const UserAvatar = () => (
    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-violet-600 text-white">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5z" />
      </svg>
    </div>
  );

  // Load persisted locale, chats and toggles
  useEffect(() => {
    chrome.storage?.local
      .get([
        STORAGE_KEYS.threads,
        STORAGE_KEYS.activeId,
        'uiLocale',
        STORAGE_KEYS.webAccess,
        STORAGE_KEYS.llmModel,
        STORAGE_KEYS.readRecent,
        'openai_api_key',
      ])
      .then(store => {
        const v = store?.uiLocale as 'en' | 'ru' | undefined;
        const localeForInit: 'en' | 'ru' = v === 'ru' ? 'ru' : 'en';
        if (v === 'en' || v === 'ru') setUiLocale(v);

        const web = store?.[STORAGE_KEYS.webAccess] as boolean | undefined;
        if (typeof web === 'boolean') setWebAccessEnabled(web);

        const model = store?.[STORAGE_KEYS.llmModel] as 'quick' | 'deep' | undefined;
        if (model === 'quick' || model === 'deep') setLlmModel(model);

        const loadedRead = (store?.[STORAGE_KEYS.readRecent] as ReadFileItem[] | undefined) ?? [];
        setReadFiles(loadedRead);

        const key = (store?.openai_api_key as string | undefined) ?? '';
        if (key) {
          setApiKeyInput(key);
          setApiKeyMasked(`${key.slice(0, 3)}••••${key.slice(-4)}`);
        }

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
  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.readRecent]: readFiles });
  }, [readFiles]);
  useEffect(() => {
    const toSave = apiKeyInput.trim();
    if (toSave === '' || toSave.startsWith('sk-')) void chrome.storage?.local.set({ openai_api_key: toSave });
  }, [apiKeyInput]);

  // Keep previous_response_id ref in sync with the active thread (survives reload via storage -> threads)
  useEffect(() => {
    const activeThread = threads.find(t => t.id === activeId);
    lastResponseIdRef.current = activeThread?.lastResponseId ?? null;
  }, [threads, activeId]);

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

  // Build last N user turns (current + previous) into Responses API input items
  const buildHistoryInputItemsFrom = useCallback(
    (all: ChatMessage[], maxTurns: number = 5): Array<Record<string, unknown>> => {
      const items: Array<Record<string, unknown>> = [];
      let i = all.length - 1;
      while (i >= 0 && items.length < maxTurns) {
        while (i >= 0 && all[i].role !== 'user') i--;
        if (i < 0) break;
        const end = i;
        const endMsg = all[end];
        const batchId = endMsg.batchId;
        let start = end;
        if (batchId) {
          while (start - 1 >= 0 && all[start - 1].role === 'user' && all[start - 1].batchId === batchId) start--;
        }
        const group = all.slice(start, end + 1).filter(m => m.role === 'user');
        const isTextMessage = (m: ChatMessage): m is Extract<ChatMessage, { type: 'text' }> => m.type === 'text';
        const isImageMessage = (m: ChatMessage): m is Extract<ChatMessage, { type: 'image' }> => m.type === 'image';
        const textItem = [...group].reverse().find(isTextMessage);
        const images = group.filter(isImageMessage);
        const text = textItem?.content || (uiLocale === 'ru' ? 'Опиши вложения.' : 'Describe the attachments.');
        const imageParts = images.map(img => ({ type: 'input_image', image_url: img.dataUrl }));
        items.push({ role: 'user', content: [{ type: 'input_text', text }, ...imageParts] });
        i = start - 1;
      }
      return items.reverse();
    },
    [uiLocale],
  );

  // Build last N user turns that appear BEFORE a specific assistant message id
  const buildHistoryInputItemsBeforeMessage = useCallback(
    (assistantMessageId: string, maxTurns: number = 5): Array<Record<string, unknown>> => {
      const idx = messages.findIndex(m => m.id === assistantMessageId);
      if (idx <= 0) return [];
      const all = messages.slice(0, idx);
      return buildHistoryInputItemsFrom(all, maxTurns);
    },
    [messages, buildHistoryInputItemsFrom],
  );

  const handleSend = useCallback(async () => {
    if (!canSend) return;

    const attachmentsSnapshot = attachments;

    const out: ChatMessage[] = [];
    const userText = input.trim();
    if (userText) out.push({ id: `user-${Date.now()}`, role: 'user', type: 'text', content: userText });
    for (const a of attachmentsSnapshot) {
      if (a.kind === 'image') out.push({ id: `img-${a.id}`, role: 'user', type: 'image', dataUrl: a.dataUrl });
      else out.push({ id: `file-${a.id}`, role: 'user', type: 'file', name: a.name, size: a.size, mime: a.mime });
    }

    let withBatch: ChatMessage[] = [];
    if (out.length > 0) {
      const batchId = out.length > 1 ? `batch-${Date.now()}` : undefined;
      withBatch = batchId ? out.map(m => ({ ...m, batchId })) : out;
      setMessages(prev => [...prev, ...withBatch]);
      upsertActiveThread(thread => ({
        ...thread,
        title:
          thread.title && thread.title !== 'New chat' && thread.title !== 'Новый чат'
            ? thread.title
            : userText
              ? userText.slice(0, 40)
              : thread.title,
        updatedAt: Date.now(),
        messages: [...thread.messages, ...withBatch],
      }));
    }

    // Prepare API request before clearing inputs
    const key = apiKeyInput.trim();
    // Build contextual history including the just-appended user turn
    const allMessagesForContext = withBatch.length > 0 ? [...messages, ...withBatch] : messages;

    setInput('');
    setAttachments([]);
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';

    if (!key) {
      const assistantMsg: ChatMessage = {
        id: `assistant-${Date.now() + 1}`,
        role: 'assistant',
        type: 'text',
        content: t.missingKey,
      };
      setMessages(prev => [...prev, assistantMsg]);
      upsertActiveThread(thread => ({
        ...thread,
        updatedAt: Date.now(),
        messages: [...thread.messages, assistantMsg],
      }));
      queueMicrotask(() => inputRef.current?.focus());
      return;
    }

    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const inputPayload = buildHistoryInputItemsFrom(allMessagesForContext, 5);

    // Streaming placeholder message (show immediately)
    const streamId = `assistant-${Date.now() + 1}`;
    setMessages(prev => [...prev, { id: streamId, role: 'assistant', type: 'text', content: '' }]);
    upsertActiveThread(thread => ({
      ...thread,
      updatedAt: Date.now(),
      messages: [...thread.messages, { id: streamId, role: 'assistant', type: 'text', content: '' }],
    }));
    setIsStreaming(true);
    setStreamingMessageId(streamId);

    // Upload file attachments via Files API to enable file_search
    const fileAttachmentIds = attachmentsSnapshot.filter(a => a.kind === 'file').map(a => a.id);
    let uploadedPairs: Array<{ file: File; fileId: string }> = [];
    if (fileAttachmentIds.length > 0) {
      try {
        const filesToUpload = fileAttachmentIds
          .map(id => attachmentFileMapRef.current[id])
          .filter((f): f is File => !!f);
        uploadedPairs = await Promise.all(
          filesToUpload.map(async file => ({ file, fileId: await uploadFileToOpenAI({ apiKey: key, file }) })),
        );
      } catch (e) {
        console.error('[CEB][SidePanel] File upload error', e);
        const msgText =
          uiLocale === 'ru' ? 'Не удалось загрузить файл(ы) в OpenAI.' : 'Failed to upload file(s) to OpenAI.';
        // Update the placeholder with error text
        setMessages(prev => prev.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content: msgText } : m)));
        upsertActiveThread(thread => ({
          ...thread,
          updatedAt: Date.now(),
          messages: thread.messages.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content: msgText } : m)),
        }));
        // Ensure attachments are cleared after error
        setAttachments([]);
        queueMicrotask(() => inputRef.current?.focus());
        return;
      }
    }

    // Prepare input_file parts for uploaded PDF files
    const uploadedFileIds: string[] = uploadedPairs.map(p => p.fileId);
    const uploadedPdfFileIds: string[] = uploadedPairs
      .filter(p => p.file.type === 'application/pdf' || p.file.name.toLowerCase().endsWith('.pdf'))
      .map(p => p.fileId);

    const inputWithFiles =
      uploadedPdfFileIds.length > 0
        ? [
            ...inputPayload,
            {
              role: 'user',
              content: uploadedPdfFileIds.map(file_id => ({ type: 'input_file', file_id })),
            },
          ]
        : inputPayload;

    // Clean used files from the map
    for (const id of fileAttachmentIds) delete attachmentFileMapRef.current[id];

    lastRequestRef.current = { model, inputPayload: inputWithFiles, fileIds: uploadedFileIds };

    const combinedTools: Array<{ type: 'web_search' }> = [];
    if (webAccessEnabled) combinedTools.push({ type: 'web_search' });

    void streamResponsesApi(
      {
        apiKey: key,
        body: {
          model,
          input: inputWithFiles,
          text: { format: { type: 'text' } },
          // Enable web_search if requested; files are passed via input_file
          ...(combinedTools.length > 0 ? { tools: combinedTools, tool_choice: 'auto' as const } : {}),
          ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
        },
      },
      {
        onDelta: chunk => {
          setMessages(prev =>
            prev.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m)),
          );
          upsertActiveThread(thread => ({
            ...thread,
            messages: thread.messages.map(m =>
              m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m,
            ),
          }));
        },
        onDone: final => {
          if (final && typeof final.id === 'string') lastResponseIdRef.current = final.id;
          setThreads(prev =>
            prev.map(t => (t.id === activeId ? { ...t, lastResponseId: lastResponseIdRef.current ?? undefined } : t)),
          );
          const citations = final ? extractCitationsFromOutput(final.output) : [];
          if (citations.length > 0) {
            const suffix =
              '\n\n' +
              (uiLocale === 'ru' ? 'Источники:' : 'Sources:') +
              '\n' +
              citations
                .slice(0, 8)
                .map(c => `- ${c.title ? `[${c.title}](${c.url})` : c.url}`)
                .join('\n');
            setMessages(prev =>
              prev.map(m =>
                m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m,
              ),
            );
            upsertActiveThread(thread => ({
              ...thread,
              updatedAt: Date.now(),
              messages: thread.messages.map(m =>
                m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m,
              ),
            }));
          } else {
            upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
          }
          setIsStreaming(false);
          setStreamingMessageId(null);
          queueMicrotask(() => inputRef.current?.focus());
        },
        onError: err => {
          console.error('[CEB][SidePanel] OpenAI stream error (send)', err);
          const status =
            err && typeof err === 'object' && 'status' in (err as Record<string, unknown>)
              ? Number((err as Record<string, unknown>).status)
              : undefined;
          // Fallback 1: retry without web_search tool on 403
          if (status === 403 && webAccessEnabled) {
            void streamResponsesApi(
              {
                apiKey: key,
                body: {
                  model,
                  input: inputWithFiles,
                  text: { format: { type: 'text' } },
                  // No tools on retry
                  ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                },
              },
              {
                onDelta: chunk => {
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m,
                    ),
                  );
                  upsertActiveThread(thread => ({
                    ...thread,
                    messages: thread.messages.map(m =>
                      m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m,
                    ),
                  }));
                },
                onDone: final => {
                  if (final && typeof final.id === 'string') lastResponseIdRef.current = final.id;
                  const citations = final ? extractCitationsFromOutput(final.output) : [];
                  if (citations.length > 0) {
                    const suffix =
                      '\n\n' +
                      (uiLocale === 'ru' ? 'Источники:' : 'Sources:') +
                      '\n' +
                      citations
                        .slice(0, 8)
                        .map(c => `- ${c.title ? `[${c.title}](${c.url})` : c.url}`)
                        .join('\n');
                    setMessages(prev =>
                      prev.map(m =>
                        m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m,
                      ),
                    );
                    upsertActiveThread(thread => ({
                      ...thread,
                      updatedAt: Date.now(),
                      messages: thread.messages.map(m =>
                        m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m,
                      ),
                    }));
                  } else {
                    upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
                  }
                  setIsStreaming(false);
                  setStreamingMessageId(null);
                  queueMicrotask(() => inputRef.current?.focus());
                },
                onError: () => {
                  const content = uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.';
                  setMessages(prev => prev.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content } : m)));
                  upsertActiveThread(thread => ({
                    ...thread,
                    updatedAt: Date.now(),
                    messages: thread.messages.map(m =>
                      m.id === streamId && m.type === 'text' ? { ...m, content } : m,
                    ),
                  }));
                  setIsStreaming(false);
                  queueMicrotask(() => inputRef.current?.focus());
                },
              },
            );
            return;
          }
          // Fallback 2: switch to gpt-4o-mini if deep model 403s
          if (status === 403 && model === 'gpt-4o') {
            const fallbackModel = 'gpt-4o-mini';
            void streamResponsesApi(
              {
                apiKey: key,
                body: {
                  model: fallbackModel,
                  input: inputWithFiles,
                  text: { format: { type: 'text' } },
                  // No tools on fallback
                  ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                },
              },
              {
                onDelta: chunk => {
                  setMessages(prev =>
                    prev.map(m =>
                      m.id === streamId && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m,
                    ),
                  );
                },
                onDone: () => {
                  setIsStreaming(false);
                  setStreamingMessageId(null);
                },
                onError: () => {
                  setIsStreaming(false);
                  setStreamingMessageId(null);
                },
              },
            );
            return;
          }
          const content = uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.';
          setMessages(prev => prev.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content } : m)));
          upsertActiveThread(thread => ({
            ...thread,
            updatedAt: Date.now(),
            messages: thread.messages.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content } : m)),
          }));
          setIsStreaming(false);
          setStreamingMessageId(null);
          queueMicrotask(() => inputRef.current?.focus());
        },
      },
    );
  }, [
    canSend,
    input,
    attachments,
    uiLocale,
    upsertActiveThread,
    apiKeyInput,
    llmModel,
    t.missingKey,
    webAccessEnabled,
    activeId,
    messages,
    buildHistoryInputItemsFrom,
  ]);

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
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (pdfFiles.length === 0) {
      event.target.value = '';
      return;
    }
    const baseTime = Date.now();
    setAttachments(prev => {
      const newItems = pdfFiles.map((f, idx) => {
        const id = `${baseTime}-${prev.length + idx}`;
        // Track file object for later upload
        attachmentFileMapRef.current[id] = f;
        return {
          id,
          kind: 'file' as const,
          name: f.name,
          size: f.size,
          mime: 'application/pdf',
        };
      });
      return [...prev, ...newItems];
    });
    event.target.value = '';
  }, []);

  // Read: helpers
  const openPdf = useCallback(async (item: ReadFileItem) => {
    try {
      let url = item.dataUrl;
      if (url.startsWith('data:')) {
        // Convert data URL to Blob to avoid PDF viewer issues with large data URLs
        const res = await fetch(url);
        const blob = await res.blob();
        url = URL.createObjectURL(blob);
      }
      const w = window.open(url, '_blank', 'noopener,noreferrer');
      if (!w) {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
      }
      if (url.startsWith('blob:')) {
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch {
      // ignore
    }
  }, []);

  const deletePdf = useCallback(
    (id: string) => {
      setReadFiles(prev => prev.filter(f => f.id !== id));
      if (readActiveId === id) setReadActiveId(null);
    },
    [readActiveId],
  );

  // Write actions
  const generateCompose = useCallback(() => {
    const base = writeComposeInput.trim() || 'Untitled draft';
    const lines = [
      `${base}`,
      '',
      `Format: ${writeFormat}, Tone: ${writeTone}, Length: ${writeLength}, Language: ${writeLanguage}${writeSuper ? ', SuperAI' : ''}.`,
      '',
      'This is a placeholder draft (UI demo). Replace with your LLM call.',
    ];
    setWriteComposeResult(lines.join('\n'));
  }, [writeComposeInput, writeFormat, writeTone, writeLength, writeLanguage, writeSuper]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }, []);

  const optimizeRevise = useCallback(() => {
    const text = writeReviseInput.trim();
    if (!text) {
      setWriteReviseResult('');
      return;
    }
    const improved = text.replace(/\s+/g, ' ').replace(/\s([,.!?])/g, '$1');
    setWriteReviseResult(`${improved}\n\n(UI demo: simple cleanup)${writeSuper ? ' + SuperAI' : ''}`);
  }, [writeReviseInput, writeSuper]);

  const runGrammar = useCallback(() => {
    const text = writeGrammarInput.trim();
    setWriteGrammarResult(text ? 'UI demo: grammar suggestions will appear here.' : '');
  }, [writeGrammarInput]);

  const runParaphrase = useCallback(() => {
    const text = writeParaphraseInput.trim();
    setWriteParaphraseResult(text ? 'UI demo: paraphrased text will appear here.' : '');
  }, [writeParaphraseInput]);

  const acceptDroppedFiles = useCallback((files: File[]) => {
    const pdfs = files.filter(
      f => (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) && f.size <= MAX_PDF_BYTES,
    );
    if (pdfs.length === 0) return;
    Promise.all(
      pdfs.map(
        f =>
          new Promise<ReadFileItem>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () =>
              resolve({
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                name: f.name,
                size: f.size,
                type: f.type || 'application/pdf',
                dataUrl: String(reader.result ?? ''),
                addedAt: Date.now(),
              });
            reader.onerror = reject;
            reader.readAsDataURL(f);
          }),
      ),
    ).then(newItems => setReadFiles(prev => [...newItems, ...prev].slice(0, 50)));
  }, []);

  const onReadDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setReadDragging(false);
      const id = e.dataTransfer.getData('application/x-read-file-id') || e.dataTransfer.getData('text/plain');
      if (id) {
        setReadActiveId(id);
        return;
      }
      const dtFiles = Array.from(e.dataTransfer.files ?? []);
      if (dtFiles.length > 0) acceptDroppedFiles(dtFiles);
    },
    [acceptDroppedFiles],
  );

  const onReadBrowse = useCallback(() => readFileInputRef.current?.click(), []);

  const onReadInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length > 0) acceptDroppedFiles(files);
      e.target.value = '';
    },
    [acceptDroppedFiles],
  );

  const onReadDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, []);

  const onReadDragEnter = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setReadDragging(true);
  }, []);

  const onReadDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setReadDragging(false);
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

  const removeAttachment = useCallback((id: string) => {
    setAttachments(prev => prev.filter(a => a.id !== id));
    // Also remove any tracked File object
    delete attachmentFileMapRef.current[id];
  }, []);

  // Delete single message
  const deleteMessage = useCallback(
    (id: string) => {
      setMessages(prev => prev.filter(m => m.id !== id));
      upsertActiveThread(thread => ({
        ...thread,
        updatedAt: Date.now(),
        messages: thread.messages.filter(m => m.id !== id),
      }));
      if (editingMessageId === id) {
        setEditingMessageId(null);
        setEditingText('');
      }
    },
    [upsertActiveThread, editingMessageId],
  );

  // Delete grouped messages by batchId
  const deleteMessageGroup = useCallback(
    (batchId: string) => {
      setMessages(prev => prev.filter(m => m.batchId !== batchId));
      upsertActiveThread(thread => ({
        ...thread,
        updatedAt: Date.now(),
        messages: thread.messages.filter(m => m.batchId !== batchId),
      }));
      if (editingMessageId) {
        const stillEditingDeleted = messages.find(m => m.id === editingMessageId)?.batchId === batchId;
        if (stillEditingDeleted) {
          setEditingMessageId(null);
          setEditingText('');
        }
      }
    },
    [upsertActiveThread, editingMessageId, messages],
  );

  // Regenerate assistant text message via API
  const regenerateAssistantMessage = useCallback(
    (id: string) => {
      const key = apiKeyInput.trim();
      if (!key) {
        const newContent = t.missingKey;
        setMessages(prev =>
          prev.map(m =>
            m.id === id && m.role === 'assistant' && m.type === 'text' ? { ...m, content: newContent } : m,
          ),
        );
        upsertActiveThread(thread => ({
          ...thread,
          updatedAt: Date.now(),
          messages: thread.messages.map(m =>
            m.id === id && m.role === 'assistant' && m.type === 'text' ? { ...m, content: newContent } : m,
          ),
        }));
        return;
      }
      const model =
        (lastRequestRef.current?.model as string | undefined) ?? (llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini');
      const historyInput = buildHistoryInputItemsBeforeMessage(id, 5);
      let inputPayload: unknown = null;
      if (historyInput.length > 0) inputPayload = historyInput;
      else if (lastRequestRef.current?.inputPayload) inputPayload = lastRequestRef.current.inputPayload;
      else inputPayload = uiLocale === 'ru' ? 'Перегенерируй предыдущий ответ' : 'Regenerate previous answer';

      // Only include previous_response_id when regenerating the most recent assistant message
      const targetIdx = messages.findIndex(m => m.id === id);
      const isLatestTarget = targetIdx === messages.length - 1;

      // Reset the target assistant message content before streaming
      setMessages(prev => prev.map(m => (m.id === id && m.type === 'text' ? { ...m, content: '' } : m)));
      upsertActiveThread(thread => ({
        ...thread,
        updatedAt: Date.now(),
        messages: thread.messages.map(m => (m.id === id && m.type === 'text' ? { ...m, content: '' } : m)),
      }));
      setIsStreaming(true);
      setStreamingMessageId(id);

      const regenTools: Array<{ type: 'web_search' }> = [];
      if (webAccessEnabled) regenTools.push({ type: 'web_search' });

      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: inputPayload,
            text: { format: { type: 'text' } },
            ...(regenTools.length > 0 ? { tools: regenTools } : {}),
            ...(regenTools.length > 0 ? { tool_choice: 'auto' as const } : {}),
            ...(isLatestTarget && lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
          },
        },
        {
          onDelta: chunk => {
            setMessages(prev =>
              prev.map(m => (m.id === id && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m)),
            );
            upsertActiveThread(thread => ({
              ...thread,
              messages: thread.messages.map(m =>
                m.id === id && m.type === 'text' ? { ...m, content: (m.content ?? '') + chunk } : m,
              ),
            }));
          },
          onDone: final => {
            if (final && typeof final.id === 'string') lastResponseIdRef.current = final.id;
            const citations = final ? extractCitationsFromOutput(final.output) : [];
            if (citations.length > 0) {
              const suffix =
                '\n\n' +
                (uiLocale === 'ru' ? 'Источники:' : 'Sources:') +
                '\n' +
                citations
                  .slice(0, 8)
                  .map(c => `- ${c.title ? `[${c.title}](${c.url})` : c.url}`)
                  .join('\n');
              setMessages(prev =>
                prev.map(m => (m.id === id && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m)),
              );
              upsertActiveThread(thread => ({
                ...thread,
                updatedAt: Date.now(),
                messages: thread.messages.map(m =>
                  m.id === id && m.type === 'text' ? { ...m, content: (m.content ?? '') + suffix } : m,
                ),
              }));
            } else {
              upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
            }
            setIsStreaming(false);
            setStreamingMessageId(null);
          },
          onError: () => {
            const newContent = uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.';
            setMessages(prev => prev.map(m => (m.id === id && m.type === 'text' ? { ...m, content: newContent } : m)));
            upsertActiveThread(thread => ({
              ...thread,
              updatedAt: Date.now(),
              messages: thread.messages.map(m =>
                m.id === id && m.type === 'text' ? { ...m, content: newContent } : m,
              ),
            }));
            setIsStreaming(false);
            setStreamingMessageId(null);
          },
        },
      );
    },
    [
      apiKeyInput,
      llmModel,
      uiLocale,
      upsertActiveThread,
      t.missingKey,
      webAccessEnabled,
      buildHistoryInputItemsBeforeMessage,
      messages,
    ],
  );

  // Start editing a user text message
  const startEditMessage = useCallback(
    (id: string) => {
      const msg = messages.find(m => m.id === id);
      if (!msg || msg.role !== 'user' || msg.type !== 'text') return;
      setEditingMessageId(id);
      setEditingText(msg.content);
    },
    [messages],
  );

  // Cancel message editing
  const cancelEditMessage = useCallback(() => {
    setEditingMessageId(null);
    setEditingText('');
  }, []);

  // Save edited message content
  const saveEditMessage = useCallback(() => {
    if (!editingMessageId) return;
    const trimmed = editingText.trim();
    setMessages(prev =>
      prev.map(m =>
        m.id === editingMessageId && m.role === 'user' && m.type === 'text' ? { ...m, content: trimmed } : m,
      ),
    );
    upsertActiveThread(thread => ({
      ...thread,
      updatedAt: Date.now(),
      messages: thread.messages.map(m =>
        m.id === editingMessageId && m.role === 'user' && m.type === 'text' ? { ...m, content: trimmed } : m,
      ),
    }));
    setEditingMessageId(null);
    setEditingText('');
  }, [editingMessageId, editingText, upsertActiveThread]);

  // Delete thread with confirmation
  const deleteThread = useCallback(
    (id: string) => {
      const ok = window.confirm(uiLocale === 'ru' ? t.confirmDeleteChat : t.confirmDeleteChat);
      if (!ok) return;
      setThreads(prev => prev.filter(th => th.id !== id));
      if (activeId === id) {
        // Switch to another thread or create new
        const remaining = threads.filter(th => th.id !== id);
        if (remaining.length > 0) {
          const nextId = remaining[0].id;
          setActiveId(nextId);
          const next = remaining.find(th => th.id === nextId)!;
          setMessages(next.messages);
        } else {
          const nid = `chat-${Date.now()}`;
          const thread: ChatThread = {
            id: nid,
            title: uiLocale === 'ru' ? 'Новый чат' : 'New chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [initialAssistant],
          };
          setThreads([thread]);
          setActiveId(nid);
          setMessages(thread.messages);
        }
      }
    },
    [activeId, threads, uiLocale, t],
  );

  // Build render blocks (group consecutive messages by batchId)
  const renderBlocks = useMemo(() => {
    const blocks: Array<
      | { kind: 'single'; item: ChatMessage }
      | { kind: 'group'; batchId: string; role: 'user' | 'assistant'; items: ChatMessage[] }
    > = [];
    for (let i = 0; i < messages.length; ) {
      const m = messages[i];
      if (m.batchId) {
        const bid = m.batchId;
        const role = m.role;
        const items: ChatMessage[] = [];
        let j = i;
        while (j < messages.length && messages[j].batchId === bid) {
          items.push(messages[j]);
          j++;
        }
        blocks.push({ kind: 'group', batchId: bid, role, items });
        i = j;
      } else {
        blocks.push({ kind: 'single', item: m });
        i += 1;
      }
    }
    return blocks;
  }, [messages]);

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

  // Paste files/images into composer (Ask AI)
  const onComposerPaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const dt = event.clipboardData;
    if (!dt) return;
    let files: File[] = Array.from(dt.files || []);
    if (files.length === 0 && dt.items) {
      files = Array.from(dt.items)
        .map(i => (i.kind === 'file' ? i.getAsFile() : null))
        .filter((f): f is File => Boolean(f));
    }
    if (files.length === 0) return;

    // prevent inserting binary garbage into textarea
    event.preventDefault();

    const genericFiles: File[] = [];
    const imageFiles: File[] = [];
    for (const f of files) {
      if (f.type.startsWith('image/')) {
        imageFiles.push(f);
      } else if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) {
        genericFiles.push(f);
      }
    }

    if (genericFiles.length > 0) {
      const baseTime = Date.now();
      setAttachments(prev => {
        const newItems = genericFiles.map((f, idx) => {
          const id = `${baseTime}-${prev.length + idx}`;
          attachmentFileMapRef.current[id] = f;
          return {
            id,
            kind: 'file' as const,
            name: f.name,
            size: f.size,
            mime: 'application/pdf',
          };
        });
        return [...prev, ...newItems];
      });
    }

    for (const img of imageFiles) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? '');
        setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image' as const, dataUrl }]);
      };
      reader.readAsDataURL(img);
    }
  }, []);

  // Tooltip positioning within viewport
  const repositionTooltip = useCallback((container: HTMLElement) => {
    const tooltip = container.querySelector('[data-tooltip="true"]') as HTMLElement | null;
    if (!tooltip) return;
    // Reset to default center first
    tooltip.style.transform = '';
    window.requestAnimationFrame(() => {
      const rect = tooltip.getBoundingClientRect();
      const margin = 8;
      let shift = 0;
      if (rect.left < margin) {
        shift = margin - rect.left;
      } else if (rect.right > window.innerWidth - margin) {
        shift = window.innerWidth - margin - rect.right;
      }
      tooltip.style.transform = shift !== 0 ? `translateX(calc(-50% + ${shift}px))` : '';
    });
  }, []);

  const onTooltipEnter = useCallback(
    (e: React.MouseEvent<HTMLSpanElement> | React.FocusEvent<HTMLSpanElement>) => {
      repositionTooltip(e.currentTarget as unknown as HTMLElement);
    },
    [repositionTooltip],
  );

  const onTooltipLeave = useCallback((e: React.MouseEvent<HTMLSpanElement> | React.FocusEvent<HTMLSpanElement>) => {
    const tooltip = (e.currentTarget as unknown as HTMLElement).querySelector(
      '[data-tooltip="true"]',
    ) as HTMLElement | null;
    if (tooltip) tooltip.style.transform = '';
  }, []);

  return (
    <div className={cn('App', 'text-left', isLight ? 'bg-slate-50' : 'bg-gray-800')}>
      <div className={cn('relative flex h-full flex-col', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 px-3 py-2 dark:border-slate-700">
          <div className="flex items-center gap-2">
            <div className="text-base font-semibold">{headerTitle}</div>
            {mode === 'ask' && !apiKeyInput.trim() && <div className="text-xs opacity-70">{t.uiOnly}</div>}
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

            {/* API Key button */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setApiKeyOpen(false);
              }}>
              <button
                onClick={() => setApiKeyOpen(v => !v)}
                title={t.apiKey}
                aria-label={t.apiKey}
                aria-haspopup="dialog"
                aria-expanded={apiKeyOpen}
                className={cn(
                  'group relative inline-flex h-8 w-8 items-center justify-center rounded-md border text-base transition-colors',
                  isLight
                    ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                    : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                )}>
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
                  <path d="M21 10v6a2 2 0 0 1-2 2H7l-4 4V6a2 2 0 0 1 2-2h8" />
                  <path d="M15 3h6v6" />
                  <path d="M10 14l11-11" />
                </svg>
                <span
                  className={cn(
                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-xs opacity-0 transition-opacity',
                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                    'group-hover:opacity-100 group-focus-visible:opacity-100',
                  )}>
                  {t.apiKey}
                </span>
              </button>
              {apiKeyOpen && (
                <div
                  className={cn(
                    'absolute right-0 z-20 mt-2 w-72 overflow-hidden rounded-md border p-3 text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  <div className="mb-2 font-medium">{t.setApiKey}</div>
                  <input
                    type="password"
                    value={apiKeyInput}
                    onChange={e => setApiKeyInput(e.target.value)}
                    placeholder={t.enterApiKey}
                    className={cn(
                      'mb-2 w-full rounded border px-2 py-1',
                      isLight ? 'border-slate-300 bg-white' : 'border-slate-600 bg-slate-700',
                    )}
                  />
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => {
                        setApiKeyOpen(false);
                        const key = apiKeyInput.trim();
                        setApiKeyMasked(key ? `${key.slice(0, 3)}••••${key.slice(-4)}` : '');
                      }}
                      className={cn(
                        'rounded px-3 py-1 text-sm',
                        isLight
                          ? 'bg-violet-600 text-white hover:bg-violet-700'
                          : 'bg-violet-600 text-white hover:bg-violet-500',
                      )}
                      aria-label={t.save}
                      title={t.save}>
                      {t.save}
                    </button>
                    <button
                      onClick={() => {
                        setApiKeyInput('');
                        setApiKeyMasked('');
                      }}
                      className={cn(
                        'rounded px-3 py-1 text-sm',
                        isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                      )}
                      aria-label={t.clear}
                      title={t.clear}>
                      {t.clear}
                    </button>
                    <div className="ml-auto text-xs opacity-70">{apiKeyMasked || t.missingKey}</div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main content area: chat + external right sidebar */}
        <div className="relative flex h-full min-h-0">
          {/* Scrollable content area */}
          <div
            ref={messagesContainerRef}
            className={cn(
              'h-full min-h-0 flex-1 overflow-y-auto overscroll-none px-3 py-3',
              isLight ? 'bg-slate-50' : 'bg-gray-800',
            )}>
            {mode === 'ask' ? (
              <div className="flex flex-col gap-3">
                {renderBlocks.map(block => {
                  if (block.kind === 'single') {
                    const m = block.item;
                    return (
                      <div key={m.id} className="group">
                        <div
                          className={cn('flex items-start gap-2', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                          {m.role === 'assistant' && <BotAvatar />}
                          {m.type === 'text' ? (
                            <div
                              className={cn(
                                'max-w-[90%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-left shadow-sm',
                                m.role === 'user'
                                  ? 'bg-violet-600 text-white'
                                  : isLight
                                    ? 'bg-white text-gray-900 ring-1 ring-black/5'
                                    : 'bg-slate-700 text-gray-100 ring-1 ring-white/10',
                              )}>
                              {editingMessageId === m.id && m.role === 'user' ? (
                                <textarea
                                  value={editingText}
                                  onChange={e => setEditingText(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter' && !e.shiftKey) {
                                      e.preventDefault();
                                      saveEditMessage();
                                    } else if (e.key === 'Escape') {
                                      e.preventDefault();
                                      cancelEditMessage();
                                    }
                                  }}
                                  rows={Math.min(10, Math.max(3, editingText.split('\n').length))}
                                  className={cn(
                                    'w-full resize-y rounded-md bg-transparent outline-none placeholder:opacity-60',
                                    m.role === 'user' ? 'text-white' : undefined,
                                  )}
                                  ref={editingTextareaRef}
                                />
                              ) : (
                                <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                                  {normalizeMathDelimiters(m.content)}
                                </ReactMarkdown>
                              )}
                              {isStreaming && streamingMessageId === m.id && (
                                <div className="mt-2 flex items-center gap-2 text-xs opacity-70">
                                  <svg
                                    aria-hidden="true"
                                    className="h-4 w-4 animate-spin"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round">
                                    <circle
                                      cx="12"
                                      cy="12"
                                      r="9"
                                      className={cn(isLight ? 'text-slate-300' : 'text-slate-500')}
                                    />
                                    <path
                                      d="M21 12a9 9 0 0 0-9-9"
                                      className={cn(isLight ? 'text-violet-600' : 'text-violet-400')}
                                    />
                                  </svg>
                                  <span>{uiLocale === 'ru' ? 'Генерирую…' : 'Generating…'}</span>
                                </div>
                              )}
                            </div>
                          ) : m.type === 'image' ? (
                            <div
                              className={cn(
                                'max-w-[90%] overflow-hidden rounded-2xl shadow-sm ring-1',
                                isLight ? 'ring-black/5' : 'ring-white/10',
                              )}>
                              <img src={m.dataUrl} alt="screenshot" className="block max-w-full" />
                            </div>
                          ) : (
                            <div
                              className={cn(
                                'max-w-[90%] rounded-2xl shadow-sm ring-1',
                                isLight
                                  ? 'bg-white text-gray-900 ring-black/5'
                                  : 'bg-slate-700 text-gray-100 ring-white/10',
                              )}>
                              <div className="flex items-center gap-2 px-3 py-2 text-sm">
                                <span>📎</span>
                                <span className="font-medium">{m.name}</span>
                                <span className="opacity-60">({Math.ceil(m.size / 1024)} KB)</span>
                              </div>
                            </div>
                          )}
                          {m.role === 'user' && <UserAvatar />}
                        </div>
                        <div
                          className={cn(
                            'mt-1 flex items-center gap-2 text-xs',
                            m.role === 'user' ? 'justify-end' : 'justify-start',
                          )}>
                          {m.role === 'assistant' && m.type === 'text' && (
                            <>
                              <span
                                className="group/regenerate relative inline-block"
                                onMouseEnter={onTooltipEnter}
                                onFocus={onTooltipEnter}
                                onMouseLeave={onTooltipLeave}
                                onBlur={onTooltipLeave}>
                                <button
                                  onClick={() => regenerateAssistantMessage(m.id)}
                                  className={cn(
                                    'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                    isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                  )}
                                  title={t.write_regenerate}
                                  aria-label={t.write_regenerate}>
                                  ↻
                                </button>
                                <span
                                  className={cn(
                                    'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                    'group-focus-within/regenerate:opacity-100 group-hover/regenerate:opacity-100',
                                  )}
                                  data-tooltip="true">
                                  {t.write_regenerate}
                                </span>
                              </span>
                              <span
                                className="group/copy relative inline-block"
                                onMouseEnter={onTooltipEnter}
                                onFocus={onTooltipEnter}
                                onMouseLeave={onTooltipLeave}
                                onBlur={onTooltipLeave}>
                                <button
                                  onClick={() => copyText(m.content)}
                                  className={cn(
                                    'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                    isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                  )}
                                  title={t.write_copy}
                                  aria-label={t.write_copy}>
                                  <svg
                                    aria-hidden="true"
                                    width="16"
                                    height="16"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    strokeLinecap="round"
                                    strokeLinejoin="round">
                                    <rect x="9" y="9" width="13" height="13" rx="2" />
                                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                  </svg>
                                </button>
                                <span
                                  className={cn(
                                    'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                    'group-focus-within/copy:opacity-100 group-hover/copy:opacity-100',
                                  )}
                                  data-tooltip="true">
                                  {t.write_copy}
                                </span>
                              </span>
                            </>
                          )}
                          {m.role === 'user' &&
                            m.type === 'text' &&
                            (editingMessageId === m.id ? (
                              <>
                                <span
                                  className="group/save relative inline-block"
                                  onMouseEnter={onTooltipEnter}
                                  onFocus={onTooltipEnter}
                                  onMouseLeave={onTooltipLeave}
                                  onBlur={onTooltipLeave}>
                                  <button
                                    onClick={saveEditMessage}
                                    className={cn(
                                      'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                      isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                    )}
                                    title={t.save}
                                    aria-label={t.save}>
                                    {t.save}
                                  </button>
                                  <span
                                    className={cn(
                                      'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                      isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                      'group-focus-within/save:opacity-100 group-hover/save:opacity-100',
                                    )}
                                    data-tooltip="true">
                                    {t.save}
                                  </span>
                                </span>
                                <span
                                  className="group/cancel relative inline-block"
                                  onMouseEnter={onTooltipEnter}
                                  onFocus={onTooltipEnter}
                                  onMouseLeave={onTooltipLeave}
                                  onBlur={onTooltipLeave}>
                                  <button
                                    onClick={cancelEditMessage}
                                    className={cn(
                                      'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                      isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                    )}
                                    title={t.cancel}
                                    aria-label={t.cancel}>
                                    {t.cancel}
                                  </button>
                                  <span
                                    className={cn(
                                      'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                      isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                      'group-focus-within/cancel:opacity-100 group-hover/cancel:opacity-100',
                                    )}
                                    data-tooltip="true">
                                    {t.cancel}
                                  </span>
                                </span>
                              </>
                            ) : (
                              <span
                                className="group/edit relative inline-block"
                                onMouseEnter={onTooltipEnter}
                                onFocus={onTooltipEnter}
                                onMouseLeave={onTooltipLeave}
                                onBlur={onTooltipLeave}>
                                <button
                                  onClick={() => startEditMessage(m.id)}
                                  className={cn(
                                    'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                    isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                  )}
                                  title={t.edit}
                                  aria-label={t.edit}>
                                  ✎
                                </button>
                                <span
                                  className={cn(
                                    'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                    'group-focus-within/edit:opacity-100 group-hover/edit:opacity-100',
                                  )}
                                  data-tooltip="true">
                                  {t.edit}
                                </span>
                              </span>
                            ))}
                          <span
                            className="group/delete relative inline-block"
                            onMouseEnter={onTooltipEnter}
                            onFocus={onTooltipEnter}
                            onMouseLeave={onTooltipLeave}
                            onBlur={onTooltipLeave}>
                            <button
                              onClick={() => deleteMessage(m.id)}
                              className={cn(
                                'rounded-md p-1 text-gray-400 transition-colors',
                                isLight
                                  ? 'hover:bg-slate-200 hover:text-red-600'
                                  : 'hover:bg-slate-700 hover:text-red-600',
                              )}
                              title={t.delete}
                              aria-label={t.delete}>
                              <svg
                                aria-hidden="true"
                                width="16"
                                height="16"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round">
                                <path d="M3 6h18" />
                                <path d="M8 6V4h8v2" />
                                <path d="M19 6l-1 14H6L5 6" />
                                <path d="M10 11v6" />
                                <path d="M14 11v6" />
                              </svg>
                            </button>
                            <span
                              className={cn(
                                'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                'group-focus-within/delete:opacity-100 group-hover/delete:opacity-100',
                              )}
                              data-tooltip="true">
                              {t.delete}
                            </span>
                          </span>
                        </div>
                      </div>
                    );
                  }
                  // group
                  const role = block.role;
                  return (
                    <div key={`g-${block.batchId}`} className="group">
                      <div className={cn('flex items-start gap-2', role === 'user' ? 'justify-end' : 'justify-start')}>
                        {role === 'assistant' && <BotAvatar />}
                        <div className="flex max-w-[90%] flex-col gap-2">
                          {block.items.map(it =>
                            it.type === 'text' ? (
                              <div
                                key={it.id}
                                className={cn(
                                  'whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-left shadow-sm',
                                  role === 'user'
                                    ? 'bg-violet-600 text-white'
                                    : isLight
                                      ? 'bg-white text-gray-900 ring-1 ring-black/5'
                                      : 'bg-slate-700 text-gray-100 ring-1 ring-white/10',
                                )}>
                                {editingMessageId === it.id && role === 'user' ? (
                                  <textarea
                                    value={editingText}
                                    onChange={e => setEditingText(e.target.value)}
                                    onKeyDown={e => {
                                      if (e.key === 'Enter' && !e.shiftKey) {
                                        e.preventDefault();
                                        saveEditMessage();
                                      } else if (e.key === 'Escape') {
                                        e.preventDefault();
                                        cancelEditMessage();
                                      }
                                    }}
                                    rows={Math.min(10, Math.max(3, editingText.split('\n').length))}
                                    className={cn(
                                      'w-full resize-y rounded-md bg-transparent outline-none placeholder:opacity-60',
                                      role === 'user' ? 'text-white' : undefined,
                                    )}
                                    ref={editingTextareaRef}
                                  />
                                ) : (
                                  <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                                    {normalizeMathDelimiters(it.content)}
                                  </ReactMarkdown>
                                )}
                                {isStreaming && streamingMessageId === it.id && (
                                  <div className="mt-2 flex items-center gap-2 text-xs opacity-70">
                                    <svg
                                      aria-hidden="true"
                                      className="h-4 w-4 animate-spin"
                                      viewBox="0 0 24 24"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="2"
                                      strokeLinecap="round"
                                      strokeLinejoin="round">
                                      <circle
                                        cx="12"
                                        cy="12"
                                        r="9"
                                        className={cn(isLight ? 'text-slate-300' : 'text-slate-500')}
                                      />
                                      <path
                                        d="M21 12a9 9 0 0 0-9-9"
                                        className={cn(isLight ? 'text-violet-600' : 'text-violet-400')}
                                      />
                                    </svg>
                                    <span>{uiLocale === 'ru' ? 'Генерирую…' : 'Generating…'}</span>
                                  </div>
                                )}
                              </div>
                            ) : it.type === 'image' ? (
                              <div
                                key={it.id}
                                className={cn(
                                  'overflow-hidden rounded-2xl shadow-sm ring-1',
                                  isLight ? 'bg-white ring-black/5' : 'bg-slate-700 ring-white/10',
                                )}>
                                <img src={it.dataUrl} alt="screenshot" className="block max-w-full" />
                              </div>
                            ) : (
                              <div
                                key={it.id}
                                className={cn(
                                  'rounded-2xl shadow-sm ring-1',
                                  isLight
                                    ? 'bg-white text-gray-900 ring-black/5'
                                    : 'bg-slate-700 text-gray-100 ring-white/10',
                                )}>
                                <div className="flex items-center gap-2 px-3 py-2 text-sm">
                                  <span>📎</span>
                                  <span className="font-medium">{it.name}</span>
                                  <span className="opacity-60">({Math.ceil(it.size / 1024)} KB)</span>
                                </div>
                              </div>
                            ),
                          )}
                        </div>
                        {role === 'user' && <UserAvatar />}
                      </div>
                      <div
                        className={cn(
                          'mt-1 flex items-center gap-2 text-xs',
                          role === 'user' ? 'justify-end' : 'justify-start',
                        )}>
                        {role === 'user' &&
                          (editingMessageId && block.items.some(it => it.id === editingMessageId) ? (
                            <>
                              <button
                                onClick={saveEditMessage}
                                className={cn(
                                  'group/edit relative rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                  isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                )}
                                title={t.save}
                                aria-label={t.save}>
                                {t.save}
                                <span
                                  className={cn(
                                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                    'group-hover/edit:opacity-100 group-focus-visible/edit:opacity-100',
                                  )}>
                                  {t.save}
                                </span>
                              </button>
                              <button
                                onClick={cancelEditMessage}
                                className={cn(
                                  'group relative rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                  isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                )}
                                title={t.cancel}
                                aria-label={t.cancel}>
                                {t.cancel}
                                <span
                                  className={cn(
                                    'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                    isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                    'group-hover:opacity-100 group-focus-visible:opacity-100',
                                  )}>
                                  {t.cancel}
                                </span>
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                // Prefer edit the first text item within group
                                const firstText = block.items.find(x => x.type === 'text');
                                if (firstText) startEditMessage(firstText.id);
                              }}
                              className={cn(
                                'group relative rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                              )}
                              title={t.edit}
                              aria-label={t.edit}>
                              ✎
                              <span
                                className={cn(
                                  'pointer-events-none absolute -top-8 left-1/2 -translate-x-1/2 whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                                  isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                                  'group-hover:opacity-100 group-focus-visible:opacity-100',
                                )}>
                                {t.edit}
                              </span>
                            </button>
                          ))}
                        <span
                          className="group/delete relative inline-block"
                          onMouseEnter={onTooltipEnter}
                          onFocus={onTooltipEnter}
                          onMouseLeave={onTooltipLeave}
                          onBlur={onTooltipLeave}>
                          <button
                            onClick={() => deleteMessageGroup(block.batchId)}
                            className={cn(
                              'rounded-md p-1 text-gray-400 transition-colors',
                              isLight
                                ? 'hover:bg-slate-200 hover:text-red-600'
                                : 'hover:bg-slate-700 hover:text-red-600',
                            )}
                            title={t.delete}
                            aria-label={t.delete}>
                            <svg
                              aria-hidden="true"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </button>
                          <span
                            className={cn(
                              'pointer-events-none absolute -top-8 left-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 overflow-hidden whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                              isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                              'group-focus-within/delete:opacity-100 group-hover/delete:opacity-100',
                            )}
                            data-tooltip="true">
                            {t.delete}
                          </span>
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : mode === 'read' ? (
              <div className="mx-auto w-full max-w-xl">
                {/* Drop zone */}
                <div
                  role="button"
                  tabIndex={0}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') onReadBrowse();
                  }}
                  onClick={onReadBrowse}
                  onDrop={onReadDrop}
                  onDragOver={onReadDragOver}
                  onDragEnter={onReadDragEnter}
                  onDragLeave={onReadDragLeave}
                  className={cn(
                    'mb-6 rounded-xl border-2 border-dashed p-8 text-center transition-colors',
                    isLight
                      ? readDragging
                        ? 'border-violet-500 bg-violet-50'
                        : 'border-slate-400 bg-slate-100'
                      : readDragging
                        ? 'border-violet-400 bg-violet-900/20'
                        : 'border-slate-600 bg-slate-800',
                  )}>
                  <div className="mb-3 flex justify-center">
                    <div
                      className={cn(
                        'grid h-16 w-16 place-items-center rounded-lg',
                        isLight ? 'bg-white' : 'bg-slate-700',
                      )}>
                      <span className="text-2xl">📄</span>
                    </div>
                  </div>
                  <div className="mb-2 text-lg font-medium">{t.read_drop_title}</div>
                  <div className="text-sm opacity-70">{t.read_drop_sub1}</div>
                  <div className="text-sm opacity-70">{t.read_drop_sub2}</div>
                  <input
                    ref={readFileInputRef}
                    type="file"
                    accept="application/pdf"
                    multiple
                    className="hidden"
                    onChange={onReadInputChange}
                  />
                </div>

                {/* Recent files */}
                <div className="mb-2 text-lg font-semibold">{t.read_recent}</div>
                <div className="flex flex-col gap-3">
                  {readFiles.length === 0 ? (
                    <div className="text-sm opacity-60">—</div>
                  ) : (
                    readFiles.map(item => (
                      <div
                        key={item.id}
                        draggable
                        onDragStart={e => {
                          e.dataTransfer.setData('application/x-read-file-id', item.id);
                          e.dataTransfer.effectAllowed = 'copy';
                        }}
                        className={cn(
                          'flex items-center gap-3 rounded-xl px-3 py-3 ring-1',
                          isLight ? 'bg-white ring-black/10' : 'bg-slate-800 ring-white/10',
                          readActiveId === item.id ? 'outline outline-2 outline-violet-500' : undefined,
                        )}>
                        <div className="grid h-10 w-10 place-items-center rounded-md bg-red-600 text-white">PDF</div>
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-medium">{item.name}</div>
                          <div className="text-xs opacity-70">{(item.size / 1024 / 1024).toFixed(2)}MB</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => openPdf(item)}
                            className={cn(
                              'rounded-md px-3 py-1 text-sm font-medium',
                              isLight
                                ? 'bg-violet-600 text-white hover:bg-violet-700'
                                : 'bg-violet-600 text-white hover:bg-violet-500',
                            )}
                            aria-label={t.read_view}
                            title={t.read_view}>
                            {t.read_view}
                          </button>
                          <button
                            onClick={() => deletePdf(item.id)}
                            className={cn(
                              'rounded-md p-2 text-gray-400 transition-colors',
                              isLight
                                ? 'hover:bg-slate-200 hover:text-red-600'
                                : 'hover:bg-slate-700 hover:text-red-600',
                            )}
                            aria-label={t.read_delete}
                            title={t.read_delete}>
                            <svg
                              aria-hidden="true"
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round">
                              <path d="M3 6h18" />
                              <path d="M8 6V4h8v2" />
                              <path d="M19 6l-1 14H6L5 6" />
                              <path d="M10 11v6" />
                              <path d="M14 11v6" />
                            </svg>
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl">
                {/* Write tabs */}
                <div className="mb-3 flex items-center gap-4">
                  {(
                    [
                      ['compose', t.write_compose],
                      ['revise', t.write_revise],
                      ['grammar', t.write_grammar],
                      ['paraphrase', t.write_paraphrase],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => setWriteTab(key)}
                      aria-pressed={writeTab === key}
                      className={cn(
                        'border-b-2 px-1 pb-1 text-sm font-semibold',
                        writeTab === key
                          ? 'border-violet-500 text-violet-500'
                          : 'border-transparent text-gray-400 hover:text-gray-600 dark:hover:text-gray-200',
                      )}
                      title={label}
                      aria-label={label}>
                      {label}
                    </button>
                  ))}
                </div>

                {writeTab === 'compose' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeComposeInput}
                      onChange={e => setWriteComposeInput(e.target.value)}
                      placeholder="Topic or brief..."
                      rows={4}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800',
                      )}
                    />

                    {/* Format */}
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_format}</div>
                      <div className="flex flex-wrap gap-2">
                        {(['auto', 'essay', 'article', 'email', 'message', 'comment', 'blog'] as const).map(x => (
                          <button
                            key={x}
                            onClick={() => setWriteFormat(x)}
                            aria-pressed={writeFormat === x}
                            className={cn(
                              'rounded-full px-3 py-1 text-sm',
                              writeFormat === x
                                ? 'bg-violet-600 text-white'
                                : isLight
                                  ? 'bg-slate-200 text-gray-900 hover:bg-slate-300'
                                  : 'bg-slate-700 text-gray-100 hover:bg-slate-600',
                            )}>
                            {t[`chip_${x}` as const]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Tone */}
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_tone}</div>
                      <div className="flex flex-wrap gap-2">
                        {(['auto', 'formal', 'professional', 'funny', 'casual'] as const).map(x => (
                          <button
                            key={x}
                            onClick={() => setWriteTone(x)}
                            aria-pressed={writeTone === x}
                            className={cn(
                              'rounded-full px-3 py-1 text-sm',
                              writeTone === x
                                ? 'bg-violet-600 text-white'
                                : isLight
                                  ? 'bg-slate-200 text-gray-900 hover:bg-slate-300'
                                  : 'bg-slate-700 text-gray-100 hover:bg-slate-600',
                            )}>
                            {t[`chip_${x}` as const]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Length */}
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_length}</div>
                      <div className="flex flex-wrap gap-2">
                        {(['auto', 'short', 'medium', 'long'] as const).map(x => (
                          <button
                            key={x}
                            onClick={() => setWriteLength(x)}
                            aria-pressed={writeLength === x}
                            className={cn(
                              'rounded-full px-3 py-1 text-sm',
                              writeLength === x
                                ? 'bg-violet-600 text-white'
                                : isLight
                                  ? 'bg-slate-200 text-gray-900 hover:bg-slate-300'
                                  : 'bg-slate-700 text-gray-100 hover:bg-slate-600',
                            )}>
                            {t[`chip_${x}` as const]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Language + SuperAI */}
                    <div className="flex items-center gap-4">
                      <div>
                        <div className="mb-1 text-sm font-semibold">{t.write_language}</div>
                        <div className="inline-flex items-center gap-2">
                          <span
                            className={cn('rounded-full px-3 py-1 text-sm', isLight ? 'bg-slate-200' : 'bg-slate-700')}>
                            {writeLanguage}
                          </span>
                          <button
                            onClick={() => setWriteLanguage(writeLanguage === 'English' ? 'English' : 'English')}
                            className={cn(
                              'rounded px-2 py-1 text-sm',
                              isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                            )}>
                            …
                          </button>
                        </div>
                      </div>
                      <div className="ml-auto inline-flex items-center gap-2">
                        <span className="text-sm opacity-80">{t.superAI}</span>
                        <button
                          onClick={() => setWriteSuper(v => !v)}
                          aria-pressed={writeSuper}
                          className={cn(
                            'h-6 w-10 rounded-full border transition-colors',
                            writeSuper
                              ? 'border-violet-500 bg-violet-600'
                              : isLight
                                ? 'border-slate-300 bg-slate-200'
                                : 'border-slate-600 bg-slate-700',
                          )}
                          title={t.superAI}
                          aria-label={t.superAI}
                        />
                      </div>
                    </div>

                    <div className="pt-2">
                      <button
                        onClick={generateCompose}
                        className={cn(
                          'w-full rounded-xl px-4 py-3 text-center text-sm font-semibold',
                          isLight
                            ? 'bg-violet-600 text-white hover:bg-violet-700'
                            : 'bg-violet-600 text-white hover:bg-violet-500',
                        )}>
                        {t.write_generate}
                      </button>
                    </div>

                    <div className="pt-2">
                      <div className="mb-2 text-sm font-semibold">{t.write_result}</div>
                      <div
                        className={cn(
                          'min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {writeComposeResult}
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          onClick={generateCompose}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_regenerate}
                          title={t.write_regenerate}>
                          ↻
                        </button>
                        <button
                          onClick={() => copyText(writeComposeResult)}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_copy}
                          title={t.write_copy}>
                          <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'revise' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeReviseInput}
                      onChange={e => setWriteReviseInput(e.target.value)}
                      placeholder="Paste text to improve..."
                      rows={8}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800',
                      )}
                    />
                    <div className="flex items-center justify-between">
                      <div className="inline-flex items-center gap-2">
                        <span className="text-sm opacity-80">{t.superAI}</span>
                        <button
                          onClick={() => setWriteSuper(v => !v)}
                          aria-pressed={writeSuper}
                          className={cn(
                            'h-6 w-10 rounded-full border transition-colors',
                            writeSuper
                              ? 'border-violet-500 bg-violet-600'
                              : isLight
                                ? 'border-slate-300 bg-slate-200'
                                : 'border-slate-600 bg-slate-700',
                          )}
                          title={t.superAI}
                          aria-label={t.superAI}
                        />
                      </div>
                      <button
                        onClick={optimizeRevise}
                        className={cn(
                          'rounded-xl px-4 py-2 text-sm font-semibold',
                          isLight
                            ? 'bg-violet-600 text-white hover:bg-violet-700'
                            : 'bg-violet-600 text-white hover:bg-violet-500',
                        )}>
                        {t.write_ai_optimize}
                      </button>
                    </div>
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_result}</div>
                      <div
                        className={cn(
                          'min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {writeReviseResult}
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          onClick={optimizeRevise}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_regenerate}
                          title={t.write_regenerate}>
                          ↻
                        </button>
                        <button
                          onClick={() => copyText(writeReviseResult)}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_copy}
                          title={t.write_copy}>
                          <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'grammar' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeGrammarInput}
                      onChange={e => setWriteGrammarInput(e.target.value)}
                      placeholder="Paste text to check..."
                      rows={8}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800',
                      )}
                    />
                    <button
                      onClick={runGrammar}
                      className={cn(
                        'rounded-xl px-4 py-2 text-sm font-semibold',
                        isLight
                          ? 'bg-violet-600 text-white hover:bg-violet-700'
                          : 'bg-violet-600 text-white hover:bg-violet-500',
                      )}>
                      {t.write_grammar}
                    </button>
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_result}</div>
                      <div
                        className={cn(
                          'min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {writeGrammarResult}
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          onClick={runGrammar}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_regenerate}
                          title={t.write_regenerate}>
                          ↻
                        </button>
                        <button
                          onClick={() => copyText(writeGrammarResult)}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_copy}
                          title={t.write_copy}>
                          <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'paraphrase' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeParaphraseInput}
                      onChange={e => setWriteParaphraseInput(e.target.value)}
                      placeholder="Paste text to paraphrase..."
                      rows={8}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-slate-800',
                      )}
                    />
                    <button
                      onClick={runParaphrase}
                      className={cn(
                        'rounded-xl px-4 py-2 text-sm font-semibold',
                        isLight
                          ? 'bg-violet-600 text-white hover:bg-violet-700'
                          : 'bg-violet-600 text-white hover:bg-violet-500',
                      )}>
                      {t.write_paraphrase}
                    </button>
                    <div>
                      <div className="mb-2 text-sm font-semibold">{t.write_result}</div>
                      <div
                        className={cn(
                          'min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {writeParaphraseResult}
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <button
                          onClick={runParaphrase}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_regenerate}
                          title={t.write_regenerate}>
                          ↻
                        </button>
                        <button
                          onClick={() => copyText(writeParaphraseResult)}
                          className={cn(
                            'rounded-md px-3 py-2 text-sm',
                            isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                          )}
                          aria-label={t.write_copy}
                          title={t.write_copy}>
                          <svg
                            aria-hidden="true"
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round">
                            <rect x="9" y="9" width="13" height="13" rx="2" />
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                          </svg>
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* External right sidebar takes full height */}
          <RightToolbar />
        </div>

        {/* Tools row: show only in Ask mode */}
        {mode === 'ask' && (
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
                      isLight
                        ? 'border-slate-200 bg-white text-gray-900'
                        : 'border-slate-700 bg-slate-800 text-gray-100',
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
                      isLight
                        ? 'border-slate-200 bg-white text-gray-900'
                        : 'border-slate-700 bg-slate-800 text-gray-100',
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
              <input
                ref={fileInputRef}
                type="file"
                accept="application/pdf"
                multiple
                className="hidden"
                onChange={onFilesSelected}
              />
            </div>
          </div>
        )}

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
                          'items_center flex h-16 w-48 gap-2 truncate px-2 text-sm',
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
                      className="group/remove absolute right-0 top-0 m-1 hidden rounded bg-black/60 px-1 py-0.5 text-xs text-white group-hover:block"
                      aria-label={t.removeAttachment}
                      title={t.removeAttachment}>
                      ✕
                      <span
                        className={cn(
                          'pointer-events-none absolute -top-6 right-0 whitespace-nowrap rounded px-2 py-1 text-[10px] opacity-0 transition-opacity',
                          isLight ? 'bg-gray-900 text-white' : 'bg-white text-gray-900',
                          'group-hover/remove:opacity-100 group-focus-visible/remove:opacity-100',
                        )}>
                        {t.removeAttachment}
                      </span>
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
                onPaste={onComposerPaste}
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
                disabled={!canSend || isStreaming}
                className={cn(
                  'group absolute bottom-2 right-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-sm shadow-sm transition-colors',
                  canSend && !isStreaming
                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                    : 'bg-gray-400 text-white opacity-60',
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

      {/* (removed) full-screen streaming overlay */}

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
                  <div
                    key={th.id}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700',
                      activeId === th.id ? 'font-semibold' : undefined,
                    )}>
                    <button
                      onClick={() => {
                        activateThread(th.id);
                        setHistorySheetOpen(false);
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2 text-left">
                      <div className="flex-1 truncate">
                        <div className="truncate">{th.title || (uiLocale === 'ru' ? 'Без названия' : 'Untitled')}</div>
                      </div>
                      <div className="ml-2 whitespace-nowrap text-xs opacity-70">
                        {new Date(th.updatedAt).toLocaleString()}
                      </div>
                    </button>
                    <button
                      onClick={() => deleteThread(th.id)}
                      className={cn(
                        'rounded-md p-1 text-gray-400 transition-colors',
                        isLight ? 'hover:bg-slate-200 hover:text-red-600' : 'hover:bg-slate-700 hover:text-red-600',
                      )}
                      title={t.deleteChat}
                      aria-label={t.deleteChat}>
                      <svg
                        aria-hidden="true"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round">
                        <path d="M3 6h18" />
                        <path d="M8 6V4h8v2" />
                        <path d="M19 6l-1 14H6L5 6" />
                        <path d="M10 11v6" />
                        <path d="M14 11v6" />
                      </svg>
                    </button>
                  </div>
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
