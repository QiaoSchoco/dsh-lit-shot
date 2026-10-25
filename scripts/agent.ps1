param(
    [string]$Hotkey = 'Alt+A',
    [int]$MaxEdge = 1920
)

# Resident capture agent for @local/dsh-shot.
#
# Protocol (one JSON object per line, ASCII only):
#   stdout  {"event":"ready","ok":true,"hotkey":"Alt+A","error":""}
#           {"event":"hotkey","ok":true,"hotkey":"Ctrl+Shift+A","error":""}
#           {"event":"shot","path":"C:\\...\\shot-....png","width":1200,"height":800}
#           {"event":"cancel"}
#           {"event":"error","error":"..."}
#   stdin   capture
#           hotkey Alt+A
#           quit

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$source = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshShot
{
    internal static class Native
    {
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    }

    internal sealed class HotkeyWindow : NativeWindow
    {
        public const int WM_HOTKEY = 0x0312;
        public Action<int> Pressed;

        public HotkeyWindow()
        {
            CreateHandle(new CreateParams());
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                Action<int> handler = Pressed;
                if (handler != null) handler(m.WParam.ToInt32());
                return;
            }
            base.WndProc(ref m);
        }
    }

    internal sealed class OverlayForm : Form
    {
        private static readonly Color Accent = Color.FromArgb(255, 74, 144, 226);
        private static readonly Color Dim = Color.FromArgb(120, 8, 12, 18);
        private static readonly Font LabelFont = new Font("Segoe UI", 9f);
        private static readonly SolidBrush LabelBack = new SolidBrush(Color.FromArgb(210, 24, 30, 40));

        private Bitmap shot;
        private Point start;
        private Rectangle selection = Rectangle.Empty;
        private bool dragging;
        private bool committing;

        public event Action<string, int, int> Captured;
        public event Action Dismissed;

        public OverlayForm()
        {
            FormBorderStyle = FormBorderStyle.None;
            StartPosition = FormStartPosition.Manual;
            ShowInTaskbar = false;
            TopMost = true;
            KeyPreview = true;
            Cursor = Cursors.Cross;
            BackColor = Color.Black;
            DoubleBuffered = true;
            SetStyle(ControlStyles.OptimizedDoubleBuffer | ControlStyles.AllPaintingInWmPaint | ControlStyles.UserPaint, true);
        }

        public void Arm(Bitmap bitmap, Rectangle bounds)
        {
            if (shot != null)
            {
                shot.Dispose();
            }
            shot = bitmap;
            selection = Rectangle.Empty;
            dragging = false;
            committing = false;
            Bounds = bounds;
            Show();
            BringToFront();
            Activate();
            Invalidate();
        }

        public void Cancel()
        {
            if (Visible && shot != null) Close(true);
        }

        public void Close(bool cancelled)
        {
            Hide();
            if (shot != null)
            {
                shot.Dispose();
                shot = null;
            }
            selection = Rectangle.Empty;
            dragging = false;
            if (cancelled)
            {
                Action d = Dismissed;
                if (d != null) d();
            }
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            if (shot == null)
            {
                e.Graphics.Clear(Color.Black);
                return;
            }
            Graphics g = e.Graphics;
            g.InterpolationMode = InterpolationMode.NearestNeighbor;
            g.PixelOffsetMode = PixelOffsetMode.Half;
            g.DrawImage(shot, new Rectangle(0, 0, ClientSize.Width, ClientSize.Height));

            using (SolidBrush dim = new SolidBrush(Dim))
            {
                if (selection.Width <= 0 || selection.Height <= 0)
                {
                    g.FillRectangle(dim, ClientRectangle);
                }
                else
                {
                    Rectangle s = selection;
                    g.FillRectangle(dim, new Rectangle(0, 0, ClientSize.Width, s.Top));
                    g.FillRectangle(dim, new Rectangle(0, s.Bottom, ClientSize.Width, ClientSize.Height - s.Bottom));
                    g.FillRectangle(dim, new Rectangle(0, s.Top, s.Left, s.Height));
                    g.FillRectangle(dim, new Rectangle(s.Right, s.Top, ClientSize.Width - s.Right, s.Height));
                }
            }

            if (selection.Width > 0 && selection.Height > 0)
            {
                using (Pen pen = new Pen(Accent, 1.5f))
                {
                    g.DrawRectangle(pen, selection);
                }
                string text = string.Format("{0} x {1}", selection.Width, selection.Height);
                Size size = TextRenderer.MeasureText(text, LabelFont);
                int x = selection.Left;
                int y = selection.Top - size.Height - 6;
                if (y < 4) y = selection.Top + 6;
                if (x + size.Width + 12 > ClientSize.Width) x = ClientSize.Width - size.Width - 12;
                g.FillRectangle(LabelBack, x, y, size.Width + 12, size.Height + 4);
                TextRenderer.DrawText(g, text, LabelFont, new Point(x + 6, y + 2), Color.White);
            }
            else
            {
                string hint = "\u62d6\u62fd\u6846\u9009\u533a\u57df\u00b7Esc \u53d6\u6d88\u00b7\u53f3\u952e\u53d6\u6d88";
                Size size = TextRenderer.MeasureText(hint, LabelFont);
                int x = (ClientSize.Width - size.Width) / 2;
                g.FillRectangle(LabelBack, x - 12, 28, size.Width + 24, size.Height + 8);
                TextRenderer.DrawText(g, hint, LabelFont, new Point(x, 32), Color.White);
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button == MouseButtons.Right)
            {
                Close(true);
                return;
            }
            if (e.Button != MouseButtons.Left) return;
            start = e.Location;
            dragging = true;
            selection = new Rectangle(e.Location, Size.Empty);
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (!dragging) return;
            selection = Normalize(start, e.Location);
            Invalidate();
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (!dragging) return;
            dragging = false;
            selection = Normalize(start, e.Location);
            if (selection.Width < 4 || selection.Height < 4)
            {
                Close(true);
                return;
            }
            Commit();
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Escape)
            {
                e.Handled = true;
                Close(true);
            }
        }

        private static Rectangle Normalize(Point a, Point b)
        {
            int x = Math.Min(a.X, b.X);
            int y = Math.Min(a.Y, b.Y);
            return new Rectangle(x, y, Math.Abs(a.X - b.X), Math.Abs(a.Y - b.Y));
        }

        private void Commit()
        {
            if (committing || shot == null) return;
            committing = true;
            string path = null;
            int width = 0;
            int height = 0;
            try
            {
                Bitmap crop = Crop(selection);
                string dir = Path.Combine(Path.GetTempPath(), "dsh-shot");
                Directory.CreateDirectory(dir);
                path = Path.Combine(dir, "shot-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
                crop.Save(path, ImageFormat.Png);
                width = crop.Width;
                height = crop.Height;
                crop.Dispose();
            }
            catch (Exception error)
            {
                Writer.Error(error.Message);
                Close(true);
                return;
            }
            Close(false);
            Action<string, int, int> handler = Captured;
            if (handler != null) handler(path, width, height);
        }

        private Bitmap Crop(Rectangle area)
        {
            int width = area.Width;
            int height = area.Height;
            int edge = Agent.MaxEdge;
            double scale = 1.0;
            if (edge > 0 && Math.Max(width, height) > edge)
            {
                scale = (double)edge / (double)Math.Max(width, height);
                width = Math.Max(1, (int)Math.Round(width * scale));
                height = Math.Max(1, (int)Math.Round(height * scale));
            }
            Bitmap crop = new Bitmap(width, height, PixelFormat.Format24bppRgb);
            using (Graphics g = Graphics.FromImage(crop))
            {
                g.InterpolationMode = InterpolationMode.HighQualityBilinear;
                g.PixelOffsetMode = PixelOffsetMode.HighQuality;
                g.DrawImage(shot, new Rectangle(0, 0, width, height), area, GraphicsUnit.Pixel);
            }
            return crop;
        }
    }

    internal static class Writer
    {
        private static readonly object Gate = new object();

        public static void Line(string json)
        {
            lock (Gate)
            {
                try
                {
                    Console.Out.WriteLine(json);
                    Console.Out.Flush();
                }
                catch
                {
                }
            }
        }

        public static void Error(string message)
        {
            Line("{\"event\":\"error\",\"error\":\"" + Escape(message) + "\"}");
        }

        public static string Escape(string text)
        {
            if (text == null) return "";
            StringBuilder builder = new StringBuilder();
            foreach (char c in text)
            {
                switch (c)
                {
                    case '\\': builder.Append("\\\\"); break;
                    case '"': builder.Append("\\\""); break;
                    case '\r': builder.Append("\\r"); break;
                    case '\n': builder.Append("\\n"); break;
                    case '\t': builder.Append("\\t"); break;
                    default:
                        if (c < ' ') builder.Append(' ');
                        else builder.Append(c);
                        break;
                }
            }
            return builder.ToString();
        }
    }

    public static class Agent
    {
        public static int MaxEdge = 1920;

        private static OverlayForm overlay;
        private static HotkeyWindow hotkeyWindow;
        private static bool hotkeyOk;
        private static string hotkeyError = "";
        private static volatile bool capturing;
        private static string currentSpec = "Alt+A";

        public static void Start(string spec, int maxEdge)
        {
            MaxEdge = maxEdge;
            Native.SetProcessDPIAware();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            hotkeyWindow = new HotkeyWindow();
            hotkeyWindow.Pressed = delegate(int id) { Trigger(); };

            overlay = new OverlayForm();
            overlay.Captured += delegate(string path, int width, int height)
            {
                capturing = false;
                Writer.Line("{\"event\":\"shot\",\"path\":\"" + Writer.Escape(path) + "\",\"width\":" + width + ",\"height\":" + height + "}");
            };
            overlay.Dismissed += delegate
            {
                capturing = false;
                Writer.Line("{\"event\":\"cancel\"}");
            };
            IntPtr unused = overlay.Handle;

            ApplyHotkey(spec);
            ReportReady();

            Thread reader = new Thread(ReadCommands);
            reader.IsBackground = true;
            reader.Start();

            Application.Run(new ApplicationContext());
        }

        private static void ReportReady()
        {
            Writer.Line("{\"event\":\"ready\",\"ok\":" + (hotkeyOk ? "true" : "false") + ",\"hotkey\":\"" + Writer.Escape(currentSpec) + "\",\"error\":\"" + Writer.Escape(hotkeyError) + "\"}");
        }

        private static void ReadCommands()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    string text = line.Trim();
                    if (text.Length == 0) continue;
                    string lower = text.ToLowerInvariant();
                    if (lower == "quit")
                    {
                        TryBeginInvoke(delegate { Application.ExitThread(); });
                        return;
                    }
                    if (lower == "capture")
                    {
                        TryBeginInvoke(delegate { Trigger(); });
                        continue;
                    }
                    if (lower == "cancel")
                    {
                        TryBeginInvoke(delegate { overlay.Cancel(); });
                        continue;
                    }
                    if (lower.StartsWith("hotkey "))
                    {
                        string spec = text.Substring(7).Trim();
                        TryBeginInvoke(delegate { ApplyHotkey(spec); });
                        continue;
                    }
                    Writer.Error("unknown command: " + text);
                }
            }
            catch (Exception error)
            {
                Writer.Error(error.Message);
            }
            TryBeginInvoke(delegate { Application.ExitThread(); });
        }

        private static void TryBeginInvoke(MethodInvoker action)
        {
            try
            {
                if (overlay != null && overlay.IsHandleCreated) overlay.BeginInvoke(action);
            }
            catch
            {
            }
        }

        private static void Trigger()
        {
            if (capturing) return;
            capturing = true;
            try
            {
                Rectangle screen = SystemInformation.VirtualScreen;
                Bitmap bitmap = new Bitmap(screen.Width, screen.Height, PixelFormat.Format24bppRgb);
                using (Graphics g = Graphics.FromImage(bitmap))
                {
                    g.CopyFromScreen(screen.Left, screen.Top, 0, 0, screen.Size, CopyPixelOperation.SourceCopy);
                }
                overlay.Arm(bitmap, screen);
            }
            catch (Exception error)
            {
                capturing = false;
                Writer.Error(error.Message);
            }
        }

        private static bool ApplyHotkey(string spec)
        {
            Unregister();
            currentSpec = spec;
            hotkeyError = "";
            uint mods = 0;
            uint key = 0;
            if (!ParseSpec(spec, out mods, out key, out hotkeyError))
            {
                hotkeyOk = false;
                Writer.Line("{\"event\":\"hotkey\",\"ok\":false,\"hotkey\":\"" + Writer.Escape(spec) + "\",\"error\":\"" + Writer.Escape(hotkeyError) + "\"}");
                return false;
            }
            hotkeyOk = Native.RegisterHotKey(hotkeyWindow.Handle, 1, mods | 0x4000, key);
            if (!hotkeyOk)
            {
                int code = Marshal.GetLastWin32Error();
                hotkeyError = code == 1409 ? "\u5feb\u6377\u952e\u5df2\u88ab\u5176\u4ed6\u7a0b\u5e8f\u5360\u7528" : ("RegisterHotKey failed: " + code);
            }
            Writer.Line("{\"event\":\"hotkey\",\"ok\":" + (hotkeyOk ? "true" : "false") + ",\"hotkey\":\"" + Writer.Escape(spec) + "\",\"error\":\"" + Writer.Escape(hotkeyError) + "\"}");
            return hotkeyOk;
        }

        private static void Unregister()
        {
            try
            {
                if (hotkeyWindow != null && hotkeyWindow.Handle != IntPtr.Zero)
                {
                    Native.UnregisterHotKey(hotkeyWindow.Handle, 1);
                }
            }
            catch
            {
            }
        }

        private static bool ParseSpec(string spec, out uint mods, out uint key, out string error)
        {
            mods = 0;
            key = 0;
            error = "";
            if (spec == null || spec.Trim().Length == 0)
            {
                error = "\u5feb\u6377\u952e\u4e3a\u7a7a";
                return false;
            }
            string[] parts = spec.Split('+');
            string last = parts[parts.Length - 1].Trim();
            for (int i = 0; i < parts.Length - 1; i++)
            {
                string token = parts[i].Trim().ToLowerInvariant();
                if (token == "alt") mods = mods | 0x0001;
                else if (token == "ctrl" || token == "control") mods = mods | 0x0002;
                else if (token == "shift") mods = mods | 0x0004;
                else if (token == "win") mods = mods | 0x0008;
                else
                {
                    error = "\u65e0\u6cd5\u8bc6\u522b\u4fee\u9970\u952e: " + token;
                    return false;
                }
            }
            if (mods == 0)
            {
                error = "\u9700\u8981\u81f3\u5c11\u4e00\u4e2a\u4fee\u9970\u952e";
                return false;
            }
            string upper = last.ToUpperInvariant();
            if (upper.Length == 1)
            {
                char c = upper[0];
                if (c >= 'A' && c <= 'Z') key = (uint)c;
                else if (c >= '0' && c <= '9') key = (uint)c;
            }
            else if (upper.Length >= 2 && upper.Length <= 3 && upper[0] == 'F')
            {
                int number;
                if (int.TryParse(upper.Substring(1), out number) && number >= 1 && number <= 24)
                {
                    key = (uint)(0x70 + number - 1);
                }
            }
            if (key == 0)
            {
                error = "\u65e0\u6cd5\u8bc6\u522b\u6309\u952e: " + last;
                return false;
            }
            return true;
        }
    }
}
'@

Add-Type -TypeDefinition $source -ReferencedAssemblies @('System.dll', 'System.Core.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll') -Language CSharp

[Console]::Out.WriteLine('{"event":"boot"}')
[Console]::Out.Flush()
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }
[DshShot.Agent]::Start($Hotkey, $MaxEdge)
