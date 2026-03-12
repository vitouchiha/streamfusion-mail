'use strict';

// Try to eval MixDrop's obfuscated JS in a VM sandbox
const vm = require('vm');

async function tryVmExtraction(embedUrl) {
  const resp = await fetch(embedUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Referer': 'https://m1xdrop.net/'
    },
    redirect: 'follow'
  });
  const html = await resp.text();
  const origin = new URL(resp.url).origin;
  
  // Extract the initial variable (window['xxx'] = 'yyy')
  const windowVarMatch = /window\['([^']+)'\]\s*=\s*'([^']+)'/.exec(html);
  if (windowVarMatch) {
    console.log('Found window var:', windowVarMatch[1], '(', windowVarMatch[2].length, 'chars)');
  }
  
  // Extract ALL inline script blocks
  const scripts = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const s = m[1].trim();
    if (s.length > 50) scripts.push(s);
  }
  
  // Try to find the big obfuscated script and run it
  const bigScript = scripts.find(s => s.length > 100000);
  if (!bigScript) {
    console.log('No big script found');
    return;
  }
  console.log('Big script size:', bigScript.length);
  
  // Create a sandbox with mock DOM  
  let capturedSrc = null;
  const sandbox = {
    window: {},
    document: {
      createElement: (tag) => {
        const el = {
          style: {},
          classList: { add: () => {}, remove: () => {}, contains: () => false },
          appendChild: () => {},
          removeChild: () => {},
          setAttribute: () => {},
          getAttribute: () => null,
          addEventListener: () => {},
          removeEventListener: () => {},
          querySelector: () => null,
          querySelectorAll: () => [],
          innerHTML: '',
          textContent: '',
          tagName: tag,
        };
        return el;
      },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: () => {},
      documentElement: { style: {} },
      body: { appendChild: () => {}, style: {} },
      cookie: '',
      referrer: '',
      location: { href: embedUrl, origin },
    },
    navigator: { userAgent: 'Mozilla/5.0', language: 'en-US', platform: 'Win32', cookieEnabled: true },
    location: { href: embedUrl, origin, protocol: 'https:', hostname: new URL(resp.url).hostname },
    screen: { width: 1920, height: 1080 },
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: (fn) => { try { fn(); } catch(_){} return 1; },
    setInterval: () => 1,
    clearTimeout: () => {},
    clearInterval: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent,
    decodeURIComponent,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Array, Object, String, Number, Boolean, RegExp, Date, Math, JSON, Error,
    Promise: { resolve: (v) => ({ then: (f) => f(v), catch: () => {} }), reject: () => ({}) },
    XMLHttpRequest: function() {
      this.open = (method, url) => { console.log('XHR open:', method, url); };
      this.send = () => {};
      this.setRequestHeader = () => {};
      this.addEventListener = () => {};
    },
    fetch: async (url) => {
      console.log('fetch called:', url);
      return { ok: true, json: async () => ({}), text: async () => '' };
    },
    MDCore: new Proxy({}, {
      set: (target, key, value) => {
        console.log(`MDCore.${key} = ${String(value).substring(0, 200)}`);
        target[key] = value;
        if (key === 'wurl' || key === 'vsrc' || key === 'src' || key === 'source') {
          capturedSrc = value;
        }
        return true;
      },
      get: (target, key) => {
        return target[key];
      }
    }),
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox.window;
  sandbox.top = sandbox.window;
  sandbox.parent = sandbox.window;
  
  // Copy window vars
  if (windowVarMatch) {
    sandbox.window[windowVarMatch[1]] = windowVarMatch[2];
    sandbox[windowVarMatch[1]] = windowVarMatch[2];
  }
  
  // Also set MDCore.ref
  const refMatch = /MDCore\.ref\s*=\s*"([^"]+)"/.exec(html);
  if (refMatch) {
    sandbox.MDCore.ref = refMatch[1];
    console.log('Set MDCore.ref =', refMatch[1]);
  }
  
  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(bigScript, context, { timeout: 5000 });
    console.log('\nVM execution completed!');
    console.log('MDCore keys:', Object.keys(sandbox.MDCore));
    console.log('Captured src:', capturedSrc);
    if (sandbox.MDCore.wurl) console.log('wurl:', sandbox.MDCore.wurl);
    if (sandbox.MDCore.vsrc) console.log('vsrc:', sandbox.MDCore.vsrc);
  } catch (e) {
    console.log('\nVM error:', e.message);
    console.log('MDCore keys so far:', Object.keys(sandbox.MDCore));
    if (sandbox.MDCore.wurl) console.log('wurl found before error:', sandbox.MDCore.wurl);
    if (sandbox.MDCore.vsrc) console.log('vsrc found before error:', sandbox.MDCore.vsrc);
    if (capturedSrc) console.log('Captured src before error:', capturedSrc);
  }
}

(async () => {
  await tryVmExtraction('https://m1xdrop.net/e/nlx0oj3kcqkwq9');
})();
