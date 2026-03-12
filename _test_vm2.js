'use strict';

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
  
  const windowVarMatch = /window\['([^']+)'\]\s*=\s*'([^']+)'/.exec(html);
  
  const scripts = [];
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const s = m[1].trim();
    if (s.length > 50) scripts.push(s);
  }
  
  const bigScript = scripts.find(s => s.length > 100000);
  if (!bigScript) return;
  
  let capturedSrc = null;
  
  // Comprehensive DOM mock
  function MockElement(tag) {
    this.tagName = tag;
    this.style = new Proxy({}, { set: () => true, get: () => '' });
    this.classList = { add:()=>{}, remove:()=>{}, contains:()=>false, toggle:()=>{} };
    this.dataset = {};
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this.parentElement = null;
    this.innerHTML = '';
    this.textContent = '';
    this.innerText = '';
    this.outerHTML = '';
    this.id = '';
    this.className = '';
    this.src = '';
    this.href = '';
    this.type = '';
    this.value = '';
    this.checked = false;
    this.offsetWidth = 100;
    this.offsetHeight = 100;
    this.clientWidth = 100;
    this.clientHeight = 100;
    this.scrollWidth = 100;
    this.scrollHeight = 100;
    this.offsetTop = 0;
    this.offsetLeft = 0;
    this.getBoundingClientRect = () => ({ top: 0, left: 0, width: 100, height: 100, bottom: 100, right: 100 });
    this.appendChild = (c) => { this.children.push(c); return c; };
    this.removeChild = () => {};
    this.insertBefore = () => {};
    this.replaceChild = () => {};
    this.setAttribute = (k, v) => { this[k] = v; };
    this.getAttribute = (k) => this[k] || null;
    this.removeAttribute = () => {};
    this.hasAttribute = () => false;
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.querySelector = () => null;
    this.querySelectorAll = () => [];
    this.getElementsByTagName = () => [];
    this.getElementsByClassName = () => [];
    this.cloneNode = () => new MockElement(tag);
    this.contains = () => false;
    this.focus = () => {};
    this.blur = () => {};
    this.click = () => {};
    this.dispatchEvent = () => true;
    this.closest = () => null;
    this.matches = () => false;
  }
  
  const document = {
    createElement: (tag) => new MockElement(tag),
    createElementNS: (ns, tag) => new MockElement(tag),
    createTextNode: () => new MockElement('#text'),
    createDocumentFragment: () => new MockElement('fragment'),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: (tag) => [],
    getElementsByClassName: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
    documentElement: new MockElement('html'),
    body: new MockElement('body'),
    head: new MockElement('head'),
    cookie: '',
    referrer: '',
    title: '',
    domain: new URL(resp.url).hostname,
    readyState: 'complete',
    location: { href: embedUrl, origin, protocol: 'https:', hostname: new URL(resp.url).hostname },
    getSelection: () => ({ rangeCount: 0 }),
    execCommand: () => false,
  };
  
  const sandbox = {
    window: {},
    document,
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36', language: 'en-US', languages: ['en-US'], platform: 'Win32', cookieEnabled: true, vendor: 'Google Inc.', appVersion: '5.0', plugins: [], mimeTypes: [] },
    location: { href: embedUrl, origin, protocol: 'https:', hostname: new URL(resp.url).hostname, pathname: new URL(embedUrl).pathname, search: '', hash: '' },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1040, colorDepth: 24, pixelDepth: 24 },
    history: { pushState: () => {}, replaceState: () => {}, go: () => {}, back: () => {}, forward: () => {} },
    console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {}, clear: () => {} },
    setTimeout: (fn, ms) => { if (ms <= 100) try { fn(); } catch(_){} return 1; },
    setInterval: () => 1,
    clearTimeout: () => {},
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { try { fn(0); } catch(_){} return 1; },
    cancelAnimationFrame: () => {},
    getComputedStyle: () => new Proxy({}, { get: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    ResizeObserver: function(cb) { this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {}; },
    MutationObserver: function(cb) { this.observe = () => {}; this.disconnect = () => {}; },
    IntersectionObserver: function(cb) { this.observe = () => {}; this.unobserve = () => {}; this.disconnect = () => {}; },
    HTMLElement: MockElement,
    HTMLVideoElement: MockElement,
    HTMLDivElement: MockElement,
    HTMLScriptElement: MockElement,
    HTMLCanvasElement: MockElement,
    Element: MockElement,
    Node: MockElement,
    Event: function(type) { this.type = type; this.preventDefault = () => {}; this.stopPropagation = () => {}; },
    CustomEvent: function(type) { this.type = type; this.detail = null; },
    Image: function() { this.src = ''; this.onload = null; this.onerror = null; },
    Audio: function() { this.src = ''; this.play = () => Promise.resolve(); this.pause = () => {}; },
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    Blob: function() {},
    FileReader: function() { this.readAsText = () => {}; this.readAsDataURL = () => {}; },
    FormData: function() {},
    Headers: function() {},
    AbortController: function() { this.signal = {}; this.abort = () => {}; },
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
    DOMParser: function() { this.parseFromString = () => document; },
    Uint8Array: globalThis.Uint8Array,
    Uint16Array: globalThis.Uint16Array,
    ArrayBuffer: globalThis.ArrayBuffer,
    DataView: globalThis.DataView,
    Symbol: globalThis.Symbol,
    Map: globalThis.Map,
    Set: globalThis.Set,
    WeakMap: globalThis.WeakMap,
    WeakSet: globalThis.WeakSet,
    Proxy: globalThis.Proxy,
    Reflect: globalThis.Reflect,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,
    escape: globalThis.escape,
    unescape: globalThis.unescape,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    NaN,
    Infinity,
    undefined,
    Array, Object, String, Number, Boolean, RegExp, Date, Math, JSON, Error, TypeError, RangeError, SyntaxError, ReferenceError, EvalError, URIError,
    Promise: globalThis.Promise,
    XMLHttpRequest: function() {
      this.open = (method, url) => {};
      this.send = () => {};
      this.setRequestHeader = () => {};
      this.addEventListener = () => {};
      this.readyState = 4;
      this.status = 200;
      this.responseText = '';
    },
    fetch: async (url, opts) => ({ ok: true, status: 200, json: async () => ({}), text: async () => '', headers: new Map() }),
    crypto: { getRandomValues: (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256); return arr; }, subtle: {} },
    performance: { now: () => Date.now() },
    devicePixelRatio: 1,
    innerWidth: 1920,
    innerHeight: 1080,
    outerWidth: 1920,
    outerHeight: 1080,
    pageXOffset: 0,
    pageYOffset: 0,
    scrollX: 0,
    scrollY: 0,
    MDCore: new Proxy({}, {
      set: (target, key, value) => {
        target[key] = value;
        const v = String(value);
        if (v.length > 5 && v.length < 500) {
          console.log(`[CAPTURE] MDCore.${key} = ${v.substring(0, 200)}`);
        }
        if (key === 'wurl' || key === 'vsrc' || key === 'src' || key === 'source' || key === 'vurl') {
          capturedSrc = value;
        }
        return true;
      },
      get: (target, key) => target[key]
    }),
  };
  sandbox.self = sandbox.window;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox.window;
  sandbox.parent = sandbox.window;
  sandbox.frames = [];
  sandbox.opener = null;
  sandbox.closed = false;
  sandbox.window.document = document;
  sandbox.window.navigator = sandbox.navigator;
  sandbox.window.location = sandbox.location;
  sandbox.window.screen = sandbox.screen;
  
  if (windowVarMatch) {
    sandbox.window[windowVarMatch[1]] = windowVarMatch[2];
    sandbox[windowVarMatch[1]] = windowVarMatch[2];
  }
  
  const refMatch = /MDCore\.ref\s*=\s*"([^"]+)"/.exec(html);
  if (refMatch) sandbox.MDCore.ref = refMatch[1];
  
  try {
    const context = vm.createContext(sandbox);
    vm.runInContext(bigScript, context, { timeout: 10000 });
    console.log('\nVM OK!');
  } catch (e) {
    console.log('\nVM error:', e.message.substring(0, 200));
  }
  
  console.log('MDCore keys:', Object.keys(sandbox.MDCore));
  for (const [k, v] of Object.entries(sandbox.MDCore)) {
    const s = String(v);
    if (s.includes('http') || s.includes('//') || s.includes('.mp4') || s.includes('.m3u8')) {
      console.log(`FOUND URL in MDCore.${k}:`, s.substring(0, 300));
    }
  }
  if (capturedSrc) console.log('CAPTURED:', capturedSrc);
}

(async () => {
  await tryVmExtraction('https://m1xdrop.net/e/nlx0oj3kcqkwq9');
})();
