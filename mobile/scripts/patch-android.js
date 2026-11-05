// Runs in CI after `npx cap add android`: permissions, foreground-service type and texts for background GPS.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
let m = fs.readFileSync(manifestPath, 'utf8');

const perms = [
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.WAKE_LOCK',
];
const missing = perms.filter(p => !m.includes(`"${p}"`));
if (missing.length) {
  m = m.replace(/<application/, missing.map(p => `<uses-permission android:name="${p}" />`).join('\n    ') + '\n\n    <application');
}

// The plugin's location service must be a "location" foreground service (Android 14+). If the plugin's own
// manifest does not say so, declare it here (merged by Gradle).
const pluginManifest = path.join(root, 'node_modules/@capacitor-community/background-geolocation/android/src/main/AndroidManifest.xml');
if (fs.existsSync(pluginManifest)) {
  const pm = fs.readFileSync(pluginManifest, 'utf8');
  console.log('Plugin manifest:\n' + pm);
  const svc = (pm.match(/<service[^>]*android:name="([^"]+)"/) || [])[1];
  if (svc && !/foregroundServiceType="location"/.test(pm) && !m.includes(svc)) {
    if (!/xmlns:tools=/.test(m)) m = m.replace('<manifest ', '<manifest xmlns:tools="http://schemas.android.com/tools" ');
    m = m.replace('</application>', `    <service android:name="${svc}" android:foregroundServiceType="location" tools:node="merge" />\n    </application>`);
    console.log('Added foregroundServiceType=location for ' + svc);
  }
}
fs.writeFileSync(manifestPath, m);

// Notification texts (Latvian) for the background-location notification.
const stringsPath = path.join(root, 'android/app/src/main/res/values/strings.xml');
let s = fs.readFileSync(stringsPath, 'utf8');
const add = {
  capacitor_background_geolocation_notification_channel_name: 'Navigācija fonā',
};
for (const [k, v] of Object.entries(add)) {
  if (!s.includes(`name="${k}"`)) s = s.replace('</resources>', `    <string name="${k}">${v}</string>\n</resources>`);
}
fs.writeFileSync(stringsPath, s);
console.log('AndroidManifest.xml:\n' + m);
