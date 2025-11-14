import inlineCss from '../../../dist/all/index.css?inline';
import { initAppWithShadow } from '@extension/shared';
import App from '@/matches/all/App';

initAppWithShadow({ id: 'CEB-extension-runtime-all', app: <App />, inlineCss });
