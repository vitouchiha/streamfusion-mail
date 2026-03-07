'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_VERCEL_BASE_URL = 'https://streamfusion-mail.vercel.app';
const DEFAULT_WAIT_TIMEOUT_MS = 180_000;
const DEFAULT_WAIT_INTERVAL_MS = 10_000;
const REQUEST_TIMEOUT_MS = 10_000;

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  return (raw || DEFAULT_VERCEL_BASE_URL).replace(/\/+$/, '');
}

function parseFlag(name) {
  return process.argv.includes(name);
}

function readLocalManifestVersion() {
  try {
    const manifestPath = path.join(__dirname, '..', 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return String(manifest.version || '').trim() || null;
  } catch {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(baseUrl, route) {
  const response = await fetch(`${baseUrl}${route}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      'accept': 'application/json, text/html;q=0.9, */*;q=0.8',
      'user-agent': 'streamfusion-vercel-smoke/1.0',
    },
  });

  const body = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    headers: response.headers,
    body,
  };
}

async function fetchJson(baseUrl, route) {
  const result = await fetchText(baseUrl, route);
  let json = null;
  try {
    json = JSON.parse(result.body);
  } catch {
    json = null;
  }

  return {
    ...result,
    json,
  };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function runOnce(baseUrl) {
  const expectedVersion = readLocalManifestVersion();

  console.log(`Smoke target: ${baseUrl}`);

  const health = await fetchJson(baseUrl, '/health');
  assert(health.ok, `/health returned HTTP ${health.status}`);
  assert(health.json && health.json.status === 'ok', '/health did not return status=ok');
  console.log(`OK /health -> version=${health.json.version || 'n/a'}`);

  const manifest = await fetchJson(baseUrl, '/manifest.json');
  assert(manifest.ok, `/manifest.json returned HTTP ${manifest.status}`);
  assert(manifest.json && manifest.json.id && manifest.json.version, '/manifest.json is missing id/version');
  if (expectedVersion) {
    assert(
      manifest.json.version === expectedVersion,
      `/manifest.json version mismatch: remote=${manifest.json.version} local=${expectedVersion}`
    );
  }
  console.log(`OK /manifest.json -> ${manifest.json.id} v${manifest.json.version}`);

  const status = await fetchJson(baseUrl, '/api/status');
  assert(status.ok, `/api/status returned HTTP ${status.status}`);
  assert(Array.isArray(status.json?.providers), '/api/status.providers is not an array');
  console.log(`OK /api/status -> providers=${status.json.providers.length}`);

  const configure = await fetchText(baseUrl, '/configure');
  assert(configure.ok, `/configure returned HTTP ${configure.status}`);
  assert(
    configure.body.includes('manifest.json') || configure.body.includes('Nello Drama') || configure.body.includes('StreamFusion'),
    '/configure did not look like the addon landing page'
  );
  console.log('OK /configure');

  const dashboard = await fetchText(baseUrl, '/dashboard');
  assert(dashboard.ok, `/dashboard returned HTTP ${dashboard.status}`);
  assert(
    dashboard.body.includes('Providers Attivi') && dashboard.body.includes('Release'),
    '/dashboard did not return the expected release/status markup'
  );
  console.log('OK /dashboard');

  if (process.env.VERCEL_SMOKE_STREAM_ID) {
    const type = String(process.env.VERCEL_SMOKE_STREAM_TYPE || 'series').trim() || 'series';
    const route = `/stream/${encodeURIComponent(type)}/${process.env.VERCEL_SMOKE_STREAM_ID}.json`;
    const stream = await fetchJson(baseUrl, route);
    assert(stream.ok, `${route} returned HTTP ${stream.status}`);
    assert(Array.isArray(stream.json?.streams), `${route} did not return a streams array`);
    console.log(`OK ${route} -> streams=${stream.json.streams.length}`);
  }
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.env.VERCEL_BASE_URL || process.env.PUBLIC_BASE_URL);
  const waitMode = parseFlag('--wait');
  const timeoutMs = Number(process.env.VERCEL_WAIT_TIMEOUT_MS || DEFAULT_WAIT_TIMEOUT_MS);
  const intervalMs = Number(process.env.VERCEL_WAIT_INTERVAL_MS || DEFAULT_WAIT_INTERVAL_MS);

  if (!waitMode) {
    await runOnce(baseUrl);
    return;
  }

  const deadline = Date.now() + timeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await runOnce(baseUrl);
      return;
    } catch (error) {
      lastError = error;
      console.log(`Smoke retry scheduled: ${error.message}`);
      await sleep(intervalMs);
    }
  }

  throw lastError || new Error('Remote smoke test timed out');
}

main().catch((error) => {
  console.error(`Vercel smoke failed: ${error.message}`);
  process.exit(1);
});
