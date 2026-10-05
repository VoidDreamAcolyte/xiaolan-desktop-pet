<#
  生成托盘图标（纯矢量绘制，不使用任何位图素材）
  ==========================================================================
  为什么需要它：
    Electron 的 Tray / nativeImage 不能直接吃 SVG，必须给 PNG/ICO。
    为了不引入任何第三方图像库，这里用 Windows 自带的 System.Drawing 现场把
    "小鱼"用矢量图形画出来（椭圆身体 + 小尾巴 + 大眼睛），再导出成 PNG。

  生成的图标只用于托盘按钮这一处；桌宠本体在 assets/fish.svg，始终是矢量。

  用法：
    npm run icons
    或  powershell -NoProfile -ExecutionPolicy Bypass -File tools/make-icons.ps1

  产物：
    assets/tray-icon.png    32×32 透明 PNG（托盘主图标）
    assets/tray-icon@2x.png 64×64 透明 PNG（高分屏备用）
#>

[CmdletBinding()]
param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# 输出目录：默认写到仓库的 assets/ 下
# （在脚本主体里计算，避免部分 PowerShell 版本在 param 默认值里拿不到脚本目录）
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
  $OutputDir = Join-Path $scriptDir '..\assets'
}

# 以 32×32 为设计基准，按目标尺寸整体缩放绘制
function New-FishBitmap {
  param([int]$Size)

  $bmp = New-Object System.Drawing.Bitmap -ArgumentList $Size, $Size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = [single]($Size / 32.0)
  $g.ScaleTransform($scale, $scale)

  # 颜色（深海蓝系，与 assets/fish.svg 保持一致）
  $cBodyTop = [System.Drawing.Color]::FromArgb(255, 27, 110, 168)
  $cBodyBottom = [System.Drawing.Color]::FromArgb(255, 6, 42, 73)
  $cFin = [System.Drawing.Color]::FromArgb(255, 12, 74, 118)
  $cEyeWhite = [System.Drawing.Color]::FromArgb(255, 246, 251, 255)
  $cPupil = [System.Drawing.Color]::FromArgb(255, 8, 36, 61)

  # 小尾巴：两片小三角贴在身体左侧
  $tailBrush = New-Object System.Drawing.SolidBrush -ArgumentList $cFin
  $tailTop = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new([single]5, [single]14),
    [System.Drawing.PointF]::new([single]0, [single]9),
    [System.Drawing.PointF]::new([single]5, [single]18)
  )
  $tailBottom = [System.Drawing.PointF[]]@(
    [System.Drawing.PointF]::new([single]5, [single]16),
    [System.Drawing.PointF]::new([single]0, [single]24),
    [System.Drawing.PointF]::new([single]5, [single]20)
  )
  $g.FillPolygon($tailBrush, $tailTop)
  $g.FillPolygon($tailBrush, $tailBottom)

  # 胖椭圆身体（深海蓝渐变）
  $bodyRect = New-Object System.Drawing.RectangleF -ArgumentList (([single]4), ([single]7), ([single]20), ([single]17))
  $bodyBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList ($bodyRect, $cBodyTop, $cBodyBottom, ([System.Drawing.Drawing2D.LinearGradientMode]::Vertical))
  $g.FillEllipse($bodyBrush, $bodyRect)

  # 小短鳍
  $finBrush = New-Object System.Drawing.SolidBrush -ArgumentList $cFin
  $g.FillEllipse($finBrush, ([single]15), ([single]20), ([single]8), ([single]5))

  # 大眼睛：眼白 + 瞳孔
  $eyeWhite = New-Object System.Drawing.SolidBrush -ArgumentList $cEyeWhite
  $pupil = New-Object System.Drawing.SolidBrush -ArgumentList $cPupil
  $g.FillEllipse($eyeWhite, ([single]10), ([single]11), ([single]6), ([single]7))
  $g.FillEllipse($eyeWhite, ([single]19), ([single]11), ([single]6), ([single]7))
  $g.FillEllipse($pupil, ([single]11.6), ([single]13), ([single]3), ([single]3.6))
  $g.FillEllipse($pupil, ([single]20.6), ([single]13), ([single]3), ([single]3.6))

  $g.Dispose()
  $tailBrush.Dispose()
  $bodyBrush.Dispose()
  $finBrush.Dispose()
  $eyeWhite.Dispose()
  $pupil.Dispose()

  return $bmp
}

if (-not (Test-Path $OutputDir)) {
  New-Item -ItemType Directory -Path $OutputDir | Out-Null
}

$targets = @(
  @{ Size = 32; Name = 'tray-icon.png' },
  @{ Size = 64; Name = 'tray-icon@2x.png' }
)

foreach ($target in $targets) {
  $bmp = New-FishBitmap -Size $target.Size
  $file = Join-Path $OutputDir $target.Name
  $bmp.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host ("[icons] 已生成 {0} ({1}x{1})" -f $file, $target.Size)
}
