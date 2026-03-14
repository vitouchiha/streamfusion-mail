# Uprot & Maxstream Architecture — Complete Analysis

## 1. MAMMAMIA UPROT BYPASS FLOW (Python)

### File Structure
- **Handlers**: [Src/API/cb01.py](Src/API/cb01.py#L77)
- **Extractors**: [Src/API/extractors/uprot.py](Src/API/extractors/uprot.py)
- **Routes**: [run.py](run.py#L329)

### MammaMia Uprot Implementation

#### GET /uprot Route
Serves the captcha UI:
```python
@app.get('/uprot')
async def uprot(request: Request):
    async with AsyncSession(proxies=proxies) as client:
        image, cookies = await get_uprot_numbers(client)
    response = static.TemplateResponse('uprot.html', {
        'request': request, 
        "image_url": image
    })
    if cookies:
        response.set_cookie(key='PHPSESSID', value=cookies.get('PHPSESSID'), httponly=True)
    return response
```

#### POST /uprot Route
Processes user captcha submission:
```python
@app.post("/uprot")
async def execute_uprot(request: Request, user_input=Form(...), PHPSESSID: str=Cookie(None)):
    async with AsyncSession(proxies=proxies) as client:
        cookies = {'PHPSESSID': PHPSESSID}
        status = await generate_uprot_txt(user_input, cookies, client)
    if status == True:
        return static.TemplateResponse('uprot.html', {..., "image_url": 'https://tinyurl.com/doneokdone'})
    elif status == False:
        return static.TemplateResponse('uprot.html', {..., "image_url": 'https://tinyurl.com/tryagaindumb'})
```

### Python Captcha Solving (`Src/API/extractors/uprot.py`)

#### Step 1: Get Captcha Image & Session
```python
async def get_uprot_numbers(client):
    url = 'https://uprot.net/msf/r4hcq47tarq8'
    headers = {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36...',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Origin': 'https://uprot.net/',
        # ... more headers
    }
    response = await client.post(ForwardProxy + url, headers=headers, proxies=proxies, impersonate='chrome')
    
    # Extract PHPSESSID cookie from Set-Cookie header
    set_cookie = response.headers.get('set-cookie')
    parts = set_cookie.split(';')[0].split('=')
    cookies = {parts[0]: parts[1]}
    
    # Extract base64 PNG image from HTML
    soup = BeautifulSoup(response.text, 'lxml', parse_only=SoupStrainer('img'))
    img = soup.find('img')['src']  # base64 PNG data
    return img, cookies
```

#### Step 2: Submit Captcha Answer
```python
async def generate_uprot_txt(numbers, cookies, client):
    data = {'captcha': str(numbers)}
    response = await client.post(ForwardProxy + url, cookies=cookies, headers=headers, data=data, proxies=proxies, impersonate='chrome')
    
    # Extract new cookie from response
    set_cookie = response.headers.get('set-cookie')
    parts = set_cookie.split(';')[0].split('=')
    cookies[parts[0]] = parts[1]
    
    # Save cookies + captcha data to uprot.txt for later use
    file_path = os.path.join(os.path.dirname(__file__), 'uprot.txt')
    with open(file_path, 'w') as file:
        file.write(f'{str(cookies)}\n{str(data)}')
    return True
```

#### Step 3: Bypass Uprot Link
```python
async def bypass_uprot(client, link):
    # Normalize mse → msf
    if 'mse' in link:
        link = link.replace('mse', 'msf')
    
    # Load saved cookies & captcha data from uprot.txt
    file_path = os.path.join(os.path.dirname(__file__), 'uprot.txt')
    with open(file_path, 'r') as file:
        text = file.read()
        parts = text.split('\n')
        cookies = json.loads(parts[0].replace("'", '"'))
        data = json.loads(parts[1].replace("'", '"'))
    
    # POST to uprot link with saved cookies + captcha answer
    response = await client.post(ForwardProxy + link, cookies=cookies, headers=headers, data=data, impersonate='chrome', proxies=proxies)
    
    # Extract "C O N T I N U E" link
    max_stream = await get_maxstream_link(response.text, client)
    return max_stream
```

#### Step 4: Extract MaxStream Link
```python
async def get_maxstream_link(text, client):
    soup = BeautifulSoup(text, 'lxml', parse_only=SoupStrainer('a'))
    a_tags = soup.find_all('a')
    max_stream = None
    
    # Look for anchor with "C O N T I N U E" text
    for tag in a_tags:
        if 'C O N T I N U E' in tag.text.upper():
            max_stream = tag['href']
    
    if max_stream:
        # Follow redirects from uprots domain
        redirect = max_stream
        time = 0
        while 'uprots' in redirect:
            response = await client.head(ForwardProxy + max_stream, headers=headers, impersonate='chrome', allow_redirects=True, proxies=proxies)
            redirect = response.url
            time += 1
            if time == 1000:
                return False
        
        # Extract video ID and build maxstream URL
        # Example: https://watchfree.xxx/something/abcdef123/...
        # → https://maxstream.video/emvvv/abcdef123
        max_stream = 'https://maxstream.video/emvvv/' + response.url.split('watchfree/')[1].split('/')[1]
    
    return max_stream
```

### MaxStream Extraction (Python)
```python
async def maxstream(url, client, streams, site_name, language, proxies, ForwardProxy):
    headers = random_headers.generate()
    response = await client.get(ForwardProxy + url, allow_redirects=True, timeout=30, headers=headers, proxies=proxies, impersonate="chrome")
    
    # Extract video URL from sources[{src:"..."}] pattern
    pattern = r'sources\W+src\W+(.*)",'
    match = re.search(pattern, response.text)
    if match:
        video_url = match.group(1)
        streams['streams'].append({
            'name': f"{Name}{language}",
            'title': f'{Icon}{site_name}\n▶️ Maxstream',
            'url': video_url,
            'behaviorHints': {'bingeGroup': f'{site_name.lower()}'}
        })
    return streams
```

### CB01 Integration Flow
```python
async def get_maxstream(link, streams, client):
    # Step 1: Check if link is stayonline.pro proxy
    if 'stayonline' in link:
        uprot_link = await get_stayonline(link, client)  # Resolve to uprot
    else:
        uprot_link = link
    
    # Step 2: Bypass uprot using saved cookies
    maxstream_link = await bypass_uprot(client, uprot_link)
    
    if maxstream_link:
        # Step 3: Extract video from maxstream
        streams = await maxstream(maxstream_link, client, streams, 'CB01', '', proxies2, ForwardProxy)
    else:
        if maxstream_link == False:
            return streams
        else:
            # Show "please do captcha" message if not yet solved
            streams['streams'].append({
                'name': f"{Name}",
                'title': f'{Icon}CB01\n▶️ Please do the captcha at /uprot in order to be able to play this content!\nRemember to refresh the sources!\nIf you recently did the captcha then dont worry, just refresh the sources',
                'url': 'https://github.com/UrloMythus/MammaMia',
                'behaviorHints': {'bingeGroup': 'cb01'}
            })
    return streams
```

## 2. STREAMFUSIONMAIL UPROT IMPLEMENTATION (JavaScript)

### File Structure
- **Uprot Extractor**: [src/extractors/uprot.js](src/extractors/uprot.js)
- **MaxStream Extractor**: [src/extractors/maxstream.js](src/extractors/maxstream.js)
- **CB01 Provider**: [src/cb01/index.js](src/cb01/index.js)

### Uprot Resolution Flow
```javascript
async function extractUprot(uprotUrl) {
  // 1. Normalize mse → msf
  let link = String(uprotUrl).trim();
  if (link.includes('/mse/')) {
    link = link.replace('/mse/', '/msf/');
  }

  const proxy = getWebshareProxy();
  const fetchOptions = {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': new URL(link).origin,
      'Referer': link,
    },
    redirect: 'follow',
  };

  let html;
  const cfProxy = process.env.CF_PROXY_URL || (typeof global !== 'undefined' && global.CF_PROXY_URL);

  if (cfProxy) {
    // Route through CF Worker proxy with Spanish IP
    const sep = cfProxy.includes('?') ? '&' : '?';
    const proxyUrl = `${cfProxy}${sep}url=${encodeURIComponent(link)}`;
    const resp = await fetch(proxyUrl, {
      headers: { 'User-Agent': UA, 'Referer': link },
      redirect: 'follow',
    });
    if (!resp.ok) return null;
    html = await resp.text();
  } else {
    // Direct fetch
    const resp = await fetch(link, fetchOptions);
    if (!resp.ok) return null;
    html = await resp.text();
  }

  // 2. Find "C O N T I N U E" link
  const continueMatch = html.match(/<a[^>]+href="([^"]+)"[^>]*>[^<]*C\s*O\s*N\s*T\s*I\s*N\s*U\s*E[^<]*<\/a>/i);
  if (!continueMatch) {
    if (html.includes('captcha') || html.includes('CAPTCHA')) {
      console.log('[Extractors] Uprot: captcha required, cannot bypass');
      return null;
    }
    return null;
  }

  let maxstreamUrl = continueMatch[1];

  // 3. Follow redirects from uprots domain
  if (maxstreamUrl.includes('uprots')) {
    try {
      const redirectResp = await fetch(maxstreamUrl, {
        headers: { 'User-Agent': UA },
        redirect: 'follow',
      });
      const finalUrl = redirectResp.url;
      // Convert to maxstream embed URL
      if (finalUrl.includes('watchfree/')) {
        const parts = finalUrl.split('watchfree/');
        if (parts[1]) {
          const videoId = parts[1].split('/')[1];
          if (videoId) {
            maxstreamUrl = `https://maxstream.video/emvvv/${videoId}`;
          }
        }
      } else {
        maxstreamUrl = finalUrl;
      }
    } catch {
      return null;
    }
  }

  // 4. Extract actual video from MaxStream
  if (maxstreamUrl.includes('maxstream')) {
    return extractMaxStream(maxstreamUrl);
  }

  return null;
}
```

### MaxStream Extraction (JavaScript)
```javascript
async function extractMaxStream(url) {
  const normalizedUrl = String(url || '').trim();
  if (!normalizedUrl.startsWith('http')) return null;

  const resp = await fetch(normalizedUrl, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5',
    },
    redirect: 'follow',
  });

  if (!resp.ok) return null;
  const html = await resp.text();

  // Primary pattern: sources[{src: "..."}] (JWPlayer style)
  const primaryMatch = /sources\W+src\W+(https?:\/\/[^"']+)["']/i.exec(html);
  if (primaryMatch && primaryMatch[1]) {
    const videoUrl = primaryMatch[1].trim();
    const origin = new URL(normalizedUrl).origin;
    return {
      url: videoUrl,
      headers: {
        'User-Agent': USER_AGENT,
        'Referer': `${origin}/`,
      },
    };
  }

  // Fallback: file:"..." pattern
  const fallbackMatch = /file\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/i.exec(html);
  if (fallbackMatch && fallbackMatch[1]) {
    const videoUrl = fallbackMatch[1].trim();
    if (videoUrl.startsWith('http')) {
      const origin = new URL(normalizedUrl).origin;
      return {
        url: videoUrl,
        headers: {
          'User-Agent': USER_AGENT,
          'Referer': `${origin}/`,
        },
      };
    }
  }

  return null;
}
```

### StayOnline.pro Resolver
```javascript
async function resolveStayOnline(link) {
  // Extract ID from: /e/{id}/ or /l/{id}/ or /{id}/
  const idMatch = /stayonline\.pro\/(?:[el]\/)?([a-zA-Z0-9_-]+)/.exec(link);
  if (!idMatch) return null;
  const id = idMatch[1];

  const resp = await fetch('https://stayonline.pro/ajax/linkEmbedView.php', {
    method: 'POST',
    headers: {
      'Origin': 'https://stayonline.pro',
      'Referer': 'https://stayonline.pro/',
      'User-Agent': UA,
      'X-Requested-With': 'XMLHttpRequest',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ id, ref: '' }).toString(),
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.data?.value || null;
}
```

## 3. CF WORKER SAFEGO CAPTCHA SOLVER

### File
[StreamFusionMail/cfworker.js](StreamFusionMail/cfworker.js#L738)

### Endpoint
`?safego=1&url=https://safego.cc/...`

Returns: `{ url: 'final_url', attempt, answer, ocrMethod }`

### Algorithm

#### Step 1: Fetch Captcha Page + PHPSESSID
```javascript
const r1 = await fetch(safegoUrl, { headers: {...}, redirect: 'manual' });
const sessid = ((r1.headers.get('Set-Cookie') || '').match(/PHPSESSID=([^;,\s]+)/) || [])[1];
const html1 = await r1.text();

// Determine field name (captch4 or captch5)
const cField = (html1.match(/name="(captch[45])"/) || [])[1] || 'captch5';

// Extract base64 PNG image from HTML
const imgMatch = html1.match(/data:image\/png;base64,([^"]+)"/i);
const b64 = imgMatch[1].replace(/\s/g, '');
```

#### Step 2: Decode PNG to Pixel Array
```javascript
// Simplified version:
async function _decodePngGrayscale(buf) {
  // Parse PNG chunks (IHDR, IDAT, IEND)
  // Decompress IDAT using zlib
  // Apply PNG filter (Paeth/Avg/Up/Sub)
  // Convert RGB/RGBA to grayscale using: 0.299*R + 0.587*G + 0.114*B
  return { width, height, pixels[] };
}

const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
const { width, height, pixels } = await _decodePngGrayscale(raw);
```

#### Step 3: Optical Character Recognition (OCR)

**Method A: Bitmap Template Matching (Primary)**
```javascript
function _ocrDigitsFromPixels(width, height, pixels, threshold=128) {
  // 1. Column darkness analysis: find digit boundaries
  const colDark = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let dark = 0;
    for (let y = 0; y < height; y++) {
      if (pixels[y * width + x] < threshold) dark++;
    }
    colDark[x] = dark / height;
  }
  
  // 2. Segment into individual digits
  const inDigit = Array.from(colDark, v => v > 0.05);
  const segments = [];
  let start = -1;
  for (let x = 0; x <= width; x++) {
    if (inDigit[x] && start < 0) start = x;
    else if (!inDigit[x] && start >= 0) {
      segments.push([start, x - 1]);
      start = -1;
    }
  }
  
  // 3. Extract each digit bitmap and match against templates
  let result = '';
  for (const [s, e] of digits) {
    // Find vertical bounds
    let top = -1, bot = -1;
    for (let y = 0; y < height; y++) {
      let d = 0;
      for (let x = s; x <= e; x++) {
        if (pixels[y * width + x] < threshold) d++;
      }
      if (d > 0) {
        if (top < 0) top = y;
        bot = y;
      }
    }
    
    // Build ASCII bitmap
    const rows = [];
    for (let y = top; y <= bot; y++) {
      let row = '';
      for (let x = s; x <= e; x++) {
        row += pixels[y * width + x] < threshold ? '#' : '.';
      }
      rows.push(row);
    }
    const key = rows.join('|');
    
    // 1. Exact match first
    let matched = null;
    for (const [ch, tmpl] of Object.entries(_BITMAP_TEMPLATES)) {
      if (tmpl === key) {
        matched = ch;
        break;
      }
    }
    
    // 2. Hamming distance fallback (if same width)
    if (!matched) {
      let best = '?', bestDist = Infinity;
      for (const [ch, tmpl] of Object.entries(_BITMAP_TEMPLATES)) {
        const t = tmpl.replace(/\|/g, '');
        const k = key.replace(/\|/g, '');
        if (t.length !== k.length) continue;
        let dist = 0;
        for (let i = 0; i < t.length; i++) {
          if (t[i] !== k[i]) dist++;
        }
        if (dist < bestDist) {
          bestDist = dist;
          best = ch;
        }
      }
      matched = bestDist <= 12 ? best : '?';
    }
    
    result += matched;
  }
  return result || null;
}
```

**Bitmap Template Maps (Calibrated)**
```javascript
const _BITMAP_TEMPLATES = {
  '0': '...##...|..####..|.##..##.|##....##|##....##|##....##|##....##|.##..##.|..####..|...##...',
  '1': '..##|.###|####|..##|..##|..##|..##|..##|..##|####',
  '2': '..####..|.##..##.|##....##|......##|.....##.|....##..|...##...|..##....|.##.....|########',
  // ... etc for 3-9
};
```

**Method B: AI Vision Fallback (Only if Pixel OCR Fails)**
```javascript
if (!answer && env?.AI) {
  try {
    const aiResp = await env.AI.run('@cf/llava-hf/llava-1.5-7b-hf', {
      image: [...Uint8Array.from(atob(b64), c => c.charCodeAt(0))],
      prompt: 'This CAPTCHA shows exactly 3 digits. What are the digits? Reply with ONLY the 3 digits, nothing else.',
      max_tokens: 10,
    });
    const aiText = (aiResp?.description || aiResp?.response || '').replace(/\D/g, '');
    if (aiText && aiText.length >= 2 && aiText.length <= 5) {
      answer = aiText;
      ocrMethod = 'ai';
    }
  } catch { /* AI failed */ }
}
```

#### Step 4: POST the Answer
```javascript
const rPost = await fetch(safegoUrl, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Cookie': `PHPSESSID=${sessid}`,
    'Origin': 'https://safego.cc',
    'Referer': safegoUrl,
    ...
  },
  body: `${cField}=${answer}`,
  redirect: 'manual',
});

// Parse response for redirect link
const postBody = await rPost.text();
const linkMatch = /<a\b[^>]+href="(https?:\/\/[^"]+)"/.exec(postBody);
let resultUrl = linkMatch ? linkMatch[1] : null;

// Fallback to 302 redirect header
if (!resultUrl) {
  const postLoc = rPost.headers.get('Location');
  if (postLoc) resultUrl = new URL(postLoc, safegoUrl).href;
}
```

#### Step 5: Optional Follow-All Redirect Chain
```javascript
const followAll = reqUrl.searchParams.get('followAll') === '1';
let finalUrl = resultUrl;
if (followAll) {
  for (let hop = 0; hop < 8; hop++) {
    if (/deltabit|turbovid|mixdrop|m1xdrop|maxstream/i.test(finalUrl)) break;
    try {
      const redir = await fetch(finalUrl, {
        headers: { 'User-Agent': UA, 'Accept': '*/*' },
        redirect: 'manual',
      });
      const loc = redir.headers.get('Location') || redir.headers.get('location');
      if (!loc) break;
      finalUrl = new URL(loc, finalUrl).href;
    } catch { break; }
  }
}

return _json({
  url: followAll ? finalUrl : resultUrl,
  attempt,
  answer,
  ocrMethod,  // 'pixel' or 'ai'
  ...(followAll && finalUrl !== resultUrl ? { intermediateUrl: resultUrl } : {})
});
```

## 4. STAYONLINE.PRO 24-HOUR UNLOCK MECHANISM

### Architecture
StayOnline.pro is an **indirection/proxy service** used by CB01

### Python Implementation
```python
async def get_stayonline(link, client):
    headers = {
        'origin': 'https://stayonline.pro',
        'user-agent': 'Mozilla/5.0 ...',
        'x-requested-with': 'XMLHttpRequest',
    }
    data = {'id': link.split("/")[-2], 'ref': ''}
    response = await client.post('https://stayonline.pro/ajax/linkEmbedView.php', headers=headers, data=data, proxies=proxies2)
    real_url = response.json()['data']['value']
    return real_url
```

### Key Points
- **24h Unlock**: StayOnline maintains session state that gates access for 24 hours
- **Link Format**: `https://stayonline.pro/{e|l}/{id}/` or `https://stayonline.pro/{id}/`
- **Resolution**: POST to `/ajax/linkEmbedView.php` with `{id, ref: ''}` returns `{data: {value: 'actual_url'}}`
- **Actual URL**: Returns uprot.net or maxstream.video URLs

## 5. KEY DIFFERENCES: MAMMAMIA vs STREAMFUSIONMAIL

| Aspect | MammaMia | StreamFusionMail |
|--------|----------|------------------|
| **Uprot Approach** | Uses saved cookies from /uprot endpoint; reuses for all links | Attempts direct fetch; falls back to CF Worker proxy with Spanish IP |
| **Cookie Persistence** | File-based (uprot.txt) in extractor directory | N/A - stateless per request |
| **OCR** | Manual captcha input via HTML form | Automatic bitmap template matching + AI fallback |
| **Proxy Strategy** | Forward proxy + random proxy list | CF Worker + Webshare proxy (Spanish IP) |
| **StayOnline** | AJAX POST to `/ajax/linkEmbedView.php` | AJAX POST to `/ajax/linkEmbedView.php` |
| **Framework** | FastAPI (Python) | Vercel API + CF Workers (JavaScript) |

## 6. EASYSTREAMS & STREAMVIX STATUS

### EasyStreams
- **File**: [tmp_easystreams/providers/extractors.js](tmp_easystreams/providers/extractors.js)
- **Status**: No uprot/maxstream specific handling (built extractor but not used in main flow)

### StreamVix
- **Files**: [tmp_streamvix/src/providers/cb01-provider.ts](tmp_streamvix/src/providers/cb01-provider.ts)
- **Status**: Avoids maxstream; prefers mixdrop
- **Comment**: "Non implementa Maxstream / altri host"
- **Logic**: Picks non-maxstream links when available
