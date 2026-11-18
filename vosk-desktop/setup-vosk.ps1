$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12
function InstallPart($url,$hash,$folder,$inner) {
 if (Test-Path "$folder/.ready") {return}
 Write-Host "Downloading $folder..."
 $tmp=Join-Path $env:TEMP ([guid]::NewGuid().ToString())
 New-Item -Type Directory -Path $tmp | Out-Null
 try {
  Invoke-WebRequest -UseBasicParsing $url -OutFile "$tmp/pkg.zip"
  if ((Get-FileHash "$tmp/pkg.zip").Hash -ne $hash) {throw 'Download verification failed'}
  Expand-Archive "$tmp/pkg.zip" "$tmp/data"
  New-Item -Force -Type Directory $folder | Out-Null
  Copy-Item "$tmp/data/$inner*" $folder -Recurse -Force
  New-Item -Type File "$folder/.ready" -Force | Out-Null
 } finally {Remove-Item -LiteralPath $tmp -Recurse -Force}
}
InstallPart 'https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip' '4acbed6dd1c744b0376e3b1cf57ce906f9dc9e95e68824584c8099a63025a3c3' 'runtime' ''
InstallPart 'https://files.pythonhosted.org/packages/c0/4c/deb0861f7da9696f8a255f1731bb73e9412cca29c4b3888a3fcb2a930a59/vosk-0.3.45-py3-none-win_amd64.whl' '6994ddc68556c7e5730c3b6f6bad13320e3519b13ce3ed2aa25a86724e7c10ac' 'engine' 'vosk/'
InstallPart 'https://alphacephei.com/vosk/models/vosk-model-small-ja-0.22.zip' 'efa092d280153a77615e9e0c7d7283e93e600de3d19d3bec686c57ef19d52eac' 'model' 'vosk-model-small-ja-0.22/'
