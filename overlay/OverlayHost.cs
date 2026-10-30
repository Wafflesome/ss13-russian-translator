// SS13 Translator - map overlay host (compiled at runtime by PowerShell; C# 5, .NET Framework).
//
// * Finds the BYOND game window and its map area.
// * Looks at the map for speech bubbles: rows of outlined letters in one colour. It never reads the
//   letters - the words come from the translated chat (src/overlay.js decides which bubble is which).
// * Follows every bubble that has an English label ~60 times a second by re-checking only the small
//   area around it, so the label moves with the speaker.
// * Draws each speaker's labels in a small transparent, click-through window: the English in the game's
//   own bubble font (Grand9K Pixel, scaled exactly like the map), on a box that covers the Russian.
// It only reads the screen and draws on top - it never touches BYOND's process or memory.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace SS13Overlay
{
    public static class Native
    {
        public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
        [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
        [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; public POINT(int x, int y) { X = x; Y = y; } }
        [StructLayout(LayoutKind.Sequential)] public struct SIZE { public int cx, cy; public SIZE(int x, int y) { cx = x; cy = y; } }
        [StructLayout(LayoutKind.Sequential, Pack = 1)] public struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
        [StructLayout(LayoutKind.Sequential)]
        public struct BITMAPINFOHEADER
        {
            public int biSize, biWidth, biHeight; public short biPlanes, biBitCount;
            public int biCompression, biSizeImage, biXPelsPerMeter, biYPelsPerMeter, biClrUsed, biClrImportant;
        }

        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder sb, int max);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT r);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);
        [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint ms);
        [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int cmd);
        [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hwnd);
        [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
        [DllImport("user32.dll")] public static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref POINT pptDst, ref SIZE psize, IntPtr hdcSrc, ref POINT pptSrc, int crKey, ref BLENDFUNCTION pblend, int dwFlags);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
        [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
        [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
        [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
        [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BITMAPINFOHEADER bmi, uint usage, out IntPtr bits, IntPtr section, uint offset);
        [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, uint rop);
        [DllImport("gdi32.dll")] public static extern bool GdiFlush();
        [DllImport("user32.dll", SetLastError = true)] public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint key, byte alpha, uint flags);
    }

    /// <summary>A row of outlined, single-colour letters found on the map (a speech bubble line).</summary>
    public class TextLine
    {
        public int X, Y, W, H, Glyphs;
        public int R, G, B;
        public double Uniform;
        public int Id;
        public string Text;          // the Russian read from the pixels (null = not read)
        public double TextScore = -1;
        public bool Small;           // the small, smoothed font of whispers, quiet speech and machines (can't be read)
        public int BDX, BW;          // a balloon alert read without its outline: its letters' left edge (from X) and width
    }

    /// <summary>A detected line followed from frame to frame.</summary>
    public class Track
    {
        public int Id, X, Y, W, H, N, R, G, B;
        public double U;
        public long Born, Seen;
        public double VX, VY;   // how fast it moves (screen pixels per millisecond), to look for it where it is going
        public int Miss;        // close-up looks in a row that didn't find it
        public bool Labeled;
        public string Group;
        public string Text; public double TextScore; public int ReadW; public long ReadAt;
        public int BDX, BW;
    }

    /// <summary>One line of the Russian bubble under a label, with its predicted geometry (game pixels).</summary>
    public class LineSpec
    {
        public int Idx, TrackId;
        public float Ax;  // bubble centre minus the left edge of the detectable letters
        public float Bd;  // bottom of the detectable letters relative to the baseline (0, or -1 with a descender)
        public float Fx0, Fx1, Ftop, Fbot; // all ink of the line: x relative to the bubble centre, y up from the baseline
    }

    /// <summary>An English label for one chat line (sent by src/overlay.js).</summary>
    public class LabelSpec
    {
        public string Key, Group;
        public long Order;
        public float Zoom;
        public int Color;
        public int Lines;
        public List<LineSpec> Russian = new List<LineSpec>();
        public string[] English = new string[0];
    }

    /// <summary>Everything drawn for one speaker: a finished image and where it goes.</summary>
    public class Composite
    {
        public string Key;
        public Rectangle Rect;     // screen rectangle of the image
        public int[] Pixels;       // premultiplied ARGB, Rect.Width * Rect.Height
        public string Signature;   // same signature = same image, only the position changed
        public long Order;
    }

    /// <summary>The bubble font as exact pixel patterns (overlay/fonts/grand9k.txt).</summary>
    public class PixelFont
    {
        public class Glyph { public int A, X, Y, W, H; public bool[] Bits; }
        public Dictionary<int, Glyph> Glyphs = new Dictionary<int, Glyph>();
        public Glyph Fallback;

        public PixelFont(string file)
        {
            foreach (string raw in File.ReadAllLines(file))
            {
                if (raw.Length == 0 || !char.IsDigit(raw[0])) continue;
                string[] p = raw.Split(' ');
                Glyph g = new Glyph();
                g.A = int.Parse(p[1]);
                if (p.Length >= 5)
                {
                    g.X = int.Parse(p[2]); g.Y = int.Parse(p[3]);
                    string[] rows = p[4].Split('/');
                    g.H = rows.Length; g.W = rows[0].Length;
                    g.Bits = new bool[g.W * g.H];
                    for (int y = 0; y < g.H; y++) for (int x = 0; x < g.W && x < rows[y].Length; x++) g.Bits[y * g.W + x] = rows[y][x] == '1';
                }
                Glyphs[int.Parse(p[0])] = g;
            }
            if (!Glyphs.TryGetValue(63, out Fallback)) { Fallback = new Glyph(); Fallback.A = 5; }
            foreach (Glyph g in Glyphs.Values) if (g.Bits != null) { MaxTop = Math.Max(MaxTop, g.Y); MaxDesc = Math.Max(MaxDesc, g.H - g.Y); }
        }
        public int MaxTop, MaxDesc;

        public Glyph Get(char c) { Glyph g; return Glyphs.TryGetValue((int)c, out g) ? g : Fallback; }

        /// <summary>Width the way BYOND measures it: no blank column after the last letter.</summary>
        public int Width(string s)
        {
            int w = 0; Glyph last = null;
            foreach (char c in s) { Glyph g = Get(c); w += g.A; last = g; }
            if (last != null && last.Bits != null) w -= Math.Max(0, last.A - (last.X + last.W));
            return Math.Max(0, w);
        }
    }

    /// <summary>
    /// logs/overlay/trace.tsv: a fine-grained record for improving the overlay later - every look at the
    /// map (how long capturing, finding and reading took) and every time a label was drawn (where the
    /// bubble was measured, how old that measurement was, where the label went, and how far the bubble had
    /// moved away from the label drawn before). Lines are only collected in memory; a background thread
    /// writes them once a second, so the overlay itself never waits for the disk. 25 MB at most, then the
    /// file is renamed to trace.old.tsv and a new one is started.
    /// </summary>
    public static class TraceLog
    {
        public static volatile bool Enabled = true;
        static readonly List<string> buf = new List<string>();
        static string file;
        static Thread writer;
        static readonly Stopwatch clock = Stopwatch.StartNew();
        public static void Start(string dir)
        {
            if (dir == null || writer != null) return;
            try { Directory.CreateDirectory(dir); } catch { }
            file = Path.Combine(dir, "trace.tsv");
            writer = new Thread(Loop); writer.IsBackground = true; writer.Priority = ThreadPriority.BelowNormal; writer.Start();
            Add("start\t" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
        }
        public static void Add(string line)
        {
            if (!Enabled || file == null) return;
            string l = clock.ElapsedMilliseconds + "\t" + line;
            lock (buf) { if (buf.Count < 50000) buf.Add(l); }
        }
        static void Loop()
        {
            while (true)
            {
                Thread.Sleep(1000);
                List<string> take;
                lock (buf) { if (buf.Count == 0) continue; take = new List<string>(buf); buf.Clear(); }
                try
                {
                    FileInfo fi = new FileInfo(file);
                    if (fi.Exists && fi.Length > 25000000)
                    {
                        string old = Path.Combine(fi.DirectoryName, "trace.old.tsv");
                        try { if (File.Exists(old)) File.Delete(old); } catch { }
                        try { File.Move(file, old); } catch { }
                    }
                    File.AppendAllText(file, string.Join("\n", take.ToArray()) + "\n");
                }
                catch { }
            }
        }
    }

    public class LabelWindow : Form
    {
        // Windows 10 can hide from screen capture only windows drawn the ordinary way, with one colour that
        // is see-through (magenta here) - not ones with smooth see-through edges (Windows 11 can do both).
        // When the smooth kind can't be hidden, labels use the colour-key kind, so the map can be read from
        // the screen (fast) instead of asking the game window to draw itself (slow).
        public static bool Keyed = false;
        public const uint KeyColorRef = 0x00FF00FF; // COLORREF (0x00BBGGRR) of the see-through colour
        public const int KeyArgb = unchecked((int)0xFFFF00FF);
        public string Signature;
        public Rectangle ShownRect = Rectangle.Empty;
        public bool Excluded, IsShown;
        public int LastError;
        public long LastUsed;
        readonly bool keyed;
        Bitmap keyedImg;
        public LabelWindow()
        {
            keyed = Keyed;
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            if (keyed) BackColor = Color.FromArgb(255, 0, 255);
            Bounds = new Rectangle(-32000, -32000, 1, 1);
        }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                // layered | transparent (click-through) | toolwindow | noactivate | topmost
                cp.ExStyle |= 0x80000 | 0x20 | 0x80 | 0x08000000 | 0x8;
                return cp;
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }
        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (keyed) { try { Native.SetLayeredWindowAttributes(Handle, KeyColorRef, 255, 1); } catch { } }
            // WDA_EXCLUDEFROMCAPTURE: our own screen checks never see the labels (Windows 10 2004+).
            // (Screenshots don't show them either; the setting "show the boxes in screenshots" turns this off.)
            if (!Host.HideFromCapture) { Excluded = false; LastError = -1; return; }
            try { Excluded = Native.SetWindowDisplayAffinity(Handle, 0x11); if (!Excluded) LastError = Marshal.GetLastWin32Error(); } catch { Excluded = false; }
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            if (keyed && keyedImg != null) e.Graphics.DrawImageUnscaled(keyedImg, 0, 0);
        }
        protected override void OnPaintBackground(PaintEventArgs e)
        {
            if (keyed && keyedImg != null) return; // the picture covers it all
            base.OnPaintBackground(e);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing && keyedImg != null) { keyedImg.Dispose(); keyedImg = null; }
            base.Dispose(disposing);
        }

        public void Push(Composite c)
        {
            if (keyed) { PushKeyed(c); return; }
            int w = c.Rect.Width, h = c.Rect.Height;
            IntPtr screenDc = Native.GetDC(IntPtr.Zero);
            IntPtr memDc = Native.CreateCompatibleDC(screenDc);
            IntPtr bits;
            Native.BITMAPINFOHEADER bi = new Native.BITMAPINFOHEADER();
            bi.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bi.biWidth = w; bi.biHeight = -h; bi.biPlanes = 1; bi.biBitCount = 32;
            IntPtr dib = Native.CreateDIBSection(screenDc, ref bi, 0, out bits, IntPtr.Zero, 0);
            try
            {
                if (dib == IntPtr.Zero) return;
                Marshal.Copy(c.Pixels, 0, bits, w * h);
                IntPtr old = Native.SelectObject(memDc, dib);
                Native.SIZE size = new Native.SIZE(w, h);
                Native.POINT src = new Native.POINT(0, 0);
                Native.POINT dst = new Native.POINT(c.Rect.X, c.Rect.Y);
                Native.BLENDFUNCTION blend = new Native.BLENDFUNCTION();
                blend.BlendOp = 0; blend.BlendFlags = 0; blend.SourceConstantAlpha = 255; blend.AlphaFormat = 1;
                Native.UpdateLayeredWindow(Handle, screenDc, ref dst, ref size, memDc, ref src, 0, ref blend, 2);
                Native.SelectObject(memDc, old);
                ShownRect = c.Rect;
                Signature = c.Signature;
            }
            finally
            {
                if (dib != IntPtr.Zero) Native.DeleteObject(dib);
                Native.DeleteDC(memDc);
                Native.ReleaseDC(IntPtr.Zero, screenDc);
            }
        }

        /// <summary>Colour-key window: pixels that are mostly see-through become the key colour, the rest solid.</summary>
        void PushKeyed(Composite c)
        {
            int w = c.Rect.Width, h = c.Rect.Height;
            if (w <= 0 || h <= 0) return;
            int[] src = c.Pixels;
            int[] px = new int[w * h];
            for (int i = 0; i < px.Length; i++)
            {
                int p = src[i];
                int a = (p >> 24) & 255;
                if (a < 128) { px[i] = KeyArgb; continue; }
                int r = (p >> 16) & 255, g = (p >> 8) & 255, b = p & 255;
                if (a < 255) { r = Math.Min(255, r * 255 / a); g = Math.Min(255, g * 255 / a); b = Math.Min(255, b * 255 / a); }
                int v = unchecked((int)0xFF000000) | (r << 16) | (g << 8) | b;
                if (v == KeyArgb) v = unchecked((int)0xFFFE00FF);
                px[i] = v;
            }
            Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppRgb);
            BitmapData bd = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppRgb);
            try
            {
                if (bd.Stride == w * 4) Marshal.Copy(px, 0, bd.Scan0, px.Length);
                else for (int y = 0; y < h; y++) Marshal.Copy(px, y * w, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), w);
            }
            finally { bmp.UnlockBits(bd); }
            Bitmap old = keyedImg;
            keyedImg = bmp;
            // SWP_NOZORDER | SWP_NOACTIVATE
            Native.SetWindowPos(Handle, IntPtr.Zero, c.Rect.X, c.Rect.Y, w, h, 0x0004 | 0x0010);
            IntPtr dc = Native.GetDC(Handle);
            try { using (Graphics gr = Graphics.FromHdc(dc)) gr.DrawImageUnscaled(bmp, 0, 0); }
            catch { }
            finally { Native.ReleaseDC(Handle, dc); }
            if (old != null) old.Dispose();
            ShownRect = c.Rect;
            Signature = c.Signature;
        }

        public void MoveTo(int x, int y)
        {
            // SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
            Native.SetWindowPos(Handle, IntPtr.Zero, x, y, 0, 0, 0x0001 | 0x0004 | 0x0010);
            ShownRect = new Rectangle(x, y, ShownRect.Width, ShownRect.Height);
        }

        public void SetShown(bool on)
        {
            if (on == IsShown) return;
            Native.ShowWindow(Handle, on ? 4 : 0); // SW_SHOWNOACTIVATE / SW_HIDE
            IsShown = on;
        }
    }

    /// <summary>A plain coloured square, used once at start-up to check that labels are hidden from screen capture.</summary>
    public class ProbeBackground : Form
    {
        public ProbeBackground()
        {
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            BackColor = Color.FromArgb(20, 200, 40);
        }
        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ExStyle |= 0x20 | 0x80 | 0x08000000 | 0x8; // click-through, toolwindow, noactivate, topmost
                return cp;
            }
        }
        protected override bool ShowWithoutActivation { get { return true; } }
    }

    public static class Host
    {
        // ------------------------------------------------------------ state
        static readonly object sync = new object();
        static readonly object emitLock = new object();
        static Rectangle mapRect = Rectangle.Empty;
        static DateTime mapRectAt = DateTime.MinValue;
        static IntPtr gameHwnd = IntPtr.Zero;
        static uint gamePid = 0;
        static uint ownPid = (uint)Process.GetCurrentProcess().Id;
        static string logFile, debugDir;
        static int frameNo = 0;
        static volatile bool saveSnapshot = false;
        public static bool ExcludedFromCapture = true;
        /// <summary>false: the labels stay visible to screen capture (screenshots show them; the map is then read from the game window).</summary>
        public static bool HideFromCapture = true;
        public static bool Headless = false; // tests: no windows, no game
        static Stopwatch clock = Stopwatch.StartNew();
        public static Func<long> Now = delegate { return clock.ElapsedMilliseconds; };
        /// <summary>Screen capture; tests replace it with a picture.</summary>
        static readonly Func<Rectangle, Bitmap> defaultCapture = DefaultCapture;
        public static Func<Rectangle, Bitmap> Capture = defaultCapture;

        static Dictionary<int, Track> tracks = new Dictionary<int, Track>();
        static List<int> goneIds = new List<int>();
        static int trackSeq = 0;
        static Dictionary<string, LabelSpec> labels = new Dictionary<string, LabelSpec>();
        static List<Rectangle> watch = new List<Rectangle>();
        static HashSet<string> expecting = new HashSet<string>(); // speakers about to get a new bubble
        static IntPtr mapHwnd = IntPtr.Zero;
        /// <summary>0 = labels are invisible to screen capture, 1 = read the game window directly (PrintWindow),
        /// 2 = hide the labels for a moment while capturing, -1 = not decided yet.</summary>
        public static int CaptureMode = 0;
        public static float ReadZoom = 0;   // map zoom, found by reading text
        static List<float> zoomVotes = new List<float>();
        public static PixelFont TipFont;
        static string tipRu = "", tipEn = "";
        static Rectangle tipBox = Rectangle.Empty; static double tipCx, tipBase; static int tipColor = 0xFFFFFF;
        static long tipHash = 0;
        static string lastTipMiss = "";
        public static PixelFont Font;
        static FontFamily cleanFamily;

        // look of the labels
        public static int BoxColor = 0x0B0D12;
        public static int BoxAlpha = 255;
        public static bool CleanFont = false;
        public static bool Predict = true;
        /// <summary>true: the box only covers the English letters; false: it also covers the whole Russian bubble.</summary>
        public static bool FitEnglish = false;
        /// <summary>0 = cover the whole bubble, 1 = only behind the English letters, 2 = tight: behind the Russian letters and the English ones, nothing more.</summary>
        public static int FitMode = 2;

        // detector thresholds
        public static int LumText = 90;    // brightest colour channel of a letter pixel (some speech colours are quite dark)
        public static int LumOutline = 50; // the black outline around every letter
        public static int DilateRadius = 3;
        public static int MinGlyph = 5, MaxGlyphH = 44, MaxGlyphW = 48, GlyphGap = 18;
        public static double MinUniform = 0.72;
        public const int LinePitch = 12;   // game pixels between the baselines of bubble lines

        public static volatile int IntervalMs = 450;
        /// <summary>Set to look at the whole map right away (a chat line just came in, or a labelled bubble got away).</summary>
        static readonly AutoResetEvent wake = new AutoResetEvent(false);
        static long lastWake;
        public static void WakeFull() { long n = Now(); if (n - lastWake < 40) return; lastWake = n; wake.Set(); }
        public static volatile int FollowMs = 33; // how often labelled bubbles are re-found (command F)
        static Form ui;
        static Dictionary<string, LabelWindow> windows = new Dictionary<string, LabelWindow>();
        static int renderQueued = 0;
        static Dictionary<string, List<double[]>> anchorHistory = new Dictionary<string, List<double[]>>();

        public static void Log(string msg)
        {
            try { if (logFile != null) File.AppendAllText(logFile, DateTime.Now.ToString("HH:mm:ss") + " " + msg + Environment.NewLine); } catch { }
        }

        public static void Emit(string json)
        {
            lock (emitLock) { Console.Out.WriteLine(json); Console.Out.Flush(); }
        }

        // ------------------------------------------------------------ start-up
        public static void Start(string fontDir, string log, string dbgDir)
        {
            TraceLog.Start(dbgDir);
            // Windows sleeps in steps of about 16 ms by default, so "look again in 18 ms" became 31 ms: ask for
            // 1 ms steps (for this program only) so bubbles are followed at the rate set
            try { Native.timeBeginPeriod(1); } catch { }
            logFile = log;
            debugDir = dbgDir;
            try { if (!Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) Native.SetProcessDPIAware(); }
            catch { try { Native.SetProcessDPIAware(); } catch { } }
            LoadFonts(fontDir);

            ManualResetEvent ready = new ManualResetEvent(false);
            Thread t = new Thread(delegate ()
            {
                ui = new Form();
                ui.FormBorderStyle = FormBorderStyle.None; ui.ShowInTaskbar = false; ui.Opacity = 0;
                ui.StartPosition = FormStartPosition.Manual; ui.Bounds = new Rectangle(-32000, -32000, 1, 1);
                ui.Load += delegate
                {
                    try { ExcludedFromCapture = ChooseLabelWindows(); }
                    catch (Exception e) { ExcludedFromCapture = false; LabelWindow.Keyed = false; Log("label window check failed: " + e.Message); }
                    CaptureMode = ExcludedFromCapture ? 0 : -1;
                    ready.Set();
                };
                Application.Run(ui);
            });
            t.SetApartmentState(ApartmentState.STA);
            t.IsBackground = true;
            t.Start();
            ready.WaitOne(5000);

            Thread reader = new Thread(ReadCommands);
            reader.IsBackground = true;
            reader.Start();

            Thread fast = new Thread(FastLoop);
            fast.IsBackground = true;
            fast.Priority = ThreadPriority.AboveNormal;
            fast.Start();
            Thread tips = new Thread(TipLoop);
            tips.IsBackground = true;
            tips.Start();
            Emit("{\"t\":\"ready\",\"excluded\":" + (ExcludedFromCapture ? "true" : "false") + ",\"font\":" + (Font != null ? "true" : "false") + "}");
        }

        /// <summary>
        /// Labels must be invisible to our own look at the screen, or the map has to be read by asking the game
        /// window to draw itself (much slower). Tries smooth labels first (Windows 11), then colour-key labels
        /// (Windows 10), and checks with a real screen capture that the label is really left out.
        /// </summary>
        static bool ChooseLabelWindows()
        {
            string build = "";
            try { build = Convert.ToString(Microsoft.Win32.Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuild", "")); } catch { }
            string notes = "";
            if (!HideFromCapture)
            {
                LabelWindow.Keyed = false;
                Log("Windows build " + build + "; labels kept visible in screenshots (setting) - the game window is read directly");
                return false;
            }
            foreach (bool keyed in new bool[] { false, true })
            {
                LabelWindow.Keyed = keyed;
                LabelWindow w = new LabelWindow();
                IntPtr h = w.Handle;
                string kind = keyed ? "colour-key labels" : "smooth labels";
                try
                {
                    if (!w.Excluded) { notes += kind + ": not allowed (error " + w.LastError + "); "; continue; }
                    string seen = CheckHidden(w);
                    if (seen == "hidden")
                    {
                        Log("Windows build " + build + "; labels hidden from capture: True (" + kind + (notes.Length > 0 ? "; " + notes.TrimEnd(' ', ';') : "") + ")");
                        Emit("{\"t\":\"labels\",\"keyed\":" + (keyed ? 1 : 0) + "}");
                        return true;
                    }
                    notes += kind + ": " + seen + "; ";
                }
                finally { w.Dispose(); }
            }
            LabelWindow.Keyed = false;
            Log("Windows build " + build + "; labels hidden from capture: False (" + notes.TrimEnd(' ', ';') + ")");
            return false;
        }

        /// <summary>
        /// Shows a pink label over a green square for a moment and looks at the screen there: first not hidden
        /// (the look must see the pink, or the check proves nothing), then hidden (the look must see green).
        /// </summary>
        static string CheckHidden(LabelWindow w)
        {
            Rectangle scr = Screen.PrimaryScreen.Bounds;
            Rectangle r = new Rectangle(scr.X + 6, scr.Y + 6, 14, 14);
            ProbeBackground bg = new ProbeBackground();
            try
            {
                bg.Bounds = r;
                bg.Show();
                Composite c = new Composite();
                c.Rect = r; c.Key = "~probe"; c.Signature = "probe";
                c.Pixels = new int[r.Width * r.Height];
                for (int i = 0; i < c.Pixels.Length; i++) c.Pixels[i] = unchecked((int)0xFFD21EBE); // opaque pink
                w.Push(c);
                w.SetShown(true);
                // on top of the green square (HWND_TOPMOST; SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)
                Native.SetWindowPos(w.Handle, new IntPtr(-1), 0, 0, 0, 0, 0x0002 | 0x0001 | 0x0010);
                Native.SetWindowDisplayAffinity(w.Handle, 0);
                int green, pink, n;
                LookAtProbe(r, out green, out pink, out n);
                if (n == 0 || pink * 10 < n * 7) { w.SetShown(false); return "check unclear (label not seen: " + green + "/" + pink + "/" + n + ")"; }
                if (!Native.SetWindowDisplayAffinity(w.Handle, 0x11)) { w.SetShown(false); return "not allowed (error " + Marshal.GetLastWin32Error() + ")"; }
                LookAtProbe(r, out green, out pink, out n);
                w.SetShown(false);
                if (green * 10 >= n * 7) return "hidden";
                if (pink * 10 >= n * 7) return "still seen by a screen capture";
                return "check unclear (" + green + "/" + pink + "/" + n + ")";
            }
            finally { try { bg.Close(); bg.Dispose(); } catch { } }
        }

        static void LookAtProbe(Rectangle r, out int green, out int pink, out int n)
        {
            for (int i = 0; i < 8; i++) { Application.DoEvents(); Thread.Sleep(20); }
            int pw, ph;
            int[] px = GrabScreen(r, out pw, out ph);
            green = 0; pink = 0; n = 0;
            for (int y = 3; y < ph - 3; y++)
                for (int x = 3; x < pw - 3; x++)
                {
                    int p = px[y * pw + x], R = (p >> 16) & 255, G = (p >> 8) & 255, B = p & 255;
                    n++;
                    if (Math.Abs(R - 20) < 40 && Math.Abs(G - 200) < 40 && Math.Abs(B - 40) < 40) green++;
                    else if (Math.Abs(R - 210) < 40 && Math.Abs(G - 30) < 40 && Math.Abs(B - 190) < 40) pink++;
                }
        }

        /// <summary>Tests: no windows and no game - the caller supplies Capture and the map area.</summary>
        public static void StartHeadless(string fontDir)
        {
            Headless = true;
            LoadFonts(fontDir);
            Thread reader = new Thread(ReadCommands); reader.IsBackground = true; reader.Start();
            Thread fast = new Thread(FastLoop); fast.IsBackground = true; fast.Start();
            Thread tips = new Thread(TipLoop); tips.IsBackground = true; tips.Start();
            Emit("{\"t\":\"ready\",\"excluded\":true,\"font\":" + (Font != null ? "true" : "false") + "}");
        }
        /// <summary>Tests: commands this host doesn't know.</summary>
        public static Action<string> ExtraCommand;
        /// <summary>Tests: what is being drawn.</summary>
        public static Dictionary<string, LabelSpec> LabelsSnapshot() { lock (sync) return new Dictionary<string, LabelSpec>(labels); }

        public static void LoadFonts(string fontDir)
        {
            try { Font = new PixelFont(Path.Combine(fontDir, "grand9k.txt")); }
            catch (Exception e) { Log("bubble font missing: " + e.Message); }
            try { TipFont = new PixelFont(Path.Combine(fontDir, "pixellari16.txt")); }
            catch (Exception e) { Log("hover-name font missing: " + e.Message); }
            foreach (string name in new string[] { "Segoe UI Semibold", "Segoe UI", "Tahoma", "DejaVu Sans" })
            {
                try { cleanFamily = new FontFamily(name); break; } catch { }
            }
            if (cleanFamily == null) cleanFamily = FontFamily.GenericSansSerif;
        }

        // ------------------------------------------------------------ window discovery
        static string ClassOf(IntPtr h) { StringBuilder sb = new StringBuilder(256); Native.GetClassName(h, sb, 256); return sb.ToString(); }
        static Rectangle RectOf(IntPtr h) { Native.RECT r; Native.GetWindowRect(h, out r); return new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top); }

        static bool FindGame()
        {
            Process[] ps = Process.GetProcessesByName("dreamseeker");
            IntPtr best = IntPtr.Zero; uint bestPid = 0; long bestArea = 0;
            foreach (Process p in ps)
            {
                uint pid = (uint)p.Id;
                Native.EnumWindows(delegate (IntPtr h, IntPtr l)
                {
                    uint wp; Native.GetWindowThreadProcessId(h, out wp);
                    if (wp == pid && Native.IsWindowVisible(h) && Native.GetWindow(h, 4) == IntPtr.Zero)
                    {
                        Rectangle r = RectOf(h);
                        long a = (long)r.Width * r.Height;
                        if (a > bestArea) { bestArea = a; best = h; bestPid = pid; }
                    }
                    return true;
                }, IntPtr.Zero);
            }
            gameHwnd = best; gamePid = bestPid;
            return best != IntPtr.Zero;
        }

        static bool IsBrowserClass(string c)
        {
            return c.IndexOf("Chrome", StringComparison.OrdinalIgnoreCase) >= 0 || c.IndexOf("WebView", StringComparison.OrdinalIgnoreCase) >= 0
                || c.IndexOf("Intermediate D3D", StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static Rectangle FindMap(bool logIt)
        {
            Rectangle main = RectOf(gameHwnd);
            List<IntPtr> kids = new List<IntPtr>();
            Native.EnumChildWindows(gameHwnd, delegate (IntPtr h, IntPtr l) { kids.Add(h); return true; }, IntPtr.Zero);
            // the chat / stat panes on the right are browser windows; the map is the big panel left of them
            int paneX = main.Right;
            foreach (IntPtr h in kids)
            {
                if (!Native.IsWindowVisible(h) || !IsBrowserClass(ClassOf(h))) continue;
                Rectangle b = RectOf(h);
                if (b.Height > main.Height / 3 && b.X > main.X + main.Width / 3) paneX = Math.Min(paneX, b.X);
            }
            Rectangle best = Rectangle.Empty; long bestArea = 0; IntPtr bestH = IntPtr.Zero;
            long minArea = (long)main.Width * main.Height / 12;
            StringBuilder dump = new StringBuilder();
            foreach (IntPtr h in kids)
            {
                string c = ClassOf(h);
                Rectangle r = RectOf(h);
                bool vis = Native.IsWindowVisible(h);
                if (logIt && r.Width > 50 && r.Height > 50) dump.AppendLine("  child " + c + " " + r + (vis ? "" : " hidden"));
                if (!vis || IsBrowserClass(c)) continue;
                long a = (long)r.Width * r.Height;
                if (a < minArea || r.Right > paneX + 8) continue;
                if (a > bestArea) { bestArea = a; best = r; bestH = h; }
            }
            if (best.IsEmpty) best = new Rectangle(main.X, main.Y, Math.Max(100, paneX - main.X), main.Height);
            mapHwnd = bestH;
            if (logIt) Log("game window " + main + " map area " + best + Environment.NewLine + dump.ToString());
            return best;
        }

        static bool GameInFront()
        {
            if (Headless) return true;
            if (gameHwnd == IntPtr.Zero || Native.IsIconic(gameHwnd)) return false;
            IntPtr fg = Native.GetForegroundWindow();
            if (fg == IntPtr.Zero) return false;
            uint pid; Native.GetWindowThreadProcessId(fg, out pid);
            return pid == gamePid || pid == ownPid;
        }

        /// <summary>Tests: use a fixed map area instead of looking for the game.</summary>
        public static void SetMapRect(Rectangle r) { lock (sync) { mapRect = r; } mapRectAt = DateTime.MaxValue; }

        static bool RefreshGame()
        {
            if (Headless) return !mapRect.IsEmpty;
            if (gameHwnd == IntPtr.Zero || !Native.IsWindowVisible(gameHwnd))
            {
                if (!FindGame()) return false;
                mapRectAt = DateTime.MinValue;
            }
            if (Native.IsIconic(gameHwnd)) return false;
            if (mapRectAt != DateTime.MaxValue && (DateTime.Now - mapRectAt).TotalSeconds > 2)
            {
                Rectangle r = FindMap(mapRect.IsEmpty || frameNo % 600 == 0);
                if (!mapRect.IsEmpty && !r.IsEmpty && (r.Width != mapRect.Width || r.Height != mapRect.Height) && ReadZoom > 0)
                {
                    // the game window was resized: the map zoom changes with it
                    lock (zoomVotes) { ReadZoom = 0; ZoomProvisional = false; zoomVotes.Clear(); goodZooms.Clear(); }
                    Log("map size changed to " + r.Width + "x" + r.Height + " - finding the zoom again");
                }
                lock (sync) { mapRect = r; }
                mapRectAt = DateTime.Now;
            }
            return mapRect.Width >= 50 && mapRect.Height >= 50;
        }

        static Bitmap DefaultCapture(Rectangle area)
        {
            int w, h;
            int[] px = GrabNative(area, out w, out h);
            return ToBitmap(px, w, h);
        }

        public static Bitmap ToBitmap(int[] px, int w, int h)
        {
            Bitmap b = new Bitmap(w, h, PixelFormat.Format32bppArgb);
            BitmapData bd = b.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
            try
            {
                if (bd.Stride == w * 4) Marshal.Copy(px, 0, bd.Scan0, w * h);
                else for (int y = 0; y < h; y++) Marshal.Copy(px, y * w, new IntPtr(bd.Scan0.ToInt64() + (long)y * bd.Stride), w);
            }
            finally { b.UnlockBits(bd); }
            return b;
        }

        /// <summary>The pixels of a screen area (ARGB). Tests replace Capture; the game uses the fast native way.</summary>
        static int[] Grab(Rectangle r, out int w, out int h)
        {
            if (!object.ReferenceEquals(Capture, defaultCapture))
            {
                using (Bitmap b = Capture(r)) { w = b.Width; h = b.Height; return Pixels(b); }
            }
            return GrabNative(r, out w, out h);
        }

        static int[] GrabNative(Rectangle r, out int w, out int h)
        {
            if (CaptureMode == 1 && mapHwnd != IntPtr.Zero)
            {
                int[] p = GrabPrinted(r, out w, out h);
                if (p != null) return p;
            }
            return GrabScreen(r, out w, out h);
        }

        // One drawing surface each for screen and game-window captures, reused (no new picture per look).
        static readonly object screenLock = new object();
        static IntPtr sDc, sBmp, sBits; static int sW, sH;
        static readonly object printLock = new object();
        static IntPtr pDc, pBmp, pBits; static int pW, pH; static long printedAt = -1000; static Rectangle printedRect;
        public static volatile int LastPrintMs;

        static void EnsureSurface(ref IntPtr dc, ref IntPtr bmp, ref IntPtr bits, ref int cw, ref int ch, int w, int h)
        {
            if (dc != IntPtr.Zero && bmp != IntPtr.Zero && w <= cw && h <= ch) return;
            int nw = Math.Max(w, cw), nh = Math.Max(h, ch);
            if (dc == IntPtr.Zero)
            {
                IntPtr scr = Native.GetDC(IntPtr.Zero);
                dc = Native.CreateCompatibleDC(scr);
                Native.ReleaseDC(IntPtr.Zero, scr);
            }
            Native.BITMAPINFOHEADER bi = new Native.BITMAPINFOHEADER();
            bi.biSize = Marshal.SizeOf(typeof(Native.BITMAPINFOHEADER));
            bi.biWidth = nw; bi.biHeight = -nh; bi.biPlanes = 1; bi.biBitCount = 32;
            IntPtr nb;
            IntPtr nbmp = Native.CreateDIBSection(dc, ref bi, 0, out nb, IntPtr.Zero, 0);
            if (nbmp == IntPtr.Zero) throw new Exception("could not make a drawing surface " + nw + "x" + nh);
            Native.SelectObject(dc, nbmp);
            if (bmp != IntPtr.Zero) Native.DeleteObject(bmp);
            bmp = nbmp; bits = nb; cw = nw; ch = nh;
        }

        static int[] CopyOut(IntPtr bits, int stridePx, int x0, int y0, int w, int h)
        {
            int[] px = new int[w * h];
            for (int y = 0; y < h; y++) Marshal.Copy(new IntPtr(bits.ToInt64() + ((long)(y0 + y) * stridePx + x0) * 4), px, y * w, w);
            for (int i = 0; i < px.Length; i++) px[i] |= unchecked((int)0xFF000000);
            return px;
        }

        /// <summary>What is on the screen there (our labels left out when they are hidden from capture).</summary>
        static int[] GrabScreen(Rectangle r, out int w, out int h)
        {
            w = Math.Max(1, r.Width); h = Math.Max(1, r.Height);
            lock (screenLock)
            {
                EnsureSurface(ref sDc, ref sBmp, ref sBits, ref sW, ref sH, w, h);
                IntPtr scr = Native.GetDC(IntPtr.Zero);
                try { Native.BitBlt(sDc, 0, 0, w, h, scr, r.X, r.Y, 0x00CC0020); }
                finally { Native.ReleaseDC(IntPtr.Zero, scr); }
                Native.GdiFlush();
                return CopyOut(sBits, sW, 0, 0, w, h);
            }
        }

        /// <summary>The game's map as the game drew it (other windows, our labels included, don't appear).</summary>
        static int[] GrabPrinted(Rectangle r, out int w, out int h)
        {
            w = r.Width; h = r.Height;
            lock (printLock)
            {
                long now = Now();
                if (now - printedAt >= 12)
                {
                    Rectangle mr = RectOf(mapHwnd);
                    if (mr.Width < 10 || mr.Height < 10) return null;
                    EnsureSurface(ref pDc, ref pBmp, ref pBits, ref pW, ref pH, mr.Width, mr.Height);
                    long t0 = Now();
                    if (!Native.PrintWindow(mapHwnd, pDc, 2)) return null;
                    Native.GdiFlush();
                    LastPrintMs = (int)(Now() - t0);
                    printedAt = Now(); printedRect = mr;
                }
                Rectangle src = new Rectangle(r.X - printedRect.X, r.Y - printedRect.Y, r.Width, r.Height);
                Rectangle inside = Rectangle.Intersect(src, new Rectangle(0, 0, printedRect.Width, printedRect.Height));
                if (w <= 0 || h <= 0 || inside.Width <= 0 || inside.Height <= 0) return null;
                if (inside == src) return CopyOut(pBits, pW, src.X, src.Y, w, h);
                // partly outside the game window: that part stays black
                int[] px = new int[w * h];
                for (int i = 0; i < px.Length; i++) px[i] = unchecked((int)0xFF000000);
                for (int y = inside.Y; y < inside.Bottom; y++)
                {
                    Marshal.Copy(new IntPtr(pBits.ToInt64() + ((long)y * pW + inside.X) * 4), px, (y - src.Y) * w + (inside.X - src.X), inside.Width);
                    for (int x = 0; x < inside.Width; x++) px[(y - src.Y) * w + (inside.X - src.X) + x] |= unchecked((int)0xFF000000);
                }
                return px;
            }
        }

        /// <summary>Labels can't be hidden from screen capture on this Windows: can the game window be read directly?</summary>
        static void ChooseCaptureMode()
        {
            CaptureMode = 2;
            if (mapHwnd == IntPtr.Zero) { Log("capture: map window not found, labels will blink while the screen is checked"); return; }
            try
            {
                Rectangle area = mapRect;
                HideAllNow();
                Thread.Sleep(60);
                Bitmap screen = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb);
                using (Graphics g = Graphics.FromImage(screen)) g.CopyFromScreen(area.X, area.Y, 0, 0, new Size(area.Width, area.Height));
                CaptureMode = 1;
                Bitmap win = DefaultCapture(area);
                CaptureMode = 2;
                long diff = 0, n = 0;
                for (int y = 4; y < area.Height - 4; y += 7)
                    for (int x = 4; x < area.Width - 4; x += 7)
                    {
                        Color a = screen.GetPixel(x, y), b = win.GetPixel(x, y);
                        diff += Math.Abs(a.R - b.R) + Math.Abs(a.G - b.G) + Math.Abs(a.B - b.B); n++;
                    }
                screen.Dispose(); win.Dispose();
                double avg = n > 0 ? diff / (double)n : 999;
                CaptureMode = avg < 12 ? 1 : 2;
                Log("capture: reading the game window directly " + (CaptureMode == 1 ? "works" : "does not work") + " (difference " + avg.ToString("0.0") + ")");
                Emit("{\"t\":\"capture\",\"mode\":" + CaptureMode + "}");
            }
            catch (Exception e) { CaptureMode = 2; Log("capture test failed: " + e.Message); }
        }

        // ------------------------------------------------------------ whole-map loop
        /// <summary>Checks the whole map for bubble lines and reports them, forever.</summary>
        public static void RunLoop(int intervalMs)
        {
            IntervalMs = intervalMs;
            Stopwatch sw = new Stopwatch();
            while (true)
            {
                sw.Restart();
                try
                {
                    if (!RefreshGame() || !GameInFront()) { HideAll(); Thread.Sleep(300); continue; }
                    if (CaptureMode == -1) ChooseCaptureMode();
                    if (ZoomProvisional && Now() - provisionalSince > 120000)
                    {
                        // the zoom remembered from last time was never confirmed by any text: look for it again
                        lock (zoomVotes) { ZoomProvisional = false; ReadZoom = 0; zoomVotes.Clear(); goodZooms.Clear(); }
                        Log("the remembered map zoom did not fit any text - searching for it again");
                    }
                    FullFrame();
                }
                catch (Exception e) { Log("frame error: " + e.Message); Thread.Sleep(1000); }
                int took = (int)sw.ElapsedMilliseconds;
                NoteTime(true, took);
                // never more than ~3/4 of one processor core, however busy the map is
                int wait = Math.Max(IntervalMs - took, took / 3);
                wake.WaitOne(Math.Max(5, wait));
            }
        }

        static List<TextLine> lastRaw; static long lastHash; static int lastW, lastH; static bool lastHadSmall;
        static long FrameHash(int[] px, int w, int h)
        {
            unchecked
            {
                long hv = 1469598103934665603L ^ w ^ ((long)h << 20);
                for (int y = 1; y < h; y += 3)
                {
                    int row = y * w;
                    for (int x = (y * 7) & 3; x < w; x += 4) hv = (hv ^ px[row + x]) * 1099511628211L;
                }
                return hv;
            }
        }
        static List<TextLine> CloneLines(List<TextLine> src)
        {
            List<TextLine> o = new List<TextLine>(src.Count);
            foreach (TextLine l in src)
            {
                TextLine c = new TextLine();
                c.X = l.X; c.Y = l.Y; c.W = l.W; c.H = l.H; c.Glyphs = l.Glyphs; c.R = l.R; c.G = l.G; c.B = l.B;
                c.Uniform = l.Uniform; c.Small = l.Small; c.Text = l.Text; c.TextScore = l.TextScore;
                o.Add(c);
            }
            return o;
        }

        /// <summary>How long looking at the map takes (written to the log once a minute, for tuning).</summary>
        static long statSame;
        static long statFullN, statFullMs, statFullMax, statFastN, statFastMs, statFastMax, statSince = -1;
        static readonly object statLock = new object();
        static void NoteTime(bool full, int ms)
        {
            lock (statLock)
            {
                long now = Now();
                if (statSince < 0) statSince = now;
                if (full) { statFullN++; statFullMs += ms; if (ms > statFullMax) statFullMax = ms; }
                else { statFastN++; statFastMs += ms; if (ms > statFastMax) statFastMax = ms; }
                if (now - statSince < 60000) return;
                double e50, e90, emax, a50; long draws;
                lock (errSamples)
                {
                    e50 = Pct(errSamples, 0.5); e90 = Pct(errSamples, 0.9); emax = errSamples.Count > 0 ? Pct(errSamples, 1) : 0; a50 = Pct(ageSamples, 0.5);
                    draws = drawCount; drawCount = 0; errSamples.Clear(); ageSamples.Clear();
                }
                int cpu = -1;
                try
                {
                    TimeSpan c = Process.GetCurrentProcess().TotalProcessorTime;
                    if (lastCpuAt > 0 && now > lastCpuAt) cpu = (int)Math.Round(100.0 * (c - lastCpu).TotalMilliseconds / (now - lastCpuAt));
                    lastCpu = c; lastCpuAt = now;
                }
                catch { }
                Log("timing: full map " + statFullN + "x (" + statSame + " unchanged) avg " + (statFullN > 0 ? statFullMs / statFullN : 0) + "ms max " + statFullMax +
                    "ms; following bubbles " + statFastN + "x avg " + (statFastN > 0 ? statFastMs / statFastN : 0) + "ms max " + statFastMax + "ms; labels drawn " + draws +
                    ", label vs bubble " + e50.ToString("0.0", CultureInfo.InvariantCulture) + "/" + e90.ToString("0.0", CultureInfo.InvariantCulture) + "/" + emax.ToString("0", CultureInfo.InvariantCulture) + " px (median/90%/max), data age " + a50.ToString("0") + " ms" + (cpu >= 0 ? ", processor " + cpu + "% of one core" : ""));
                Emit("{\"t\":\"stats\",\"full\":" + statFullN + ",\"same\":" + statSame + ",\"fullAvg\":" + (statFullN > 0 ? statFullMs / statFullN : 0) + ",\"fullMax\":" + statFullMax +
                    ",\"fast\":" + statFastN + ",\"fastAvg\":" + (statFastN > 0 ? statFastMs / statFastN : 0) + ",\"fastMax\":" + statFastMax + ",\"draws\":" + draws +
                    ",\"err50\":" + e50.ToString("0.0", CultureInfo.InvariantCulture) + ",\"err90\":" + e90.ToString("0.0", CultureInfo.InvariantCulture) + ",\"errMax\":" + emax.ToString("0.0", CultureInfo.InvariantCulture) +
                    ",\"age50\":" + a50.ToString("0", CultureInfo.InvariantCulture) + ",\"cpu\":" + cpu + ",\"interval\":" + IntervalMs + ",\"follow\":" + FollowMs +
                    ",\"mode\":" + CaptureMode + ",\"keyed\":" + (LabelWindow.Keyed ? 1 : 0) + ",\"capAvg\":" + (statCapN > 0 ? statCapMs / statCapN : 0) + ",\"printMs\":" + (CaptureMode == 1 ? LastPrintMs : -1) + "}");
                TraceLog.Add("S\tmode=" + CaptureMode + "\tkeyed=" + (LabelWindow.Keyed ? 1 : 0) + "\tcapAvg=" + (statCapN > 0 ? statCapMs / statCapN : 0) + "\tprintMs=" + LastPrintMs + "\tcpu=" + cpu);
                statFullN = statFullMs = statFullMax = statFastN = statFastMs = statFastMax = statSame = 0; statSince = now;
                statCapN = statCapMs = 0;
            }
        }

        public static void FullFrame()
        {
            Rectangle area; lock (sync) { area = mapRect; }
            long t0 = Now();
            bool hide = CaptureMode == 2 && !Headless;
            if (hide) HideAllNow();
            List<TextLine> lines;
            int[] px; int pw, ph;
            long tCap, tAna; bool same = false;
            px = Grab(area, out pw, out ph);
            if (hide) RequestRender();
            {
                tCap = Now();
                // a picture identical to the last one (nobody moving, nothing animating) needs no new look
                bool wantSmall = SmallWanted || frameNo % 2 == 0;
                long hash = FrameHash(px, pw, ph);
                if (lastRaw != null && hash == lastHash && pw == lastW && ph == lastH && (lastHadSmall || !wantSmall))
                {
                    lines = CloneLines(lastRaw);
                    lock (statLock) statSame++;
                    same = true;
                }
                else
                {
                    smallPass = frameNo % 2 == 0;
                    lines = AnalyzeShot(px, pw, ph);
                    smallPass = false;
                    lastRaw = CloneLines(lines); lastHash = hash; lastW = pw; lastH = ph; lastHadSmall = wantSmall;
                }
                frameNo++;
                tAna = Now();
                bool snap = saveSnapshot || frameNo == 5;
                if (debugDir != null && snap)
                {
                    try
                    {
                        // saved on another thread: writing a picture takes a moment, the map keeps being followed
                        string dir = snapshotName != null ? Path.Combine(debugDir, "missed") : debugDir;
                        string file = Path.Combine(dir, (snapshotName ?? "overlay_capture") + ".png");
                        Bitmap copy = ToBitmap(px, pw, ph);
                        ThreadPool.QueueUserWorkItem(delegate
                        {
                            try { Directory.CreateDirectory(dir); copy.Save(file, ImageFormat.Png); } catch { }
                            finally { copy.Dispose(); }
                        });
                    }
                    catch { }
                }
            }
            foreach (TextLine l in lines) { l.X += area.X; l.Y += area.Y; }
            lines = MergeRows(lines);
            List<int> gone;
            lock (sync)
            {
                UpdateTracks(lines, area, t0, true);
                RemoveStale(Now());
                gone = new List<int>(goneIds); goneIds.Clear();
            }
            long tTrack = Now();
            ReadLines(lines, px, pw, ph, area, t0, 16);
            long tRead = Now();
            if (debugDir != null && (saveSnapshot || frameNo == 5)) { saveSnapshot = false; SaveDebug(lines, area); snapshotName = null; }
            EmitFrame(true, area, lines, gone, Now() - t0);
            RequestRender();
            // F: capture, find, track, read, total (ms), lines found, picture unchanged, tracks, labels
            int nt, nl; lock (sync) { nt = tracks.Count; nl = labels.Count; }
            TraceLog.Add("F\t" + (tCap - t0) + "\t" + (tAna - tCap) + "\t" + (tTrack - tAna) + "\t" + (tRead - tTrack) + "\t" + (Now() - t0) + "\t" + lines.Count + "\t" + (same ? 1 : 0) + "\t" + nt + "\t" + nl);
        }

        static volatile string snapshotName;
        static void SaveDebug(List<TextLine> lines, Rectangle area)
        {
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("map area " + area + "  labels hidden from capture: " + ExcludedFromCapture + "  zoom gap " + GlyphGap);
                foreach (TextLine l in lines) sb.AppendLine("#" + l.Id + " " + (l.X - area.X) + "," + (l.Y - area.Y) + " " + l.W + "x" + l.H + " letters=" + l.Glyphs + " color=" + l.R + "," + l.G + "," + l.B + " uniform=" + l.Uniform.ToString("0.00"));
                lock (sync)
                {
                    sb.AppendLine("labels:");
                    foreach (LabelSpec lb in labels.Values) sb.AppendLine("  " + lb.Key + " zoom " + lb.Zoom.ToString("0.00") + " tracks " + lb.Russian.Count + " : " + string.Join(" / ", lb.English));
                }
                File.WriteAllText(snapshotName != null ? Path.Combine(debugDir, "missed", snapshotName + ".txt") : Path.Combine(debugDir, "overlay_lines.txt"), sb.ToString());
            }
            catch { }
        }

        // ------------------------------------------------------------ fast loop (labelled bubbles)
        /// <summary>Re-finds every labelled bubble ~60 times a second by checking only the area around it.</summary>
        static void FastLoop()
        {
            Stopwatch sw = new Stopwatch();
            while (true)
            {
                sw.Restart();
                bool worked = false;
                try
                {
                    if (!mapRect.IsEmpty && GameInFront() && (CaptureMode == 0 || CaptureMode == 1)) worked = FastTick();
                }
                catch (Exception e) { Log("fast error: " + e.Message); Thread.Sleep(200); }
                int took = (int)sw.ElapsedMilliseconds;
                if (worked) NoteTime(false, took);
                // each look at a bubble asks the game window to draw itself once more (PrintWindow): the
                // follow rate is kept modest so the game itself doesn't slow down
                // (and never back to back: a slow capture still leaves the processor some rest)
                int wait = worked ? Math.Max(FollowMs - took, took > 45 ? took / 5 : 1) : 40 - took;
                Thread.Sleep(Math.Max(1, wait));
            }
        }

        static double capEma = 30; // how long taking a close-up picture takes lately (ms)
        static long statCapN, statCapMs;

        /// <summary>One fast pass. Returns false when there was nothing to follow.</summary>
        public static bool FastTick()
        {
            List<Rectangle> rois = new List<Rectangle>();
            List<Track> followed = new List<Track>();
            Rectangle area;
            long tickStart = Now();
            lock (sync)
            {
                area = mapRect;
                long now = tickStart;
                Dictionary<string, Rectangle> byGroup = new Dictionary<string, Rectangle>();
                foreach (LabelSpec lb in labels.Values)
                {
                    float z = lb.Zoom > 0 ? lb.Zoom : 2;
                    foreach (LineSpec ls in lb.Russian)
                    {
                        Track t;
                        if (!tracks.TryGetValue(ls.TrackId, out t) || now - t.Seen > 900) continue;
                        followed.Add(t);
                        // look where it was and where it is heading (a wider look could pick up someone else's
                        // bubble; if it got away, the whole map is looked at right away instead)
                        Rectangle r = new Rectangle(t.X, t.Y, t.W, t.H);
                        int m = (int)Math.Max(24, 16 * z);
                        r.Inflate(m, m);
                        // where it will be when the picture is taken: its last sighting is this old, and taking
                        // the picture itself takes a while (measured)
                        long ahead = Math.Min(220, now - t.Seen + (long)capEma + 25);
                        int px2 = (int)Math.Round(t.VX * ahead), py2 = (int)Math.Round(t.VY * ahead);
                        if (px2 != 0 || py2 != 0)
                        {
                            Rectangle p2 = r; p2.Offset(px2, py2);
                            r = Rectangle.Union(r, p2);
                        }
                        // when the game lags, the view (and every bubble) jumps a whole map tile at once, in the
                        // direction it was gliding: look that far ahead too
                        double sp = Math.Sqrt(t.VX * t.VX + t.VY * t.VY);
                        if (sp > 0.08)
                        {
                            double tile = 32 * z + 6;
                            Rectangle p3 = new Rectangle(t.X, t.Y, t.W, t.H);
                            p3.Inflate(m / 2, m / 2);
                            p3.Offset((int)Math.Round(px2 + t.VX / sp * tile), (int)Math.Round(py2 + t.VY / sp * tile));
                            r = Rectangle.Union(r, p3);
                        }
                        Rectangle cur;
                        byGroup[lb.Group] = byGroup.TryGetValue(lb.Group, out cur) ? Rectangle.Union(cur, r) : r;
                    }
                }
                rois.AddRange(byGroup.Values);
                rois.AddRange(watch);
            }
            if (rois.Count == 0) return false;
            // merge overlapping areas so nothing is analysed twice
            bool merged = true;
            while (merged)
            {
                merged = false;
                for (int i = 0; i < rois.Count && !merged; i++)
                    for (int j = i + 1; j < rois.Count; j++)
                        if (rois[i].IntersectsWith(rois[j])) { rois[i] = Rectangle.Union(rois[i], rois[j]); rois.RemoveAt(j); merged = true; break; }
            }
            long capMs = 0, anaMs = 0; int pixels = 0;
            foreach (Rectangle r0 in rois)
            {
                Rectangle r = Rectangle.Intersect(r0, area);
                if (r.Width < 8 || r.Height < 8) continue;
                long t0 = Now();
                List<TextLine> lines;
                int[] px; int pw, ph;
                px = Grab(r, out pw, out ph);
                long tc = Now(); capMs += tc - t0; pixels += pw * ph;
                capEma = 0.8 * capEma + 0.2 * (tc - t0);
                lock (statLock) { statCapN++; statCapMs += tc - t0; }
                lines = AnalyzeShot(px, pw, ph);
                anaMs += Now() - tc;
                foreach (TextLine l in lines) { l.X += r.X; l.Y += r.Y; }
                lines = MergeRows(lines);
                bool fresh;
                lock (sync) fresh = UpdateTracks(lines, r, t0, false);
                if (fresh)
                {
                    ReadLines(lines, px, pw, ph, r, t0, 4);
                    EmitFrame(false, r, lines, null, Now() - t0);
                }
            }
            // a followed bubble that wasn't where it was looked for: look at the whole map now
            bool lost = false; int missed = 0;
            lock (sync)
                foreach (Track t in followed)
                    if (t.Seen < tickStart) { t.Miss++; missed++; if (t.Miss == 1) lost = true; }
            if (lost) WakeFull();
            // T: areas looked at, their size (pixels), capture ms, find ms, total ms, lines followed, not found
            TraceLog.Add("T\t" + rois.Count + "\t" + pixels + "\t" + capMs + "\t" + anaMs + "\t" + (Now() - tickStart) + "\t" + followed.Count + "\t" + missed + (lost ? "\twake" : ""));
            RequestRender();
            return true;
        }

        // ------------------------------------------------------------ reading the letters
        static string LettersOnly(string t)
        {
            if (t == null) return "";
            StringBuilder sb = new StringBuilder();
            foreach (char c in t) if (char.IsLetter(c) && "IilLj".IndexOf(c) < 0) sb.Append(char.ToLowerInvariant(c));
            return sb.ToString();
        }
        static int Letters(string t) { int n = 0; if (t != null) foreach (char c in t) if (char.IsLetter(c)) n++; return n; }

        /// <summary>Looks like real words (not a row of I, l, dots and quotes that any pattern can produce)?</summary>
        public static bool WordLike(string t, int min)
        {
            if (t == null) return false;
            int good = 0, other = 0;
            foreach (char c in t)
            {
                if (c == ' ') continue;
                if (char.IsLetter(c) && "IilLj".IndexOf(c) < 0) good++; else other++;
            }
            return good >= min && good >= 3 * other;
        }

        public static string Json(string t)
        {
            StringBuilder sb = new StringBuilder("\"");
            foreach (char c in t)
            {
                if (c == '"' || c == '\\') sb.Append('\\').Append(c);
                else if (c < ' ') sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.Append('"').ToString();
        }

        /// <summary>Reads the Russian of new (or changed) lines; a line's text is remembered with its track.</summary>
        static void ReadLines(List<TextLine> lines, int[] px, int pw, int ph, Rectangle area, long now, int budget)
        {
            if (Font == null) return;
            List<TextLine> todo = new List<TextLine>();
            Dictionary<TextLine, long> born = new Dictionary<TextLine, long>();
            lock (sync)
            {
                foreach (TextLine l in lines)
                {
                    Track t;
                    if (!tracks.TryGetValue(l.Id, out t)) continue;
                    born[l] = t.Born;
                    bool same = t.Text != null && Math.Abs(t.ReadW - l.W) <= Math.Max(2, (int)Math.Ceiling(ReadZoom));
                    // a poor read (often a bubble still fading in, or the background changing behind it)
                    // is tried again a little later
                    if (same && t.TextScore < 0.75 && now - t.ReadAt >= 250 && now - t.Born < 6000) same = false;
                    // young lines are read again now and then: a new bubble can appear exactly where the
                    // speaker's previous one was (same colour, same size) and take over its track
                    if (same && now - t.ReadAt >= 700 && now - t.Born < 8000) same = false;
                    // ...at once when that speaker has just said something new
                    if (same && t.Labeled && t.Group != null && expecting.Contains(t.Group) && now - t.ReadAt >= 150) same = false;
                    if (same || (t.ReadAt > 0 && now - t.ReadAt < 250)) { l.Text = t.Text; l.TextScore = t.TextScore; l.BDX = t.BDX; l.BW = t.BW; continue; }
                    if (l.Glyphs < 2 || l.Uniform < 0.75 || l.Small) continue;
                    todo.Add(l);
                }
            }
            // new lines first (a bubble that just appeared), then the rest
            todo.Sort(delegate (TextLine a, TextLine b)
            {
                int c = born[b].CompareTo(born[a]);
                return c != 0 ? c : b.Glyphs.CompareTo(a.Glyphs);
            });
            int done = 0, searches = 0;
            foreach (TextLine l in todo)
            {
                if (done >= budget) break;
                Rectangle box = new Rectangle(l.X - area.X, l.Y - area.Y, l.W, l.H);
                ReadResult r;
                if (ReadZoom > 0)
                {
                    r = PixelReader.ReadLine(px, pw, ph, box, l.R, l.G, l.B, ReadZoom, Font);
                    if (ZoomProvisional && r.Score >= 0.95 && WordLike(r.Text, 5)) ConfirmZoom("a bubble");
                    // white text with only a faint outline: a balloon alert ("не является пищей!"), read by its colour
                    if (BalloonColour(l) && (r.Score < 0.93 || l.W < 40 * ReadZoom))
                    {
                        Rectangle eb = PixelReader.WhiteExtent(px, pw, ph, box, l.R, l.G, l.B, ReadZoom);
                        ReadResult rb = PixelReader.ReadLine(px, pw, ph, eb, l.R, l.G, l.B, ReadZoom, Font, 3, true);
                        if (rb.Score >= 0.85 && rb.InkLeft >= 0 && (rb.Score > r.Score + 0.02 || rb.Text.Length > r.Text.Length + 1))
                        {
                            r = rb;
                            int inkL = (int)Math.Round(rb.OriginX + rb.InkLeft * rb.Zoom), inkR = (int)Math.Round(rb.OriginX + (rb.InkRight + 1) * rb.Zoom);
                            l.BDX = inkL - box.X; l.BW = Math.Max(1, inkR - inkL);
                        }
                    }
                }
                else
                {
                    if (l.Glyphs < 5 || l.Uniform < 0.8 || searches >= 3) continue;
                    searches++;
                    // the usual view is 15 tiles tall: try that zoom first, search only if it doesn't read
                    float prior = (float)(area.Height / 480.0);
                    r = PixelReader.ReadLine(px, pw, ph, box, l.R, l.G, l.B, prior, Font, 5);
                    if (r.Score >= 0.97 && WordLike(r.Text, 6) && Math.Abs(r.Zoom / prior - 1) < 0.012) AcceptZoom(r.Zoom, "a clean bubble line at the usual view size");
                    else if (r.Score >= 0.95 && WordLike(r.Text, 5)) Vote(r.Zoom);
                    else if (l.Glyphs >= 6) StartZoomSearch(px, pw, ph, box, l, area);
                }
                done++;
                l.Text = r.Score >= 0.4 ? r.Text : ""; l.TextScore = r.Score; // weak reads are still compared with chat (they must match the words)
                if (ReadZoom > 0 && r.Score >= 0.97 && WordLike(r.Text, 6) && Math.Abs(r.Zoom / ReadZoom - 1) < 0.015) NoteZoom(r.Zoom);
                lock (sync)
                {
                    Track t;
                    if (tracks.TryGetValue(l.Id, out t))
                    {
                        // a second try of the same words that came out worse keeps the first reading (but new
                        // words are taken: another bubble may have appeared in the same place)
                        bool sameWords = LettersOnly(t.Text) == LettersOnly(l.Text);
                        if (t.Text != null && t.TextScore > r.Score + 0.05 && (sameWords || r.Score < 0.6) && Math.Abs(t.ReadW - l.W) <= Math.Max(2, (int)Math.Ceiling(ReadZoom))) { l.Text = t.Text; l.TextScore = t.TextScore; l.BDX = t.BDX; l.BW = t.BW; t.ReadAt = now; }
                        else { t.Text = l.Text; t.TextScore = r.Score; t.ReadW = l.W; t.ReadAt = now; t.BDX = l.BDX; t.BW = l.BW; }
                    }
                }
            }
        }

        /// <summary>Balloon alerts are white (a little grey while they fade in or out).</summary>
        public static bool BalloonColour(TextLine l)
        {
            int mx = Math.Max(l.R, Math.Max(l.G, l.B)), mn = Math.Min(l.R, Math.Min(l.G, l.B));
            return mn >= 165 && mx - mn <= 28;
        }

        static List<float> goodZooms = new List<float>();
        /// <summary>Every cleanly read line measures the zoom again; keep the middle value.</summary>
        static void NoteZoom(float z)
        {
            lock (zoomVotes)
            {
                goodZooms.Add(z);
                if (goodZooms.Count > 25) goodZooms.RemoveAt(0);
                if (goodZooms.Count < 3) return;
                List<float> s = new List<float>(goodZooms); s.Sort();
                float med = s[s.Count / 2];
                if (Math.Abs(med / ReadZoom - 1) > 0.002) { ReadZoom = med; SetZoom(med); }
            }
        }

        static List<double> ZoomCandidates(Rectangle area)
        {
            List<double> c = new List<double>();
            c.Add(area.Height / 480.0); // the usual view is 15 tiles of 32 pixels tall
            foreach (int vx in new int[] { 15, 17, 19, 21 }) c.Add(area.Width / (vx * 32.0));
            foreach (double z in new double[] { 2, 3, 2.5, 1.5, 4, 1, 3.5 }) c.Add(z);
            return c;
        }

        /// <summary>The map zoom isn't known yet: find the one at which this line reads as clean text.</summary>
        static ReadResult FindZoom(int[] px, int pw, int ph, Rectangle box, TextLine l, Rectangle area, PixelFont font)
        {
            // Read the line starting from many zooms. Each read fits the zoom to the line itself; the right
            // zoom is the one most starting points end up at (a wrong one only reads well by accident).
            ReadResult best = new ReadResult();
            foreach (double c in ZoomCandidates(area))
            {
                List<ReadResult> reads = new List<ReadResult>();
                for (int k = -12; k <= 12; k++)
                {
                    ReadResult r = PixelReader.ReadLine(px, pw, ph, box, l.R, l.G, l.B, (float)(c * (1 + k * 0.0025)), font, 0);
                    if (WordLike(r.Text, 4) && r.Score >= 0.8) reads.Add(r);
                }
                double bestWeight = 0;
                foreach (ReadResult a in reads)
                {
                    double w = 0; int n = 0;
                    foreach (ReadResult b in reads) if (Math.Abs(b.Zoom / a.Zoom - 1) < 0.0015) { w += b.Score; n++; }
                    if (n >= 3 && w > bestWeight) { bestWeight = w; best = a; }
                }
                if (bestWeight > 0) break;
            }
            if (best.Score >= 0.95 && WordLike(best.Text, 5)) Vote(best.Zoom);
            return best;
        }

        // Zoom remembered from the last session (same map size): used at once, confirmed by the first text read.
        public static volatile bool ZoomProvisional;
        static long provisionalSince;
        static void ConfirmZoom(string what)
        {
            if (!ZoomProvisional) return;
            ZoomProvisional = false;
            Log("remembered map zoom confirmed by " + what + ": " + ReadZoom.ToString("0.000"));
        }
        public static void UseRememberedZoom(int w, int h, float z)
        {
            lock (zoomVotes)
            {
                if (ReadZoom > 0 || mapRect.Width != w || mapRect.Height != h || z < 0.5f || z > 12) return;
                ReadZoom = z; SetZoom(z);
                ZoomProvisional = true; provisionalSince = Now();
            }
            Log("using the map zoom remembered from last time: " + z.ToString("0.000"));
        }

        static void AcceptZoom(float zoom, string why)
        {
            lock (zoomVotes)
            {
                if (ReadZoom > 0) return;
                ReadZoom = zoom;
                SetZoom(zoom);
                Log("map zoom found from " + why + ": " + zoom.ToString("0.000"));
            }
        }

        // The full zoom search reads a line at many sizes and takes a moment: it runs beside the screen
        // checks (on a copy of the line) so following the bubbles never waits for it.
        static readonly object zoomJobLock = new object();
        static bool zoomJobBusy;
        static long lastZoomJob;
        static void StartZoomSearch(int[] px, int pw, int ph, Rectangle box, TextLine l, Rectangle area)
        {
            lock (zoomJobLock)
            {
                if (zoomJobBusy || Now() - lastZoomJob < 1000) return;
                zoomJobBusy = true; lastZoomJob = Now();
            }
            Rectangle R = box; R.Inflate(24, 24);
            R = Rectangle.Intersect(R, new Rectangle(0, 0, pw, ph));
            int[] sub = new int[R.Width * R.Height];
            for (int y = 0; y < R.Height; y++) Array.Copy(px, (R.Y + y) * pw + R.X, sub, y * R.Width, R.Width);
            Rectangle b2 = new Rectangle(box.X - R.X, box.Y - R.Y, box.Width, box.Height);
            TextLine copy = new TextLine(); copy.R = l.R; copy.G = l.G; copy.B = l.B; copy.Glyphs = l.Glyphs; copy.W = l.W; copy.H = l.H;
            int sw = R.Width, sh = R.Height;
            ThreadPool.QueueUserWorkItem(delegate (object o)
            {
                try { if (ReadZoom <= 0) FindZoom(sub, sw, sh, b2, copy, area, Font); }
                catch (Exception e) { Log("zoom search error: " + e.Message); }
                finally { lock (zoomJobLock) zoomJobBusy = false; }
            });
        }

        static void Vote(float zoom)
        {
            {
                lock (zoomVotes)
                {
                    zoomVotes.Add(zoom);
                    if (zoomVotes.Count >= 2)
                    {
                        float a = zoomVotes[zoomVotes.Count - 1], b = zoomVotes[zoomVotes.Count - 2];
                        if (Math.Abs(a / b - 1) < 0.01)
                        {
                            ReadZoom = (a + b) / 2;
                            SetZoom(ReadZoom);
                            Log("map zoom found from bubble text: " + ReadZoom.ToString("0.000"));
                        }
                    }
                }
            }
        }

        // ------------------------------------------------------------ hover names (screentips)
        static void TipLoop()
        {
            while (true)
            {
                int wait = 70;
                try
                {
                    if (!mapRect.IsEmpty && GameInFront() && TipFont != null && CaptureMode != -1)
                    {
                        if (ReadZoom > 0) TipTick(); else { TipZoom(); wait = 600; }
                        if (CaptureMode == 2) wait = Math.Max(wait, 350);
                    }
                }
                catch (Exception e) { Log("hover name error: " + e.Message); wait = 1000; }
                Thread.Sleep(wait);
            }
        }

        /// <summary>Zoom not known yet: the hover name is the quickest clean text to find it with.</summary>
        static void TipZoom()
        {
            Rectangle area = mapRect;
            double guess = Math.Max(1, area.Height / 480.0);
            Rectangle band = new Rectangle(area.X, area.Y, area.Width, Math.Min(area.Height, (int)Math.Round(40 * guess)));
            int[] px; int pw, ph;
            px = Grab(band, out pw, out ph);
            List<TextLine> lines = MergeRows(AnalyzeShot(px, pw, ph, 4, (int)Math.Ceiling(guess * 24), (int)Math.Ceiling(guess * 18), (int)Math.Round(guess * 8), 170, (int)Math.Ceiling(guess * 2.4)));
            TextLine best = null;
            foreach (TextLine l in lines)
            {
                double cx = l.X + l.W / 2.0;
                if (l.Glyphs < 5 || l.Uniform < 0.8 || cx < pw * 0.15 || cx > pw * 0.85) continue;
                if (best == null || l.W > best.W) best = l;
            }
            if (best != null) FindZoom(px, pw, ph, new Rectangle(best.X, best.Y, best.W, best.H), best, area, TipFont);
        }

        /// <summary>Reads the name shown at the top of the map when hovering over something.</summary>
        public static void TipTick()
        {
            float z = ReadZoom;
            Rectangle area = mapRect;
            Rectangle band = new Rectangle(area.X, area.Y, area.Width, Math.Min(area.Height, (int)Math.Round(30 * z)));
            bool hide = CaptureMode == 2 && !Headless && tipEn.Length > 0;
            if (hide) HideAllNow();
            int[] px; int pw, ph;
            px = Grab(band, out pw, out ph);
            if (hide) RequestRender();
            ulong hsh = 1469598103934665603UL;
            for (int i = 0; i < px.Length; i += 11) hsh = (hsh ^ (ulong)(px[i] & 0xF0F0F0)) * 1099511628211UL;
            if ((long)hsh == tipHash) return;
            tipHash = (long)hsh;
            // hover names are white: a high brightness threshold keeps the map's own clutter out
            List<TextLine> lines = MergeRows(AnalyzeShot(px, pw, ph, 4, (int)Math.Ceiling(z * 18), (int)Math.Ceiling(z * 14), (int)Math.Round(z * 7), 170, (int)Math.Ceiling(z * 2.4)));
            TextLine best = null;
            foreach (TextLine l in lines)
            {
                double cx = l.X + l.W / 2.0;
                if (l.H < 6 * z || l.Glyphs < 2 || l.Uniform < 0.75) continue;
                if (cx < pw * 0.15 || cx > pw * 0.85) continue;
                if (best == null || l.W > best.W) best = l;
            }
            string ru = "";
            ReadResult rr = null;
            if (best != null)
            {
                rr = PixelReader.ReadLine(px, pw, ph, new Rectangle(best.X, best.Y, best.W, best.H), best.R, best.G, best.B, z, TipFont, 3);
                if (rr.Score >= 0.8 && Letters(rr.Text) >= 2) ru = rr.Text.Trim();
                if (ZoomProvisional && rr.Score >= 0.95 && WordLike(rr.Text, 4)) ConfirmZoom("a hover name");
            }
            if (rr != null && ru.Length == 0 && rr.Text != null && rr.Text.Length > 0 && rr.Text != lastTipMiss)
            {
                lastTipMiss = rr.Text;
                Log("hover name not read well: \"" + rr.Text + "\" (score " + rr.Score.ToString("0.00", CultureInfo.InvariantCulture) + ")");
            }
            lock (sync)
            {
                if (ru == tipRu) return;
                tipRu = ru; tipEn = "";
                if (ru.Length > 0)
                {
                    tipBox = new Rectangle(band.X + best.X, band.Y + best.Y, best.W, best.H);
                    tipCx = band.X + rr.OriginX + (rr.InkLeft + rr.InkRight + 1) / 2.0 * rr.Zoom;
                    tipBase = band.Y + rr.OriginY + rr.Baseline * rr.Zoom;
                    tipColor = (best.R << 16) | (best.G << 8) | best.B;
                }
            }
            Emit("{\"t\":\"tip\",\"ru\":" + Json(ru) + "}");
            RequestRender();
        }

        // ------------------------------------------------------------ tracking
        /// <summary>
        /// Pairs detected lines with known tracks (same colour and size, nearby), updates them and creates
        /// tracks for new lines. Returns true when a track was created. Caller holds the lock.
        /// </summary>
        /// <summary>
        /// How far the whole view moved since the lines were last seen (the camera follows you, or whoever you
        /// follow as a ghost, and jumps several tiles at once when the game lags): the move most lines -
        /// bubbles and the map's own writing alike - agree on. (0,0) when it didn't move or nothing agrees.
        /// </summary>
        public static int ShiftX, ShiftY, ShiftVotes;
        static void EstimateShift(List<TextLine> lines, List<Track> cands, long captureT)
        {
            ShiftX = 0; ShiftY = 0; ShiftVotes = 0;
            Dictionary<long, List<int[]>> bins = new Dictionary<long, List<int[]>>();
            int still = 0, voters = 0;
            foreach (Track t in cands)
            {
                long age = captureT - t.Seen;
                if (age < 20 || age > 900) continue;
                bool any = false, zero = false;
                HashSet<long> mine = new HashSet<long>();
                foreach (TextLine l in lines)
                {
                    int cr = l.R - t.R, cg = l.G - t.G, cb = l.B - t.B;
                    if (cr * cr + cg * cg + cb * cb > 25 * 25) continue;
                    if (Math.Abs(l.W - t.W) > Math.Max(3, t.W / 16) || Math.Abs(l.H - t.H) > 2 || Math.Abs(l.Glyphs - t.N) > 1) continue;
                    int dx = (int)Math.Round((l.X + l.W / 2.0) - (t.X + t.W / 2.0)), dy = (l.Y + l.H) - (t.Y + t.H);
                    if (Math.Abs(dx) > 900 || Math.Abs(dy) > 900) continue;
                    any = true;
                    if (Math.Abs(dx) <= 4 && Math.Abs(dy) <= 4) { zero = true; continue; }
                    long key = ((long)Math.Round(dx / 8.0) << 20) ^ (long)(Math.Round(dy / 8.0) + 4096);
                    if (!mine.Add(key)) continue;
                    List<int[]> b;
                    if (!bins.TryGetValue(key, out b)) { b = new List<int[]>(); bins[key] = b; }
                    b.Add(new int[] { dx, dy });
                }
                if (any) voters++;
                if (zero) still++;
            }
            List<int[]> best = null, second = null;
            foreach (List<int[]> b in bins.Values)
            {
                if (best == null || b.Count > best.Count) { second = best; best = b; }
                else if (second == null || b.Count > second.Count) second = b;
            }
            // a still view with repeating floor patterns also "agrees" on moves of a tile or two: the move must
            // be backed by clearly more lines than stayed where they were
            if (best == null || best.Count < 3 || best.Count < 2 * still + 1 || best.Count * 4 < voters) return;
            if (second != null && second.Count * 3 > best.Count * 2) return; // no clear winner
            List<int> xs = new List<int>(), ys = new List<int>();
            foreach (int[] d in best) { xs.Add(d[0]); ys.Add(d[1]); }
            xs.Sort(); ys.Sort();
            ShiftX = xs[xs.Count / 2]; ShiftY = ys[ys.Count / 2]; ShiftVotes = best.Count;
        }

        public static bool UpdateTracks(List<TextLine> lines, Rectangle region, long captureT, bool full)
        {
            List<Track> cands = new List<Track>();
            Rectangle near = region; near.Inflate(4, 4);
            foreach (Track t in tracks.Values)
                if (full || near.IntersectsWith(new Rectangle(t.X, t.Y, t.W, t.H))) cands.Add(t);
            int maxDisp = full ? 320 : Math.Max(40, Math.Min(region.Width, region.Height) / 2);
            // a look at the whole map: did the whole view move? Then each line is also compared with where its
            // track is now, after that move (a jump of several tiles no longer loses every bubble)
            int sx = 0, sy = 0;
            if (full)
            {
                EstimateShift(lines, cands, captureT);
                sx = ShiftX; sy = ShiftY;
                if (sx != 0 || sy != 0) TraceLog.Add("V	" + sx + "	" + sy + "	" + ShiftVotes);
            }
            List<double[]> pairs = new List<double[]>();
            for (int i = 0; i < lines.Count; i++)
            {
                TextLine l = lines[i];
                for (int j = 0; j < cands.Count; j++)
                {
                    Track t = cands[j];
                    // a labelled bubble is known to be there: follow it even if a letter flickers
                    bool young = captureT - t.Born < 900 || t.Labeled;
                    int cr = l.R - t.R, cg = l.G - t.G, cb = l.B - t.B;
                    double cd = Math.Sqrt(cr * cr + cg * cg + cb * cb);
                    if (cd > (young ? 60 : 45)) continue;
                    int dn = Math.Abs(l.Glyphs - t.N);
                    if (dn > Math.Max(2, (young ? 0.6 : 0.3) * Math.Max(l.Glyphs, t.N))) continue;
                    if (Math.Abs(l.W - t.W) > Math.Max(10, (young ? 0.5 : 0.2) * Math.Max(l.W, t.W))) continue;
                    if (Math.Abs(l.H - t.H) > Math.Max(5, 0.3 * Math.Max(l.H, t.H))) continue;
                    double dx = (l.X + l.W / 2.0) - (t.X + t.W / 2.0), dy = (l.Y + l.H) - (t.Y + t.H);
                    double disp = Math.Sqrt(dx * dx + dy * dy);
                    if ((sx != 0 || sy != 0) && captureT - t.Seen >= 20)
                    {
                        double ex = dx - sx, ey = dy - sy;
                        disp = Math.Min(disp, Math.Sqrt(ex * ex + ey * ey));
                    }
                    if (disp > maxDisp) continue;
                    // A labelled bubble moves with its speaker, at most about a tile a step: when the view did not
                    // move, a line much further from where it was heading is another bubble (the right one was
                    // just not seen this time), and taking it would carry the label away from its words.
                    if (t.Labeled && sx == 0 && sy == 0)
                    {
                        double dtm = Math.Min(400, Math.Max(0, captureT - t.Seen));
                        double ex2 = dx - t.VX * dtm, ey2 = dy - t.VY * dtm;
                        double tile = 32 * (ReadZoom > 0 ? ReadZoom : 3f);
                        if (Math.Sqrt(ex2 * ex2 + ey2 * ey2) > tile * (0.5 + 0.6 * Math.Min(1.0, dtm / 250.0))) continue;
                    }
                    double cost = disp + 4 * cd + 8 * dn;
                    // This speaker is about to get a new bubble: theirs slide up and the new one appears
                    // where the old one was, so prefer the line that moved up for an old bubble.
                    if (t.Labeled && t.Group != null && expecting.Contains(t.Group) && dy > -4) cost += 60;
                    pairs.Add(new double[] { i, j, cost });
                }
            }
            pairs.Sort(delegate (double[] a, double[] b) { return a[2].CompareTo(b[2]); });
            bool[] usedL = new bool[lines.Count];
            HashSet<int> usedT = new HashSet<int>();
            foreach (double[] p in pairs)
            {
                int i = (int)p[0], j = (int)p[1];
                if (usedL[i] || usedT.Contains(j)) continue;
                usedL[i] = true; usedT.Add(j);
                Track t = cands[j]; TextLine l = lines[i];
                l.Id = t.Id;
                if (t.Seen > captureT) continue; // a newer close-up look already moved it
                NoteMotion(t, l, captureT);
                t.X = l.X; t.Y = l.Y; t.W = l.W; t.H = l.H; t.N = Math.Max(t.N, l.Glyphs);
                t.R = l.R; t.G = l.G; t.B = l.B; t.U = l.Uniform; t.Seen = captureT;
            }
            // A labelled line that jumped further than usual (bubbles slide up when the same speaker says
            // something new): pick it up again instead of starting a new track.
            for (int i = 0; i < lines.Count; i++)
            {
                if (usedL[i]) continue;
                TextLine l = lines[i];
                Track best = null; double bestD = double.MaxValue;
                foreach (Track t in cands)
                {
                    if (!t.Labeled || usedT.Contains(cands.IndexOf(t)) || captureT - t.Seen < 60) continue;
                    int cr = l.R - t.R, cg = l.G - t.G, cb = l.B - t.B;
                    if (cr * cr + cg * cg + cb * cb > 45 * 45) continue;
                    if (Math.Abs(l.W - t.W) > Math.Max(12, 0.25 * Math.Max(l.W, t.W))) continue;
                    if (Math.Abs(l.H - t.H) > Math.Max(6, 0.35 * Math.Max(l.H, t.H))) continue;
                    double dx = (l.X + l.W / 2.0) - (t.X + t.W / 2.0), dy = (l.Y + l.H) - (t.Y + t.H);
                    if (Math.Abs(dx) > Math.Max(40, l.W * 0.5) || Math.Abs(dy) > Math.Max(120, l.H * 8)) continue;
                    double d = Math.Abs(dx) + Math.Abs(dy);
                    if (d < bestD) { bestD = d; best = t; }
                }
                if (best == null) continue;
                usedL[i] = true; usedT.Add(cands.IndexOf(best));
                l.Id = best.Id;
                best.VX = 0; best.VY = 0; best.Miss = 0;
                best.X = l.X; best.Y = l.Y; best.W = l.W; best.H = l.H; best.N = l.Glyphs;
                best.R = l.R; best.G = l.G; best.B = l.B; best.U = l.Uniform; best.Seen = captureT;
            }
            if ((sx != 0 || sy != 0) && full)
            {
                // labelled bubbles not found this time (a busy floor behind them): they moved with the view,
                // so the next close-up look is made where they are now
                for (int j = 0; j < cands.Count; j++)
                {
                    Track t = cands[j];
                    if (usedT.Contains(j) || !t.Labeled || captureT - t.Seen < 20 || captureT - t.Seen > 900) continue;
                    t.X += sx; t.Y += sy;
                }
            }
            bool created = false;
            for (int i = 0; i < lines.Count; i++)
            {
                if (usedL[i]) continue;
                TextLine l = lines[i];
                Track t = new Track();
                t.Id = ++trackSeq; t.X = l.X; t.Y = l.Y; t.W = l.W; t.H = l.H; t.N = l.Glyphs;
                t.R = l.R; t.G = l.G; t.B = l.B; t.U = l.Uniform; t.Born = captureT; t.Seen = captureT;
                tracks[t.Id] = t;
                l.Id = t.Id;
                created = true;
            }
            return created;
        }

        static void NoteMotion(Track t, TextLine l, long at)
        {
            long dt = at - t.Seen;
            t.Miss = 0;
            if (dt <= 0 || dt > 400) { t.VX = 0; t.VY = 0; return; }
            double vx = ((l.X + l.W / 2.0) - (t.X + t.W / 2.0)) / dt, vy = ((l.Y + l.H) - (t.Y + t.H)) / dt;
            vx = Math.Max(-3, Math.Min(3, vx)); vy = Math.Max(-3, Math.Min(3, vy));
            t.VX = 0.35 * t.VX + 0.65 * vx; t.VY = 0.35 * t.VY + 0.65 * vy;
        }

        static void RemoveStale(long now)
        {
            List<int> dead = new List<int>();
            foreach (Track t in tracks.Values) if (now - t.Seen > (t.Labeled ? 1000 : 1500)) dead.Add(t.Id);
            foreach (int id in dead) { tracks.Remove(id); goneIds.Add(id); }
            if (tracks.Count > 600)
            {
                List<Track> all = new List<Track>(tracks.Values);
                all.Sort(delegate (Track a, Track b) { return a.Seen.CompareTo(b.Seen); });
                for (int i = 0; i < all.Count - 600; i++) { tracks.Remove(all[i].Id); goneIds.Add(all[i].Id); }
            }
        }

        static void EmitFrame(bool full, Rectangle area, List<TextLine> lines, List<int> gone, long ms)
        {
            StringBuilder sb = new StringBuilder();
            sb.Append("{\"t\":\"frame\",\"full\":").Append(full ? 1 : 0).Append(",\"ms\":").Append(ms)
              .Append(full ? ",\"rect\":[" : ",\"roi\":[").Append(area.X).Append(',').Append(area.Y).Append(',').Append(area.Width).Append(',').Append(area.Height).Append("],\"lines\":[");
            for (int i = 0; i < lines.Count; i++)
            {
                TextLine l = lines[i];
                if (i > 0) sb.Append(',');
                sb.Append("{\"id\":").Append(l.Id).Append(",\"box\":[").Append(l.X).Append(',').Append(l.Y).Append(',').Append(l.W).Append(',').Append(l.H)
                  .Append("],\"n\":").Append(l.Glyphs).Append(",\"c\":[").Append(l.R).Append(',').Append(l.G).Append(',').Append(l.B)
                  .Append("],\"u\":").Append(l.Uniform.ToString("0.00", CultureInfo.InvariantCulture));
                if (l.Small) sb.Append(",\"sm\":1");
                if (l.BW > 0) sb.Append(",\"bx\":[").Append(l.BDX).Append(',').Append(l.BW).Append(']');
                // "ts" is sent once the line has been read (also when it couldn't be read: then "txt" is empty)
                if (l.TextScore >= 0) sb.Append(",\"txt\":").Append(Json(l.Text ?? "")).Append(",\"ts\":").Append(l.TextScore.ToString("0.00", CultureInfo.InvariantCulture));
                sb.Append('}');
            }
            sb.Append(']');
            if (full && ReadZoom > 0) sb.Append(",\"zoom\":").Append(ReadZoom.ToString("0.0000", CultureInfo.InvariantCulture)).Append(",\"zc\":").Append(ZoomProvisional ? 0 : 1);
            if (gone != null && gone.Count > 0)
            {
                sb.Append(",\"gone\":[");
                for (int i = 0; i < gone.Count; i++) { if (i > 0) sb.Append(','); sb.Append(gone[i]); }
                sb.Append(']');
            }
            sb.Append('}');
            Emit(sb.ToString());
        }

        // ------------------------------------------------------------ detection
        /// <summary>
        /// Finds rows of outlined letters drawn in one colour - the signature of BYOND speech bubbles:
        /// bright pixel-font letters with a black outline, one colour per speaker. Coordinates are relative
        /// to the picture.
        /// </summary>
        public static int[] Pixels(Bitmap shot)
        {
            int w = shot.Width, h = shot.Height;
            int[] px = new int[w * h];
            BitmapData bd = shot.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
            Marshal.Copy(bd.Scan0, px, 0, px.Length);
            shot.UnlockBits(bd);
            return px;
        }
        public static List<TextLine> AnalyzeShot(Bitmap shot) { return AnalyzeShot(Pixels(shot), shot.Width, shot.Height); }
        /// <summary>
        /// Two passes: bright letters (most speech colours) and dimmer ones. A low threshold alone lets a pale
        /// floor run into the letters; a high one alone misses darker speech colours.
        /// </summary>
        public static List<TextLine> AnalyzeShot(int[] px, int w, int h)
        {
            bool[] near = NearOutline(px, w, h, DilateRadius, LumOutline);
            List<TextLine> res = AnalyzeCore(px, w, h, near, MinGlyph, MaxGlyphH, MaxGlyphW, GlyphGap, 160);
            if (LumText < 160) AddNew(res, AnalyzeCore(px, w, h, near, MinGlyph, MaxGlyphH, MaxGlyphW, GlyphGap, LumText));
            if (SmallWanted || smallPass)
            {
                // a small-font line wins over pieces of it the letter finder picked up (shorter than it)
                foreach (TextLine l in AnalyzeSmall(px, w, h))
                {
                    List<TextLine> over = new List<TextLine>();
                    foreach (TextLine k in res)
                    {
                        int ix = Math.Min(l.X + l.W, k.X + k.W) - Math.Max(l.X, k.X), iy = Math.Min(l.Y + l.H, k.Y + k.H) - Math.Max(l.Y, k.Y);
                        if (ix > 0 && iy > 0) over.Add(k);
                    }
                    bool pieces = true;
                    foreach (TextLine k in over) if (k.H >= 0.75 * l.H || k.Y < l.Y - 3 || k.Y + k.H > l.Y + l.H + 3) { pieces = false; break; }
                    if (!pieces) continue;
                    foreach (TextLine k in over) res.Remove(k);
                    res.Add(l);
                }
            }
            return res;
        }
        static void AddNew(List<TextLine> res, List<TextLine> more)
        {
            foreach (TextLine l in more)
            {
                bool dup = false;
                foreach (TextLine k in res)
                {
                    int ix = Math.Min(l.X + l.W, k.X + k.W) - Math.Max(l.X, k.X), iy = Math.Min(l.Y + l.H, k.Y + k.H) - Math.Max(l.Y, k.Y);
                    if (ix > 0 && iy > 0) { dup = true; break; }
                }
                if (!dup) res.Add(l);
            }
        }

        /// <summary>Set by the translator while a whisper / quiet / machine line is expected or labelled (command Y).</summary>
        public static volatile bool SmallWanted;
        // Small lines are also looked for on every other full screen check, so map text in that font is
        // already known (as scenery) when a whisper or a machine's line is expected.
        [ThreadStatic] static bool smallPass;

        /// <summary>
        /// Lines in the small font BYOND uses for whispers, quiet speech and machines ("italics": MS Serif).
        /// Its letters are smoothed (several shades of one colour) and touch each other, so they are found as
        /// rows of one hue inside a solid black outline rather than as separate letters. They can't be read;
        /// the map overlay pairs them with chat by size, colour, place and timing.
        /// </summary>
        public static List<TextLine> AnalyzeSmall(int[] px, int w, int h)
        {
            List<TextLine> res = new List<TextLine>();
            float z = Math.Max(1f, MaxGlyphH / 12f);
            int R = (int)Math.Ceiling(1.6 * z);
            int N = w * h;
            int vMax = (int)(12 * z), vTight = (int)(9 * z), hMax = (int)(130 * z);
            bool[] black = Buf(ref bufBlack, N, false);
            for (int i = 0; i < N; i++)
            {
                int c = px[i];
                black[i] = (c & 0xF0F0F0) == 0 && ((c >> 16) & 255) <= 14 && ((c >> 8) & 255) <= 14 && (c & 255) <= 14;
            }
            // ink: coloured pixels inside the outline - black close above and below (a line of text is at
            // most ~12 game pixels tall) and somewhere to the left and right within a line's length
            byte[] ok = Buf(ref bufOk, N, true); // bit 1: vertical fits, bit 2: near black vertically, bit 4: horizontal fits, bit 8: near black horizontally
            ushort[] up = Buf(ref bufDist, N + w, false); // distance to black above (row by row; the last w entries: running distance below)
            {
                int[] run = Buf(ref bufCol, w, false);
                int cap = vMax + 1; // only compared with vMax and smaller
                for (int x = 0; x < w; x++) run[x] = 30000;
                for (int y = 0; y < h; y++)
                {
                    int row = y * w;
                    for (int x = 0; x < w; x++) { int d = black[row + x] ? 0 : run[x] + 1; if (d > cap) d = cap; run[x] = d; up[row + x] = (ushort)d; }
                }
                for (int x = 0; x < w; x++) run[x] = 30000;
                for (int y = h - 1; y >= 0; y--)
                {
                    int row = y * w;
                    for (int x = 0; x < w; x++)
                    {
                        int i = row + x;
                        int d = black[i] ? 0 : run[x] + 1; if (d > cap) d = cap; run[x] = d;
                        int u = up[i], sum = u + d;
                        if (sum <= vMax) ok[i] |= 1;
                        if (u <= R || d <= R || sum <= vTight) ok[i] |= 2;
                    }
                }
            }
            ushort[] dist = new ushort[w];
            for (int y = 0; y < h; y++)
            {
                int row = y * w, d = 30000;
                for (int x = 0; x < w; x++) { d = black[row + x] ? 0 : (d < 30000 ? d + 1 : 30000); dist[x] = (ushort)d; }
                d = 30000;
                for (int x = w - 1; x >= 0; x--)
                {
                    int i = row + x;
                    d = black[i] ? 0 : (d < 30000 ? d + 1 : 30000);
                    int lf = dist[x];
                    if (lf + d <= hMax) ok[i] |= 4;
                    if (lf <= R || d <= R) ok[i] |= 8;
                }
            }
            bool[] ink = Buf(ref bufInk, N, false);
            for (int i = 0; i < N; i++)
            {
                int o = ok[i];
                if ((o & 5) != 5 || (o & 10) == 0) { ink[i] = false; continue; }
                int c = px[i];
                ink[i] = Math.Max((c >> 16) & 255, Math.Max((c >> 8) & 255, c & 255)) >= 40;
            }
            // blobs of ink
            int[] lab = Buf(ref bufLab, N, true);
            int[] stack = Buf(ref bufStack, N, false);
            List<int[]> blobs = new List<int[]>(); // minx,miny,maxx,maxy,count
            int next = 0;
            for (int s0 = 0; s0 < N; s0++)
            {
                if (!ink[s0] || lab[s0] != 0) continue;
                next++;
                int sp = 0; stack[sp++] = s0; lab[s0] = next;
                int minx = int.MaxValue, miny = int.MaxValue, maxx = -1, maxy = -1, cnt = 0;
                while (sp > 0)
                {
                    int i = stack[--sp];
                    int x = i % w, y = i / w;
                    cnt++;
                    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
                    for (int dy = -1; dy <= 1; dy++)
                    {
                        int ny = y + dy; if (ny < 0 || ny >= h) continue;
                        for (int dx = -1; dx <= 1; dx++)
                        {
                            int nx = x + dx; if (nx < 0 || nx >= w) continue;
                            int j = ny * w + nx;
                            if (ink[j] && lab[j] == 0) { lab[j] = next; stack[sp++] = j; }
                        }
                    }
                }
                blobs.Add(new int[] { minx, miny, maxx, maxy, cnt });
            }
            // letters/words: 3..12 game pixels tall
            List<int> keep = new List<int>();
            for (int k = 0; k < blobs.Count; k++)
            {
                int[] b = blobs[k];
                int bh = b[3] - b[1] + 1, bw = b[2] - b[0] + 1;
                if (bh >= 3 * z && bh <= 12 * z && bw <= 120 * z && b[4] >= 6) keep.Add(k);
            }
            // join pieces on one row (shared middle, small gaps)
            int n = keep.Count;
            int[] parent = new int[n];
            for (int k = 0; k < n; k++) parent[k] = k;
            for (int a = 0; a < n; a++)
                for (int b = a + 1; b < n; b++)
                {
                    int[] A = blobs[keep[a]], B = blobs[keep[b]];
                    int ov = Math.Min(A[3], B[3]) - Math.Max(A[1], B[1]);
                    if (ov < Math.Min(A[3] - A[1], B[3] - B[1]) * 0.5) continue;
                    if (Math.Abs(A[3] - B[3]) > 3 * z) continue; // same baseline (give or take descenders)
                    int gap = Math.Max(B[0] - A[2], A[0] - B[2]);
                    if (gap > 5 * z) continue;
                    Union0(parent, a, b);
                }
            Dictionary<int, List<int>> lines = new Dictionary<int, List<int>>();
            for (int k = 0; k < n; k++)
            {
                int r = Find0(parent, k);
                List<int> l; if (!lines.TryGetValue(r, out l)) { l = new List<int>(); lines[r] = l; }
                l.Add(keep[k]);
            }
            foreach (List<int> members in lines.Values)
            {
                int x0 = int.MaxValue, y0 = int.MaxValue, x1 = -1, y1 = -1;
                foreach (int k in members) { int[] b = blobs[k]; x0 = Math.Min(x0, b[0]); y0 = Math.Min(y0, b[1]); x1 = Math.Max(x1, b[2]); y1 = Math.Max(y1, b[3]); }
                int W = x1 - x0 + 1, H = y1 - y0 + 1;
                if (W < 6 * z || H < 5 * z || H > 13 * z) continue;
                // one hue (or grey), dark outline all around, enough ink
                long inkN = 0, blackN = 0, sr = 0, sg = 0, sb = 0;
                List<double> hues = new List<double>();
                int grey = 0, coloured = 0;
                for (int y = y0; y <= y1; y++)
                    for (int x = x0; x <= x1; x++)
                    {
                        int i = y * w + x;
                        if (black[i]) { blackN++; continue; }
                        if (!ink[i]) continue;
                        int lb = lab[i]; bool mine = false;
                        foreach (int k in members) if (k + 1 == lb) { mine = true; break; }
                        if (!mine) continue;
                        inkN++;
                        int c = px[i];
                        int r = (c >> 16) & 255, g = (c >> 8) & 255, b2 = c & 255;
                        int mx = Math.Max(r, Math.Max(g, b2)), mn = Math.Min(r, Math.Min(g, b2));
                        if (mx - mn < 22) grey++;
                        else { coloured++; if (hues.Count < 4000) hues.Add(Hue(r, g, b2)); }
                    }
                long area = (long)W * H;
                if (inkN < 4 * z * z || blackN < area * 0.18 || inkN < area * 0.10) continue;
                bool oneHue;
                if (grey >= 0.75 * inkN) oneHue = true;
                else if (coloured >= 0.6 * inkN)
                {
                    hues.Sort();
                    double med = hues[hues.Count / 2]; int near = 0;
                    foreach (double hh in hues) { double dd = Math.Abs(hh - med); if (dd > 180) dd = 360 - dd; if (dd <= 22) near++; }
                    oneHue = near >= 0.8 * hues.Count;
                }
                else oneHue = false;
                if (!oneHue) continue;
                // the line's colour: its brightest quarter (the letters' cores; edges are smoothed darker)
                List<int> lum = new List<int>();
                for (int y = y0; y <= y1; y++)
                    for (int x = x0; x <= x1; x++)
                    {
                        int i = y * w + x; if (!ink[i]) continue;
                        int c = px[i]; lum.Add(Math.Max((c >> 16) & 255, Math.Max((c >> 8) & 255, c & 255)));
                    }
                lum.Sort();
                int cut = lum[(int)(lum.Count * 0.75)];
                long cnt2 = 0;
                for (int y = y0; y <= y1; y++)
                    for (int x = x0; x <= x1; x++)
                    {
                        int i = y * w + x; if (!ink[i]) continue;
                        int c = px[i]; int r = (c >> 16) & 255, g = (c >> 8) & 255, b2 = c & 255;
                        if (Math.Max(r, Math.Max(g, b2)) < cut) continue;
                        sr += r; sg += g; sb += b2; cnt2++;
                    }
                if (cnt2 == 0) continue;
                if (Math.Max(sr, Math.Max(sg, sb)) / cnt2 < 80) continue; // speech is never that dark
                TextLine t = new TextLine();
                t.X = x0; t.Y = y0; t.W = W; t.H = H;
                t.Glyphs = Math.Max(2, (int)Math.Round(W / (4.0 * z)));
                t.R = (int)(sr / cnt2); t.G = (int)(sg / cnt2); t.B = (int)(sb / cnt2);
                t.Uniform = 0.9;
                t.Small = true;
                res.Add(t);
            }
            return res;
        }
        static double Hue(int r, int g, int b)
        {
            double R = r / 255.0, G = g / 255.0, B = b / 255.0;
            double mx = Math.Max(R, Math.Max(G, B)), mn = Math.Min(R, Math.Min(G, B)), d = mx - mn;
            if (d <= 0) return 0;
            double h;
            if (mx == R) h = ((G - B) / d) % 6; else if (mx == G) h = (B - R) / d + 2; else h = (R - G) / d + 4;
            h *= 60; if (h < 0) h += 360;
            return h;
        }
        static int Find0(int[] p, int x) { while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; } return x; }
        static void Union0(int[] p, int a, int b) { a = Find0(p, a); b = Find0(p, b); if (a != b) p[b] = a; }
        public static List<TextLine> AnalyzeShot(int[] px, int w, int h, int minGlyph, int maxGlyphH, int maxGlyphW, int glyphGap, int lumText) { return AnalyzeShot(px, w, h, minGlyph, maxGlyphH, maxGlyphW, glyphGap, lumText, DilateRadius); }
        public static List<TextLine> AnalyzeShot(int[] px, int w, int h, int minGlyph, int maxGlyphH, int maxGlyphW, int glyphGap, int lumText, int R)
        {
            return AnalyzeCore(px, w, h, NearOutline(px, w, h, R, LumOutline), minGlyph, maxGlyphH, maxGlyphW, glyphGap, lumText);
        }

        // Work arrays are kept between frames (one set per thread): allocating ~40 MB per look at the map
        // made the .NET garbage collector run all the time.
        [ThreadStatic] static bool[] bufNear, bufDarkH, bufText, bufBlack, bufInk;
        [ThreadStatic] static int[] bufLab, bufStack, bufCol;
        [ThreadStatic] static byte[] bufOk;
        [ThreadStatic] static ushort[] bufDist;
        static T[] Buf<T>(ref T[] b, int n, bool clear) { if (b == null || b.Length < n) b = new T[n]; else if (clear) Array.Clear(b, 0, n); return b; }

        /// <summary>
        /// Pixels within R of a near-black one (horizontally and vertically): where a letter's fill can be,
        /// next to its outline. The same for every brightness pass, so it is worked out once per picture.
        /// Row by row only (column walks are slow: they jump through memory).
        /// </summary>
        static bool[] NearOutline(int[] px, int w, int h, int R, int lumOutline)
        {
            int N = w * h;
            bool[] darkH = Buf(ref bufDarkH, N, false);
            bool[] near = Buf(ref bufNear, N, false);
            for (int y = 0; y < h; y++)
            {
                int row = y * w, run = -100000;
                for (int x = 0; x < w; x++)
                {
                    int c = px[row + x];
                    if ((((c >> 16) & 255) * 299 + ((c >> 8) & 255) * 587 + (c & 255) * 114) / 1000 <= lumOutline) run = x;
                    darkH[row + x] = x - run <= R;
                }
                run = 100000;
                for (int x = w - 1; x >= 0; x--)
                {
                    int c = px[row + x];
                    if ((((c >> 16) & 255) * 299 + ((c >> 8) & 255) * 587 + (c & 255) * 114) / 1000 <= lumOutline) run = x;
                    if (run - x <= R) darkH[row + x] = true;
                }
            }
            int[] col = Buf(ref bufCol, w, false);
            for (int x = 0; x < w; x++) col[x] = -100000;
            for (int y = 0; y < h; y++)
            {
                int row = y * w;
                for (int x = 0; x < w; x++) { if (darkH[row + x]) col[x] = y; near[row + x] = y - col[x] <= R; }
            }
            for (int x = 0; x < w; x++) col[x] = 100000;
            for (int y = h - 1; y >= 0; y--)
            {
                int row = y * w;
                for (int x = 0; x < w; x++) { if (darkH[row + x]) col[x] = y; if (col[x] - y <= R) near[row + x] = true; }
            }
            return near;
        }

        static List<TextLine> AnalyzeCore(int[] px, int w, int h, bool[] near, int minGlyph, int maxGlyphH, int maxGlyphW, int glyphGap, int lumText)
        {
            int N = w * h;
            bool[] text = Buf(ref bufText, N, false);
            for (int i = 0; i < N; i++)
            {
                if (!near[i]) { text[i] = false; continue; }
                int c = px[i];
                text[i] = ((c >> 16) & 255) >= lumText || ((c >> 8) & 255) >= lumText || (c & 255) >= lumText;
            }

            // Connected pieces = candidate letters.
            int[] lab = Buf(ref bufLab, N, true);
            List<int[]> boxes = new List<int[]>(); // minx, miny, maxx, maxy, count, avgR, avgG, avgB, sumR, sumG, sumB
            int[] stack = Buf(ref bufStack, N, false);
            int next = 0;
            for (int start = 0; start < N; start++)
            {
                if (!text[start] || lab[start] != 0) continue;
                next++;
                int sp = 0; stack[sp++] = start; lab[start] = next;
                int minx = int.MaxValue, miny = int.MaxValue, maxx = -1, maxy = -1, cnt = 0, sr = 0, sg = 0, sb = 0;
                while (sp > 0)
                {
                    int i = stack[--sp];
                    int y = i / w, x = i - y * w;
                    cnt++;
                    int pc = px[i]; sr += (pc >> 16) & 255; sg += (pc >> 8) & 255; sb += pc & 255;
                    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
                    int y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0, x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0;
                    for (int dy = y0; dy <= y1; dy++)
                    {
                        int rowj = i + dy * w;
                        for (int dx = x0; dx <= x1; dx++)
                        {
                            int j = rowj + dx;
                            if (text[j] && lab[j] == 0) { lab[j] = next; stack[sp++] = j; }
                        }
                    }
                }
                boxes.Add(new int[] { minx, miny, maxx, maxy, cnt, sr / cnt, sg / cnt, sb / cnt, sr, sg, sb });
            }
            int n = boxes.Count;
            bool[] glyph = new bool[n + 1];
            for (int k = 0; k < n; k++)
            {
                int[] b = boxes[k];
                int bw = b[2] - b[0] + 1, bh = b[3] - b[1] + 1;
                glyph[k + 1] = bh >= minGlyph && bh <= maxGlyphH && bw <= maxGlyphW && b[4] >= 4;
            }

            // Join letters that sit side by side on the same row into lines (union-find).
            int[] parent = new int[n + 1];
            for (int k = 0; k <= n; k++) parent[k] = k;
            Dictionary<int, List<int>> bands = new Dictionary<int, List<int>>();
            for (int k = 0; k < n; k++)
            {
                if (!glyph[k + 1]) continue;
                int band = boxes[k][1] / 16;
                List<int> l; if (!bands.TryGetValue(band, out l)) { l = new List<int>(); bands[band] = l; }
                l.Add(k);
            }
            int reach = Math.Max(3, maxGlyphH / 16 + 1);
            for (int k = 0; k < n; k++)
            {
                if (!glyph[k + 1]) continue;
                int[] a = boxes[k];
                int ah = a[3] - a[1] + 1;
                int band = a[1] / 16;
                for (int bb = band - reach; bb <= band + reach; bb++)
                {
                    List<int> l; if (!bands.TryGetValue(bb, out l)) continue;
                    foreach (int m in l)
                    {
                        if (m <= k) continue;
                        int[] c = boxes[m];
                        int ov = Math.Min(a[3], c[3]) - Math.Max(a[1], c[1]);
                        if (ov <= Math.Min(ah, c[3] - c[1] + 1) * 0.4) continue;
                        int gap = Math.Max(c[0] - a[2], a[0] - c[2]);
                        if (gap >= glyphGap) continue;
                        // letters of one bubble share one colour; scenery next to it doesn't
                        int dr = a[5] - c[5], dg = a[6] - c[6], db = a[7] - c[7];
                        if (dr * dr + dg * dg + db * db > 45 * 45) continue;
                        Union(parent, k + 1, m + 1);
                    }
                }
            }
            Dictionary<int, int> lineOf = new Dictionary<int, int>();
            List<long[]> acc = new List<long[]>(); // minx,miny,maxx,maxy,glyphs,pixels,sumR,sumG,sumB
            List<List<int>> members = new List<List<int>>();
            for (int k = 1; k <= n; k++)
            {
                if (!glyph[k]) continue;
                int root = Find(parent, k);
                int li;
                if (!lineOf.TryGetValue(root, out li)) { li = acc.Count; lineOf[root] = li; acc.Add(new long[] { int.MaxValue, int.MaxValue, -1, -1, 0, 0, 0, 0, 0 }); members.Add(new List<int>()); }
                int[] b = boxes[k - 1];
                long[] L = acc[li];
                L[0] = Math.Min(L[0], b[0]); L[1] = Math.Min(L[1], b[1]); L[2] = Math.Max(L[2], b[2]); L[3] = Math.Max(L[3], b[3]); L[4]++;
                L[5] += b[4]; L[6] += b[8]; L[7] += b[9]; L[8] += b[10];
                members[li].Add(k);
            }
            List<TextLine> res = new List<TextLine>();
            for (int li = 0; li < acc.Count; li++)
            {
                long[] L = acc[li];
                if (L[4] < 2 || L[5] < 12) continue;
                // share of the line's pixels close to its average colour (only the letters' own pixels are visited)
                long ar = L[6] / L[5], ag = L[7] / L[5], ab = L[8] / L[5], close = 0;
                foreach (int k in members[li])
                {
                    int[] b = boxes[k - 1];
                    for (int y = b[1]; y <= b[3]; y++)
                    {
                        int row = y * w;
                        for (int x = b[0]; x <= b[2]; x++)
                        {
                            int i = row + x;
                            if (lab[i] != k) continue;
                            int c = px[i];
                            long dr = ((c >> 16) & 255) - ar, dg = ((c >> 8) & 255) - ag, db = (c & 255) - ab;
                            if (dr * dr + dg * dg + db * db <= 32 * 32) close++;
                        }
                    }
                }
                double uniform = (double)close / L[5];
                if (uniform < MinUniform) continue;
                TextLine t = new TextLine();
                t.X = (int)L[0]; t.Y = (int)L[1]; t.W = (int)(L[2] - L[0] + 1); t.H = (int)(L[3] - L[1] + 1);
                t.Glyphs = (int)L[4];
                t.R = (int)ar; t.G = (int)ag; t.B = (int)ab;
                t.Uniform = uniform;
                res.Add(t);
            }
            return res;
        }
        static int Find(int[] p, int x) { while (p[x] != x) { p[x] = p[p[x]]; x = p[x]; } return x; }
        static void Union(int[] p, int a, int b) { a = Find(p, a); b = Find(p, b); if (a != b) p[b] = a; }

        /// <summary>Pieces on the same row with the same colour are one bubble line (split at wide spaces).</summary>
        public static List<TextLine> MergeRows(List<TextLine> lines)
        {
            List<TextLine> outl = new List<TextLine>(lines);
            bool changed = true;
            while (changed)
            {
                changed = false;
                for (int i = 0; i < outl.Count && !changed; i++)
                {
                    for (int j = i + 1; j < outl.Count; j++)
                    {
                        TextLine a = outl[i], b = outl[j];
                        if (a.Small != b.Small) continue;
                        int ov = Math.Min(a.Y + a.H, b.Y + b.H) - Math.Max(a.Y, b.Y);
                        if (ov < Math.Min(a.H, b.H) * 0.5) continue;
                        int gap = Math.Max(b.X - (a.X + a.W), a.X - (b.X + b.W));
                        if (gap > Math.Max(a.H, b.H) * 2.5) continue;
                        int dr = a.R - b.R, dg = a.G - b.G, db = a.B - b.B;
                        if (dr * dr + dg * dg + db * db > 30 * 30) continue;
                        TextLine m = new TextLine();
                        m.X = Math.Min(a.X, b.X); m.Y = Math.Min(a.Y, b.Y);
                        m.W = Math.Max(a.X + a.W, b.X + b.W) - m.X; m.H = Math.Max(a.Y + a.H, b.Y + b.H) - m.Y;
                        m.Glyphs = a.Glyphs + b.Glyphs;
                        int na = Math.Max(1, a.Glyphs), nb = Math.Max(1, b.Glyphs);
                        m.R = (a.R * na + b.R * nb) / (na + nb); m.G = (a.G * na + b.G * nb) / (na + nb); m.B = (a.B * na + b.B * nb) / (na + nb);
                        m.Uniform = Math.Min(a.Uniform, b.Uniform);
                        m.Small = a.Small;
                        outl[i] = m; outl.RemoveAt(j); changed = true; break;
                    }
                }
            }
            return outl;
        }

        // ------------------------------------------------------------ commands from the translator
        static void ReadCommands()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null) { try { Command(line); } catch (Exception e) { Log("command error: " + e.Message); } }
            }
            catch (Exception e) { Log("reader stopped: " + e.Message); }
            Environment.Exit(0);
        }

        public static void Command(string line)
        {
            if (line.Length == 0) return;
            char k = line[0];
            string body = line.Substring(1);
            if (k == 'Q') Environment.Exit(0);
            else if (k == 'I') { int iv; if (int.TryParse(body.Trim(), out iv)) IntervalMs = Math.Max(30, iv); }
            else if (k == 'F') { int iv; if (int.TryParse(body.Trim(), out iv)) FollowMs = Math.Max(10, Math.Min(200, iv)); }
            else if (k == 'D') { string nm = body.Trim(); if (nm.Length > 0 && nm.Length < 60 && nm.IndexOfAny(Path.GetInvalidFileNameChars()) < 0) snapshotName = nm; saveSnapshot = true; WakeFull(); }
            else if (k == 'N' && body.Trim().Length == 0) { WakeFull(); TraceLog.Add("W\tchat"); }
            else if (k == 'V') TraceLog.Enabled = body.Trim() != "0";
            else if (k == 'T')
            {
                string[] p = body.Split(',');
                if (p.Length >= 2) { int.TryParse(p[0], out LumText); int.TryParse(p[1], out LumOutline); }
                if (p.Length >= 3) int.TryParse(p[2], out DilateRadius);
            }
            else if (k == 'S')
            {
                // box colour, box alpha (0-255), font (0 game / 1 clean), predict (0/1)
                string[] p = body.Split(',');
                if (p.Length >= 1) int.TryParse(p[0], out BoxColor);
                if (p.Length >= 2) { int a; if (int.TryParse(p[1], out a)) BoxAlpha = Math.Max(0, Math.Min(255, a)); }
                if (p.Length >= 3) CleanFont = p[2].Trim() == "1";
                if (p.Length >= 4) Predict = p[3].Trim() != "0";
                if (p.Length >= 5) { int fm; if (!int.TryParse(p[4].Trim(), out fm)) fm = 2; FitMode = Math.Max(0, Math.Min(2, fm)); FitEnglish = FitMode == 1; }
                RequestRender();
            }
            else if (k == 'Y')
            {
                SmallWanted = body.Trim() == "1";
            }
            else if (k == 'R')
            {
                // R<width>,<height>,<zoom>: the zoom found last time for a map of this size
                string[] p = body.Trim().Split(',');
                int w, h; float z;
                if (p.Length == 3 && int.TryParse(p[0], out w) && int.TryParse(p[1], out h) && float.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out z)) UseRememberedZoom(w, h, z);
            }
            else if (k == 'Z')
            {
                float z;
                if (float.TryParse(body.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out z) && z > 0.5f && z < 12 && ReadZoom <= 0) SetZoom(z);
            }
            else if (k == 'H')
            {
                // hover name translation: russian \x1f english
                string[] p = body.Split('\u001f');
                if (p.Length >= 2) { lock (sync) { if (p[0] == tipRu) tipEn = p[1]; } RequestRender(); }
            }
            else if (k == 'X')
            {
                HashSet<string> e = new HashSet<string>();
                foreach (string g in body.Split('\u001e')) if (g.Length > 0) e.Add(g);
                lock (sync) expecting = e;
            }
            else if (k == 'W')
            {
                List<Rectangle> rs = new List<Rectangle>();
                foreach (string rec in body.Split(';'))
                {
                    string[] p = rec.Split(',');
                    if (p.Length < 4) continue;
                    int x, y, w, h;
                    if (int.TryParse(p[0], out x) && int.TryParse(p[1], out y) && int.TryParse(p[2], out w) && int.TryParse(p[3], out h) && w > 0 && h > 0) rs.Add(new Rectangle(x, y, w, h));
                }
                lock (sync) watch = rs;
            }
            else if (k != 'L') { if (ExtraCommand != null) ExtraCommand(line); }
            else
            {
                Dictionary<string, LabelSpec> next = new Dictionary<string, LabelSpec>();
                if (body.Length > 0)
                {
                    foreach (string rec in body.Split('\u001e'))
                    {
                        LabelSpec lb = ParseLabel(rec);
                        if (lb != null) next[lb.Key] = lb;
                    }
                }
                lock (sync)
                {
                    labels = next;
                    foreach (Track t in tracks.Values) { t.Labeled = false; t.Group = null; }
                    foreach (LabelSpec lb in labels.Values)
                        foreach (LineSpec ls in lb.Russian) { Track t; if (tracks.TryGetValue(ls.TrackId, out t)) { t.Labeled = true; t.Group = lb.Group; } }
                }
                RequestRender();
            }
        }

        /// <summary>The map's zoom (screen pixels per game pixel) sets the detector's size limits.</summary>
        public static void SetZoom(float z)
        {
            GlyphGap = Math.Max(8, (int)Math.Round(z * 5.5));      // a space between words is 3 game pixels
            MaxGlyphH = Math.Max(30, (int)Math.Ceiling(z * 12));
            MaxGlyphW = Math.Max(30, (int)Math.Ceiling(z * 10));
            MinGlyph = Math.Max(4, Math.Min(6, (int)Math.Round(z * 1.75)));
        }

        // key \x1f group \x1f order \x1f zoom \x1f color \x1f lines \x1f russian \x1f english
        // russian: idx:track:ax:bd:fx0:fx1:ftop:fbot separated by ';'   english: lines separated by \x1d
        public static LabelSpec ParseLabel(string rec)
        {
            string[] f = rec.Split('\u001f');
            if (f.Length < 8) return null;
            CultureInfo ci = CultureInfo.InvariantCulture;
            LabelSpec lb = new LabelSpec();
            lb.Key = f[0]; lb.Group = f[1];
            long.TryParse(f[2], out lb.Order);
            float.TryParse(f[3], NumberStyles.Float, ci, out lb.Zoom);
            int.TryParse(f[4], out lb.Color);
            int.TryParse(f[5], out lb.Lines);
            foreach (string s in f[6].Split(';'))
            {
                string[] p = s.Split(':');
                if (p.Length < 8) continue;
                LineSpec ls = new LineSpec();
                int.TryParse(p[0], out ls.Idx); int.TryParse(p[1], out ls.TrackId);
                float.TryParse(p[2], NumberStyles.Float, ci, out ls.Ax); float.TryParse(p[3], NumberStyles.Float, ci, out ls.Bd);
                float.TryParse(p[4], NumberStyles.Float, ci, out ls.Fx0); float.TryParse(p[5], NumberStyles.Float, ci, out ls.Fx1);
                float.TryParse(p[6], NumberStyles.Float, ci, out ls.Ftop); float.TryParse(p[7], NumberStyles.Float, ci, out ls.Fbot);
                lb.Russian.Add(ls);
            }
            lb.English = f[7].Length > 0 ? f[7].Split('\u001d') : new string[0];
            if (lb.Zoom <= 0.3f || lb.Lines <= 0) return null;
            return lb;
        }

        // ------------------------------------------------------------ composing labels
        class Anchor { public double X, Y; public long Seen; public bool Ok; }

        /// <summary>Where a label's bubble is now: its centre and the baseline of its last line.</summary>
        static Anchor AnchorOf(LabelSpec lb, long now)
        {
            Anchor a = new Anchor();
            double sx = 0, sy = 0; int cnt = 0;
            float z = lb.Zoom;
            foreach (LineSpec ls in lb.Russian)
            {
                Track t;
                if (!tracks.TryGetValue(ls.TrackId, out t) || now - t.Seen > 350) continue;
                sx += t.X + ls.Ax * z;
                sy += t.Y + t.H + ls.Bd * z + (lb.Lines - 1 - ls.Idx) * LinePitch * z;
                a.Seen = Math.Max(a.Seen, t.Seen);
                cnt++;
            }
            if (cnt == 0) return a;
            a.X = sx / cnt; a.Y = sy / cnt; a.Ok = true;
            return a;
        }

        /// <summary>Builds the image of every speaker's labels.</summary>
        public static List<Composite> Compose()
        {
            long now = Now();
            List<Composite> result = new List<Composite>();
            Dictionary<string, List<LabelSpec>> groups = new Dictionary<string, List<LabelSpec>>();
            Dictionary<string, Anchor> anchors = new Dictionary<string, Anchor>();
            Dictionary<int, Rectangle> trackBoxes = new Dictionary<int, Rectangle>();
            Rectangle area;
            lock (sync)
            {
                area = mapRect;
                foreach (LabelSpec lb in labels.Values)
                {
                    Anchor a = AnchorOf(lb, now);
                    if (!a.Ok) continue;
                    anchors[lb.Key] = a;
                    List<LabelSpec> g;
                    if (!groups.TryGetValue(lb.Group, out g)) { g = new List<LabelSpec>(); groups[lb.Group] = g; }
                    g.Add(lb);
                    foreach (LineSpec ls in lb.Russian)
                    {
                        Track t;
                        if (tracks.TryGetValue(ls.TrackId, out t) && now - t.Seen <= 150) trackBoxes[ls.TrackId] = new Rectangle(t.X, t.Y, t.W, t.H);
                    }
                }
            }
            foreach (KeyValuePair<string, List<LabelSpec>> kv in groups)
            {
                Composite c = ComposeGroup(kv.Key, kv.Value, anchors, trackBoxes, area, now);
                if (c != null) result.Add(c);
            }
            Composite tip = ComposeTip(area);
            if (tip != null) result.Add(tip);
            result.Sort(delegate (Composite a, Composite b) { return a.Order.CompareTo(b.Order); });
            return result;
        }

        static Composite ComposeGroup(string key, List<LabelSpec> group, Dictionary<string, Anchor> anchors, Dictionary<int, Rectangle> trackBoxes, Rectangle area, long now)
        {
            // newest message at the bottom, like the game stacks them
            // Stacked by where the messages really are (lowest first), not by when they were paired: two lines
            // said together can be paired in either order, and an older message placed below a newer one would
            // have its English pushed above the newer one's, leaving an empty box over its own Russian.
            Dictionary<string, long> row = new Dictionary<string, long>();
            foreach (LabelSpec lb in group)
            {
                double pitch = Math.Max(1.0, LinePitch * lb.Zoom);
                row[lb.Key] = (long)Math.Round(anchors[lb.Key].Y / pitch);
            }
            group.Sort(delegate (LabelSpec a, LabelSpec b)
            {
                int c0 = row[b.Key].CompareTo(row[a.Key]);
                return c0 != 0 ? c0 : b.Order.CompareTo(a.Order);
            });
            LabelSpec newest = group[0];
            long newestOrder = newest.Order;
            foreach (LabelSpec lb in group) if (lb.Order > newestOrder) newestOrder = lb.Order;
            Anchor an = anchors[newest.Key];
            float z = newest.Zoom;
            double ax = an.X, ay = an.Y;
            if (Predict) PredictAnchor(key, an, now, ref ax, ref ay);
            NoteDrawn(key, an, ax, ay, now);
            double shiftX = ax - an.X, shiftY = ay - an.Y; // prediction moves everything together
            int axR = (int)Math.Round(ax), ayR = (int)Math.Round(ay);
            int pad = Math.Max(1, (int)Math.Round(z * 0.4));
            int outline = (int)Math.Ceiling(z);

            List<Rectangle> boxes = new List<Rectangle>();
            List<GlyphRun> runs = new List<GlyphRun>();
            StringBuilder sig = new StringBuilder();
            double nextFree = double.MaxValue; // highest baseline still free for the next (older) message
            foreach (LabelSpec lb in group)
            {
                Anchor a = anchors[lb.Key];
                double cx = a.X + shiftX, base0 = a.Y + shiftY;
                // 1) boxes over this message's Russian lines, where they are (unless the box is to fit the English only)
                foreach (LineSpec ls in lb.Russian)
                {
                    if (FitMode == 1) break;
                    int rp = FitMode == 2 ? 0 : pad; // tight: the Russian letters and their outline only
                    double baseY = base0 - (lb.Lines - 1 - ls.Idx) * LinePitch * lb.Zoom;
                    int x0 = (int)Math.Floor(cx + ls.Fx0 * lb.Zoom) - outline - rp;
                    int x1 = (int)Math.Ceiling(cx + ls.Fx1 * lb.Zoom) + outline + rp;
                    int y0 = (int)Math.Floor(baseY - ls.Ftop * lb.Zoom) - outline - rp;
                    int y1 = (int)Math.Ceiling(baseY - ls.Fbot * lb.Zoom) + outline + rp;
                    if (x1 > x0 && y1 > y0) boxes.Add(new Rectangle(x0, y0, x1 - x0, y1 - y0));
                    Rectangle tb;
                    if (trackBoxes.TryGetValue(ls.TrackId, out tb))
                    {
                        // the letters as actually seen, in case the prediction is a pixel off
                        tb.Offset((int)Math.Round(shiftX), (int)Math.Round(shiftY));
                        int tp = FitMode == 2 ? outline + 1 : outline + pad;
                        tb.Inflate(tp, tp);
                        boxes.Add(tb);
                    }
                }
                // 2) its English, on its own last baseline unless a newer message's English is in the way
                double last = Math.Min(base0, nextFree);
                int cxR = (int)Math.Round(cx);
                for (int i = lb.English.Length - 1, k = 0; i >= 0; i--, k++)
                {
                    int baseline = (int)Math.Round(last - k * LinePitch * z);
                    GlyphRun r = LayoutLine(lb.English[i], lb.Color, z, cxR, baseline);
                    if (r == null) continue;
                    runs.Add(r);
                    Rectangle bg = r.Ink;
                    if (FitMode != 0) bg.Inflate(outline, outline); // just the letters and their outline
                    else bg.Inflate(outline + pad, outline + pad);
                    boxes.Add(bg);
                    sig.Append(lb.English[i]).Append('@').Append(cxR - axR).Append(',').Append(baseline - ayR).Append(':').Append(lb.Color).Append('\u001d');
                }
                nextFree = last - Math.Max(1, lb.English.Length) * LinePitch * z;
            }
            if (boxes.Count == 0) return null;
            Rectangle all = boxes[0];
            foreach (Rectangle b in boxes) all = Rectangle.Union(all, b);
            Rectangle clip = Rectangle.Intersect(all, area);
            if (clip.Width <= 0 || clip.Height <= 0) return null;

            Composite c = new Composite();
            c.Key = key; c.Rect = clip; c.Order = newestOrder;
            sig.Append('|').Append(BoxColor).Append('|').Append(BoxAlpha).Append('|').Append(CleanFont).Append('|').Append(FitMode).Append('|').Append(z.ToString("0.000", CultureInfo.InvariantCulture)).Append('|');
            sig.Append(clip.X - axR).Append(',').Append(clip.Y - ayR).Append(',').Append(clip.Width).Append(',').Append(clip.Height).Append('|');
            foreach (Rectangle b in boxes) sig.Append(b.X - axR).Append(',').Append(b.Y - ayR).Append(',').Append(b.Width).Append(',').Append(b.Height).Append(';');
            c.Signature = sig.ToString();
            c.Pixels = Paint(clip, boxes, runs);
            return c;
        }

        /// <summary>The English hover name, over the Russian one, in the same font.</summary>
        static Composite ComposeTip(Rectangle area)
        {
            string en; Rectangle box; double cx, bl; int col; float z = ReadZoom;
            lock (sync) { en = tipEn; box = tipBox; cx = tipCx; bl = tipBase; col = tipColor; if (tipRu.Length == 0) en = ""; }
            if (en.Length == 0 || TipFont == null || z <= 0) return null;
            int outline = (int)Math.Ceiling(z), pad = Math.Max(1, (int)Math.Round(z * 0.4));
            List<Rectangle> boxes = new List<Rectangle>();
            Rectangle rb = box; rb.Inflate(outline + pad, outline + pad); boxes.Add(rb);
            GlyphRun r = LayoutLine(en, col, z, (int)Math.Round(cx), (int)Math.Round(bl), TipFont);
            List<GlyphRun> runs = new List<GlyphRun>();
            if (r != null) { runs.Add(r); Rectangle eb = r.Ink; eb.Inflate(outline + pad, outline + pad); boxes.Add(eb); }
            Rectangle all = boxes[0];
            foreach (Rectangle b in boxes) all = Rectangle.Union(all, b);
            Rectangle clip = Rectangle.Intersect(all, area);
            if (clip.Width <= 0 || clip.Height <= 0) return null;
            Composite c = new Composite();
            c.Key = "~tip"; c.Rect = clip; c.Order = long.MaxValue;
            c.Signature = "tip|" + en + "|" + clip + "|" + BoxColor + "|" + BoxAlpha + "|" + CleanFont;
            c.Pixels = Paint(clip, boxes, runs);
            return c;
        }

        // How far behind the labels are: each time a bubble is measured again, the distance between where
        // it is now and where its label was drawn (before this update). Collected per minute.
        static readonly Dictionary<string, double[]> drawn = new Dictionary<string, double[]>(); // x, y, time, data time
        static readonly List<double> errSamples = new List<double>();
        static readonly List<double> ageSamples = new List<double>();
        static long drawCount;
        static void NoteDrawn(string key, Anchor an, double ax, double ay, long now)
        {
            lock (errSamples)
            {
                double[] d;
                double err = -1;
                if (drawn.TryGetValue(key, out d) && an.Seen > d[3])
                {
                    double dx = an.X - d[0], dy = an.Y - d[1];
                    err = Math.Sqrt(dx * dx + dy * dy);
                    if (errSamples.Count < 20000) errSamples.Add(err);
                }
                if (ageSamples.Count < 20000) ageSamples.Add(now - an.Seen);
                drawCount++;
                if (drawn.Count > 200) drawn.Clear();
                drawn[key] = new double[] { ax, ay, now, an.Seen };
                // R: speaker, bubble measured x y, how old that measurement is (ms), label drawn at x y, distance the bubble moved from the label before (px, -1 = no new measurement)
                TraceLog.Add("R\t" + key + "\t" + Math.Round(an.X) + "\t" + Math.Round(an.Y) + "\t" + (now - an.Seen) + "\t" + Math.Round(ax) + "\t" + Math.Round(ay) + "\t" + (err < 0 ? "-1" : err.ToString("0.0", CultureInfo.InvariantCulture)));
            }
        }
        static double Pct(List<double> a, double p) { if (a.Count == 0) return 0; List<double> s = new List<double>(a); s.Sort(); return s[Math.Min(s.Count - 1, (int)(p * s.Count))]; }
        static TimeSpan lastCpu = TimeSpan.Zero; static long lastCpuAt = -1;

        /// <summary>Follows steady motion a few milliseconds ahead so the label doesn't trail a walking speaker.</summary>
        static void PredictAnchor(string key, Anchor an, long now, ref double ax, ref double ay)
        {
            List<double[]> h;
            if (!anchorHistory.TryGetValue(key, out h)) { if (anchorHistory.Count > 64) anchorHistory.Clear(); h = new List<double[]>(); anchorHistory[key] = h; }
            if (h.Count == 0 || h[h.Count - 1][0] != an.Seen) h.Add(new double[] { an.Seen, an.X, an.Y });
            while (h.Count > 4) h.RemoveAt(0);
            if (h.Count < 3) return;
            double[] a = h[h.Count - 3], b = h[h.Count - 2], c = h[h.Count - 1];
            double dt1 = b[0] - a[0], dt2 = c[0] - b[0];
            // (sightings up to a quarter second apart: the game window can be slow to read)
            if (dt1 <= 0 || dt2 <= 0 || dt1 > 250 || dt2 > 250 || now - c[0] > 250) return;
            double vx1 = (b[1] - a[1]) / dt1, vy1 = (b[2] - a[2]) / dt1;
            double vx2 = (c[1] - b[1]) / dt2, vy2 = (c[2] - b[2]) / dt2;
            // only when it moves steadily (a glide), never on a jump or a stop
            double s1 = Math.Sqrt(vx1 * vx1 + vy1 * vy1), s2 = Math.Sqrt(vx2 * vx2 + vy2 * vy2);
            if (s2 < 0.05 || s2 > 2.5) return;
            if (Math.Abs(s1 - s2) > 0.35 * s2 || vx1 * vx2 + vy1 * vy2 <= 0) return;
            // ahead by how old the last sighting is (plus the moment until the label is on screen)
            double lead = Math.Min(100, Math.Max(0, now - c[0]) + 12);
            ax += vx2 * lead; ay += vy2 * lead;
        }

        class GlyphRun
        {
            public string Text; public int Color; public float Z; public PixelFont F;
            public int OriginX, Baseline;   // screen position of the line start and its baseline
            public Rectangle Ink;          // screen rectangle of the letters
            public int Width;              // game pixels
        }

        /// <summary>Screen coordinate of game-pixel position u on a line that starts at origin.</summary>
        static int Sx(int origin, float z, int u) { return origin + (int)Math.Round(u * z); }

        static GlyphRun LayoutLine(string s, int color, float z, int centreX, int baseline) { return LayoutLine(s, color, z, centreX, baseline, Font); }
        static GlyphRun LayoutLine(string s, int color, float z, int centreX, int baseline, PixelFont font)
        {
            if (string.IsNullOrEmpty(s) || s.Trim().Length == 0) return null;
            GlyphRun r = new GlyphRun();
            r.Text = s; r.Color = color; r.Z = z; r.Baseline = baseline; r.F = font;
            if (CleanFont || font == null)
            {
                float em = (font == TipFont && font != null ? 15f : 8f) * z * 0.95f;
                using (Bitmap tmp = new Bitmap(1, 1))
                using (Graphics g = Graphics.FromImage(tmp))
                using (System.Drawing.Font f = new System.Drawing.Font(cleanFamily, em, FontStyle.Regular, GraphicsUnit.Pixel))
                {
                    SizeF sz = g.MeasureString(s, f, 100000, StringFormat.GenericTypographic);
                    int w = (int)Math.Ceiling(sz.Width);
                    r.OriginX = centreX - w / 2;
                    r.Ink = new Rectangle(r.OriginX, baseline - (int)Math.Round(em * 0.75), w, (int)Math.Round(em * 0.98));
                    r.Width = (int)Math.Round(w / z);
                }
                return r;
            }
            r.Width = font.Width(s);
            r.OriginX = (int)Math.Round(centreX - r.Width * z / 2.0);
            int minX = int.MaxValue, maxX = int.MinValue, top = int.MinValue, bot = int.MaxValue, pen = 0;
            foreach (char ch in s)
            {
                PixelFont.Glyph g = font.Get(ch);
                if (g.Bits != null)
                {
                    minX = Math.Min(minX, pen + g.X); maxX = Math.Max(maxX, pen + g.X + g.W);
                    top = Math.Max(top, g.Y); bot = Math.Min(bot, g.Y - g.H);
                }
                pen += g.A;
            }
            if (minX == int.MaxValue) return null;
            int sx0 = Sx(r.OriginX, z, minX), sx1 = Sx(r.OriginX, z, maxX);
            int sy0 = baseline - (int)Math.Round(top * z), sy1 = baseline - (int)Math.Round(bot * z);
            r.Ink = new Rectangle(sx0, sy0, sx1 - sx0, sy1 - sy0);
            return r;
        }

        static int Premul(int rgb, int a)
        {
            int r = ((rgb >> 16) & 255) * a / 255, g = ((rgb >> 8) & 255) * a / 255, b = (rgb & 255) * a / 255;
            return (a << 24) | (r << 16) | (g << 8) | b;
        }

        static int[] Paint(Rectangle clip, List<Rectangle> boxes, List<GlyphRun> runs)
        {
            int w = clip.Width, h = clip.Height;
            int[] px = new int[w * h];
            if (BoxAlpha > 0)
            {
                int box = Premul(BoxColor, BoxAlpha);
                foreach (Rectangle b0 in boxes)
                {
                    Rectangle b = Rectangle.Intersect(b0, clip);
                    for (int y = b.Top; y < b.Bottom; y++)
                    {
                        int row = (y - clip.Y) * w - clip.X;
                        for (int x = b.Left; x < b.Right; x++) px[row + x] = box;
                    }
                }
            }
            foreach (GlyphRun r in runs)
            {
                if (CleanFont || r.F == null) PaintClean(px, clip, r);
                else PaintPixels(px, clip, r);
            }
            return px;
        }

        /// <summary>The game's own look: letters at game size with a 1-pixel black outline, scaled up like the map.</summary>
        static void PaintPixels(int[] px, Rectangle clip, GlyphRun r)
        {
            // game-pixel mask of the line, one pixel of room on every side for the outline
            int top = r.F.MaxTop + 1, nativeH = top + r.F.MaxDesc + 3;
            int nativeW = Math.Max(1, r.Width) + 8;
            byte[] m = new byte[nativeW * nativeH]; // 1 = letter, 2 = outline
            int pen = 0;
            foreach (char ch in r.Text)
            {
                PixelFont.Glyph g = r.F.Get(ch);
                if (g.Bits != null)
                {
                    for (int yy = 0; yy < g.H; yy++)
                        for (int xx = 0; xx < g.W; xx++)
                        {
                            if (!g.Bits[yy * g.W + xx]) continue;
                            int nx = pen + g.X + xx + 1, ny = top - g.Y + yy;
                            if (nx >= 0 && nx < nativeW && ny >= 0 && ny < nativeH) m[ny * nativeW + nx] = 1;
                        }
                }
                pen += g.A;
            }
            for (int y = 0; y < nativeH; y++)
                for (int x = 0; x < nativeW; x++)
                {
                    if (m[y * nativeW + x] != 0) continue;
                    bool near = false;
                    for (int dy = -1; dy <= 1 && !near; dy++)
                        for (int dx = -1; dx <= 1; dx++)
                        {
                            int nx = x + dx, ny = y + dy;
                            if (nx >= 0 && ny >= 0 && nx < nativeW && ny < nativeH && m[ny * nativeW + nx] == 1) { near = true; break; }
                        }
                    if (near) m[y * nativeW + x] = 2;
                }
            int fill = unchecked((int)0xFF000000) | (r.Color & 0xFFFFFF);
            int black = unchecked((int)0xFF000000);
            float z = r.Z;
            for (int y = 0; y < nativeH; y++)
            {
                // mask row y covers heights (top - y - 1) .. (top - y) above the baseline
                int sy0 = r.Baseline - (int)Math.Round((top - y) * z), sy1 = r.Baseline - (int)Math.Round((top - y - 1) * z);
                int ya = Math.Max(sy0, clip.Top), yb = Math.Min(sy1, clip.Bottom);
                if (ya >= yb) continue;
                for (int x = 0; x < nativeW; x++)
                {
                    byte v = m[y * nativeW + x];
                    if (v == 0) continue;
                    // mask column x is game pixel u = x - 1 of the line
                    int sx0 = Sx(r.OriginX, z, x - 1), sx1 = Sx(r.OriginX, z, x);
                    int xa = Math.Max(sx0, clip.Left), xb = Math.Min(sx1, clip.Right);
                    int col = v == 1 ? fill : black;
                    for (int sy = ya; sy < yb; sy++)
                    {
                        int row = (sy - clip.Y) * clip.Width - clip.X;
                        for (int sx = xa; sx < xb; sx++) px[row + sx] = col;
                    }
                }
            }
        }

        /// <summary>The "clean" look: a smooth Windows font with a black outline.</summary>
        static void PaintClean(int[] px, Rectangle clip, GlyphRun r)
        {
            Rectangle rr = r.Ink; rr.Inflate((int)Math.Ceiling(r.Z) + 3, (int)Math.Ceiling(r.Z) + 3);
            Rectangle area = Rectangle.Intersect(rr, clip);
            if (area.Width <= 0 || area.Height <= 0) return;
            float em = (r.F == TipFont && r.F != null ? 15f : 8f) * r.Z * 0.95f;
            using (Bitmap bmp = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb))
            {
                using (Graphics g = Graphics.FromImage(bmp))
                using (GraphicsPath tp = new GraphicsPath())
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.Clear(Color.Transparent);
                    tp.AddString(r.Text, cleanFamily, (int)FontStyle.Regular, em, new PointF(r.OriginX - area.X, r.Baseline - em * 0.93f - area.Y), StringFormat.GenericTypographic);
                    using (Pen outline = new Pen(Color.Black, Math.Max(2f, r.Z * 1.2f))) { outline.LineJoin = LineJoin.Round; g.DrawPath(outline, tp); }
                    using (SolidBrush fill = new SolidBrush(Color.FromArgb((r.Color >> 16) & 255, (r.Color >> 8) & 255, r.Color & 255))) g.FillPath(fill, tp);
                }
                BitmapData bd = bmp.LockBits(new Rectangle(0, 0, area.Width, area.Height), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
                int[] src = new int[area.Width * area.Height];
                Marshal.Copy(bd.Scan0, src, 0, src.Length);
                bmp.UnlockBits(bd);
                for (int y = 0; y < area.Height; y++)
                {
                    for (int x = 0; x < area.Width; x++)
                    {
                        int s = src[y * area.Width + x];
                        int sa = (s >> 24) & 255;
                        if (sa == 0) continue;
                        int di = (area.Y + y - clip.Y) * clip.Width + (area.X + x - clip.X);
                        int d = px[di];
                        // source over destination; destination is premultiplied
                        int sr = ((s >> 16) & 255) * sa / 255, sg = ((s >> 8) & 255) * sa / 255, sb = (s & 255) * sa / 255;
                        int inv = 255 - sa;
                        int da = (d >> 24) & 255, dr = (d >> 16) & 255, dg = (d >> 8) & 255, db = d & 255;
                        px[di] = ((sa + da * inv / 255) << 24) | ((sr + dr * inv / 255) << 16) | ((sg + dg * inv / 255) << 8) | (sb + db * inv / 255);
                    }
                }
            }
        }

        // ------------------------------------------------------------ windows
        public static void RequestRender()
        {
            if (Headless || ui == null) return;
            if (Interlocked.Exchange(ref renderQueued, 1) == 1) return;
            try { ui.BeginInvoke((MethodInvoker)DrawAll); } catch { renderQueued = 0; }
        }

        static void DrawAll()
        {
            Interlocked.Exchange(ref renderQueued, 0);
            try
            {
                if (!GameInFront()) { HideAllNow(); return; }
                List<Composite> comps = Compose();
                long now = Now();
                HashSet<string> keep = new HashSet<string>();
                foreach (Composite c in comps)
                {
                    keep.Add(c.Key);
                    LabelWindow w;
                    if (!windows.TryGetValue(c.Key, out w))
                    {
                        w = new LabelWindow();
                        IntPtr hh = w.Handle;
                        windows[c.Key] = w;
                        if (!w.Excluded && CaptureMode == 0 && !Headless)
                        {
                            // this label can't be hidden from the screen check after all: read the game window instead
                            ExcludedFromCapture = false;
                            CaptureMode = -1;
                            Log("a label window could not be hidden from capture (error " + w.LastError + ") - checking the game window directly instead");
                        }
                    }
                    w.LastUsed = now;
                    Rectangle shown = w.ShownRect;
                    if (w.Signature != c.Signature || shown.Size != c.Rect.Size) w.Push(c);
                    else if (shown.Location != c.Rect.Location) w.MoveTo(c.Rect.X, c.Rect.Y);
                    w.SetShown(true);
                }
                List<string> drop = new List<string>();
                foreach (KeyValuePair<string, LabelWindow> kv in windows)
                {
                    if (keep.Contains(kv.Key)) continue;
                    kv.Value.SetShown(false);
                    if (now - kv.Value.LastUsed > 15000) drop.Add(kv.Key);
                }
                foreach (string k in drop) { try { windows[k].Dispose(); } catch { } windows.Remove(k); }
            }
            catch (Exception e) { Log("draw error: " + e.Message); }
        }

        static void HideAll()
        {
            if (Headless || ui == null) return;
            try { ui.BeginInvoke((MethodInvoker)HideAllNow); } catch { }
        }

        static void HideAllNow()
        {
            if (Headless || ui == null) return;
            if (ui.InvokeRequired) { try { ui.Invoke((MethodInvoker)HideAllNow); } catch { } return; }
            foreach (LabelWindow w in windows.Values) w.SetShown(false);
        }
    }
}
