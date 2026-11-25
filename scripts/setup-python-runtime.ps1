# Recreate the bundled Python runtime that ships with EasyDeal.
#
# Why this script exists:
# python-runtime/ is too big to commit (~140 MB of .pyd, .dll, wheels).
# Run this once on a fresh clone before `npm run dist:win` so electron-builder
# can include the runtime via the asarUnpack glob in package.json.
#
# What it does:
#   1. download Python 3.12.7 embeddable zip (~12 MB) from python.org
#   2. unzip into ./python-runtime/
#   3. patch python312._pth to enable site-packages + bundled sibling modules
#   4. bootstrap pip via get-pip.py
#   5. pip install all sidecar deps (mcp / croniter / httpx / qrcode /
#      Pillow / MetaTrader5 / flask / requests / pytz)
#
# Total time: ~3-5 min on a decent connection. After it finishes, run
# `npm run dist:win:nobump` to package.

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$rtDir    = Join-Path $repoRoot "python-runtime"

if (Test-Path $rtDir) {
  Write-Host "[setup-python-runtime] ./python-runtime already exists. Delete it first if you want to recreate." -ForegroundColor Yellow
  exit 1
}

Write-Host "[setup-python-runtime] Creating $rtDir ..."
New-Item -ItemType Directory -Path $rtDir | Out-Null
Set-Location $rtDir

# 1) Download Python 3.12.7 embeddable distribution.
$pyVer  = "3.12.7"
$pyUrl  = "https://www.python.org/ftp/python/$pyVer/python-$pyVer-embed-amd64.zip"
$pyZip  = Join-Path $rtDir "pyembed.zip"
Write-Host "[setup-python-runtime] Downloading $pyUrl ..."
Invoke-WebRequest -Uri $pyUrl -OutFile $pyZip -UseBasicParsing

# 2) Unzip + cleanup.
Write-Host "[setup-python-runtime] Unzipping ..."
Expand-Archive -Path $pyZip -DestinationPath $rtDir -Force
Remove-Item $pyZip

# 3) Patch python312._pth to enable site-packages and the sibling ./python
# directory used in both the source tree and packaged app.asar.unpacked tree.
# Embeddable Python otherwise omits even the executed script's directory.
# Must be written WITHOUT a BOM: Windows PowerShell 5.1's `-Encoding UTF8`
# prepends one, Python then reads the first entry as "<BOM>python312.zip",
# can't find the stdlib and dies with "No module named 'encodings'".
$pthPath = Join-Path $rtDir "python312._pth"
@'
python312.zip
.
Lib\site-packages
..\python

import site
'@ | Set-Content -Path $pthPath -Encoding ASCII

# 4) Bootstrap pip.
$getPip = Join-Path $rtDir "get-pip.py"
Write-Host "[setup-python-runtime] Bootstrapping pip ..."
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip -UseBasicParsing
& "$rtDir\python.exe" $getPip --no-warn-script-location
Remove-Item $getPip

# 5) Install runtime deps. Tsinghua mirror by default — comment out -i if
#    you're outside CN.
$pkgs = @("mcp<2", "croniter", "httpx", "qrcode", "Pillow", "MetaTrader5",
          "flask", "requests", "pytz",
          "numpy>=1.24", "psutil")
Write-Host "[setup-python-runtime] Installing $($pkgs -join ', ') ..."
& "$rtDir\python.exe" -m pip install --no-warn-script-location `
    -i https://pypi.tuna.tsinghua.edu.cn/simple `
    @pkgs

# Strip __pycache__ to shrink the bundle.
Get-ChildItem -Path $rtDir -Recurse -Directory -Filter "__pycache__" |
    Remove-Item -Recurse -Force

Write-Host ""
Write-Host "[setup-python-runtime] Done." -ForegroundColor Green
$size = (Get-ChildItem $rtDir -Recurse | Measure-Object Length -Sum).Sum / 1MB
Write-Host ("[setup-python-runtime] Size: {0:N0} MB" -f $size)
Write-Host "[setup-python-runtime] Next step: npm install && npm run dist:win:nobump"
