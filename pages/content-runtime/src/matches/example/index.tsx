import inlineCss from '../../../dist/example/index.css?inline';
import { initAppWithShadow } from '@extension/shared';
import App from '@/matches/example/App';

initAppWithShadow({ id: 'CEB-extension-runtime-example', app: <App />, inlineCss });
