const fs = require('fs');

async function updateServerJs() {
  let code = fs.readFileSync('server.js', 'utf8');

  // Rimuovi il vecchio riferimento a FlareSolverr
  code = code.replace(/const \{ testFlareSolverr \} = require\('\.\/src\/utils\/flaresolverr'\);\n?/g, '');

  const startIdx = code.indexOf('async function buildPage');
  const fallbackStartIdx = code.indexOf('function buildPage');
  const actualStartIdx = startIdx !== -1 ? startIdx : fallbackStartIdx;
  
  const endIdx = code.indexOf('// ─── Startup ───');

  if (actualStartIdx === -1 || endIdx === -1) {
    console.error('Non riesco a trovare gli indici per buildPage');
    return;
  }

  const before = code.substring(0, actualStartIdx);
  const after = code.substring(endIdx);

  const newHtmlFunc = `function buildPage(req, host) {
  const v = manifest.version;
  const f = req.config || {};
  function esc(s) { return (s || '').replace(/"/g, '&quot;'); }
  
  return \`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>\${manifest.name} \${v}</title>
  <link href="https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --primary: #ff7eb3;
      --secondary: #00f2fe;
      --bg: #09090b;
      --bg-card: rgba(255, 255, 255, 0.03);
      --glass-border: rgba(255, 255, 255, 0.1);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      background-image: 
        radial-gradient(circle at 15% 50%, rgba(255, 126, 179, 0.12), transparent 25%),
        radial-gradient(circle at 85% 30%, rgba(0, 242, 254, 0.1), transparent 25%);
      color: var(--text);
      font-family: 'Poppins', sans-serif;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 40px 20px;
    }
    .container {
      max-width: 650px; width: 100%; background: var(--bg-card);
      backdrop-filter: blur(20px); border: 1px solid var(--glass-border);
      border-radius: 24px; padding: 45px 35px;
      box-shadow: 0 30px 60px -15px rgba(0,0,0,0.6); position: relative;
    }
    .container::before {
      content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
    }
    .header { text-align: center; margin-bottom: 35px; }
    h1 {
      font-weight: 800; font-size: 2.8rem; margin-bottom: 10px; letter-spacing: -1px;
      background: -webkit-linear-gradient(0deg, var(--primary), var(--secondary));
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .badge {
      display: inline-block; vertical-align: super;
      background: rgba(255, 126, 179, 0.15); border: 1px solid rgba(255, 126, 179, 0.3);
      color: var(--primary); padding: 4px 10px; border-radius: 20px; font-size: 0.8rem; font-weight: 600;
    }
    .lead { color: var(--text-muted); font-size: 0.95rem; line-height: 1.6; }
    .card { background: rgba(0,0,0,0.2); border-radius: 16px; padding: 25px; margin-bottom: 20px; border: 1px solid rgba(255,255,255,0.05); }
    .card-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; color: #fff; text-transform:uppercase; font-size:0.9rem; letter-spacing:1px; }
    .input-grp { margin-bottom: 15px; }
    label { display: block; font-size: 0.85rem; color: var(--text-muted); margin-bottom: 8px; font-weight: 500; }
    input[type=url] {
      width: 100%; background: #18191c; border: 1px solid #272a30; border-radius: 10px;
      padding: 14px 16px; color: #fff; font-size: 0.95rem; font-family: 'Poppins', sans-serif;
      transition: all 0.2s ease; outline: none;
    }
    input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(255, 126, 179, 0.15); }
    .hint { font-size: 0.75rem; color: #64748b; margin-top: 8px; line-height: 1.4; }
    .checks { display: flex; flex-direction: column; gap: 12px; margin-top: 5px; }
    .check-label {
      display: flex; align-items: center; gap: 12px; font-size: 0.9rem; color: #cbd5e1; cursor: pointer;
      background: #18191c; padding: 12px 16px; border-radius: 10px; border: 1px solid #272a30; transition: 0.2s;
    }
    .check-label:hover { border-color: #475569; }
    .check-label input { width: 18px; height: 18px; accent-color: var(--primary); }
    .btn-submit {
      width: 100%; padding: 16px; margin-top: 10px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      color: #000; border: none; border-radius: 12px; font-family: 'Poppins', sans-serif; font-size: 1.1rem;
      font-weight: 700; cursor: pointer; transition: all 0.2s ease; box-shadow: 0 8px 20px rgba(255, 126, 179, 0.3);
    }
    .btn-submit:hover { transform: translateY(-2px); box-shadow: 0 12px 25px rgba(255, 126, 179, 0.4); }
    .btn-submit:active { transform: translateY(1px); }
    .result {
      display: none; background: rgba(0,0,0,0.3); border: 1px solid var(--secondary); border-radius: 16px;
      padding: 25px; margin-top: 25px; 
    }
    .result.show { display: block; animation: slideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1); }
    .url-box {
      background: #0f1115; border: 1px solid #272a30; border-radius: 10px; padding: 14px;
      font-family: monospace; color: #a5b4fc; font-size: 0.9rem; word-break: break-all; margin-bottom: 20px;
    }
    .actions { display: flex; gap: 12px; }
    .btn-action {
      flex: 1; padding: 14px; border-radius: 10px; text-align: center; text-decoration: none;
      font-weight: 600; font-size: 0.95rem; cursor: pointer; border: none; font-family: 'Poppins', sans-serif;
    }
    .btn-stremio { background: linear-gradient(135deg, var(--secondary), #0093E9); color: #000; }
    .btn-stremio:hover { opacity: 0.9; }
    .btn-copy { background: #1e293b; color: #f8fafc; border: 1px solid #334155; }
    .toast { display: none; text-align: center; color: var(--secondary); font-size: 0.85rem; margin-top: 12px; font-weight: 500; }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Nello Drama <span class="badge">v\${v}</span></h1>
      <p class="lead">Il meglio dei Drama Coreani e Asiatici per Stremio.</p>
    </div>

    <form id="cfgForm">
      <div class="card">
        <div class="card-title">⚡ Reti e Bypass</div>
        <div class="input-grp">
          <label>URL Proxy MediaFlow (Opzionale)</label>
          <input type="url" id="m_url" placeholder="https://nome-mediaflow.com" value="\${esc(f.mfpUrl)}"/>
          <div class="hint">Usato per sbloccare i flussi HLS se supportato dal server.</div>
        </div>
        <div class="input-grp">
          <label>IP Bypass Proxy Personale</label>
          <input type="url" id="p_url" placeholder="http://user:pass@host:port" value="\${esc(f.proxyUrl)}"/>
          <div class="hint">Obbligatorio per i server Vercel al fine di aggirare Cloudflare su KissKH.</div>
        </div>
      </div>

      <div class="card">
        <div class="card-title">🎭 Impostazioni Catalogo</div>
        <div class="checks">
          <label class="check-label">
            <input type="checkbox" id="h_cat" \${f.hideCats?'checked':''}/> 
            Nascondi cloni delle sezioni (Mostra solo le principali Cinemeta)
          </label>
          <label class="check-label">
            <input type="checkbox" id="c_mode" \${f.cinemetaMode !== false ? 'checked' : ''}/> 
            Attiva compatibilità con IMDb/Cinemeta (Consigliato)
          </label>
        </div>
      </div>

      <button type="submit" class="btn-submit">Ottieni Addon Nello Drama</button>
    </form>

    <div id="res" class="result">
      <div style="color:var(--secondary); font-weight:600; margin-bottom:10px; text-transform:uppercase;">Tutto Pronto</div>
      <div id="udisp" class="url-box"></div>
      <div class="actions">
        <button id="_actCp" class="btn-action btn-copy">Copia Link</button>
        <a id="_actInst" class="btn-action btn-stremio" href="#">Apri in Stremio</a>
      </div>
      <div id="okmsg" class="toast">✨ Link magico copiato negli appunti!</div>
    </div>
  </div>

<script>
(function(){
  function b64e(str) {
    return btoa(encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, function(a,p){
      return String.fromCharCode(parseInt(p, 16));
    })).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
  }
  var frm = document.getElementById('cfgForm');
  frm.onsubmit = function(e) {
    e.preventDefault();
    var c = {
      proxyUrl: document.getElementById('p_url').value.trim(),
      mfpUrl: document.getElementById('m_url').value.trim(),
      providers: ['kisskh', 'rama'],
      hideCats: document.getElementById('h_cat').checked,
      cinemetaMode: document.getElementById('c_mode').checked,
      tmdbKey: '04a60155a01ff61453266bd9a367448e'
    };
    var enc = b64e(JSON.stringify(c));
    var base = window.location.origin;
    var finalUrl = enc ? base + '/' + enc + '/manifest.json' : base + '/manifest.json';
    var stremioUrl = finalUrl.replace(/^https?:/, 'stremio:');
    
    document.getElementById('res').classList.add('show');
    document.getElementById('udisp').textContent = finalUrl;
    document.getElementById('_actInst').href = stremioUrl;
    
    document.getElementById('_actCp').onclick = function(){
      navigator.clipboard.writeText(finalUrl).then(function(){
        var msg = document.getElementById('okmsg');
        msg.style.display = 'block';
        setTimeout(function(){ msg.style.display='none'; }, 3000);
      });
    };
  };
})();
</script>
</body>
</html>\`;
}
\n\n`;

  const finalCode = before + newHtmlFunc + after;
  fs.writeFileSync('server.js', finalCode);
  console.log('Fatto!');
}

updateServerJs();

