# ==========================================================
# EasyDeal 自签代码签名证书生成脚本
# ==========================================================
# 用法：
#   1. 用「以管理员身份运行」的 PowerShell 跑：
#      powershell -ExecutionPolicy Bypass -File scripts/gen-selfsigned-cert.ps1
#   2. 输出：
#      certs/easydeal-selfsigned.pfx           (含私钥，build 时用)
#      certs/easydeal-selfsigned-public.cer    (公钥，给客户装到 Trusted Publishers)
#   3. 跑：
#      $env:WIN_CSC_LINK = (Resolve-Path ".\certs\easydeal-selfsigned.pfx").Path
#      $env:WIN_CSC_KEY_PASSWORD = "你设的密码"
#      npm run dist:win
#
# ⚠ 重要提醒：自签证书不会让 SmartScreen / 浏览器停止弹警告。它只在
#    「客户已手动把你的证书装进 Trusted Root + Trusted Publishers」的场景下
#    免警告。量产建议买真证书。
# ==========================================================

param(
    [string]$Subject       = "CN=Fay 数字人开源社区, O=Fay Agent, C=CN",
    [string]$FriendlyName  = "EasyDeal Self-Signed Code Signing",
    [int]$ValidityYears    = 5,
    [string]$OutDir        = "certs",
    [string]$Password      = ""    # 留空则交互式输入
)

$ErrorActionPreference = "Stop"

# 1. 准备输出目录
$repoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$absOutDir = Join-Path $repoRoot $OutDir
if (-not (Test-Path $absOutDir)) {
    New-Item -ItemType Directory -Path $absOutDir | Out-Null
}

# 2. 生成证书到当前用户的证书库
Write-Host "正在生成自签代码签名证书……" -ForegroundColor Cyan
Write-Host "  Subject:       $Subject"
Write-Host "  Friendly Name: $FriendlyName"
Write-Host "  Validity:      $ValidityYears years"

$cert = New-SelfSignedCertificate `
    -Subject $Subject `
    -FriendlyName $FriendlyName `
    -Type CodeSigningCert `
    -KeyUsage DigitalSignature `
    -KeyAlgorithm RSA `
    -KeyLength 4096 `
    -HashAlgorithm SHA256 `
    -NotAfter (Get-Date).AddYears($ValidityYears) `
    -CertStoreLocation "Cert:\CurrentUser\My"

Write-Host ""
Write-Host "✓ 证书已生成在 Cert:\CurrentUser\My，Thumbprint: $($cert.Thumbprint)" -ForegroundColor Green

# 3. 导出 PFX (含私钥)
$pfxPath = Join-Path $absOutDir "easydeal-selfsigned.pfx"
if ([string]::IsNullOrEmpty($Password)) {
    $securePwd = Read-Host -AsSecureString -Prompt "为 PFX 文件设置一个密码（build 时要用）"
} else {
    $securePwd = ConvertTo-SecureString -String $Password -Force -AsPlainText
}
Export-PfxCertificate `
    -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" `
    -FilePath $pfxPath `
    -Password $securePwd `
    -ChainOption EndEntityCertOnly | Out-Null
Write-Host "✓ PFX (含私钥):   $pfxPath" -ForegroundColor Green

# 4. 导出 CER (公钥，给客户用来手动信任)
$cerPath = Join-Path $absOutDir "easydeal-selfsigned-public.cer"
Export-Certificate `
    -Cert "Cert:\CurrentUser\My\$($cert.Thumbprint)" `
    -FilePath $cerPath | Out-Null
Write-Host "✓ CER (公钥, 给客户): $cerPath" -ForegroundColor Green

# 5. 提示下一步
Write-Host ""
Write-Host "============================================================" -ForegroundColor Yellow
Write-Host "下一步：" -ForegroundColor Yellow
Write-Host ""
Write-Host "  ① build 时用此证书签名（PowerShell）：" -ForegroundColor Yellow
Write-Host '     $env:WIN_CSC_LINK = "' + $pfxPath + '"'
Write-Host '     $env:WIN_CSC_KEY_PASSWORD = "你刚才设的密码"'
Write-Host '     npm run dist:win' -ForegroundColor Yellow
Write-Host ""
Write-Host "  ② 给愿意信任你的客户：" -ForegroundColor Yellow
Write-Host "     - 让他们双击 $cerPath"
Write-Host "     - 「安装证书」→ 「本地计算机」→「将所有证书放入下列存储」→ 选「受信任的根证书颁发机构」"
Write-Host "     - 再装一份到「受信任的发布者」（Trusted Publishers）"
Write-Host "     - 之后该客户机器再装你的 .exe 不弹 SmartScreen"
Write-Host ""
Write-Host "  ③ 把 certs/ 加到 .gitignore，PFX 千万别进 git！" -ForegroundColor Red
Write-Host "============================================================" -ForegroundColor Yellow
