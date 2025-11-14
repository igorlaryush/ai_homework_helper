import deepmerge from 'deepmerge';
import globalConfig from '@extension/tailwindcss-config';
import type { Config } from 'tailwindcss';

export const withUI = (tailwindConfig: Config): Config =>
  deepmerge(
    {
      darkMode: ['class'],
      presets: [globalConfig],
      content: ['../../packages/ui/lib/**/*.tsx'],
    },
    tailwindConfig,
  );
