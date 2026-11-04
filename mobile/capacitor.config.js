// @ts-check
/**
 * GOTCHA mobile shell: Capacitor configuration.
 *
 * Plain JavaScript (typed through JSDoc) on purpose: the Capacitor CLI can only
 * load a capacitor.config.ts when the `typescript` package is installed in this
 * project, and `typescript` is not one of the dependencies granted to mobile/.
 * Editors still type-check this file through tsconfig.json (checkJs).
 *
 * The shell bundles NOTHING of the web app. The WebView loads the live
 * Next.js app (frontend-v2) from `server.url`; `www/` holds only the offline
 * fallback page shown when that load fails.
 *
 * The environment is chosen at build time, when `cap sync` / `cap copy` /
 * `cap run` evaluates this file:
 *
 *   GOTCHA_ENV=dev  npx cap sync   -> https://dev.gotcha.co.il
 *   GOTCHA_ENV=prod npx cap sync   -> https://app.gotcha.co.il   (the default)
 *
 * The values end up baked into the native projects
 * (android/app/src/main/assets/capacitor.config.json and
 * ios/App/App/capacitor.config.json), so ALWAYS re-sync after switching.
 */
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

/** @typedef {'dev' | 'prod'} GotchaEnv */

/**
 * @typedef {object} EnvTarget
 * @property {string} origin    Where the web app is served.
 * @property {string} authHost  The Authentik / sign-in host. Login runs inside the WebView.
 */

/** @type {Readonly<Record<GotchaEnv, EnvTarget>>} */
const TARGETS = {
  dev: { origin: 'https://dev.gotcha.co.il', authHost: 'auth-dev.gotcha.co.il' },
  prod: { origin: 'https://app.gotcha.co.il', authHost: 'auth.gotcha.co.il' },
};

/**
 * @param {string | undefined} raw
 * @returns {GotchaEnv}
 */
function resolveEnv(raw) {
  if (raw === undefined || raw === '') return 'prod';
  if (raw === 'dev' || raw === 'prod') return raw;
  // Fail loudly: a typo must never silently ship a prod build pointed at dev or vice versa.
  throw new Error(`GOTCHA_ENV must be "dev" or "prod" (got "${raw}")`);
}

const env = resolveEnv(process.env.GOTCHA_ENV);
const target = TARGETS[env];
const appHost = new URL(target.origin).host;

/** Hebrew is the default locale. */
const START_PATH = '/he/m/inbox';
const START_URL = `${target.origin}${START_PATH}`;

/*
 * The offline page (www/index.html) is a LOCAL page, so it cannot know which
 * environment it belongs to. Write that one fact next to it every time this
 * config is evaluated (every cap command), before `cap copy` copies www/ into
 * the native projects. The file is gitignored; without it the page retries prod.
 */
try {
  writeFileSync(
    join(__dirname, 'www', 'env.js'),
    `window.GOTCHA_SHELL = ${JSON.stringify({ env, startUrl: START_URL })};\n`,
  );
} catch (_err) {
  // Read-only checkout or missing www/: the fallback page defaults to prod.
}

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'il.co.gotcha.app',
  appName: 'GOTCHA',
  webDir: 'www',

  server: {
    url: START_URL,
    // Hosts the WebView may navigate to. Anything else opens in the system browser
    // (Capacitor's built-in rule). The path-level rule for the app origin lives in
    // the NavigationPolicy native plugin, configured under `plugins` below.
    allowNavigation: [appHost, target.authHost],
    cleartext: false,
    // Local page (inside webDir) shown when the remote load fails.
    errorPath: 'index.html',
  },

  android: {
    // HTTPS only. Mixed content stays blocked.
    allowMixedContent: false,
    webContentsDebuggingEnabled: env === 'dev',
  },

  ios: {
    contentInset: 'never',
    webContentsDebuggingEnabled: env === 'dev',
    // Keep the default, persistent WKWebsiteDataStore: no app-bound domains, no
    // non-persistent store. The session cookie must survive kill and reboot.
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    /**
     * Local native plugin (android/.../NavigationPolicyPlugin.java,
     * ios/App/App/NavigationPolicyPlugin.swift). On the app origin, only these
     * path prefixes stay inside the WebView; any other app page opens in the
     * system browser. Other hosts are handled by `server.allowNavigation`.
     */
    NavigationPolicy: {
      appOrigin: target.origin,
      authHosts: [target.authHost],
      // `/<locale>/m/...` is matched by pattern; these are literal prefixes.
      /*
       * ★ Sign-in and password recovery stay in the app. On prod they are
       *   served on the app's own origin (app.gotcha.co.il/he/sign-in); dev
       *   serves them on the auth host, which is why dev never showed it. On
       *   prod the login opened the system browser and the flow broke there
       *   (Omer, 2026-11-04).
       */
      inAppPathPrefixes: [
        '/api/auth/',
        ...['', '/he', '/en'].flatMap((locale) => [`${locale}/sign-in`, `${locale}/recover`]),
      ],
      locales: ['he', 'en'],
    },

    // Cookies stay in the platform WebView store (WKWebsiteDataStore.default /
    // android.webkit.CookieManager). Do NOT enable CapacitorCookies: it swaps the
    // cookie handler and is not needed when the page and the API share one origin.
    CapacitorCookies: { enabled: false },
    CapacitorHttp: { enabled: false },

    PushNotifications: {
      // iOS: how a notification is shown while the app is in the foreground.
      presentationOptions: ['badge', 'sound', 'alert'],
    },

    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      launchFadeOutDuration: 250,
      backgroundColor: '#121212',
      showSpinner: false,
      androidScaleType: 'CENTER_INSIDE',
      splashFullScreen: false,
      splashImmersive: false,
    },

    // Capacitor 8 core plugin. Android 15+ is always edge to edge; 'css' keeps the
    // WebView honest about insets and exposes --safe-area-inset-* to the page.
    SystemBars: {
      insetsHandling: 'css',
      // The app's ground is the warm paper (GOTCHA Mobile App design): dark icons.
      style: 'LIGHT',
    },

    // iOS, and Android below 15 (where backgroundColor / overlaysWebView still apply).
    StatusBar: {
      // Capacitor naming: 'LIGHT' = dark text for a light background.
      style: 'LIGHT',
      backgroundColor: '#FAF8F4',
      overlaysWebView: false,
    },
  },
};

module.exports = config;
