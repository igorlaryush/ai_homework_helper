import { config } from '@dotenvx/dotenvx';

const pathDist = `${import.meta.dirname}/../../../../.env`;
const pathSrc = `${import.meta.dirname}/../../../.env`;

// Try loading from dist path first, then fallback to src path
let parsed = config({ path: pathDist }).parsed;

if (!parsed || Object.keys(parsed).length === 0) {
  parsed = config({ path: pathSrc }).parsed;
}

export const baseEnv = parsed ?? {};

export const dynamicEnvValues = {
  CEB_NODE_ENV: baseEnv.CEB_DEV === 'true' ? 'development' : 'production',
  API_HOST: baseEnv.API_HOST || 'https://chatgpt-proxy-500570371278.us-west2.run.app',
} as const;

