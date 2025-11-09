import 'webextension-polyfill';
import { exampleThemeStorage } from '@extension/storage';

const LOG_PREFIX = '[CEB][BG]';

// Track open-state per tab (best-effort; there is no official open/close event)
const tabIdToPanelOpenState = new Map<number, boolean>();
const portIdToTabId = new Map<number, number>();
let nextPortId = 1;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .then(() => console.debug(`${LOG_PREFIX} setPanelBehavior(openPanelOnActionClick: true) done`))
  .catch(error => console.error(`${LOG_PREFIX} setPanelBehavior error`, error));

exampleThemeStorage.get().then(theme => {
  console.log('theme', theme);
});

console.log('Background loaded');
console.debug(
  `${LOG_PREFIX} sidePanel API keys`,
  Object.keys((chrome as unknown as { sidePanel?: unknown }).sidePanel ?? {}),
);
console.log("Edit 'chrome-extension/src/background/index.ts' and save to reload.");

// When the side panel page connects, mark panel as open for the active tab of that window
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'side-panel') return;
  const portId = nextPortId++;
  console.debug(`${LOG_PREFIX} onConnect from side-panel`, { portId });

  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    const tab = tabs[0];
    if (!tab?.id) return;
    tabIdToPanelOpenState.set(tab.id, true);
    portIdToTabId.set(portId, tab.id);
    void chrome.tabs.sendMessage(tab.id, { type: 'SIDE_PANEL_OPENED' });
  });

  port.onDisconnect.addListener(() => {
    const tabId = portIdToTabId.get(portId);
    console.debug(`${LOG_PREFIX} side-panel port disconnected`, { portId, tabId });
    if (typeof tabId === 'number') {
      tabIdToPanelOpenState.set(tabId, false);
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_CLOSED' });
      portIdToTabId.delete(portId);
    }
  });
});

const toggleSidePanelForTab = async (tabId: number): Promise<void> => {
  console.debug(`${LOG_PREFIX} toggleSidePanelForTab start`, { tabId });
  try {
    const hasGetOptions = typeof (chrome.sidePanel as { getOptions?: unknown }).getOptions === 'function';
    const hasSetOptions = typeof (chrome.sidePanel as { setOptions?: unknown }).setOptions === 'function';
    const hasOpen = typeof (chrome.sidePanel as { open?: unknown }).open === 'function';
    console.debug(`${LOG_PREFIX} API availability`, { hasGetOptions, hasSetOptions, hasOpen });

    let isEnabled: boolean | undefined;
    if (hasGetOptions) {
      try {
        const options = await chrome.sidePanel.getOptions!({ tabId });
        console.debug(`${LOG_PREFIX} getOptions ->`, options);
        isEnabled = options?.enabled;
      } catch (err) {
        console.error(`${LOG_PREFIX} getOptions error`, err);
      }
    } else {
      console.debug(`${LOG_PREFIX} getOptions not available`);
    }

    if (isEnabled === true) {
      if (hasSetOptions) {
        console.debug(`${LOG_PREFIX} disabling side panel via setOptions({ enabled: false })`);
        await chrome.sidePanel.setOptions!({ tabId, enabled: false });
        tabIdToPanelOpenState.set(tabId, false);
        void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_CLOSED' });
        console.debug(`${LOG_PREFIX} disabled side panel`);
      } else {
        console.debug(`${LOG_PREFIX} setOptions not available; cannot disable`);
      }
      return;
    }

    if (hasSetOptions) {
      console.debug(`${LOG_PREFIX} enabling side panel via setOptions({ enabled: true, path })`);
      await chrome.sidePanel.setOptions!({ tabId, enabled: true, path: 'side-panel/index.html' });
      console.debug(`${LOG_PREFIX} enabled side panel with path`);
    } else {
      console.debug(`${LOG_PREFIX} setOptions not available; skipping enable`);
    }

    if (hasOpen) {
      console.debug(`${LOG_PREFIX} opening side panel via open({ tabId })`);
      await chrome.sidePanel.open!({ tabId });
      tabIdToPanelOpenState.set(tabId, true);
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_OPENED' });
      console.debug(`${LOG_PREFIX} open resolved`);
    } else {
      console.debug(`${LOG_PREFIX} open not available; cannot open`);
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} Failed to toggle side panel`, error);
  }
};

chrome.runtime.onMessage.addListener((message, sender) => {
  console.debug(`${LOG_PREFIX} onMessage`, message, { senderTabId: sender.tab?.id });
  const tabId = sender.tab?.id;

  if (message?.type === 'IS_SIDE_PANEL_OPEN') {
    if (typeof tabId === 'number') {
      const isOpen = tabIdToPanelOpenState.get(tabId) ?? false;
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_STATE', isOpen });
    }
    return;
  }

  // Screenshot request from side panel: ask the active tab to show selection overlay
  if (message?.type === 'SCREENSHOT_REQUEST') {
    console.debug(`${LOG_PREFIX} SCREENSHOT_REQUEST received`);
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const activeTab = tabs[0];
      const tabId = activeTab?.id;
      const tabUrl = activeTab?.url ?? '';

      if (typeof tabId !== 'number') {
        console.warn(`${LOG_PREFIX} no activeTab for BEGIN_SELECTION`);
        chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
        return;
      }

      // Some pages are restricted and do not allow content scripts
      const isRestrictedUrl =
        tabUrl.startsWith('chrome://') ||
        tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('about:') ||
        tabUrl.startsWith('chrome-extension://') ||
        /^https?:\/\/chrome\.google\.com\//.test(tabUrl);
      if (isRestrictedUrl) {
        console.warn(`${LOG_PREFIX} cannot inject content script on restricted URL`, { tabUrl });
        chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
        return;
      }

      const sendBeginSelection = () => {
        try {
          chrome.tabs.sendMessage(tabId, { type: 'BEGIN_SELECTION' }, () => {
            const error = chrome.runtime.lastError;
            if (error) {
              console.warn(`${LOG_PREFIX} BEGIN_SELECTION send failed; attempting injection`, error);
              try {
                chrome.scripting.executeScript({ target: { tabId }, files: ['content-ui/all.iife.js'] }, () => {
                  const injectError = chrome.runtime.lastError;
                  if (injectError) {
                    console.error(`${LOG_PREFIX} executeScript failed`, injectError);
                    chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
                    return;
                  }
                  // Retry shortly after successful injection to ensure listeners are ready
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { type: 'BEGIN_SELECTION' }, () => {
                      const retryError = chrome.runtime.lastError;
                      if (retryError) {
                        console.error(`${LOG_PREFIX} Retry BEGIN_SELECTION failed`, retryError);
                        chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
                      } else {
                        console.debug(`${LOG_PREFIX} BEGIN_SELECTION delivered after injection`, { tabId });
                      }
                    });
                  }, 80);
                });
              } catch (e) {
                console.error(`${LOG_PREFIX} executeScript threw`, e);
                chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
              }
            } else {
              console.debug(`${LOG_PREFIX} BEGIN_SELECTION delivered`, { tabId });
            }
          });
        } catch (e) {
          console.error(`${LOG_PREFIX} tabs.sendMessage threw`, e);
          chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
        }
      };

      console.debug(`${LOG_PREFIX} sending BEGIN_SELECTION to tab`, { tabId });
      sendBeginSelection();
    });
    return;
  }

  // Selection result from content script: capture visible tab and forward to side panel
  if (message?.type === 'SCREENSHOT_SELECTION') {
    const { bounds } = message as { bounds?: { x: number; y: number; width: number; height: number; dpr: number } };
    console.debug(`${LOG_PREFIX} SCREENSHOT_SELECTION`, bounds);
    chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }, dataUrl => {
      if (!dataUrl) {
        console.error(`${LOG_PREFIX} captureVisibleTab returned empty dataUrl`, chrome.runtime.lastError);
        return;
      }
      console.debug(`${LOG_PREFIX} captureVisibleTab OK, sending SCREENSHOT_CAPTURED`);
      chrome.runtime.sendMessage({ type: 'SCREENSHOT_CAPTURED', dataUrl, bounds }).catch(() => undefined);
    });
    return;
  }

  if (typeof tabId !== 'number') {
    console.debug(`${LOG_PREFIX} no sender.tab.id; message ignored`);
    return;
  }

  if (message?.type === 'OPEN_SIDE_PANEL') {
    try {
      chrome.sidePanel
        .open?.({ tabId })
        .then(() => {
          tabIdToPanelOpenState.set(tabId, true);
          void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_OPENED' });
          console.debug(`${LOG_PREFIX} open() resolved (OPEN_SIDE_PANEL)`);
        })
        .catch(error => console.error(`${LOG_PREFIX} open() error (OPEN_SIDE_PANEL)`, error));
      void chrome.sidePanel.setOptions?.({ tabId, enabled: true, path: 'side-panel/index.html' });
    } catch (error) {
      console.error(`${LOG_PREFIX} immediate open() threw (OPEN_SIDE_PANEL)`, error);
    }
    return;
  }

  if (message?.type === 'TOGGLE_SIDE_PANEL') {
    void toggleSidePanelForTab(tabId);
  }
});

// Install tracking
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason === 'install') {
    trackEvent('install');
  }
});

// Keep track of connected external ports from allowed domains
const connectedPorts = new Set<chrome.runtime.Port>();

chrome.runtime.onConnectExternal.addListener(port => {
  const originOrUrl = (port.sender?.origin as string | undefined) ?? port.sender?.url ?? '';
  if (
    originOrUrl.includes('onlineapp.pro') ||
    originOrUrl.includes('onlineapp.live') ||
    originOrUrl.includes('onlineapp.stream')
  ) {
    connectedPorts.add(port);
    port.onDisconnect.addListener(() => {
      connectedPorts.delete(port);
    });
  } else {
    console.warn('Connection attempt from unauthorized domain:', originOrUrl);
    try {
      port.disconnect();
    } catch {
      // ignore
    }
  }
});

const getUserId = (callback: (userId: string) => void): void => {
  chrome.storage.sync.get(['user_id'], result => {
    if (result.user_id) {
      callback(result.user_id as string);
    } else {
      const userId = crypto.randomUUID();
      chrome.storage.sync.set({ user_id: userId, ['pw-680-visitor-id']: userId }, () => {
        callback(userId);
      });
    }
  });
};

const trackEvent = (eventName: string, additionalData: Record<string, unknown> = {}): void => {
  getUserId(userId => {
    fetch('https://onlineapp.pro/api/track-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: eventName,
        wallId: 680,
        extensionId: chrome.runtime.id,
        userId,
        ...additionalData,
      }),
    }).catch(error => {
      console.error('trackEvent error:', error);
    });
  });
};

const notifyConnectedClients = (notification: unknown): void => {
  connectedPorts.forEach(port => {
    try {
      port.postMessage(notification as never);
    } catch (error) {
      console.error('Error sending notification to port:', error);
      connectedPorts.delete(port);
    }
  });
};

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  const originOrUrl = (sender.origin as string | undefined) ?? sender.url ?? '';
  if (
    originOrUrl.includes('onlineapp.pro') ||
    originOrUrl.includes('onlineapp.live') ||
    originOrUrl.includes('onlineapp.stream')
  ) {
    if (message?.source === 'supabase-auth-adapter') {
      switch (message?.action) {
        case 'ping':
          sendResponse({ status: 'ok' });
          break;
        case 'getItem': {
          try {
            const { key } = message.data ?? {};
            chrome.storage.sync.get(key, result => {
              if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message;
                console.error('Storage error:', errorMessage);
                sendResponse({ status: 'error', message: errorMessage });
              } else {
                sendResponse({ status: 'success', value: (result as Record<string, unknown>)[key] ?? null });
              }
            });
            return true;
          } catch (error) {
            console.error('Error in getItem:', error);
            sendResponse({ status: 'error', message: (error as Error).message });
          }
          break;
        }
        case 'setItem': {
          try {
            const { key, value } = message.data ?? {};
            chrome.storage.sync.set({ [key]: value }, () => {
              if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message;
                console.error('Storage error:', errorMessage);
                sendResponse({ status: 'error', message: errorMessage });
              } else {
                sendResponse({ status: 'success' });
                notifyConnectedClients({
                  type: 'storage_update',
                  action: 'set',
                  key,
                  value,
                  timestamp: Date.now(),
                });
              }
            });
            return true;
          } catch (error) {
            console.error('Error in setItem:', error);
            sendResponse({ status: 'error', message: (error as Error).message });
          }
          break;
        }
        case 'removeItem': {
          try {
            const { key } = message.data ?? {};
            chrome.storage.sync.remove(key, () => {
              if (chrome.runtime.lastError) {
                const errorMessage = chrome.runtime.lastError.message;
                console.error('Storage error:', errorMessage);
                sendResponse({ status: 'error', message: errorMessage });
              } else {
                notifyConnectedClients({
                  type: 'storage_update',
                  action: 'remove',
                  key,
                  timestamp: Date.now(),
                });
                sendResponse({ status: 'success' });
              }
            });
            return true;
          } catch (error) {
            console.error('Error in removeItem:', error);
            sendResponse({ status: 'error', message: (error as Error).message });
          }
          break;
        }
        default:
          console.warn('Unknown action:', message?.action);
          sendResponse({ status: 'error', message: 'Unknown action' });
          break;
      }
    } else if (message?.type === 'broadcast') {
      notifyConnectedClients(message?.data ?? message);
      sendResponse({
        status: 'success',
        message: 'Message broadcasted successfully',
        clientsCount: connectedPorts.size,
      });
    } else {
      console.warn('Message has neither source nor type');
      sendResponse({ status: 'error', message: 'Invalid message format' });
    }
  } else {
    console.warn('Message from unauthorized domain:', originOrUrl);
    sendResponse({ status: 'error', message: 'Unauthorized domain' });
  }

  return true;
});
