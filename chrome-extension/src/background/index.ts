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
    // Use our tracked state to determine if we should close or open
    // This avoids the issue where getOptions().enabled is true but the panel was manually closed by the user
    const isKnownOpen = tabIdToPanelOpenState.get(tabId) ?? false;
    console.debug(`${LOG_PREFIX} toggle state`, { isKnownOpen });

    const hasSetOptions = typeof (chrome.sidePanel as { setOptions?: unknown }).setOptions === 'function';
    const hasOpen = typeof (chrome.sidePanel as { open?: unknown }).open === 'function';

    if (isKnownOpen) {
      // If we think it's open, try to close it by disabling
      if (hasSetOptions) {
        console.debug(`${LOG_PREFIX} closing side panel via setOptions({ enabled: false })`);
        await chrome.sidePanel.setOptions!({ tabId, enabled: false });
      } else {
        console.debug(`${LOG_PREFIX} cannot close: setOptions not available`);
      }
    } else {
      // If we think it's closed, enable and open
      if (hasSetOptions) {
        console.debug(`${LOG_PREFIX} enabling side panel via setOptions({ enabled: true })`);
        await chrome.sidePanel.setOptions!({ tabId, enabled: true, path: 'side-panel/index.html' });
      }
      if (hasOpen) {
        console.debug(`${LOG_PREFIX} opening side panel via open({ tabId })`);
        await chrome.sidePanel.open!({ tabId });
      } else {
        console.debug(`${LOG_PREFIX} cannot open: open() not available`);
      }
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
        tabUrl.startsWith('chrome-search://') ||
        tabUrl.startsWith('edge://') ||
        tabUrl.startsWith('brave://') ||
        tabUrl.startsWith('vivaldi://') ||
        tabUrl.startsWith('opera://') ||
        tabUrl.startsWith('about:') ||
        tabUrl.startsWith('chrome-extension://') ||
        /^https?:\/\/chrome\.google\.com\//.test(tabUrl);
      if (isRestrictedUrl) {
        console.warn(`${LOG_PREFIX} cannot inject content script on restricted URL`, { tabUrl });
        chrome.runtime
          .sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'restricted', url: tabUrl })
          .catch(() => undefined);
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
                    chrome.runtime
                      .sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'inject_failed', url: tabUrl })
                      .catch(() => undefined);
                    return;
                  }
                  // Retry shortly after successful injection to ensure listeners are ready
                  setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, { type: 'BEGIN_SELECTION' }, () => {
                      const retryError = chrome.runtime.lastError;
                      if (retryError) {
                        console.error(`${LOG_PREFIX} Retry BEGIN_SELECTION failed`, retryError);
                        chrome.runtime
                          .sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'retry_failed', url: tabId })
                          .catch(() => undefined);
                      } else {
                        console.debug(`${LOG_PREFIX} BEGIN_SELECTION delivered after injection`, { tabId });
                      }
                    });
                  }, 80);
                });
              } catch (e) {
                console.error(`${LOG_PREFIX} executeScript threw`, e);
                chrome.runtime
                  .sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'execute_threw', url: tabId })
                  .catch(() => undefined);
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
    const { bounds, autoSend } = message as {
      bounds?: { x: number; y: number; width: number; height: number; dpr: number };
      autoSend?: boolean;
    };
    console.debug(`${LOG_PREFIX} SCREENSHOT_SELECTION`, bounds);
    chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }, dataUrl => {
      if (!dataUrl) {
        console.error(`${LOG_PREFIX} captureVisibleTab returned empty dataUrl`, chrome.runtime.lastError);
        return;
      }
      console.debug(`${LOG_PREFIX} captureVisibleTab OK`);

      // Save to storage for side panel to pick up
      const pending = { dataUrl, bounds, autoSend, timestamp: Date.now() };
      chrome.storage.local.set({ pendingScreenshot: pending }).then(() => {
        console.debug(`${LOG_PREFIX} pendingScreenshot saved, opening side panel`);
        if (typeof tabId === 'number') {
          chrome.sidePanel.open({ tabId }).catch(err => {
            console.error(`${LOG_PREFIX} Failed to open side panel from background`, err);
          });
        }
      });

      chrome.runtime.sendMessage({ type: 'SCREENSHOT_CAPTURED', dataUrl, bounds, autoSend }).catch(() => undefined);
    });
    return;
  }

  if (typeof tabId !== 'number') {
    console.debug(`${LOG_PREFIX} no sender.tab.id; message ignored`);
    return;
  }

  if (message?.type === 'OPEN_SIDE_PANEL') {
    try {
      // Enable first, then open
      await chrome.sidePanel.setOptions?.({ tabId, enabled: true, path: 'side-panel/index.html' });
      await chrome.sidePanel.open?.({ tabId });
      tabIdToPanelOpenState.set(tabId, true);
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_OPENED' });
      console.debug(`${LOG_PREFIX} OPEN_SIDE_PANEL done`);
    } catch (error) {
      console.error(`${LOG_PREFIX} OPEN_SIDE_PANEL failed`, error);
    }
    return;
  }

  if (message?.type === 'CLOSE_SIDE_PANEL') {
    try {
      await chrome.sidePanel.setOptions?.({ tabId, enabled: false });
      tabIdToPanelOpenState.set(tabId, false);
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_CLOSED' });
      console.debug(`${LOG_PREFIX} CLOSE_SIDE_PANEL done`);
    } catch (error) {
      console.error(`${LOG_PREFIX} CLOSE_SIDE_PANEL failed`, error);
    }
    return;
  }

  if (message?.type === 'TOGGLE_SIDE_PANEL') {
    // Fallback if client logic is insufficient
    void toggleSidePanelForTab(tabId);
  }
});

// Install tracking
// Open welcome page on first install
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    try {
      chrome.tabs.create({ url: 'http://aihomeworkhelper.tilda.ws/' });
    } catch (error) {
      console.error(`${LOG_PREFIX} onInstalled open welcome error`, error);
    }
  }
});

// Keep track of connected external ports from allowed domains
// Removed external connections from onlineapp.* domains

// Removed analytics helpers referencing onlineapp.pro

// Removed broadcast notify to external clients

// Removed external message handler for onlineapp.* domains
