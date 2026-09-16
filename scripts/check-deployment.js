const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const requiredFiles = [
  ['index.html', 100000],
  ['radio-watch-server.js', 5000],
  ['three.min.js', 500000],
  ['polygon-clipping.min.js', 20000],
  ['aviation-data.js', 8000],
  ['radio-audio-worklet.js', 1000],
  ['manifest.webmanifest', 200],
  ['scripts/system-audio-mute.ps1', 3000],
  ['vendor/webrtlsdr/LICENSE', 10000],
  ['vendor/webrtlsdr/package.json', 30],
  ['vendor/webrtlsdr/errors.js', 1000],
  ['vendor/webrtlsdr/rtlsdr.js', 50],
  ['vendor/webrtlsdr/rtlsdr/r8xx.js', 15000],
  ['vendor/webrtlsdr/rtlsdr/r820t.js', 1000],
  ['vendor/webrtlsdr/rtlsdr/r828d.js', 4000],
  ['vendor/webrtlsdr/rtlsdr/rtl2832u.js', 10000],
  ['vendor/webrtlsdr/rtlsdr/rtlcom.js', 9000],
  ['vendor/webrtlsdr/rtlsdr/rtldevice.js', 800],
  ['vendor/webrtlsdr/rtlsdr/tuner.js', 500],
  ['CZ-WPT-National-XCSoar.cup', 40000],
  ['CZ_low_plus_CE_26-04-01.cub', 150000]
];

const problems = [];
for (const [relativePath, minimumBytes] of requiredFiles) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) {
    problems.push(`${relativePath} is missing`);
    continue;
  }
  const size = fs.statSync(filePath).size;
  if (size < minimumBytes) problems.push(`${relativePath} is unexpectedly small (${size} bytes)`);
}

for (const relativePath of ['radio-watch-server.js', 'aviation-data.js']) {
  const filePath = path.join(root, relativePath);
  if (!fs.existsSync(filePath)) continue;
  try { new Function(fs.readFileSync(filePath, 'utf8')); }
  catch (error) { problems.push(`${relativePath} has invalid JavaScript: ${error.message}`); }
}

const htmlPath = path.join(root, 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).filter(source => source.trim());
  try { inlineScripts.forEach(source => new Function(source)); }
  catch (error) { problems.push(`index.html has invalid inline JavaScript: ${error.message}`); }
  if (!html.includes('api/live-traffic') || !html.includes('api/metars')) {
    problems.push('index.html does not reference both production API routes');
  }
}

if (problems.length) {
  console.error(`Deployment check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}

console.log(`Deployment check passed (${requiredFiles.length} required runtime files).`);
