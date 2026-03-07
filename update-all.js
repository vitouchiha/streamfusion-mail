'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DEFAULT_VERCEL_BASE_URL = 'https://streamfusion-mail.vercel.app';

const manifestPath = path.join(ROOT, 'manifest.json');
const readmePath = path.join(ROOT, 'README.md');
const changelogPath = path.join(ROOT, 'CHANGELOG.md');
const dashboardLandingPath = path.join(ROOT, 'web', 'landing', 'index.html');

const RELEASE_MARKERS = {
  start: '<!-- release:meta:start -->',
  end: '<!-- release:meta:end -->',
};

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function writeTextIfChanged(filePath, nextValue) {
  const currentValue = readText(filePath);
  if (currentValue === nextValue) return false;
  fs.writeFileSync(filePath, nextValue, 'utf8');
  return true;
}

function normalizeBaseUrl(value) {
  const raw = String(value || '').trim();
  return (raw || DEFAULT_VERCEL_BASE_URL).replace(/\/+$/, '');
}

function replaceMarkedSection(text, replacement) {
  const { start, end } = RELEASE_MARKERS;
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    throw new Error(`Missing release markers: ${start} ... ${end}`);
  }

  const before = text.slice(0, startIndex);
  const after = text.slice(endIndex + end.length);
  return `${before}${replacement}${after}`;
}

function syncVersionedInstallPaths(text, version) {
  return String(text || '').replace(
    /\/install\/v\d+\.\d+\.\d+\/manifest\.json/g,
    `/install/v${version}/manifest.json`
  );
}

function buildReadmeReleaseBlock({ version, date, baseUrl }) {
  return [
    RELEASE_MARKERS.start,
    `- Release: \`v${version}\``,
    `- Date: \`${date}\``,
    `- Remote smoke target: \`${baseUrl}\``,
    RELEASE_MARKERS.end,
  ].join('\n');
}

function buildDashboardReleaseBlock({ version, date, baseUrl }) {
  return [
    RELEASE_MARKERS.start,
    '      <div class="release-meta">',
    `        <span class="release-pill">Release v${version}</span>`,
    `        <span class="release-date">Aggiornato ${date}</span>`,
    `        <a class="release-link" href="${baseUrl}/manifest.json" target="_blank" rel="noreferrer">Manifest</a>`,
    '      </div>',
    RELEASE_MARKERS.end,
  ].join('\n');
}

function ensureChangelogEntry(text, { version, date }) {
  if (text.includes(`## [${version}]`)) return text;

  const entry = [
    `## [${version}] - ${date}`,
    '',
    '### Changed',
    '- Release sync automatica: README, dashboard addon e smoke test remoto Vercel allineati.',
    '',
    '---',
    '',
  ].join('\n');

  const anchor = '\n---\n\n';
  const anchorIndex = text.indexOf(anchor);
  if (anchorIndex === -1) {
    return `${text.trim()}\n\n---\n\n${entry}`;
  }

  const insertAt = anchorIndex + anchor.length;
  return `${text.slice(0, insertAt)}${entry}${text.slice(insertAt)}`;
}

function main() {
  const manifest = JSON.parse(readText(manifestPath));
  const version = String(manifest.version || '').trim();
  if (!version) {
    throw new Error('manifest.json is missing "version"');
  }

  const date = new Date().toISOString().slice(0, 10);
  const baseUrl = normalizeBaseUrl(process.env.VERCEL_BASE_URL || process.env.PUBLIC_BASE_URL);

  let nextReadme = replaceMarkedSection(
    readText(readmePath),
    buildReadmeReleaseBlock({ version, date, baseUrl })
  );
  nextReadme = syncVersionedInstallPaths(nextReadme, version);
  writeTextIfChanged(readmePath, nextReadme);

  let nextDashboardLanding = replaceMarkedSection(
    readText(dashboardLandingPath),
    buildDashboardReleaseBlock({ version, date, baseUrl })
  );
  nextDashboardLanding = syncVersionedInstallPaths(nextDashboardLanding, version);
  writeTextIfChanged(dashboardLandingPath, nextDashboardLanding);

  const nextChangelog = ensureChangelogEntry(readText(changelogPath), { version, date });
  writeTextIfChanged(changelogPath, nextChangelog);

  console.log(`Release sync complete for v${version} (${date})`);
}

main();
