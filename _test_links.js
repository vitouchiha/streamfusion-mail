// Quick test: check what link format eurostreaming uses for hosts
(async () => {
  try {
    const r = await fetch('https://eurostream.ing/wp-json/wp/v2/posts/77498?_fields=content', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const d = await r.json();
    const html = d.content?.rendered || '';
    // Find 4x01 episode section
    const epMatch = html.match(/4&#215;01\s*(.*?)(?=<br\s*\/?>)/is);
    if (epMatch) {
      console.log('=== Episode 4x01 section ===');
      console.log(epMatch[0].substring(0, 500));
      // Extract all <a> tags
      const links = [...html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/g)];
      const epLinks = links.filter(m => /DeltaBit|Turbovid|MixDrop|MaxStream/i.test(m[2]));
      console.log('\n=== Host links in post ===');
      epLinks.slice(0, 10).forEach(m => console.log(`${m[2]} -> ${m[1]}`));
    } else {
      console.log('No 4x01 found. Searching for any episode patterns...');
      const anyEp = html.match(/\d+&#215;\d+/g);
      console.log('Episodes found:', anyEp?.slice(0, 5));
    }
  } catch (e) { console.error(e.message); }
})();
