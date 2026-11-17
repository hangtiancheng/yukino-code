
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'

using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class YukinoComputer
{
  [StructLayout(LayoutKind.Sequential)]
  private struct INPUT { public uint type; public InputUnion value; }
  [StructLayout(LayoutKind.Explicit)]
  private struct InputUnion
  {
    [FieldOffset(0)] public MOUSEINPUT mouse;
    [FieldOffset(0)] public KEYBDINPUT keyboard;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct MOUSEINPUT
  {
    public int x;
    public int y;
    public uint data;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }
  [StructLayout(LayoutKind.Sequential)]
  private struct KEYBDINPUT
  {
    public ushort virtualKey;
    public ushort scanCode;
    public uint flags;
    public uint time;
    public UIntPtr extraInfo;
  }

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extraInfo);
  [DllImport("user32.dll", SetLastError = true)]
  private static extern uint SendInput(uint count, INPUT[] inputs, int size);

  private static void SendKeyboard(ushort virtualKey, ushort scanCode, uint flags)
  {
    var inputs = new[] {
      new INPUT {
        type = 1,
        value = new InputUnion {
          keyboard = new KEYBDINPUT {
            virtualKey = virtualKey,
            scanCode = scanCode,
            flags = flags,
            extraInfo = UIntPtr.Zero
          }
        }
      }
    };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1)
    {
      throw new InvalidOperationException("SendInput failed.");
    }
  }

  public static void Move(int x, int y) { Cursor.Position = new Point(x, y); }
  public static Point Position() { return Cursor.Position; }
  public static void Mouse(uint flags, int data = 0) { mouse_event(flags, 0, 0, data, UIntPtr.Zero); }
  public static void Key(int virtualKey, bool down) { SendKeyboard((ushort)virtualKey, 0, down ? 0u : 2u); }
  public static void Text(string text)
  {
    foreach (char value in text)
    {
      SendKeyboard(0, value, 4u);
      SendKeyboard(0, value, 6u);
    }
  }
}

'@ -ReferencedAssemblies System.Drawing, System.Windows.Forms -OutputAssembly $env:YUKINO_COMPUTER_ASSEMBLY
