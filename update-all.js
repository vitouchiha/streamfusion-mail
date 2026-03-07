// update-all.js
// Automates version/date update in README, landing, manifest, and pushes to GitHub

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = __dirname;
const manifestPath = path.join(root, 'manifest.json');
const readmePath = path.join(root, 'README.md');
const landingPath = path.join(root, 'landing.txt');
const changelogPath = path.join(root, 'CHANGELOG.md');

// 1. Get current version from manifest
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const version = manifest.version;
const today = new Date().toISOString().slice(0, 10);

// 2. Update README.md (replace version/date if present)
let readme = fs.readFileSync(readmePath, 'utf8');
readme = readme.replace(/(v?\d+\.\d+\.\d+)(\s*\(\d{4}-\d{2}-\d{2}\))?/, `v${version} (${today})`);
fs.writeFileSync(readmePath, readme);

// 3. Update landing.txt (replace version if present)
let landing = fs.readFileSync(landingPath, 'utf8');
landing = landing.replace(/v\d+\.\d+\.\d+/, `v${version}`);
fs.writeFileSync(landingPath, landing);

// 4. Optionally, append to CHANGELOG.md if not already present
let changelog = fs.readFileSync(changelogPath, 'utf8');
if (!changelog.includes(`[${version}] — ${today}`)) {
  changelog = `\n## [${version}] — ${today}\n\n### Changed\n- Aggiornamento automatico versione e landing page.\n` + changelog;
  fs.writeFileSync(changelogPath, changelog);
}

// 5. Git add, commit, push
execSync('git add .', { stdio: 'inherit' });
execSync(`git commit -m "chore: update docs/landing for v${version} (${today})"`, { stdio: 'inherit' });
execSync('git push', { stdio: 'inherit' });

console.log('All docs, landing, and changelog updated and pushed!');
