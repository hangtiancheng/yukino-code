
$ErrorActionPreference = 'Stop';
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding;
Add-Type -AssemblyName System.Drawing;
Add-Type -AssemblyName System.Windows.Forms;
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height;
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size);
$bitmap.Save($env:YUKINO_SCREENSHOT_PATH, [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose(); $bitmap.Dispose();
Write-Output "$($bounds.Width),$($bounds.Height)"
