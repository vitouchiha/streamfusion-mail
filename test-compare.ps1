$addons = @(
  @{ name="NelloStream"; url="https://streamfusion-mail.vercel.app" }
  @{ name="StreamVix"; url="https://streamvix.hayd.uk" }
  @{ name="EasyStreams"; url="https://easystreams.stremio.dpdns.org" }
  @{ name="MammaMia"; url="https://mammamia.stremio.dpdns.org" }
)

$titles = @(
  @{ name="Barbie (movie)"; id="tt1517268" }
  @{ name="Squid Game S2E1"; id="tt10919420:2:1" }
  @{ name="Our Universe S1E4"; id="tt39453765:1:4" }
  @{ name="One Piece S1E1"; id="tt0388629:1:1" }
)

foreach ($t in $titles) {
  $type = if ($t.id -match ':') { "series" } else { "movie" }
  Write-Host ""
  Write-Host "=== $($t.name) ($type/$($t.id)) ==="
  foreach ($a in $addons) {
    try {
      $uri = "$($a.url)/stream/$type/$($t.id).json"
      $r = Invoke-RestMethod -Uri $uri -TimeoutSec 60 -ErrorAction Stop
      $count = 0
      if ($r.streams) { $count = $r.streams.Count }
      $names = "none"
      if ($count -gt 0) {
        $parts = @()
        foreach ($s in $r.streams) {
          $n = ""
          if ($s.title) { $n = ($s.title -split "`n")[0].Trim() }
          elseif ($s.name) { $n = ($s.name -split "`n")[0].Trim() }
          else { $n = "?" }
          if ($n.Length -gt 50) { $n = $n.Substring(0, 50) }
          $parts += $n
        }
        $names = $parts -join " | "
      }
      Write-Host "  $($a.name): $count streams [$names]"
    } catch {
      Write-Host "  $($a.name): ERROR - $($_.Exception.Message)"
    }
  }
}
Write-Host ""
Write-Host "=== DONE ==="
