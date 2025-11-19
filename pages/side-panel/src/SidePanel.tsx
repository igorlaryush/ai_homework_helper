import '@/SidePanel.css';
import 'katex/dist/katex.min.css';
import { Moon, Sun, History } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import OnboardingTour from './components/OnboardingTour';
import type { TourStep } from './components/OnboardingTour';
import { UI_I18N } from './i18n-data';
import type { UILocale } from './i18n-data';
import { MarkdownText } from '@/components/assistant-ui/markdown-text';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { useStorage, withErrorBoundary, withSuspense } from '@extension/shared';
import { exampleThemeStorage } from '@extension/storage';
import { cn, ErrorDisplay, LoadingSpinner, IconButton } from '@extension/ui';


const LOG_PREFIX = '[CEB][SidePanel]';

const StreamableMarkdown = ({
  text,
  streaming,
  forcePlain,
  className,
}: {
  text?: string;
  streaming: boolean;
  forcePlain?: boolean;
  className?: string;
}) => {
  const content = text ?? '';
  if (!content) return null;

  if (forcePlain) {
    return <div className={cn('whitespace-pre-wrap break-words', className)}>{content}</div>;
  }

  return (
    <MarkdownText className={cn('aui-md', className)} key={`${streaming ? 's:' : ''}${content}`}>
      {content}
    </MarkdownText>
  );
};


type ChatMessage =
  | { id: string; role: 'user' | 'assistant'; type: 'text'; content: string; batchId?: string; noRender?: boolean }
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

const isTextMessage = (m: ChatMessage): m is Extract<ChatMessage, { type: 'text' }> => m.type === 'text';

type ChatThread = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  lastResponseId?: string;
  // optional link to a PDF from Read section that this chat is about
  linkedPdfId?: string;
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

// Map UI locale to human-readable language name for clearer system instructions
const uiLocaleToLanguageName = (locale: string): string => {
  switch (locale) {
    case 'ru':
      return 'Russian';
    case 'uk':
      return 'Ukrainian';
    case 'de':
      return 'German';
    case 'fr':
      return 'French';
    case 'es':
      return 'Spanish';
    case 'pt':
      return 'Portuguese';
    case 'tr':
      return 'Turkish';
    case 'zh':
      return 'Chinese';
    case 'en':
    default:
      return 'English';
  }
};

// Build a general-purpose system prompt enforcing Markdown, UI language, and image handling
const buildSystemPromptMarkdown = (uiLocale: string): string => {
  const languageName = uiLocaleToLanguageName(uiLocale);
  return [
    'You are a helpful AI studying assistant.',
    'All of your responses must be formatted using Markdown.',
    `Default to responding in ${languageName}. If the user explicitly requests another language or later instructions specify one, follow that.`,
    'If the user provides images (e.g., screenshots), analyze them. If they contain questions or tasks, answer or solve them directly using the image content; otherwise briefly describe what is shown and ask clarifying questions if needed.',
    'If a task allows a short, direct answer (e.g., a number, date, or single term), first give the short answer clearly; then, on a new line, provide a concise, step-by-step explanation. If the instructions explicitly say to return only the result (e.g., "return only the corrected text"), do not add explanations.',
  ].join(' ');
};

const buildAskAiSystemPrompt = (uiLocale: string): string => {
  const languageName = uiLocaleToLanguageName(uiLocale);
  return `You are an AI Homework Helper. Your goal is to help students understand their assignments, not just to give them answers.

[CRITICAL RULE]

When a user asks a question, first determine if it can have a short, direct answer (like a number, date, or a single term).

- If YES: First, state the answer clearly. Then, on a new line, provide a detailed, step-by-step explanation of how to arrive at that answer.

- If NO (the question requires a detailed explanation): Provide the detailed explanation directly.

Always be encouraging and clear in your explanations.

[LANGUAGE]
Always respond in ${languageName} by default. If the user explicitly requests another language, follow their preference.

[IMAGES]
If the user includes any images (e.g., screenshots), first identify whether they contain questions or tasks. If they do, answer those questions or complete the task directly using the content of the image. If not, briefly describe the image and ask a clarifying question.`;
};

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
  { apiKey: _apiKey, body, signal }: { apiKey: string; body: Record<string, unknown>; signal?: AbortSignal },
  { onDelta, onDone, onError }: StreamCallbacks,
): Promise<void> => {
  // Mark unused when using backend proxy
  void _apiKey;
  try {
    const res = await fetch('https://chatgpt-proxy-500570371278.us-west2.run.app/v1/responses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({ ...body, stream: true }),
      signal,
    });
    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = await res.text();
      } catch {
        // ignore
      }
      // Fallback: on 5xx, retry without streaming (JSON response)
      if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
        try {
          const nonStream = await fetch('https://chatgpt-proxy-500570371278.us-west2.run.app/v1/responses', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({ ...body, stream: false }),
            signal,
          });
          if (nonStream.ok) {
            const json = (await nonStream.json()) as ResponsesResult;
            // Best-effort: emit full text to UI before completing
            try {
              const text =
                (json && typeof json.output_text === 'string' && json.output_text) ||
                (Array.isArray(json?.output)
                  ? json.output
                      .flatMap(item => (Array.isArray(item?.content) ? item.content : []))
                      .map((c: unknown) => {
                        const cc = c as { text?: string };
                        return typeof cc?.text === 'string' ? cc.text : '';
                      })
                      .filter(Boolean)
                      .join('')
                  : '');
              if (text) onDelta(text);
              console.log('[CEB][LLM] Final text:', text);
              console.log('[CEB][LLM] Full response:', json);
            } catch {
              // ignore
            }
            onDone(json);
            return;
          }
        } catch {
          // ignore and fallthrough to error
        }
      }
      onError({ status: res.status, body: bodyText });
      return;
    }
    if (!res.body) {
      // Fallback when stream body missing: try non-stream JSON once
      try {
        const nonStream = await fetch('https://chatgpt-proxy-500570371278.us-west2.run.app/v1/responses', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({ ...body, stream: false }),
          signal,
        });
        if (nonStream.ok) {
          const json = (await nonStream.json()) as ResponsesResult;
          try {
            const text =
              (json && typeof json.output_text === 'string' && json.output_text) ||
              (Array.isArray(json?.output)
                ? json.output
                    .flatMap(item => (Array.isArray(item?.content) ? item.content : []))
                    .map((c: unknown) => {
                      const cc = c as { text?: string };
                      return typeof cc?.text === 'string' ? cc.text : '';
                    })
                    .filter(Boolean)
                    .join('')
                : '');
            if (text) onDelta(text);
            console.log('[CEB][LLM] Final text:', text);
            console.log('[CEB][LLM] Full response:', json);
          } catch {
            // ignore
          }
          onDone(json);
          return;
        }
      } catch {
        // ignore
      }
      throw new Error('No response body');
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let finalResult: ResponsesResult | null = null;
    let accumulatedText = '';
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
            if (piece) {
              onDelta(piece);
              accumulatedText += piece;
            }
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
    if (accumulatedText) console.log('[CEB][LLM] Final text:', accumulatedText);
    if (finalResult) console.log('[CEB][LLM] Full response:', finalResult);
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
const uploadFileToOpenAI = async ({ apiKey: _apiKey, file }: { apiKey: string; file: File }): Promise<string> => {
  // Mark unused when using backend proxy
  void _apiKey;
  const form = new FormData();
  form.append('file', file, file.name);
  // Use user_data for files that will be used as model inputs per OpenAI guidance
  form.append('purpose', 'user_data');

  const res = await fetch('https://chatgpt-proxy-500570371278.us-west2.run.app/v1/files', {
    method: 'POST',
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

// Removed default assistant greeting message

const STORAGE_KEYS = {
  threads: 'chatThreads',
  activeId: 'activeChatId',
  webAccess: 'webAccessEnabled',
  llmModel: 'llmModel',
  readRecent: 'readRecentFiles',
  compactMode: 'compactMode',
  onboardingDone: 'sidePanelOnboardingDone',
  fontSizeLevel: 'messageFontSizeLevel',
} as const;

// Rating links (open in new tab)
const RATING_POSITIVE_URL =
  'https://chromewebstore.google.com/detail/ai-homework-helper/gbihmkplhmilebglblgjgjphofpkkmhp/reviews';
const RATING_CRITICAL_URL =
  'https://docs.google.com/forms/d/e/1FAIpQLSey4dZTfI0HTMjmgEV4k5_ypMUFiYjGkC50KEPM_eXw94l7zA/viewform?usp=header';

const SidePanel = () => {
  const { isLight } = useStorage(exampleThemeStorage);

  useEffect(() => {
    // Ensure Radix portals (tooltips) get correct theme vars by toggling on <html>
    document.documentElement.classList.toggle('dark', !isLight);
  }, [isLight]);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [activeId, setActiveId] = useState<string>('');

  const [input, setInput] = useState<string>('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [screenshotActive, setScreenshotActive] = useState<boolean>(false);
  const [screenshotError, setScreenshotError] = useState<string>('');
  const [screenshotOverlayStarted, setScreenshotOverlayStarted] = useState<boolean>(false);
  const [imageActive, setImageActive] = useState<boolean>(false);
  const [fileActive, setFileActive] = useState<boolean>(false);
  const [newChatActive, setNewChatActive] = useState<boolean>(false);
  const [historySheetOpen, setHistorySheetOpen] = useState<boolean>(false);
  const [webPopoverOpen, setWebPopoverOpen] = useState<boolean>(false);
  const [webAccessEnabled, setWebAccessEnabled] = useState<boolean>(false);
  const [modelPopoverOpen, setModelPopoverOpen] = useState<boolean>(false);
  const [llmModel, setLlmModel] = useState<'quick' | 'deep'>('quick');
  // Local API key input is removed
  const lastRequestRef = useRef<{ model: string; inputPayload: unknown; fileIds?: string[] } | null>(null);

  const [isInputFocused, setIsInputFocused] = useState<boolean>(false);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);

  const [uiLocale, setUiLocale] = useState<UILocale>('en');
  const [langOpen, setLangOpen] = useState<boolean>(false);
  const [compactMode, setCompactMode] = useState<boolean>(false);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);
  const [fontSizeLevel, setFontSizeLevel] = useState<number>(2);
  const messageFontSizeClass = useMemo(() => {
    switch (fontSizeLevel) {
      case 0:
        return 'text-sm';
      case 1:
        return 'text-base';
      case 2:
        return 'text-lg';
      case 3:
        return 'text-xl';
      case 4:
        return 'text-2xl';
      default:
        return 'text-lg';
    }
  }, [fontSizeLevel]);
  // Editing state for user messages
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState<string>('');
  // Header rating UI state
  const [ratingHover, setRatingHover] = useState<number | null>(null);
  const [ratingSelected, setRatingSelected] = useState<number | null>(null);
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
  const [writeComposeResult, setWriteComposeResult] = useState<string>('');

  const [writeReviseInput, setWriteReviseInput] = useState<string>('');
  const [writeReviseResult, setWriteReviseResult] = useState<string>('');

  const [writeGrammarInput, setWriteGrammarInput] = useState<string>('');
  const [writeGrammarResult, setWriteGrammarResult] = useState<string>('');

  const [writeParaphraseInput, setWriteParaphraseInput] = useState<string>('');
  const [writeParaphraseResult, setWriteParaphraseResult] = useState<string>('');
  const [writeLangOpen, setWriteLangOpen] = useState<boolean>(false);
  const t = (UI_I18N as unknown as Record<UILocale, (typeof UI_I18N)['en']>)[uiLocale] ?? UI_I18N.en;
  const [subject, setSubject] = useState<string>('auto');
  const subjects = [
    'auto',
    'math',
    'social',
    'lang',
    'science',
    'history',
    'econ',
    'music',
    'phys',
    'chem',
    'bio',
    'art',
    'geo',
    'cs',
  ] as const;

  const [isComposeStreaming, setIsComposeStreaming] = useState<boolean>(false);
  const [toolsMenuOpen, setToolsMenuOpen] = useState<boolean>(false);
  const [isReviseStreaming, setIsReviseStreaming] = useState<boolean>(false);
  const [isGrammarStreaming, setIsGrammarStreaming] = useState<boolean>(false);
  const [isParaphraseStreaming, setIsParaphraseStreaming] = useState<boolean>(false);
  const abortRef = useRef<AbortController | null>(null);

  // Read mode state
  const [readFiles, setReadFiles] = useState<ReadFileItem[]>([]);
  const [readDragging, setReadDragging] = useState<boolean>(false);
  const [readActiveId, setReadActiveId] = useState<string | null>(null);

  // Welcome screen helpers
  const extensionIconUrl = useMemo(() => {
    try {
      return chrome.runtime.getURL('icon-96.png');
    } catch {
      return '';
    }
  }, []);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageActiveTimeoutRef = useRef<number | undefined>(undefined);
  const fileActiveTimeoutRef = useRef<number | undefined>(undefined);
  const readFileInputRef = useRef<HTMLInputElement | null>(null);
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // In-memory map of attachment id -> File object for uploads
  const attachmentFileMapRef = useRef<Record<string, File>>({});
  // Flag to auto-send first screenshot taken from the welcome screen
  const autoSendAfterScreenshotRef = useRef<boolean>(false);

  const langLabelKeyByCode: Record<UILocale, keyof (typeof UI_I18N)['en']> = {
    en: 'lang_en',
    ru: 'lang_ru',
    uk: 'lang_uk',
    de: 'lang_de',
    fr: 'lang_fr',
    es: 'lang_es',
    pt: 'lang_pt',
    tr: 'lang_tr',
    zh: 'lang_zh',
  };
  const languageOptions: ReadonlyArray<readonly [UILocale, string]> = [
    ['en', '🇺🇸'],
    ['ru', '🇷🇺'],
    ['uk', '🇺🇦'],
    ['de', '🇩🇪'],
    ['fr', '🇫🇷'],
    ['es', '🇪🇸'],
    ['pt', '🇵🇹'],
    ['tr', '🇹🇷'],
    ['zh', '🇨🇳'],
  ];
  const languageEnglishNameByCode: Record<UILocale, string> = {
    en: 'English',
    ru: 'Russian',
    uk: 'Ukrainian',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    pt: 'Portuguese',
    tr: 'Turkish',
    zh: 'Chinese',
  };
  const headerTitle = mode === 'ask' ? t.title : mode === 'read' ? t.nav_read : t.nav_write;

  const currentRating = ratingHover ?? ratingSelected ?? 0;
  const ratingEmoji =
    currentRating === 0
      ? null
      : currentRating === 1
        ? '😞'
        : currentRating === 2
          ? '😕'
          : currentRating === 3
            ? '😐'
            : currentRating === 4
              ? '🙂'
              : '🤩';

  useEffect(() => {
    if (editingMessageId) {
      queueMicrotask(() => editingTextareaRef.current?.focus());
    }
  }, [editingMessageId]);

  // Avatars for assistant and user
  const BotAvatar = () => (
    <div
      className={cn(
        'grid h-6 w-6 shrink-0 place-items-center rounded-full',
        isLight ? 'bg-violet-100 text-violet-700' : 'bg-slate-700 text-violet-300',
      )}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 3 2 8l10 5 7-3.5V15h2V8L12 3z" />
        <path d="M5 12v3.5A4.5 4.5 0 0 0 9.5 20h5A4.5 4.5 0 0 0 19 15.5V12l-7 3.5L5 12z" />
      </svg>
    </div>
  );
  const UserAvatar = () => (
    <div className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-violet-600 text-white">
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 12a5 5 0 1 0-5-5 5 5 0 0 0 5 5zm0 2c-4.418 0-8 2.239-8 5v1h16v-1c0-2.761-3.582-5-8-5z" />
      </svg>
    </div>
  );

  // First-run onboarding tour
  const [tourOpen, setTourOpen] = useState<boolean>(false);
  const tourSteps = useMemo<TourStep[]>(
    () => [
      {
        id: 'screenshot',
        selector: '[data-tour-id="screenshot"]',
        title: 'Take a screenshot',
        content:
          'Capture the current page or a selected area to discuss with AI. Note: some pages restrict screenshots.',
      },
      {
        id: 'nav-ask',
        selector: '[data-tour-id="nav-ask"]',
        title: 'Mode: Ask AI',
        content: 'Main chat mode. Ask questions and get answers from the assistant.',
      },
      {
        id: 'nav-read',
        selector: '[data-tour-id="nav-read"]',
        title: 'Mode: Read',
        content: 'Load and read PDFs. Discuss documents and get summaries and answers.',
      },
      {
        id: 'nav-write',
        selector: '[data-tour-id="nav-write"]',
        title: 'Mode: Write',
        content: 'Generate and refine text: drafts, grammar checks, and paraphrasing.',
      },
      {
        id: 'send',
        selector: '[data-tour-id="send"]',
        title: 'Send message',
        content: 'Type your message below and press Send. Shift+Enter adds a new line.',
      },
    ],
    [],
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
        STORAGE_KEYS.compactMode,
        STORAGE_KEYS.fontSizeLevel,
      ])
      .then(store => {
        const v = store?.uiLocale as UILocale | undefined;
        const allowed: UILocale[] = ['en', 'ru', 'de', 'es', 'fr', 'pt', 'uk', 'tr', 'zh'];

        let defaultLocale: UILocale = 'en';
        try {
          const browserLang = chrome.i18n.getUILanguage().split('-')[0] as UILocale;
          if (allowed.includes(browserLang)) {
            defaultLocale = browserLang;
          }
        } catch {
          // ignore
        }

        const selected: UILocale = allowed.includes(v as UILocale) ? (v as UILocale) : defaultLocale;
        const localeForInit: 'en' | 'ru' = selected === 'ru' ? 'ru' : 'en';
        setUiLocale(selected);

        const web = store?.[STORAGE_KEYS.webAccess] as boolean | undefined;
        if (typeof web === 'boolean') setWebAccessEnabled(web);

        const model = store?.[STORAGE_KEYS.llmModel] as 'quick' | 'deep' | undefined;
        if (model === 'quick' || model === 'deep') setLlmModel(model);

        const loadedRead = (store?.[STORAGE_KEYS.readRecent] as ReadFileItem[] | undefined) ?? [];
        setReadFiles(loadedRead);
        const loadedCompact = store?.[STORAGE_KEYS.compactMode] as boolean | undefined;
        if (typeof loadedCompact === 'boolean') setCompactMode(loadedCompact);
        const loadedFontSizeLevel = store?.[STORAGE_KEYS.fontSizeLevel] as number | undefined;
        if (typeof loadedFontSizeLevel === 'number' && loadedFontSizeLevel >= 0 && loadedFontSizeLevel <= 4) {
          setFontSizeLevel(loadedFontSizeLevel);
        }

        // No local API key is used

        const loadedThreads = (store?.[STORAGE_KEYS.threads] as ChatThread[] | undefined) ?? [];
        const loadedActive = (store?.[STORAGE_KEYS.activeId] as string | undefined) ?? '';

        if (loadedThreads.length === 0) {
          const id = `chat-${Date.now()}`;
          const initial: ChatThread = {
            id,
            title: localeForInit === 'ru' ? 'Новый чат' : 'New chat',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
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

  // Show onboarding on first run
  useEffect(() => {
    chrome.storage?.local.get([STORAGE_KEYS.onboardingDone]).then(store => {
      const done = Boolean(store?.[STORAGE_KEYS.onboardingDone]);
      if (!done) setTourOpen(true);
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
    void chrome.storage?.local.set({ [STORAGE_KEYS.compactMode]: compactMode });
  }, [compactMode]);
  useEffect(() => {
    void chrome.storage?.local.set({ [STORAGE_KEYS.fontSizeLevel]: fontSizeLevel });
  }, [fontSizeLevel]);
  // No local API key is persisted

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
        const text =
          textItem?.content ||
          UI_I18N[uiLocale].image_prompt_task;
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
    const key = '';
    // Build contextual history including the just-appended user turn
    const allMessagesForContext = withBatch.length > 0 ? [...messages, ...withBatch] : messages;

    setInput('');
    setAttachments([]);
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';

    // No local API key required when using backend proxy

    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const inputPayload = buildHistoryInputItemsFrom(allMessagesForContext, 5);

    // Streaming message: render markdown live as it streams
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
        const msgText = UI_I18N[uiLocale].upload_error;
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

    const finalInput = [
      { role: 'system', content: [{ type: 'input_text', text: buildAskAiSystemPrompt(uiLocale) }] },
      ...inputWithFiles,
    ];

    // Clean used files from the map
    for (const id of fileAttachmentIds) delete attachmentFileMapRef.current[id];

    lastRequestRef.current = { model, inputPayload: inputWithFiles, fileIds: uploadedFileIds };

    const combinedTools: Array<{ type: 'web_search' }> = [];
    if (webAccessEnabled) combinedTools.push({ type: 'web_search' });

    {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: finalInput,
            text: { format: { type: 'text' } },
            // Enable web_search if requested; files are passed via input_file
            ...(combinedTools.length > 0 ? { tools: combinedTools, tool_choice: 'auto' as const } : {}),
            ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
          },
          signal: ctrl.signal,
        },
        {
          onDelta: chunk => {
            setMessages(prev => {
              const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
              const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
              const nextRaw = String(currentRaw ?? '') + chunk;
              return prev.map(m => {
                if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                return m;
              });
            });
            upsertActiveThread(thread => {
              const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
              const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
              const nextRaw = String(currentRaw ?? '') + chunk;
              return {
                ...thread,
                messages: thread.messages.map(m => {
                  if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                  return m;
                }),
              };
            });
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
              setMessages(prev => {
                const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                const nextRaw = String(currentRaw ?? '') + suffix;
                return prev.map(m => {
                  if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                  return m;
                });
              });
              upsertActiveThread(thread => {
                const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                const nextRaw = String(currentRaw ?? '') + suffix;
                return {
                  ...thread,
                  updatedAt: Date.now(),
                  messages: thread.messages.map(m => {
                    if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                    return m;
                  }),
                };
              });
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
              {
                const ctrl = new AbortController();
                abortRef.current = ctrl;
                void streamResponsesApi(
                  {
                    apiKey: key,
                    body: {
                      model,
                      input: finalInput,
                      text: { format: { type: 'text' } },
                      // No tools on retry
                      ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                    },
                    signal: ctrl.signal,
                  },
                  {
                    onDelta: chunk => {
                      setMessages(prev => {
                        const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return prev.map(m => {
                          if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                          return m;
                        });
                      });
                      upsertActiveThread(thread => {
                        const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return {
                          ...thread,
                          messages: thread.messages.map(m => {
                            if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                            return m;
                          }),
                        };
                      });
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
                        setMessages(prev => {
                          const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                          const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                          const nextRaw = String(currentRaw ?? '') + suffix;
                          return prev.map(m => {
                            if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                            return m;
                          });
                        });
                        upsertActiveThread(thread => {
                          const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                          const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                          const nextRaw = String(currentRaw ?? '') + suffix;
                          return {
                            ...thread,
                            updatedAt: Date.now(),
                            messages: thread.messages.map(m => {
                              if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                              return m;
                            }),
                          };
                        });
                      } else {
                        upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
                      }
                      setIsStreaming(false);
                      setStreamingMessageId(null);
                      queueMicrotask(() => inputRef.current?.focus());
                    },
                    onError: () => {
                      const content = uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.';
                      setMessages(prev =>
                        prev.map(m => (m.id === streamId && m.type === 'text' ? { ...m, content } : m)),
                      );
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
              }
              return;
            }
            // Fallback 2: switch to gpt-4o-mini if deep model 403s
            if (status === 403 && model === 'gpt-4o') {
              const fallbackModel = 'gpt-4o-mini';
              {
                const ctrl = new AbortController();
                abortRef.current = ctrl;
                void streamResponsesApi(
                  {
                    apiKey: key,
                    body: {
                      model: fallbackModel,
                      input: finalInput,
                      text: { format: { type: 'text' } },
                      // No tools on fallback
                      ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                    },
                    signal: ctrl.signal,
                  },
                  {
                    onDelta: chunk => {
                      setMessages(prev => {
                        const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return prev.map(m => {
                          if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                          return m;
                        });
                      });
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
              }
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
    }
  }, [
    canSend,
    input,
    attachments,
    uiLocale,
    upsertActiveThread,
    llmModel,
    webAccessEnabled,
    activeId,
    messages,
    buildHistoryInputItemsFrom,
  ]);

  // Keep a stable reference to the latest handleSend to invoke after async state updates
  const handleSendRef = useRef<() => void>(() => {});
  useEffect(() => {
    handleSendRef.current = handleSend;
  }, [handleSend]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const clearComposer = useCallback(() => {
    setInput('');
    setAttachments([]);
    if (imageInputRef.current) imageInputRef.current.value = '';
    if (fileInputRef.current) fileInputRef.current.value = '';
    queueMicrotask(() => inputRef.current?.focus());
  }, []);

  const cancelStreaming = useCallback(() => {
    try {
      abortRef.current?.abort();
    } catch {
      // ignore
    }
    setIsStreaming(false);
    setStreamingMessageId(null);
    setIsComposeStreaming(false);
    setIsReviseStreaming(false);
    setIsGrammarStreaming(false);
    setIsParaphraseStreaming(false);
  }, []);

  const requestScreenshot = useCallback(() => {
    setScreenshotError('');
    setScreenshotOverlayStarted(false);
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

  // Read: open or create chat for a given PDF and switch to Ask AI
  const openChatWithPdf = useCallback(
    async (item: ReadFileItem) => {
      const existing = threads.find(tn => tn.linkedPdfId === item.id);
      const prompt = t.read_chat_prompt;

      if (existing) {
        setActiveId(existing.id);
        setMessages(existing.messages);
        setMode('ask');
        return;
      }

      const id = `chat-${Date.now()}`;
      const initial: ChatThread = {
        id,
        title: item.name.slice(0, 40),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        linkedPdfId: item.id,
        messages: [],
      };

      setThreads(prev => [initial, ...prev]);
      setActiveId(id);
      setMessages(initial.messages);
      setMode('ask');

      try {
        const res = await fetch(item.dataUrl);
        const blob = await res.blob();
        const file = new File([blob], item.name || 'document.pdf', { type: blob.type || 'application/pdf' });
        const attachId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        attachmentFileMapRef.current[attachId] = file;
        setAttachments([{ id: attachId, kind: 'file', name: file.name, size: file.size, mime: file.type }]);
        setInput(prompt);
        window.setTimeout(() => {
          handleSendRef.current();
        }, 0);
      } catch {
        // ignore failures to auto-attach; user can still chat manually
      }
    },
    [threads, t.read_chat_prompt],
  );

  const deletePdf = useCallback(
    (id: string) => {
      setReadFiles(prev => prev.filter(f => f.id !== id));
      if (readActiveId === id) setReadActiveId(null);
    },
    [readActiveId],
  );

  // Write actions
  const generateCompose = useCallback(async () => {
    if (isComposeStreaming) return;
    const key = '';
    const base = writeComposeInput.trim() || (uiLocale === 'ru' ? 'Без названия' : 'Untitled draft');
    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
    const fmt = titleCase(writeFormat);
    const tone = titleCase(writeTone);
    const len = titleCase(writeLength);
    const lang = writeLanguage;
    const systemPrompt = `You are EduWriterGPT, an advanced AI writing assistant designed to help students and learners create high-quality written works.
Your goal is to generate a well-structured and coherent piece of text perfectly suited for academic or personal purposes.

Follow these parameters when generating text:
- Format: ${fmt}
- Tone: ${tone} 
- Length: ${len}
- Language: ${lang}
- Topic: ${base}

If the user selects "Auto" for any parameter, intelligently determine the most appropriate option based on the topic and context.

Guidelines:
1. Write as a human would — clear, natural, and contextually appropriate for students or academic readers.
2. For "Essay" or "Article", include an introduction, body, and conclusion.
3. For "Email" or "Message", make it concise, polite, and context-aware.
4. For "Comment" or "Blog", make it engaging and relevant to the topic.
5. Adjust tone accordingly:
   - "Formal" → academic, objective, and polite
   - "Professional" → clear, structured, confident
   - "Funny" → light, witty, and entertaining
   - "Casual" → friendly, simple, and conversational
6. Adjust length:
   - "Short" → 1–2 short paragraphs
   - "Medium" → 3–5 paragraphs
   - "Long" → detailed, 6+ paragraphs or full essay-style
7. Always keep coherence, grammar correctness, and readability at the highest standard.

Now generate the best possible ${fmt} in ${lang} with a ${tone} tone and ${len} length about this topic:
"${base}"`;

    setWriteComposeResult('');
    setIsComposeStreaming(true);
    {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: buildSystemPromptMarkdown(uiLocale) }] },
              { role: 'system', content: [{ type: 'input_text', text: systemPrompt }] },
              { role: 'user', content: [{ type: 'input_text', text: base }] },
            ],
            text: { format: { type: 'text' } },
          },
          signal: ctrl.signal,
        },
        {
          onDelta: chunk => setWriteComposeResult(prev => (prev ?? '') + chunk),
          onDone: () => setIsComposeStreaming(false),
          onError: () => {
            setWriteComposeResult(uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.');
            setIsComposeStreaming(false);
          },
        },
      );
    }
  }, [isComposeStreaming, llmModel, uiLocale, writeComposeInput, writeFormat, writeTone, writeLength, writeLanguage]);

  const copyText = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // ignore
    }
  }, []);

  const optimizeRevise = useCallback(async () => {
    if (isReviseStreaming) return;
    const text = writeReviseInput.trim();
    if (!text) {
      setWriteReviseResult('');
      return;
    }
    const key = '';
    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const instruction =
      uiLocale === 'ru'
        ? `Улучшай стиль и ясность текста, сохраняя смысл. Язык: ${writeLanguage}. Тон: ${writeTone}. Верни только улучшенный текст без пояснений.`
        : `Improve style and clarity while preserving meaning. Language: ${writeLanguage}. Tone: ${writeTone}. Return only the improved text without explanations.`;
    setWriteReviseResult('');
    setIsReviseStreaming(true);
    {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: buildSystemPromptMarkdown(uiLocale) }] },
              { role: 'user', content: [{ type: 'input_text', text: instruction }] },
              { role: 'user', content: [{ type: 'input_text', text }] },
            ],
            text: { format: { type: 'text' } },
          },
          signal: ctrl.signal,
        },
        {
          onDelta: chunk => setWriteReviseResult(prev => (prev ?? '') + chunk),
          onDone: () => setIsReviseStreaming(false),
          onError: () => {
            setWriteReviseResult(uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.');
            setIsReviseStreaming(false);
          },
        },
      );
    }
  }, [isReviseStreaming, llmModel, uiLocale, writeReviseInput, writeLanguage, writeTone]);

  const runGrammar = useCallback(async () => {
    if (isGrammarStreaming) return;
    const text = writeGrammarInput.trim();
    if (!text) {
      setWriteGrammarResult('');
      return;
    }
    const key = '';
    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const instruction =
      uiLocale === 'ru'
        ? 'Исправь грамматику и орфографию. Верни только исправленный текст без пояснений.'
        : 'Fix grammar and spelling. Return only the corrected text without explanations.';
    setWriteGrammarResult('');
    setIsGrammarStreaming(true);
    {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: buildSystemPromptMarkdown(uiLocale) }] },
              { role: 'user', content: [{ type: 'input_text', text: instruction }] },
              { role: 'user', content: [{ type: 'input_text', text }] },
            ],
            text: { format: { type: 'text' } },
          },
          signal: ctrl.signal,
        },
        {
          onDelta: chunk => setWriteGrammarResult(prev => (prev ?? '') + chunk),
          onDone: () => setIsGrammarStreaming(false),
          onError: () => {
            setWriteGrammarResult(uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.');
            setIsGrammarStreaming(false);
          },
        },
      );
    }
  }, [isGrammarStreaming, llmModel, uiLocale, writeGrammarInput]);

  const runParaphrase = useCallback(async () => {
    if (isParaphraseStreaming) return;
    const text = writeParaphraseInput.trim();
    if (!text) {
      setWriteParaphraseResult('');
      return;
    }
    const key = '';
    const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
    const instruction =
      'Paraphrase the text while preserving meaning. Maintain the original language of the input text. Return only the paraphrased text.';
    setWriteParaphraseResult('');
    setIsParaphraseStreaming(true);
    {
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      void streamResponsesApi(
        {
          apiKey: key,
          body: {
            model,
            input: [
              { role: 'system', content: [{ type: 'input_text', text: buildSystemPromptMarkdown(uiLocale) }] },
              { role: 'user', content: [{ type: 'input_text', text: instruction }] },
              { role: 'user', content: [{ type: 'input_text', text }] },
            ],
            text: { format: { type: 'text' } },
          },
          signal: ctrl.signal,
        },
        {
          onDelta: chunk => setWriteParaphraseResult(prev => (prev ?? '') + chunk),
          onDone: () => setIsParaphraseStreaming(false),
          onError: () => {
            setWriteParaphraseResult(uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.');
            setIsParaphraseStreaming(false);
          },
        },
      );
    }
  }, [isParaphraseStreaming, llmModel, uiLocale, writeParaphraseInput]);

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
      messages: [],
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

  // Welcome screen: open a new chat and auto-send the captured screenshot
  const handleWelcomeScreenshot = useCallback(() => {
    createNewChat();
    setMode('ask');
    autoSendAfterScreenshotRef.current = true;
    setScreenshotActive(true);
    chrome.runtime.sendMessage({ type: 'SCREENSHOT_REQUEST' }).catch(() => setScreenshotActive(false));
  }, [createNewChat]);

  // Check for pending screenshot (from floating button)
  useEffect(() => {
    chrome.storage.local.get(['pendingScreenshot']).then(async res => {
      const pending = res.pendingScreenshot as {
        dataUrl: string;
        bounds: { x: number; y: number; width: number; height: number; dpr: number };
        autoSend: boolean;
        timestamp: number;
      };
      if (pending && Date.now() - pending.timestamp < 60000) {
        console.debug(`${LOG_PREFIX} found pendingScreenshot`);
        await chrome.storage.local.remove('pendingScreenshot');
        if (pending.autoSend) {
          autoSendAfterScreenshotRef.current = true;
        }
        try {
          const cropped = await cropImageDataUrl(pending.dataUrl, pending.bounds);
          setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl: cropped }]);
        } catch (e) {
          console.error(`${LOG_PREFIX} failed to process pending screenshot`, e);
        }
      }
    });
  }, []);

  // Handle screenshot results and errors
  useEffect(() => {
    const onMessage = async (message: unknown) => {
      const msg = message as {
        type?: string;
        dataUrl?: string;
        bounds?: { x: number; y: number; width: number; height: number; dpr: number };
        autoSend?: boolean;
      };
      if (msg?.type === 'SCREENSHOT_OVERLAY_STARTED') {
        setScreenshotOverlayStarted(true);
        setScreenshotError('');
        return;
      }
      if (msg?.type === 'SCREENSHOT_CAPTURED' && msg.dataUrl && msg.bounds) {
        if (msg.autoSend) {
          autoSendAfterScreenshotRef.current = true;
        }
        try {
          const cropped = await cropImageDataUrl(msg.dataUrl, msg.bounds);
          setAttachments(prev => [...prev, { id: `${Date.now()}-${prev.length}`, kind: 'image', dataUrl: cropped }]);
        } catch {
          // ignore
        } finally {
          setScreenshotError('');
          setScreenshotActive(false);
          setScreenshotOverlayStarted(false);
        }
      }
      if (msg?.type === 'SCREENSHOT_CANCELLED') {
        setScreenshotActive(false);
        setScreenshotOverlayStarted(false);
      }
      if (msg?.type === 'SCREENSHOT_NOT_ALLOWED') {
        setScreenshotActive(false);
        if (!screenshotOverlayStarted) {
          setScreenshotError(t.screenshot_not_allowed);
          window.setTimeout(() => setScreenshotError(''), 6000);
        }
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [t, screenshotOverlayStarted]);

  // If screenshot was initiated from welcome screen, auto-send once it is attached
  useEffect(() => {
    if (autoSendAfterScreenshotRef.current && attachments.some(a => a.kind === 'image')) {
      autoSendAfterScreenshotRef.current = false;
      // Ensure active chat exists and we're in ask mode
      if (!activeId) createNewChat();
      setMode('ask');
      // Defer to next tick to allow state to settle
      queueMicrotask(() => handleSendRef.current());
    }
  }, [attachments, activeId, createNewChat]);

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

  // Branch: trim messages after a user message/group and generate a new assistant answer
  const startBranchFromMessages = useCallback(
    (kept: ChatMessage[]) => {
      setMessages(kept);
      upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now(), messages: kept }));

      const key = '';
      const model = llmModel === 'deep' ? 'gpt-4o' : 'gpt-4o-mini';
      const inputPayload = buildHistoryInputItemsFrom(kept, 5);
      const branchInput = [
        { role: 'system', content: [{ type: 'input_text', text: buildAskAiSystemPrompt(uiLocale) }] },
        ...inputPayload,
      ];

      lastRequestRef.current = { model, inputPayload };

      const streamId = `assistant-${Date.now() + 1}`;
      setMessages(prev => [...prev, { id: streamId, role: 'assistant', type: 'text', content: '' }]);
      upsertActiveThread(thread => ({
        ...thread,
        updatedAt: Date.now(),
        messages: [...thread.messages, { id: streamId, role: 'assistant', type: 'text', content: '' }],
      }));
      setIsStreaming(true);
      setStreamingMessageId(streamId);

      const combinedTools: Array<{ type: 'web_search' }> = [];
      if (webAccessEnabled) combinedTools.push({ type: 'web_search' });

      {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        void streamResponsesApi(
          {
            apiKey: key,
            body: {
              model,
              input: branchInput,
              text: { format: { type: 'text' } },
              ...(combinedTools.length > 0 ? { tools: combinedTools, tool_choice: 'auto' as const } : {}),
              ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
            },
            signal: ctrl.signal,
          },
          {
            onDelta: chunk => {
              setMessages(prev => {
                const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                const nextRaw = String(currentRaw ?? '') + chunk;
                return prev.map(m => {
                  if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                  return m;
                });
              });
              upsertActiveThread(thread => {
                const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                const nextRaw = String(currentRaw ?? '') + chunk;
                return {
                  ...thread,
                  messages: thread.messages.map(m => {
                    if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                    return m;
                  }),
                };
              });
            },
            onDone: final => {
              if (final && typeof final.id === 'string') lastResponseIdRef.current = final.id;
              setThreads(prev =>
                prev.map(t =>
                  t.id === activeId ? { ...t, lastResponseId: lastResponseIdRef.current ?? undefined } : t,
                ),
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
                setMessages(prev => {
                  const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                  const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                  const nextRaw = String(currentRaw ?? '') + suffix;
                  return prev.map(m => {
                    if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                    return m;
                  });
                });
                upsertActiveThread(thread => {
                  const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                  const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                  const nextRaw = String(currentRaw ?? '') + suffix;
                  return {
                    ...thread,
                    updatedAt: Date.now(),
                    messages: thread.messages.map(m => {
                      if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                      return m;
                    }),
                  };
                });
              } else {
                upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
              }
              setIsStreaming(false);
              setStreamingMessageId(null);
              queueMicrotask(() => inputRef.current?.focus());
            },
            onError: err => {
              console.error('[CEB][SidePanel] OpenAI stream error (branch)', err);
              const status =
                err && typeof err === 'object' && 'status' in (err as Record<string, unknown>)
                  ? Number((err as Record<string, unknown>).status)
                  : undefined;
              if (status === 403 && webAccessEnabled) {
                void streamResponsesApi(
                  {
                    apiKey: key,
                    body: {
                      model,
                      input: branchInput,
                      text: { format: { type: 'text' } },
                      ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                    },
                  },
                  {
                    onDelta: chunk => {
                      setMessages(prev => {
                        const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return prev.map(m => {
                          if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                          return m;
                        });
                      });
                      upsertActiveThread(thread => {
                        const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return {
                          ...thread,
                          messages: thread.messages.map(m => {
                            if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                            return m;
                          }),
                        };
                      });
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
                        setMessages(prev => {
                          const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                          const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                          const nextRaw = String(currentRaw ?? '') + suffix;
                          return prev.map(m => {
                            if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                            return m;
                          });
                        });
                        upsertActiveThread(thread => {
                          const rawMsg = thread.messages.find(m => m.id === streamId && m.type === 'text');
                          const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                          const nextRaw = String(currentRaw ?? '') + suffix;
                          return {
                            ...thread,
                            updatedAt: Date.now(),
                            messages: thread.messages.map(m => {
                              if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                              return m;
                            }),
                          };
                        });
                      } else {
                        upsertActiveThread(thread => ({ ...thread, updatedAt: Date.now() }));
                      }
                      // No duplication; we already stream-render the same message
                      setIsStreaming(false);
                      setStreamingMessageId(null);
                      queueMicrotask(() => inputRef.current?.focus());
                    },
                    onError: () => {
                      const content = uiLocale === 'ru' ? 'Ошибка запроса к OpenAI.' : 'Failed to call OpenAI.';
                      const applyErr = (m: ChatMessage) =>
                        m.id === streamId && m.type === 'text' ? { ...m, content } : m;
                      setMessages(prev => prev.map(applyErr));
                      upsertActiveThread(thread => ({
                        ...thread,
                        updatedAt: Date.now(),
                        messages: thread.messages.map(applyErr),
                      }));
                      setIsStreaming(false);
                      queueMicrotask(() => inputRef.current?.focus());
                    },
                  },
                );
                return;
              }
              if (status === 403 && model === 'gpt-4o') {
                const fallbackModel = 'gpt-4o-mini';
                void streamResponsesApi(
                  {
                    apiKey: key,
                    body: {
                      model: fallbackModel,
                      input: branchInput,
                      text: { format: { type: 'text' } },
                      ...(lastResponseIdRef.current ? { previous_response_id: lastResponseIdRef.current } : {}),
                    },
                  },
                  {
                    onDelta: chunk => {
                      setMessages(prev => {
                        const rawMsg = prev.find(m => m.id === streamId && m.type === 'text');
                        const currentRaw = rawMsg && isTextMessage(rawMsg) ? rawMsg.content : '';
                        const nextRaw = String(currentRaw ?? '') + chunk;
                        return prev.map(m => {
                          if (m.id === streamId && m.type === 'text') return { ...m, content: nextRaw };
                          return m;
                        });
                      });
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
              const applyErr = (m: ChatMessage) => (m.id === streamId && m.type === 'text' ? { ...m, content } : m);
              setMessages(prev => prev.map(applyErr));
              upsertActiveThread(thread => ({
                ...thread,
                updatedAt: Date.now(),
                messages: thread.messages.map(applyErr),
              }));
              setIsStreaming(false);
              setStreamingMessageId(null);
              queueMicrotask(() => inputRef.current?.focus());
            },
          },
        );
      }
    },
    [upsertActiveThread, llmModel, webAccessEnabled, buildHistoryInputItemsFrom, uiLocale, activeId],
  );

  const branchFromMessage = useCallback(
    (id: string) => {
      const idx = messages.findIndex(m => m.id === id);
      if (idx < 0) return;
      const kept = messages.slice(0, idx + 1);
      startBranchFromMessages(kept);
    },
    [messages, startBranchFromMessages],
  );

  const branchFromGroup = useCallback(
    (batchId: string) => {
      const lastIdx = (() => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i];
          if (m.role === 'user' && m.batchId === batchId) return i;
          if (m.batchId === batchId && m.role !== 'user') break;
        }
        return -1;
      })();
      if (lastIdx < 0) return;
      const kept = messages.slice(0, lastIdx + 1);
      startBranchFromMessages(kept);
    },
    [messages, startBranchFromMessages],
  );

  // Regenerate assistant text message via API
  const regenerateAssistantMessage = useCallback(
    (id: string) => {
      const key = '';
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

      const regenInput: Array<Record<string, unknown>> = Array.isArray(inputPayload)
        ? [
            { role: 'system', content: [{ type: 'input_text', text: buildAskAiSystemPrompt(uiLocale) }] },
            ...((inputPayload as Array<Record<string, unknown>>) || []),
          ]
        : [
            { role: 'system', content: [{ type: 'input_text', text: buildAskAiSystemPrompt(uiLocale) }] },
            { role: 'user', content: [{ type: 'input_text', text: String(inputPayload) }] },
          ];

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

      {
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        void streamResponsesApi(
          {
            apiKey: key,
            body: {
              model,
              input: regenInput,
              text: { format: { type: 'text' } },
              ...(regenTools.length > 0 ? { tools: regenTools } : {}),
              ...(regenTools.length > 0 ? { tool_choice: 'auto' as const } : {}),
              ...(isLatestTarget && lastResponseIdRef.current
                ? { previous_response_id: lastResponseIdRef.current }
                : {}),
            },
            signal: ctrl.signal,
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
              setMessages(prev =>
                prev.map(m => (m.id === id && m.type === 'text' ? { ...m, content: newContent } : m)),
              );
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
      }
    },
    [llmModel, uiLocale, upsertActiveThread, webAccessEnabled, buildHistoryInputItemsBeforeMessage, messages],
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
            messages: [],
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
        'flex w-14 flex-col items-center gap-3 border-l p-1.5',
        isLight ? 'border-slate-300 bg-slate-50' : 'border-slate-700 bg-slate-900',
      )}>
      {/* Ask AI */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour-id="nav-ask"
            onClick={() => setMode('ask')}
            aria-pressed={mode === 'ask'}
            className={cn(
              'group flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none',
              mode === 'ask'
                ? isLight
                  ? 'bg-slate-200 text-violet-700'
                  : 'bg-slate-700 text-violet-300'
                : isLight
                  ? 'text-gray-500 hover:bg-slate-200'
                  : 'text-gray-400 hover:bg-slate-800',
            )}
            aria-label={t.nav_ask}>
            {/* star-like */}
            <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l1.8 4.6L18 8.5l-4.2 2 1 4.7L12 13.7 9.2 15.2l1-4.7L6 8.5l4.2-1.9L12 2z" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t.nav_ask}</TooltipContent>
      </Tooltip>

      {/* Read */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour-id="nav-read"
            onClick={() => setMode('read')}
            aria-pressed={mode === 'read'}
            className={cn(
              'group flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none',
              mode === 'read'
                ? isLight
                  ? 'bg-slate-200 text-violet-700'
                  : 'bg-slate-700 text-violet-300'
                : isLight
                  ? 'text-gray-500 hover:bg-slate-200'
                  : 'text-gray-400 hover:bg-slate-800',
            )}
            aria-label={t.nav_read}>
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
              <path d="M3 19V6a2 2 0 0 1 2-2h6v17H5a2 2 0 0 1-2-2z" />
              <path d="M13 21V4h6a2 2 0 0 1 2 2v13" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t.nav_read}</TooltipContent>
      </Tooltip>

      {/* Write */}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-tour-id="nav-write"
            onClick={() => setMode('write')}
            aria-pressed={mode === 'write'}
            className={cn(
              'group flex h-9 w-9 items-center justify-center rounded-lg transition-colors focus-visible:outline-none',
              mode === 'write'
                ? isLight
                  ? 'bg-slate-200 text-violet-700'
                  : 'bg-slate-700 text-violet-300'
                : isLight
                  ? 'text-gray-500 hover:bg-slate-200'
                  : 'text-gray-400 hover:bg-slate-800',
            )}
            aria-label={t.nav_write}>
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
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" />
            </svg>
          </button>
        </TooltipTrigger>
        <TooltipContent side="left">{t.nav_write}</TooltipContent>
      </Tooltip>
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

  // (former custom tooltip helpers removed; using Radix Tooltip instead)

  return (
    <div className={cn('App', 'text-left', isLight ? 'bg-slate-50' : 'bg-gray-800', !isLight && 'dark')}>
      <div className={cn('relative flex h-full flex-col', isLight ? 'text-gray-900' : 'text-gray-100')}>
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-slate-200 bg-gradient-to-r from-white to-slate-50 px-3 py-2 shadow-sm dark:border-slate-700 dark:from-slate-800 dark:to-slate-900">
          <div className="flex items-center gap-3">
            <div className="text-base font-semibold">{headerTitle}</div>
            {/* Rating */}
            <div className="flex items-center gap-2">
              <span className={cn('text-xs', isLight ? 'text-slate-500' : 'text-slate-300')}>{t.rateUs}</span>
              <div className="flex items-center">
                {[1, 2, 3, 4, 5].map(i => (
                  <button
                    key={i}
                    type="button"
                    aria-label={`Rate ${i} of 5`}
                    onMouseEnter={() => setRatingHover(i)}
                    onMouseLeave={() => setRatingHover(null)}
                    onFocus={() => setRatingHover(i)}
                    onBlur={() => setRatingHover(null)}
                    onClick={() => {
                      setRatingSelected(i);
                      const url = i >= 4 ? RATING_POSITIVE_URL : RATING_CRITICAL_URL;
                      if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
                        chrome.tabs.create({ url });
                      } else {
                        window.open(url, '_blank', 'noopener,noreferrer');
                      }
                    }}
                    className={cn(
                      'p-1 transition-transform duration-150 focus:outline-none focus:ring-0',
                      'hover:scale-110 active:scale-95',
                    )}>
                    <svg
                      viewBox="0 0 24 24"
                      aria-hidden="true"
                      className={cn(
                        'h-4 w-4 fill-current',
                        i <= (currentRating || 0)
                          ? isLight
                            ? 'text-amber-400'
                            : 'text-amber-300'
                          : isLight
                            ? 'text-slate-300'
                            : 'text-slate-600',
                      )}>
                      <path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z" />
                    </svg>
                  </button>
                ))}
                {ratingEmoji && (
                  <div className={cn('ml-1 text-base', isLight ? 'text-slate-700' : 'text-slate-200')}>
                    {ratingEmoji}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="relative flex items-center gap-2">
            {/* Theme toggle */}
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  onClick={exampleThemeStorage.toggle}
                  ariaLabel={t.toggleTheme}
                  className={cn(
                    'mt-0 text-lg',
                    isLight
                      ? 'border-slate-300 bg-white text-amber-500 hover:bg-slate-50'
                      : 'border-slate-600 bg-slate-700 text-amber-300 hover:bg-slate-600',
                  )}>
                  {isLight ? (
                    <Moon aria-hidden="true" className="h-5 w-5" />
                  ) : (
                    <Sun aria-hidden="true" className="h-5 w-5" />
                  )}
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t.toggleTheme}</TooltipContent>
            </Tooltip>

            {/* History */}
            <Tooltip>
              <TooltipTrigger asChild>
                <IconButton
                  onClick={() => setHistorySheetOpen(true)}
                  ariaLabel={t.history}
                  className={cn(
                    'mt-0 text-lg',
                    isLight
                      ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                      : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                  )}>
                  <History aria-hidden="true" className="h-5 w-5" />
                </IconButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t.history}</TooltipContent>
            </Tooltip>

            {/* Controls: compact, language */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setLangOpen(false);
              }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setLangOpen(v => !v)}
                    className={cn(
                      'flex h-8 items-center gap-2 rounded-md border px-2 text-sm transition-colors',
                      isLight
                        ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                        : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                    )}
                    aria-label={t.langButton}>
                    <img src="icons/globe.svg" alt="" aria-hidden="true" className="h-4 w-4" />
                    <span className="text-xs font-bold">{uiLocale.toUpperCase()}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t.langButton}</TooltipContent>
              </Tooltip>
              {langOpen && (
                <div
                  className={cn(
                    'absolute right-0 z-20 mt-2 w-56 overflow-hidden rounded-md border text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  {languageOptions.map(([code, flag]) => (
                    <button
                      key={code}
                      onClick={() => {
                        setUiLocale(code as UILocale);
                        setLangOpen(false);
                      }}
                      role="option"
                      aria-selected={uiLocale === (code as UILocale)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                        uiLocale === (code as UILocale) ? 'font-semibold' : undefined,
                      )}>
                      <span>{flag}</span>
                      <span className="flex-1">{t[langLabelKeyByCode[code as UILocale]]}</span>
                      {uiLocale === (code as UILocale) && <span aria-hidden>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Settings: font size */}
            <div
              className="relative"
              onBlur={e => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setSettingsOpen(false);
              }}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <IconButton
                    onClick={() => setSettingsOpen(v => !v)}
                    ariaLabel="Settings"
                    className={cn(
                      isLight
                        ? 'border-slate-300 bg-white text-gray-900 hover:bg-slate-50'
                        : 'border-slate-600 bg-slate-700 text-gray-100 hover:bg-slate-600',
                    )}>
                    <img src="icons/settings.svg" alt="" aria-hidden="true" className="h-5 w-5" />
                  </IconButton>
                </TooltipTrigger>
                <TooltipContent side="bottom">Settings</TooltipContent>
              </Tooltip>
              {settingsOpen && (
                <div
                  className={cn(
                    'absolute right-0 z-20 mt-2 w-60 overflow-hidden rounded-md border text-sm shadow-lg',
                    isLight ? 'border-slate-200 bg-white text-gray-900' : 'border-slate-700 bg-slate-800 text-gray-100',
                  )}>
                  <div className="p-3">
                    <div className="mb-2 flex items-center justify-between text-gray-500 dark:text-gray-400">
                      <span className="text-xs">A</span>
                      <span className="text-base">A</span>
                      <span className="text-xl">A</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={4}
                      step={1}
                      value={fontSizeLevel}
                      onChange={e => setFontSizeLevel(Number(e.target.value))}
                      className="w-full"
                    />
                  </div>
                </div>
              )}
            </div>

            {/* API Key input removed */}
          </div>
        </div>

        {/* Main content area: chat + external right sidebar */}
        <div className="relative flex h-full min-h-0">
          {/* Scrollable content area */}
          <div
            ref={messagesContainerRef}
            className={cn(
              'h-full min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-none px-3 py-3',
              isLight ? 'bg-slate-50' : 'bg-gray-800',
            )}>
            <div
              role="note"
              className={cn(
                'mb-3 rounded-md border px-3 py-2 text-sm',
                isLight
                  ? 'border-amber-200 bg-amber-50 text-amber-800'
                  : 'border-amber-700 bg-amber-900/30 text-amber-200',
              )}>
              {t.contact_feature_idea ?? 'Got feature ideas or feedback?'} {t.contact_email_cta ?? 'Email me:'}{' '}
              <a
                href="mailto:laryushin.extension@gmail.com"
                className={cn('underline underline-offset-2', isLight ? 'text-amber-900' : 'text-amber-200')}>
                laryushin.extension@gmail.com
              </a>
            </div>
            {mode === 'ask' ? (
              <div className={cn('flex flex-col', compactMode ? 'gap-2' : 'gap-3')}>
                {messages.length === 0 && (
                  <div className="flex flex-1 flex-col overflow-y-auto px-4 py-6">
                    {/* Subject Section */}
                    <div className="mb-6 text-center">
                      <div className="mb-3 text-lg font-medium text-gray-500 dark:text-gray-400">{t.welcome_subject}</div>
                      <div className="flex flex-wrap justify-center gap-2">
                        {subjects.map(subKey => (
                          <button
                            key={subKey}
                            onClick={() => setSubject(subKey)}
                            className={cn(
                              'rounded-full px-4 py-1.5 text-sm transition-colors border',
                              subject === subKey
                                ? 'bg-violet-600 text-white border-violet-600'
                                : isLight
                                  ? 'bg-transparent text-gray-600 border-gray-300 hover:border-gray-400'
                                  : 'bg-transparent text-gray-300 border-gray-600 hover:border-gray-500',
                            )}>
                            {t[`subj_${subKey}` as keyof typeof t]}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Question Section */}
                    <div className="mb-6 text-center">
                      <div className="mb-3 text-lg font-medium text-gray-500 dark:text-gray-400">{t.welcome_question}</div>
                      <button
                        data-tour-id="screenshot"
                        onClick={handleWelcomeScreenshot}
                        className={cn(
                          'w-full rounded-full py-4 flex items-center justify-center gap-2 text-lg font-semibold shadow-lg transition-transform active:scale-[0.98]',
                          'bg-violet-600 text-white hover:bg-violet-700'
                        )}
                      >
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <rect x="3" y="7" width="18" height="14" rx="2" />
                              <circle cx="12" cy="14" r="4" />
                              <path d="M9 7l1.5-2h3L15 7" />
                            </svg>
                        {t.screenshot || 'Screenshot'}
                      </button>
                            </div>

                    {/* Separator */}
                    <div className="relative mb-6 text-center">
                      <div className="absolute inset-0 flex items-center">
                        <div className={cn("w-full border-t", isLight ? "border-gray-300" : "border-gray-700")}></div>
                          </div>
                      <div className="relative flex justify-center">
                        <span className={cn("px-4 text-sm text-gray-500", isLight ? "bg-slate-50" : "bg-gray-800")}>Or</span>
                        </div>
                    </div>

                    {/* Input */}
                    <div className="mb-auto">
                      <div className={cn(
                        "flex items-center gap-2 rounded-full border px-4 py-3 shadow-sm",
                        isLight ? "bg-white border-gray-300" : "bg-gray-900 border-gray-700"
                      )}>
                        <input
                          type="text"
                          value={input}
                          onChange={e => setInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                              e.preventDefault();
                              if (input.trim().length > 0) {
                                handleSend();
                              }
                            }
                          }}
                          placeholder={t.welcome_placeholder}
                          className="flex-1 bg-transparent outline-none"
                        />
                        <button
                          data-tour-id="send"
                          onClick={handleSend}
                          disabled={!input.trim()}
                          className={cn(
                            "flex h-8 w-8 items-center justify-center rounded-full transition-colors",
                            input.trim() ? "bg-violet-600 text-white" : "bg-gray-300 text-gray-500 dark:bg-gray-700"
                          )}
                        >
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                             <path d="M5 12h14" />
                             <path d="M12 5l7 7-7 7" />
                          </svg>
                      </button>
                    </div>
                    </div>

                    {/* Footer Removed */}
                  </div>
                )}
                {renderBlocks.map(block => {
                  if (block.kind === 'single') {
                    const m = block.item;
                    return (
                      <div key={m.id} className="group">
                        <div
                          className={cn('flex items-start gap-1', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                          {m.role === 'assistant' && <BotAvatar />}
                          {m.type === 'text' ? (
                            <div
                              className={cn(
                                'max-w-[93%] whitespace-pre-wrap break-words rounded-2xl text-left shadow-sm',
                                compactMode ? 'px-3 py-2' : 'px-4 py-3',
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
                                    messageFontSizeClass,
                                    m.role === 'user' ? 'text-white' : undefined,
                                  )}
                                  ref={editingTextareaRef}
                                />
                              ) : (
                                <StreamableMarkdown
                                  text={m.content}
                                  streaming={isStreaming && streamingMessageId === m.id}
                                  forcePlain={m.noRender === true}
                                  className={messageFontSizeClass}
                                />
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
                                'max-w-[93%] overflow-hidden rounded-2xl shadow-sm ring-1',
                                isLight ? 'ring-black/5' : 'ring-white/10',
                              )}>
                              <img src={m.dataUrl} alt="screenshot" className="block max-w-full" />
                            </div>
                          ) : (
                            <div
                              className={cn(
                                'max-w-[93%] rounded-2xl shadow-sm ring-1',
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
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => regenerateAssistantMessage(m.id)}
                                    className={cn(
                                      'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                      isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                    )}
                                    aria-label={t.write_regenerate}>
                                    ↻
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top">{t.write_regenerate}</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => copyText(m.content)}
                                    className={cn(
                                      'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                      isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                    )}
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
                                </TooltipTrigger>
                                <TooltipContent side="top">{t.write_copy}</TooltipContent>
                              </Tooltip>
                            </>
                          )}
                          {m.role === 'user' &&
                            m.type === 'text' &&
                            (editingMessageId === m.id ? (
                              <>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      onClick={saveEditMessage}
                                      className={cn(
                                        'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                        isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                      )}
                                      aria-label={t.save}>
                                      {t.save}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">{t.save}</TooltipContent>
                                </Tooltip>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <button
                                      onClick={cancelEditMessage}
                                      className={cn(
                                        'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                        isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                      )}
                                      aria-label={t.cancel}>
                                      {t.cancel}
                                    </button>
                                  </TooltipTrigger>
                                  <TooltipContent side="top">{t.cancel}</TooltipContent>
                                </Tooltip>
                              </>
                            ) : (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <button
                                    onClick={() => startEditMessage(m.id)}
                                    className={cn(
                                      'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                      isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                    )}
                                    aria-label={t.edit}>
                                    ✎
                                  </button>
                                </TooltipTrigger>
                                <TooltipContent side="top">{t.edit}</TooltipContent>
                              </Tooltip>
                            ))}
                          {m.role === 'user' && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  onClick={() => branchFromMessage(m.id)}
                                  className={cn(
                                    'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                    isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                  )}
                                  aria-label={t.branchFromHere}>
                                  ⎇
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top">{t.branchFromHere}</TooltipContent>
                            </Tooltip>
                          )}
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => deleteMessage(m.id)}
                                className={cn(
                                  'rounded-md p-1 text-gray-400 transition-colors',
                                  isLight
                                    ? 'hover:bg-slate-200 hover:text-red-600'
                                    : 'hover:bg-slate-700 hover:text-red-600',
                                )}
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
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.delete}</TooltipContent>
                          </Tooltip>
                        </div>
                      </div>
                    );
                  }
                  // group
                  const role = block.role;
                  return (
                    <div key={`g-${block.batchId}`} className="group">
                      <div className={cn('flex items-start gap-1', role === 'user' ? 'justify-end' : 'justify-start')}>
                        {role === 'assistant' && <BotAvatar />}
                        <div className="flex max-w-[93%] flex-col gap-2">
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
                                      messageFontSizeClass,
                                      role === 'user' ? 'text-white' : undefined,
                                    )}
                                    ref={editingTextareaRef}
                                  />
                                ) : (
                                  <StreamableMarkdown
                                    text={it.content}
                                    streaming={isStreaming && streamingMessageId === it.id}
                                    forcePlain={it.noRender === true}
                                    className={messageFontSizeClass}
                                  />
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
                        {role === 'user' && (
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => branchFromGroup(block.batchId)}
                                className={cn(
                                  'rounded-md px-2 py-1 text-gray-500 hover:text-violet-600',
                                  isLight ? 'hover:bg-slate-200' : 'hover:bg-slate-700',
                                )}
                                aria-label={t.branchFromHere}>
                                ⎇
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.branchFromHere}</TooltipContent>
                          </Tooltip>
                        )}
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => deleteMessageGroup(block.batchId)}
                              className={cn(
                                'rounded-md p-1 text-gray-400 transition-colors',
                                isLight
                                  ? 'hover:bg-slate-200 hover:text-red-600'
                                  : 'hover:bg-slate-700 hover:text-red-600',
                              )}
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
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.delete}</TooltipContent>
                        </Tooltip>
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
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => openPdf(item)}
                                className={cn(
                                  'rounded-md px-3 py-1 text-sm font-medium',
                                  isLight
                                    ? 'bg-violet-600 text-white hover:bg-violet-700'
                                    : 'bg-violet-600 text-white hover:bg-violet-500',
                                )}
                                aria-label={t.read_view}>
                                {t.read_view}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.read_view}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => openChatWithPdf(item)}
                                className={cn(
                                  'rounded-md px-3 py-1 text-sm font-medium',
                                  isLight
                                    ? 'bg-emerald-600 text-white hover:bg-emerald-700'
                                    : 'bg-emerald-600 text-white hover:bg-emerald-500',
                                )}
                                aria-label={t.read_chat}>
                                {t.read_chat}
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.read_chat}</TooltipContent>
                          </Tooltip>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => deletePdf(item.id)}
                                className={cn(
                                  'rounded-md p-2 text-gray-400 transition-colors',
                                  isLight
                                    ? 'hover:bg-slate-200 hover:text-red-600'
                                    : 'hover:bg-slate-700 hover:text-red-600',
                                )}
                                aria-label={t.read_delete}>
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
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.read_delete}</TooltipContent>
                          </Tooltip>
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
                      placeholder={t.write_compose_placeholder}
                      rows={4}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-gray-800',
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

                    {/* Language */}
                    <div className="flex items-center gap-4">
                      <div>
                        <div className="mb-1 text-sm font-semibold">{t.write_language}</div>
                        <div
                          className="relative inline-block"
                          onBlur={e => {
                            if (!e.currentTarget.contains(e.relatedTarget as Node)) setWriteLangOpen(false);
                          }}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                onClick={() => setWriteLangOpen(v => !v)}
                                onBlur={() => {
                                  // Ensure button blur to menu doesn't close immediately; menu wrapper handles outside blur
                                }}
                                className={cn(
                                  'inline-flex items-center gap-1 rounded-full px-3 py-1 text-sm',
                                  isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                                )}
                                aria-haspopup="listbox"
                                aria-expanded={writeLangOpen}
                                aria-label={t.write_language}>
                                <span>{writeLanguage}</span>
                                <span aria-hidden>▾</span>
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top">{t.write_language}</TooltipContent>
                          </Tooltip>
                          {writeLangOpen && (
                            <div
                              className={cn(
                                'absolute z-20 mt-2 w-56 overflow-hidden rounded-md border text-sm shadow-lg',
                                isLight
                                  ? 'border-slate-200 bg-white text-gray-900'
                                  : 'border-slate-700 bg-slate-800 text-gray-100',
                              )}
                              role="listbox">
                              {languageOptions.map(([code, flag]) => {
                                const labelKey = langLabelKeyByCode[code];
                                const englishName = languageEnglishNameByCode[code];
                                const isSelected = writeLanguage === englishName;
                                return (
                                  <button
                                    key={code}
                                    onClick={() => {
                                      setWriteLanguage(englishName);
                                      setWriteLangOpen(false);
                                    }}
                                    role="option"
                                    aria-selected={isSelected}
                                    className={cn(
                                      'flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-slate-700 dark:focus:bg-slate-700',
                                      isSelected ? 'font-semibold' : undefined,
                                    )}>
                                    <span>{flag}</span>
                                    <span className="flex-1">{t[labelKey]}</span>
                                    {isSelected && <span aria-hidden>✓</span>}
                                  </button>
                                );
                              })}
                            </div>
                          )}
                        </div>
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
                          'relative min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {isComposeStreaming && !writeComposeResult && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                              <span className="text-sm">{t.loading}</span>
                            </div>
                          </div>
                        )}
                        <StreamableMarkdown
                          text={writeComposeResult}
                          streaming={isComposeStreaming}
                          className={messageFontSizeClass}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={generateCompose}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
                              aria-label={t.write_regenerate}>
                              ↻
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_regenerate}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => copyText(writeComposeResult)}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
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
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_copy}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'revise' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeReviseInput}
                      onChange={e => setWriteReviseInput(e.target.value)}
                      placeholder={t.write_revise_placeholder}
                      rows={8}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-gray-800',
                      )}
                    />
                    <div className="flex items-center justify-end">
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
                          'relative min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {isReviseStreaming && !writeReviseResult && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                              <span className="text-sm">{t.loading}</span>
                            </div>
                          </div>
                        )}
                        <StreamableMarkdown
                          text={writeReviseResult}
                          streaming={isReviseStreaming}
                          className={messageFontSizeClass}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={optimizeRevise}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
                              aria-label={t.write_regenerate}>
                              ↻
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_regenerate}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => copyText(writeReviseResult)}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
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
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_copy}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'grammar' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeGrammarInput}
                      onChange={e => setWriteGrammarInput(e.target.value)}
                      placeholder={t.write_grammar_placeholder}
                      rows={8}
                      className={cn(
                        'w-full resize-y rounded-xl border px-3 py-2 outline-none',
                        isLight ? 'border-slate-300 bg-white' : 'border-slate-700 bg-gray-800',
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
                          'relative min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {isGrammarStreaming && !writeGrammarResult && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                              <span className="text-sm">{t.loading}</span>
                            </div>
                          </div>
                        )}
                        <StreamableMarkdown text={writeGrammarResult} streaming={isGrammarStreaming} />
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={runGrammar}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
                              aria-label={t.write_regenerate}>
                              ↻
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_regenerate}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => copyText(writeGrammarResult)}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
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
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_copy}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  </div>
                )}

                {writeTab === 'paraphrase' && (
                  <div className="space-y-4">
                    <textarea
                      value={writeParaphraseInput}
                      onChange={e => setWriteParaphraseInput(e.target.value)}
                      placeholder={t.write_paraphrase_placeholder}
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
                          'relative min-h-[140px] whitespace-pre-wrap rounded-xl p-3',
                          isLight ? 'bg-white ring-1 ring-black/10' : 'bg-slate-800 ring-1 ring-white/10',
                        )}>
                        {isParaphraseStreaming && !writeParaphraseResult && (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <div className="flex items-center gap-2 text-slate-500">
                              <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-slate-400 border-t-transparent" />
                              <span className="text-sm">{t.loading}</span>
                            </div>
                          </div>
                        )}
                        <StreamableMarkdown
                          text={writeParaphraseResult}
                          streaming={isParaphraseStreaming}
                          className={messageFontSizeClass}
                        />
                      </div>
                      <div className="mt-3 flex items-center gap-3">
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={runParaphrase}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
                              aria-label={t.write_regenerate}>
                              ↻
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_regenerate}</TooltipContent>
                        </Tooltip>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              onClick={() => copyText(writeParaphraseResult)}
                              className={cn(
                                'rounded-md px-3 py-2 text-sm',
                                isLight ? 'bg-slate-200 hover:bg-slate-300' : 'bg-slate-700 hover:bg-slate-600',
                              )}
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
                          </TooltipTrigger>
                          <TooltipContent side="top">{t.write_copy}</TooltipContent>
                        </Tooltip>
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

        {/* Inline notice about screenshot restrictions */}
        {screenshotError && (
          <div
            role="alert"
            aria-live="polite"
            className={cn(
              'mx-3 my-2 flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm transition-colors',
              isLight
                ? 'border-red-200 bg-red-50 text-red-800 hover:bg-red-100'
                : 'border-red-700 bg-red-900/40 text-red-200 hover:bg-red-900/60',
            )}>
            <button
              type="button"
              onClick={() => setScreenshotError('')}
              className={cn(
                'flex-1 rounded bg-transparent text-left outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
                isLight ? 'focus-visible:ring-red-300' : 'focus-visible:ring-red-800',
              )}
              title={t.cancel}
              aria-label={t.cancel}>
              {screenshotError}
            </button>
            <button
              onClick={e => {
                e.stopPropagation();
                setScreenshotError('');
              }}
              className={cn('rounded px-1 text-xs', isLight ? 'hover:bg-red-200/60' : 'hover:bg-red-800/50')}
              title={t.cancel}
              aria-label={t.cancel}>
              ✕
            </button>
          </div>
        )}

        {/* Tools row: show only in Ask mode */}
        {mode === 'ask' && messages.length > 0 && (
          <div className="composer-bar border-t border-slate-200 px-3 py-1 dark:border-slate-700">
            <div className="flex items-center gap-2">
              {/* Screenshot - Visible */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-tour-id="screenshot"
                    onClick={requestScreenshot}
                    className={cn(
                      'group relative inline-flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95',
                      screenshotActive
                        ? 'bg-violet-600 text-white'
                        : isLight
                          ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                          : 'bg-violet-900/40 text-violet-200 hover:bg-violet-900/60'
                    )}
                    aria-pressed={screenshotActive}
                    aria-label={t.screenshot}>
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
                      <rect x="3" y="7" width="18" height="14" rx="2" />
                      <circle cx="12" cy="14" r="4" />
                      <path d="M9 7l1.5-2h3L15 7" />
                    </svg>
                    <span>{t.screenshot || 'Screenshot'}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t.screenshot}</TooltipContent>
              </Tooltip>

              {/* New Chat - Visible */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-tour-id="new-chat"
                    onClick={onNewChat}
                    className={cn(
                      'group relative inline-flex items-center justify-center gap-2 rounded-full px-3 py-1.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 active:scale-95',
                      newChatActive
                        ? 'bg-emerald-600 text-white'
                        : isLight
                          ? 'bg-emerald-100 text-emerald-700 hover:bg-emerald-200'
                          : 'bg-emerald-900/40 text-emerald-200 hover:bg-emerald-900/60'
                    )}
                    aria-pressed={newChatActive}
                    aria-label={t.newChat}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 5v14" />
                        <path d="M5 12h14" />
                    </svg>
                    <span>{t.newChat || 'New chat'}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t.newChat}</TooltipContent>
              </Tooltip>

              {/* Menu Button for other tools */}
              <div className="relative ml-auto">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                      onClick={() => setToolsMenuOpen(v => !v)}
                    className={cn(
                      'group relative inline-flex items-center justify-center rounded-md border px-2 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95',
                         toolsMenuOpen
                            ? isLight ? 'bg-slate-200' : 'bg-slate-700'
                            : isLight ? 'bg-white hover:bg-slate-50 border-slate-300' : 'bg-slate-700 hover:bg-slate-600 border-slate-600'
                      )}
                    >
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="1" />
                        <circle cx="19" cy="12" r="1" />
                        <circle cx="5" cy="12" r="1" />
                    </svg>
                  </button>
                </TooltipTrigger>
                  <TooltipContent side="top">Tools</TooltipContent>
              </Tooltip>

                {toolsMenuOpen && (
                   <div className={cn(
                      "absolute bottom-full right-0 z-50 mb-2 w-48 rounded-xl border p-1 shadow-xl backdrop-blur-md",
                      isLight ? "bg-white/95 border-slate-200" : "bg-slate-800/95 border-slate-700"
                   )}>
                      {/* Uploads */}
                      <button onClick={() => { onClickUploadImage(); setToolsMenuOpen(false); }} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 text-left")}>
                         <span className="w-5 text-center text-lg leading-none">🖼️</span> {t.uploadImage}
                    </button>
                      <button onClick={() => { onClickUploadFile(); setToolsMenuOpen(false); }} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 text-left")}>
                         <span className="w-5 text-center text-lg leading-none">📄</span> {t.uploadFile}
                    </button>
                      <div className="my-1 border-t border-black/10 dark:border-white/10" />
                      {/* Web Access Toggle */}
                      <button onClick={() => setWebAccessEnabled(v => !v)} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 text-left")}>
                         <div className="flex items-center gap-2"><span className="w-5 text-center text-lg leading-none">🌐</span> {t.webAccess}</div>
                         <div className={cn("h-3 w-3 rounded-full", webAccessEnabled ? "bg-emerald-500" : "bg-gray-300 dark:bg-gray-600")} />
                      </button>
                      {/* Model Toggle */}
                       <button onClick={() => setLlmModel(v => v === 'quick' ? 'deep' : 'quick')} className={cn("flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm hover:bg-black/5 dark:hover:bg-white/10 text-left")}>
                         <div className="flex items-center gap-2"><span className="w-5 text-center text-lg leading-none">🧠</span> {t.model}</div>
                         <span className="text-xs opacity-60 uppercase">{llmModel}</span>
                    </button>
                  </div>
                )}
                {/* Backdrop to close menu */}
                {toolsMenuOpen && (
                   <div className="fixed inset-0 z-40" onClick={() => setToolsMenuOpen(false)} />
                )}
              </div>

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

        {/* Composer: hide on welcome screen (no messages) */}
        {mode === 'ask' && messages.length > 0 && (
          <div className="composer-bar border-t border-slate-200 px-3 py-2 dark:border-slate-700">
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
                onFocus={() => setIsInputFocused(true)}
                data-tour-id="composer"
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onComposerPaste}
                rows={compactMode ? 1 : 2}
                placeholder={t.placeholder}
                className={cn(
                  'w-full resize-none rounded-md border px-3 pb-12 pr-24 pt-2 text-lg outline-none',
                  compactMode ? 'max-h-32 min-h-[48px]' : 'max-h-40 min-h-[64px]',
                  isLight
                    ? 'border-slate-300 bg-white text-gray-900 focus:border-violet-500 focus:ring-1 focus:ring-violet-500'
                    : 'border-slate-600 bg-gray-800 text-gray-100 focus:border-violet-400 focus:ring-1 focus:ring-violet-400',
                )}
              />
              {input.trim().length > 0 && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={clearComposer}
                      className={cn(
                        'group absolute bottom-2 right-12 inline-flex h-8 w-8 items-center justify-center rounded-md text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95',
                        isLight
                          ? 'bg-slate-200 text-gray-700 hover:bg-slate-300'
                          : 'bg-slate-600 text-gray-100 hover:bg-slate-500',
                      )}
                      aria-label={t.clear}>
                      <svg
                        aria-hidden="true"
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        className="h-4 w-4 group-hover:text-red-600">
                        <path d="M3 6h18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <path
                          d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                        <path
                          d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t.clear}</TooltipContent>
                </Tooltip>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    data-tour-id="send"
                    onClick={isStreaming ? cancelStreaming : handleSend}
                    disabled={!canSend && !isStreaming}
                    className={cn(
                      'group absolute bottom-2 right-2 inline-flex h-8 w-8 items-center justify-center rounded-md text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 active:scale-95',
                      isStreaming
                        ? 'bg-slate-500 text-white hover:bg-red-600'
                        : canSend
                          ? 'bg-violet-600 text-white hover:bg-violet-700'
                          : 'bg-gray-400 text-white opacity-60',
                    )}
                    aria-label={isStreaming ? t.cancel : t.send}>
                    {isStreaming ? (
                      <span
                        aria-hidden="true"
                        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-white/90 border-t-transparent"
                      />
                    ) : (
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
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{isStreaming ? t.cancel : t.send}</TooltipContent>
              </Tooltip>
            </div>
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
                    role="button"
                    tabIndex={0}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        activateThread(th.id);
                        setHistorySheetOpen(false);
                      }
                    }}
                    onClick={() => {
                      activateThread(th.id);
                      setHistorySheetOpen(false);
                    }}
                    className={cn(
                      'flex w-full cursor-pointer items-center gap-2 px-3 py-2 hover:bg-slate-100 dark:hover:bg-slate-700',
                      activeId === th.id ? 'font-semibold' : undefined,
                    )}>
                    <div className="flex min-w-0 flex-1 items-start gap-2 text-left">
                      <div className="flex-1 truncate">
                        <div className="truncate">{th.title || (uiLocale === 'ru' ? 'Без названия' : 'Untitled')}</div>
                      </div>
                      <div className="ml-2 whitespace-nowrap text-xs opacity-70">
                        {new Date(th.updatedAt).toLocaleString()}
                      </div>
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          onClick={e => {
                            e.stopPropagation();
                            deleteThread(th.id);
                          }}
                          className={cn(
                            'rounded-md p-1 text-gray-400 transition-colors',
                            isLight ? 'hover:bg-slate-200 hover:text-red-600' : 'hover:bg-slate-700 hover:text-red-600',
                          )}
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
                      </TooltipTrigger>
                      <TooltipContent side="top">{t.deleteChat}</TooltipContent>
                    </Tooltip>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
      {/* Onboarding tour overlay */}
      <OnboardingTour
        open={tourOpen}
        steps={tourSteps}
        onClose={() => {
          setTourOpen(false);
          void chrome.storage?.local.set({ [STORAGE_KEYS.onboardingDone]: true });
        }}
      />
    </div>
  );
};

export default withErrorBoundary(withSuspense(SidePanel, <LoadingSpinner />), ErrorDisplay);
