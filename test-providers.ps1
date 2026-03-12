$tests = @(
    @{ Label='Barbie (movie)'; Path='movie/tt1517268' },
    @{ Label='Squid Game S2E1'; Path='series/tt10919420%3A2%3A1' },
    @{ Label='Our Universe S1E4 (kdrama)'; Path='series/tt39453765%3A1%3A4' },
    @{ Label='One Piece S1E1 (anime)'; Path='series/tt0388629%3A1%3A1' }
)

$addons = @(
    @{ Name='NelloStream'; Url='https://streamfusion-mail.vercel.app' },
    @{ Name='StreamVix'; Url='https://streamvix.hayd.uk' }
)

foreach ($test in $tests) {
    Write-Host "`n=== $($test.Label) ===" -ForegroundColor Cyan
    foreach ($addon in $addons) {
        $uri = "$($addon.Url)/stream/$($test.Path).json"
        try {
            $r = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 60
            $j = $r.Content | ConvertFrom-Json
            $count = $j.streams.Count
            $details = @()
            foreach ($s in $j.streams) {
                $lines = $s.title -split "`n"
                $name = ($s.name -split "`n")[-1]
                $details += "$name"
            }
            $unique = ($details | Select-Object -Unique) -join ', '
            Write-Host "  $($addon.Name): $count streams [$unique]"
        } catch {
            Write-Host "  $($addon.Name): ERROR - $($_.Exception.Message.Substring(0,80))" -ForegroundColor Red
        }
    }
}
Write-Host "`nDone!" -ForegroundColor Green
