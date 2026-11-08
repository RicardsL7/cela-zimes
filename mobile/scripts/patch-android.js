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
// A14: App Links — https://growlab.cc saites (e-pasta pieslēgšanās, Google, Stripe atgriešanās) atver lietotni.
// Pārbaudīts (autoVerify) tikai ar parakstītu laidienu, kura sertifikāts ir growlab.cc/.well-known/assetlinks.json.
if (!m.includes('android:host="growlab.cc"')) {
  const filter = `
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="growlab.cc" />
            </intent-filter>
`;
  const i = m.indexOf('</activity>');
  if (i < 0) throw new Error('AndroidManifest.xml: nav </activity> — App Links nevar pievienot');
  m = m.slice(0, i) + filter.trimStart().replace(/^/, '    ') + '        ' + m.slice(i);
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

// A14: versija un paraksts (app/build.gradle).
//   versionCode — CZ_VERSION_CODE (GitHub Actions: palaišanas numurs) — katrs jauns laidiens lielāks, telefons to atjaunina;
//   versionName — mobile/package.json „version”;
//   paraksts — tikai, ja CZ_KEYSTORE_FILE ir (GitHub Secrets → darbplūsma atkodē failu). Atslēgas šeit nav.
const gradlePath = path.join(root, 'android/app/build.gradle');
let g = fs.readFileSync(gradlePath, 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const code = parseInt(process.env.CZ_VERSION_CODE || '1', 10);
if (!(code >= 1 && code < 2100000000)) throw new Error('CZ_VERSION_CODE nederīgs: ' + process.env.CZ_VERSION_CODE);
if (!/versionCode \d+/.test(g) || !/versionName "[^"]*"/.test(g)) throw new Error('build.gradle: nav versionCode / versionName');
g = g.replace(/versionCode \d+/, 'versionCode ' + code).replace(/versionName "[^"]*"/, `versionName "${pkg.version}"`);
if (process.env.CZ_KEYSTORE_FILE) {
  if (!/\bandroid \{/.test(g) || !/buildTypes \{\s*release \{/.test(g)) throw new Error('build.gradle: nav android { / buildTypes { release {');
  if (!g.includes('signingConfigs {')) {
    g = g.replace(/\bandroid \{/, `android {
    signingConfigs {
        release {
            storeFile file(System.getenv("CZ_KEYSTORE_FILE"))
            storePassword System.getenv("CZ_KEYSTORE_PASSWORD")
            keyAlias System.getenv("CZ_KEY_ALIAS")
            keyPassword System.getenv("CZ_KEY_PASSWORD")
        }
    }`);
    g = g.replace(/buildTypes \{\s*release \{/, m0 => m0 + '\n            signingConfig signingConfigs.release');
  }
  console.log('Paraksts: release (no GitHub Secrets)');
} else console.log('Paraksts: nav (CZ_KEYSTORE_FILE nav) — būvē tikai testa (debug) APK');
fs.writeFileSync(gradlePath, g);
console.log('versionCode ' + code + ', versionName ' + pkg.version);
