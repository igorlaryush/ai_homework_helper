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
    const isKnownOpen = tabIdToPanelOpenState.get(tabId) ?? false;
    console.debug(`${LOG_PREFIX} toggle state`, { isKnownOpen });

    const hasSetOptions = typeof (chrome.sidePanel as { setOptions?: unknown }).setOptions === 'function';
    const hasOpen = typeof (chrome.sidePanel as { open?: unknown }).open === 'function';

    if (isKnownOpen) {
      if (hasSetOptions) {
        console.debug(`${LOG_PREFIX} closing side panel via setOptions({ enabled: false })`);
        await chrome.sidePanel.setOptions!({ tabId, enabled: false });
      } else {
        console.debug(`${LOG_PREFIX} cannot close: setOptions not available`);
      }
    } else {
      if (hasSetOptions) {
        console.debug(`${LOG_PREFIX} enabling side panel via setOptions({ enabled: true })`);
        // Note: We enable it first. The actual open might require a user gesture which this function might not have
        // if it's called deeply async. But typically toggle is called from a shortcut or similar.
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


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.debug(`${LOG_PREFIX} onMessage`, message, { senderTabId: sender.tab?.id });
  
  const tabId = sender.tab?.id;

    // OPTIMISTIC OPEN: Call chrome.sidePanel.open synchronously if possible to capture user gesture
  if (message?.type === 'OPEN_SIDE_PANEL' && typeof tabId === 'number') {
    console.debug(`${LOG_PREFIX} synchronous OPEN_SIDE_PANEL attempt`);
    
    // To satisfy "user gesture" requirement, we must call open() immediately in the synchronous tick.
    // We cannot await setOptions(). 
    // Strategy: Fire open() immediately (it might fail if not enabled), AND fire setOptions().
    // If open() fails because not enabled, we retry it in the callback of setOptions (though that might lose gesture).
    // BUT: If we set openPanelOnActionClick: true globally, we might not need explicit open() if it was a click?
    // No, this is a custom button.
    
    // Best chance: 
    // 1. Enable it (fire and forget promise)
    // 2. Open it (synchronously / immediately)
    
    // Check if we should skip setOptions if panel is already active?
    // chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'side-panel/index.html' });
    
    try {
        // Try opening first; if it fails, we might need to enable it
        chrome.sidePanel.open({ tabId });
        console.debug(`${LOG_PREFIX} open() called synchronously`);
    } catch (err) {
        console.warn(`${LOG_PREFIX} synchronous open() failed, trying setOptions`, err);
        chrome.sidePanel.setOptions({ tabId, enabled: true, path: 'side-panel/index.html' })
            .then(() => {
                 // Retry open? Usually user gesture is gone by now.
                 console.debug(`${LOG_PREFIX} setOptions done`);
            });
    }
      
    // We also allow handleMessage to run to update state and send events.
  }

  // Handle message asynchronously
  handleMessage(message, sender)
    .then(response => {
      if (response !== undefined) sendResponse(response);
    })
    .catch(error => {
      console.error(`${LOG_PREFIX} handleMessage error`, error);
    });

  return true; // Keep channel open for async response
});

const handleMessage = async (msg: unknown, sender: chrome.runtime.MessageSender) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = msg as any;
  const tabId = sender.tab?.id;

  if (message?.type === 'IS_SIDE_PANEL_OPEN') {
    if (typeof tabId === 'number') {
      const isOpen = tabIdToPanelOpenState.get(tabId) ?? false;
      void chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_STATE', isOpen });
    }
    return;
  }

  if (message?.type === 'SCREENSHOT_REQUEST') {
    const { autoSend } = message;
    console.debug(`${LOG_PREFIX} SCREENSHOT_REQUEST received`, { autoSend });
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    const activeTabId = activeTab?.id;
    const tabUrl = activeTab?.url ?? '';

    if (typeof activeTabId !== 'number') {
      console.warn(`${LOG_PREFIX} no activeTab for BEGIN_SELECTION`);
      await chrome.runtime.sendMessage({ type: 'SCREENSHOT_CANCELLED' }).catch(() => undefined);
      return;
    }

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
      await chrome.runtime.sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'restricted', url: tabUrl }).catch(() => undefined);
      return;
    }

    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'BEGIN_SELECTION', autoSend });
      console.debug(`${LOG_PREFIX} BEGIN_SELECTION delivered`, { activeTabId });
    } catch (error) {
       console.warn(`${LOG_PREFIX} BEGIN_SELECTION send failed; attempting injection`, error);
       try {
         await chrome.scripting.executeScript({ target: { tabId: activeTabId }, files: ['content-ui/all.iife.js'] });
         // Retry shortly after injection
         setTimeout(() => {
            chrome.tabs.sendMessage(activeTabId, { type: 'BEGIN_SELECTION', autoSend })
                .catch(e => console.error(`${LOG_PREFIX} Retry BEGIN_SELECTION failed`, e));
         }, 100);
       } catch (injectError) {
         console.error(`${LOG_PREFIX} executeScript failed`, injectError);
         await chrome.runtime.sendMessage({ type: 'SCREENSHOT_NOT_ALLOWED', reason: 'inject_failed', url: tabUrl }).catch(() => undefined);
       }
    }
    return;
  }

  if (message?.type === 'SCREENSHOT_SELECTION') {
    const { bounds, autoSend } = message;
    console.debug(`${LOG_PREFIX} SCREENSHOT_SELECTION`, bounds);
    
    const dataUrl = await new Promise<string>(resolve => {
      chrome.tabs.captureVisibleTab(chrome.windows.WINDOW_ID_CURRENT, { format: 'png' }, resolve);
    });

    if (!dataUrl) {
      console.error(`${LOG_PREFIX} captureVisibleTab returned empty dataUrl`, chrome.runtime.lastError);
      return;
    }
    
    const pending = { dataUrl, bounds, autoSend, timestamp: Date.now() };
    await chrome.storage.local.set({ pendingScreenshot: pending });
    console.debug(`${LOG_PREFIX} pendingScreenshot saved, opening side panel`);
    
    if (typeof tabId === 'number') {
      await chrome.sidePanel.open({ tabId }).catch(err => {
         console.debug(`${LOG_PREFIX} Failed to open side panel from background (non-fatal)`, err);
      });
    }
    await chrome.runtime.sendMessage({ type: 'SCREENSHOT_CAPTURED', dataUrl, bounds, autoSend }).catch(() => undefined);
    return;
  }

  if (typeof tabId !== 'number') {
    console.debug(`${LOG_PREFIX} no sender.tab.id; message ignored`);
    return;
  }

  if (message?.type === 'OPEN_SIDE_PANEL') {
    // Logic handled mostly in synchronous block, but we update state here
    try {
      console.debug(`${LOG_PREFIX} OPEN_SIDE_PANEL (async update)`);
      // We do NOT call open() here again to avoid "User gesture required" error 
      // if the async gap killed the token.
      // But we do update state.
      tabIdToPanelOpenState.set(tabId, true);
      await chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_OPENED' });
      return { success: true };
    } catch (error) {
      console.error(`${LOG_PREFIX} OPEN_SIDE_PANEL async part failed`, error);
      throw error;
    }
  }

  if (message?.type === 'CLOSE_SIDE_PANEL') {
    try {
      await chrome.sidePanel.setOptions({ tabId, enabled: false });
      tabIdToPanelOpenState.set(tabId, false);
      await chrome.tabs.sendMessage(tabId, { type: 'SIDE_PANEL_CLOSED' });
      console.debug(`${LOG_PREFIX} CLOSE_SIDE_PANEL done`);
      return { success: true };
    } catch (error) {
      console.error(`${LOG_PREFIX} CLOSE_SIDE_PANEL failed`, error);
      throw error;
    }
  }

  if (message?.type === 'TOGGLE_SIDE_PANEL') {
    await toggleSidePanelForTab(tabId);
    return { success: true };
  }
  
  return undefined;
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    try {
      chrome.tabs.create({ url: 'http://aihomeworkhelper.tilda.ws/' });
    } catch (error) {
      console.error(`${LOG_PREFIX} onInstalled open welcome error`, error);
    }
  }
});
