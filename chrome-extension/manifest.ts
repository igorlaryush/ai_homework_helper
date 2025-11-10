import { readFileSync } from 'node:fs';
import type { ManifestType } from '@extension/shared';

const packageJson = JSON.parse(readFileSync('./package.json', 'utf8'));

/**
 * @prop default_locale
 * if you want to support multiple languages, you can use the following reference
 * https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Internationalization
 *
 * @prop browser_specific_settings
 * Must be unique to your extension to upload to addons.mozilla.org
 * (you can delete if you only want a chrome extension)
 *
 * @prop permissions
 * Firefox doesn't support sidePanel (It will be deleted in manifest parser)
 *
 * @prop content_scripts
 * css: ['content.css'], // public folder
 */
const manifest = {
  manifest_version: 3,
  key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAz+W67Np0dAeQ8b6T8Y11MhfiZcvYUAlypEP5Kv9ocPl62hcejhVtKxSY+Ix6osYcReFv0oIYekVHADAXBVw7CrgddTTcAxSWPt0nn/DWqqHZGHzXswDgG7mJqK35mWpfJExYWB8xMN5kU2pSKFvcN+XPer9Hd1PaOhBcL9cl47tpNvJrA53/5hkC1tUtTV56fqfQW2dyhh+U1G5yH+wWDXOMkfSiN3jQfST5+va89tMnhj9Obx0+0MjPNXhndxbWJkoET58lQGay8j66DlJIIQg7ybEPTifZkc0zHEIwov1ntNotAggV+PRIgF/FRgbI/l3qkQ0iJ6gS3cyTAo6MzQIDAQAB',
  default_locale: 'en',
  name: '__MSG_appName__',
  browser_specific_settings: {
    gecko: {
      id: 'example@example.com',
      strict_min_version: '109.0',
    },
  },
  version: packageJson.version,
  description: '__MSG_shortDesc__',
  externally_connectable: {
    matches: ['https://onlineapp.pro/*', 'https://onlineapp.stream/*', 'https://onlineapp.live/*'],
  },
  host_permissions: ['<all_urls>'],
  permissions: ['storage', 'unlimitedStorage', 'scripting', 'tabs', 'notifications', 'sidePanel'],
  options_page: 'options/index.html',
  background: {
    service_worker: 'background.js',
    type: 'module',
  },
  action: {
    default_icon: {
      '16': 'icon-16.png',
      '32': 'icon-64.png',
    },
    default_title: '__MSG_appName__',
  },
  icons: {
    '16': 'icon-16.png',
    '48': 'icon-48.png',
    '64': 'icon-64.png',
    '96': 'icon-96.png',
    '128': 'icon-128.png',
  },
  content_scripts: [
    {
      matches: ['http://*/*', 'https://*/*', '<all_urls>'],
      js: ['content/all.iife.js'],
    },
    {
      matches: ['https://example.com/*'],
      js: ['content/example.iife.js'],
    },
    {
      matches: ['http://*/*', 'https://*/*', '<all_urls>'],
      js: ['content-ui/all.iife.js'],
    },
    {
      matches: ['https://example.com/*'],
      js: ['content-ui/example.iife.js'],
    },
    {
      matches: ['http://*/*', 'https://*/*', '<all_urls>'],
      css: ['content.css'],
    },
  ],
  devtools_page: 'devtools/index.html',
  web_accessible_resources: [
    {
      resources: ['*.js', '*.css', '*.svg', 'icon-16.png', 'icon-48.png', 'icon-64.png', 'icon-96.png', 'icon-128.png'],
      matches: ['*://*/*'],
    },
  ],
  side_panel: {
    default_path: 'side-panel/index.html',
  },
} satisfies ManifestType;

export default manifest;
