import '@/index.css';
import { TooltipProvider } from '@/components/ui/tooltip';
import SidePanel from '@/SidePanel';
import { createRoot } from 'react-dom/client';

const LOG_PREFIX = '[CEB][SidePanel]';

const init = () => {
  try {
    const port = chrome.runtime.connect({ name: 'side-panel' });
    port.postMessage({ type: 'SIDE_PANEL_PORT_OPEN' });
    console.debug(`${LOG_PREFIX} port connected`);
    port.onDisconnect.addListener(() => {
      console.debug(`${LOG_PREFIX} port disconnected`);
    });
  } catch (error) {
    console.error(`${LOG_PREFIX} port connect error`, error);
  }

  const appContainer = document.querySelector('#app-container');
  if (!appContainer) {
    throw new Error('Can not find #app-container');
  }
  const root = createRoot(appContainer);
  root.render(
    <TooltipProvider>
      <SidePanel />
    </TooltipProvider>,
  );
};

init();
