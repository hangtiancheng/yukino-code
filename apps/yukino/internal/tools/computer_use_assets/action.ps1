
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path $env:YUKINO_COMPUTER_ASSEMBLY

$payload = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:YUKINO_COMPUTER_INPUT)) | ConvertFrom-Json
function Resolve-Key([string]$name) {
  switch ($name.ToUpperInvariant()) {
    'CTRL' { return 0x11 }
    'CONTROL' { return 0x11 }
    'SHIFT' { return 0x10 }
    'ALT' { return 0x12 }
    'OPTION' { return 0x12 }
    'CMD' { return 0x5B }
    'COMMAND' { return 0x5B }
    'META' { return 0x5B }
    'WIN' { return 0x5B }
    'WINDOWS' { return 0x5B }
    'ENTER' { return 0x0D }
    'RETURN' { return 0x0D }
    'ESC' { return 0x1B }
    'ESCAPE' { return 0x1B }
    'BACKSPACE' { return 0x08 }
    'DELETE' { return 0x2E }
    'TAB' { return 0x09 }
    'SPACE' { return 0x20 }
    'LEFT' { return 0x25 }
    'UP' { return 0x26 }
    'RIGHT' { return 0x27 }
    'DOWN' { return 0x28 }
    'HOME' { return 0x24 }
    'END' { return 0x23 }
    'PAGEUP' { return 0x21 }
    'PAGEDOWN' { return 0x22 }
    default {
      if ($name.Length -eq 1) { return [int][char]$name.ToUpperInvariant() }
      try { return [int]([System.Enum]::Parse([System.Windows.Forms.Keys], $name, $true)) }
      catch { throw "Unsupported key: $name" }
    }
  }
}
function Key-Down($keys) { foreach ($key in $keys) { [YukinoComputer]::Key((Resolve-Key $key), $true) } }
function Key-Up($keys) { for ($i = $keys.Count - 1; $i -ge 0; $i--) { [YukinoComputer]::Key((Resolve-Key $keys[$i]), $false) } }
function Move-To($value) {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  [YukinoComputer]::Move($bounds.X + [int]$value.x, $bounds.Y + [int]$value.y)
}

$keys = @($payload.keys)
switch ($payload.action) {
  'cursor_position' {
    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $point = [YukinoComputer]::Position()
    Write-Output "$(($point.X - $bounds.X)),$(($point.Y - $bounds.Y))"
  }
  'mouse_move' { Key-Down $keys; Move-To $payload; Key-Up $keys }
  'left_mouse_down' { [YukinoComputer]::Mouse(0x0002) }
  'left_mouse_up' { [YukinoComputer]::Mouse(0x0004) }
  'mouse_click' {
    Move-To $payload
    Key-Down $keys
    $down = switch ($payload.button) { 'right' { 0x0008 } 'middle' { 0x0020 } default { 0x0002 } }
    $up = switch ($payload.button) { 'right' { 0x0010 } 'middle' { 0x0040 } default { 0x0004 } }
    for ($i = 0; $i -lt [int]$payload.clicks; $i++) {
      [YukinoComputer]::Mouse($down); [YukinoComputer]::Mouse($up); Start-Sleep -Milliseconds 80
    }
    Key-Up $keys
  }
  'left_click_drag' {
    Key-Down $keys
    Move-To $payload.path[0]
    [YukinoComputer]::Mouse(0x0002)
    foreach ($point in $payload.path | Select-Object -Skip 1) { Move-To $point; Start-Sleep -Milliseconds 20 }
    [YukinoComputer]::Mouse(0x0004)
    Key-Up $keys
  }
  'scroll' {
    if ($null -ne $payload.x -and $null -ne $payload.y) { Move-To $payload }
    Key-Down $keys
    [YukinoComputer]::Mouse(0x0800, - ([int]$payload.scrollY * 120))
    [YukinoComputer]::Mouse(0x01000, [int]$payload.scrollX * 120)
    Key-Up $keys
  }
  'key' { Key-Down $keys; Key-Up $keys }
  'hold_key' { Key-Down $keys; Start-Sleep -Milliseconds ([int]([double]$payload.duration * 1000)); Key-Up $keys }
  'type' { [YukinoComputer]::Text([string]$payload.text) }
  default { throw "Unsupported action: $($payload.action)" }
}
