// SS13 Translator - reads text the game draws on the map in its own pixel fonts.
//
// BYOND draws speech bubbles and the hover name with known pixel fonts (Grand9K Pixel 8 px and
// Pixellari 16 px, the exact files from the server), with a 1-pixel black outline, then scales the whole
// map up. So the text can be read back exactly, letter by letter, without any Windows text recognition:
//   1. find the game-pixel grid of the line (where the scaled pixels start and how big they are),
//   2. sample one value per game pixel - back to the original tiny picture,
//   3. compare it with every letter of the font (exact pixel patterns) from left to right.
// Letters that look identical in Latin and Cyrillic (А/A, о/o ...) are read as Cyrillic.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Text;

namespace SS13Overlay
{
    public class ReadResult
    {
        public string Text = "";
        public double Score;       // share of the line's pixels explained by the letters read (0..1)
        public float Zoom;
        public double OriginX, OriginY; // screen position of game pixel (0,0) of the sampled grid
        public int InkLeft, InkRight;   // game-pixel columns of the first/last letter ink
        public int Baseline;            // game-pixel row of the baseline in the sampled grid
    }

    public class GlyphCols
    {
        public char Ch; public int W, A, X, Y, H; public uint[] Cols; public int Ink; public bool Cyr;
        public bool Weak; // thin marks (I l ! ' . , | ...) that any pattern of stray pixels can look like
    }

    public static class PixelReader
    {
        public static Action<string> Debug;
        static Dictionary<PixelFont, List<GlyphCols>> cache = new Dictionary<PixelFont, List<GlyphCols>>();

        static List<GlyphCols> Prepare(PixelFont f)
        {
            lock (cache)
            {
                List<GlyphCols> list;
                if (cache.TryGetValue(f, out list)) return list;
                list = new List<GlyphCols>();
                foreach (KeyValuePair<int, PixelFont.Glyph> kv in f.Glyphs)
                {
                    PixelFont.Glyph g = kv.Value;
                    int cp = kv.Key;
                    if (g.Bits == null || g.H > 30 || cp < 33) continue;
                    if (cp > 0x7E && cp < 0x400 && "«»—–…№".IndexOf((char)cp) < 0 && "ёЁ".IndexOf((char)cp) < 0) continue;
                    if (cp > 0x45F && "«»—–…№“”„’".IndexOf((char)cp) < 0) continue;
                    GlyphCols gc = new GlyphCols();
                    gc.Ch = (char)cp; gc.W = g.W; gc.A = g.A; gc.X = g.X; gc.Y = g.Y; gc.H = g.H;
                    gc.Cols = new uint[g.W];
                    for (int x = 0; x < g.W; x++)
                        for (int y = 0; y < g.H; y++)
                            if (g.Bits[y * g.W + x]) { gc.Cols[x] |= 1u << y; gc.Ink++; }
                    gc.Cyr = cp >= 0x400 && cp <= 0x4FF;
                    gc.Weak = "Il1!|'`.,:;-_\u2014\u2013\"\u201e\u201c\u201d\u2019\u2026i()[]{}/\\".IndexOf((char)cp) >= 0;
                    list.Add(gc);
                }
                // wider and inkier letters first: when two match equally, the bigger explanation wins;
                // Cyrillic before Latin look-alikes
                list.Sort(delegate (GlyphCols a, GlyphCols b)
                {
                    if (a.Cyr != b.Cyr) return a.Cyr ? -1 : 1;
                    return b.Ink.CompareTo(a.Ink);
                });
                cache[f] = list;
                return list;
            }
        }

        /// <summary>Is this pixel the text colour (rather than the outline or the background)?</summary>
        static bool IsFill(int c, int r, int g, int b)
        {
            int pr = (c >> 16) & 255, pg = (c >> 8) & 255, pb = c & 255;
            int dr = pr - r, dg = pg - g, db = pb - b;
            int d2 = dr * dr + dg * dg + db * db;
            int k2 = pr * pr + pg * pg + pb * pb; // distance to black
            return d2 <= 75 * 75 && d2 * 3 < k2 * 2;
        }

        /// <summary>
        /// Balloon alerts ("не является пищей!") are white with only a faint see-through outline, so a
        /// letter pixel is told from the background by its colour alone: close to the text colour.
        /// </summary>
        static bool IsFillTight(int c, int r, int g, int b)
        {
            int pr = (c >> 16) & 255, pg = (c >> 8) & 255, pb = c & 255;
            int dr = pr - r, dg = pg - g, db = pb - b;
            return dr * dr + dg * dg + db * db <= 34 * 34;
        }

        /// <summary>
        /// The whole width of a balloon alert: the line finder often catches only the part of it that lies
        /// over a dark floor (the outline is faint). Text-coloured columns are followed left and right from the
        /// part found, across gaps up to a word space, at most 200 game pixels (the balloon's width).
        /// </summary>
        public static Rectangle WhiteExtent(int[] px, int pw, int ph, Rectangle box, int r, int g, int b, float zoom)
        {
            float z = Math.Max(zoom, 1f);
            int y0 = Math.Max(0, box.Y - (int)Math.Ceiling(z)), y1 = Math.Min(ph - 1, box.Y + box.Height + (int)Math.Ceiling(z));
            int maxGap = (int)Math.Ceiling(4.5 * z), maxW = (int)Math.Ceiling(200 * z);
            Func<int, bool> colHas = delegate (int x)
            {
                if (x < 0 || x >= pw) return false;
                for (int y = y0; y <= y1; y++) if (IsFillTight(px[y * pw + x], r, g, b)) return true;
                return false;
            };
            int left = box.X, right = box.X + box.Width - 1, gap = 0;
            for (int x = box.X - 1; x >= 0 && right - x < maxW; x--)
            {
                if (colHas(x)) { left = x; gap = 0; } else if (++gap > maxGap) break;
            }
            gap = 0;
            for (int x = box.X + box.Width; x < pw && x - left < maxW; x++)
            {
                if (colHas(x)) { right = x; gap = 0; } else if (++gap > maxGap) break;
            }
            return new Rectangle(left, box.Y, right - left + 1, box.Height);
        }

        /// <summary>The black of the letters' outline.</summary>
        static bool IsDark(int c)
        {
            return ((c >> 16) & 255) < 32 && ((c >> 8) & 255) < 32 && (c & 255) < 32;
        }

        /// <summary>Grid offset (0..z) that puts game-pixel edges where the picture changes most.</summary>
        static double FitPhase(int[] trans, int n, double z)
        {
            double best = 0, bestScore = -1;
            for (double ph = 0; ph < z; ph += 0.1)
            {
                double s = 0;
                for (double e = ph; e < n; e += z)
                {
                    int i = (int)Math.Round(e);
                    if (i > 0 && i < n) s += trans[i];
                }
                if (s > bestScore) { bestScore = s; best = ph; }
            }
            return best;
        }

        /// <summary>Least-squares fit of the grid (offset + zoom) to the edges actually seen.</summary>
        static void Refine(int[] trans, int n, ref double z, ref double phase)
        {
            for (int it = 0; it < 3; it++)
            {
                double sw = 0, sk = 0, st = 0, skk = 0, skt = 0;
                for (int t = 1; t < n; t++)
                {
                    if (trans[t] == 0) continue;
                    double k = Math.Round((t - phase) / z);
                    double pred = phase + k * z;
                    if (Math.Abs(t - pred) > 0.75) continue;
                    double w = trans[t];
                    sw += w; sk += w * k; st += w * t; skk += w * k * k; skt += w * k * t;
                }
                double den = sw * skk - sk * sk;
                if (sw < 4 || Math.Abs(den) < 1e-9) return;
                double nz = (sw * skt - sk * st) / den;
                double np = (st - nz * sk) / sw;
                if (Math.Abs(nz / z - 1) > 0.03) return;
                z = nz; phase = np;
                while (phase < 0) phase += z;
                while (phase >= z) phase -= z;
            }
        }

        /// <summary>How well a zoom explains the edges in the picture (for finding the zoom).</summary>
        static double GridScore(int[] trans, int n, double z, out double phase)
        {
            phase = FitPhase(trans, n, z);
            double hit = 0, all = 0;
            for (int i = 1; i < n; i++) all += trans[i];
            for (double e = phase; e < n; e += z)
            {
                int i = (int)Math.Round(e);
                if (i > 0 && i < n) hit += trans[i];
            }
            // edges between grid lines are what a wrong zoom produces; a too-small zoom is punished by
            // its many empty grid lines through the cost per line
            return all > 0 ? (hit / all) - 0.02 * (n / z) / Math.Max(1, n / 3.0) : 0;
        }

        /// <summary>
        /// Reads one line of text inside `box` (picture coordinates) drawn in colour (r,g,b).
        /// zoom: map zoom if known (0 = find it).
        /// </summary>
        public static ReadResult ReadLine(int[] px, int pw, int ph, Rectangle box, int r, int g, int b, float zoom, PixelFont font)
        {
            return ReadLine(px, pw, ph, box, r, g, b, zoom, font, 1);
        }

        /// <summary>sweep: how many zoom steps (0.2% each) to try either side of `zoom`.</summary>
        public static ReadResult ReadLine(int[] px, int pw, int ph, Rectangle box, int r, int g, int b, float zoom, PixelFont font, int sweep)
        {
            return ReadLine(px, pw, ph, box, r, g, b, zoom, font, sweep, false);
        }

        /// <summary>balloon: white text without a black outline (balloon alerts) - only the colour decides.</summary>
        public static ReadResult ReadLine(int[] px, int pw, int ph, Rectangle box, int r, int g, int b, float zoom, PixelFont font, int sweep, bool balloon)
        {
            ReadResult res = new ReadResult();
            if (font == null) return res;
            int pad = (int)Math.Ceiling(Math.Max(zoom, 2) * 2) + 2;
            // a little more room above: the breve of "й" / dots of "ё" sit apart from the letter, so the line
            // found on the map may start below them (then "й" was read as "и")
            int padTop = (int)Math.Ceiling(Math.Max(zoom, 2) * 4) + 2;
            Rectangle R = Rectangle.Intersect(new Rectangle(box.X - pad, box.Y - padTop, box.Width + 2 * pad, box.Height + pad + padTop), new Rectangle(0, 0, pw, ph));
            if (R.Width < 4 || R.Height < 4) return res;
            int W = R.Width, H = R.Height;
            bool[] m = new bool[W * H];
            for (int y = 0; y < H; y++)
                for (int x = 0; x < W; x++)
                    m[y * W + x] = balloon ? IsFillTight(px[(R.Y + y) * pw + R.X + x], r, g, b) : IsFill(px[(R.Y + y) * pw + R.X + x], r, g, b);
            // Letters always have their black outline right next to them; floor, carpet or a sign of a
            // similar colour does not. Text-coloured pixels far from any black are background.
            if (!balloon)
            {
                int reach = (int)Math.Ceiling(2 * Math.Max(zoom > 0 ? zoom : 3f, 1f)) + 1;
                int[] dh = new int[W * H];
                for (int y = 0; y < H; y++)
                {
                    int d = 1000;
                    for (int x = 0; x < W; x++) { d = IsDark(px[(R.Y + y) * pw + R.X + x]) ? 0 : d + 1; dh[y * W + x] = d; }
                    d = 1000;
                    for (int x = W - 1; x >= 0; x--) { d = IsDark(px[(R.Y + y) * pw + R.X + x]) ? 0 : d + 1; if (d < dh[y * W + x]) dh[y * W + x] = d; }
                }
                int[] dv = new int[H];
                for (int x = 0; x < W; x++)
                {
                    int d = 1000;
                    for (int y = 0; y < H; y++) { d = IsDark(px[(R.Y + y) * pw + R.X + x]) ? 0 : d + 1; dv[y] = d; }
                    d = 1000;
                    for (int y = H - 1; y >= 0; y--)
                    {
                        d = IsDark(px[(R.Y + y) * pw + R.X + x]) ? 0 : d + 1;
                        int i = y * W + x;
                        if (m[i] && dh[i] > reach && Math.Min(d, dv[y]) > reach) m[i] = false;
                    }
                }
            }
            int[] tx = new int[W], ty = new int[H];
            for (int y = 0; y < H; y++)
                for (int x = 1; x < W; x++) if (m[y * W + x] != m[y * W + x - 1]) tx[x]++;
            for (int y = 1; y < H; y++)
                for (int x = 0; x < W; x++) if (m[y * W + x] != m[(y - 1) * W + x]) ty[y]++;

            // zoom candidates
            List<double> zs = new List<double>();
            if (zoom > 0) { zs.Add(zoom); for (int k = 1; k <= sweep; k++) { zs.Add(zoom * (1 - 0.002 * k)); zs.Add(zoom * (1 + 0.002 * k)); } } // the fit below adjusts each to this line
            else
            {
                double bestZ = 0, bestS = -1, phx;
                for (double z = 1.0; z <= 6.0; z += 0.01)
                {
                    double s = GridScore(tx, W, z, out phx) + GridScore(ty, H, z, out phx);
                    if (s > bestS) { bestS = s; bestZ = z; }
                }
                for (double z = bestZ - 0.012; z <= bestZ + 0.012; z += 0.002) zs.Add(z);
                zs.Add(bestZ * 2); zs.Add(bestZ / 2);
            }
            ReadResult best = res;
            foreach (double z0 in zs)
            {
                if (z0 < 0.9) continue;
                double z = z0;
                double phx = FitPhase(tx, W, z), phy = FitPhase(ty, H, z);
                // the edges of the scaled pixels pin the exact zoom of this line down
                Refine(tx, W, ref z, ref phx);
                phy = FitPhase(ty, H, z);
                ReadResult rr = Decode(m, W, H, z, phx, phy, font);
                if (rr.Score > best.Score || (rr.Score == best.Score && rr.Text.Length > best.Text.Length))
                {
                    rr.OriginX = R.X + phx; rr.OriginY = R.Y + phy; rr.Zoom = (float)z;
                    best = rr;
                }
            }
            return best;
        }

        static ReadResult Decode(bool[] m, int W, int H, double z, double phx, double phy, PixelFont font)
        {
            ReadResult res = new ReadResult();
            int nw = (int)Math.Floor((W - phx) / z), nh = (int)Math.Floor((H - phy) / z);
            if (nw < 2 || nh < 3 || nh > 31) return res;
            // one value per game pixel: the middle of its scaled block
            uint[] cols = new uint[nw];
            int ink = 0;
            for (int i = 0; i < nw; i++)
            {
                int x0 = (int)Math.Ceiling(phx + i * z), x1 = (int)Math.Floor(phx + (i + 1) * z - 0.001);
                for (int j = 0; j < nh; j++)
                {
                    int y0 = (int)Math.Ceiling(phy + j * z), y1 = (int)Math.Floor(phy + (j + 1) * z - 0.001);
                    int on = 0, all = 0;
                    // inner part of the block (edges can be blended)
                    int xa = x0 + (x1 - x0 >= 2 ? 1 : 0), xb = x1 - (x1 - x0 >= 2 ? 1 : 0);
                    int ya = y0 + (y1 - y0 >= 2 ? 1 : 0), yb = y1 - (y1 - y0 >= 2 ? 1 : 0);
                    for (int y = ya; y <= yb; y++) for (int x = xa; x <= xb; x++) { all++; if (m[y * W + x]) on++; }
                    if (all > 0 && on * 2 > all) { cols[i] |= 1u << j; ink++; }
                }
            }
            if (ink < 4) return res;
            if (Debug != null)
            {
                StringBuilder d = new StringBuilder("z=" + z.ToString("0.0000") + " ph=" + phx.ToString("0.00") + "," + phy.ToString("0.00") + "\n");
                for (int j = 0; j < nh; j++) { for (int i = 0; i < nw; i++) d.Append((cols[i] >> j & 1) != 0 ? '#' : '.'); d.Append('\n'); }
                Debug(d.ToString());
            }
            List<GlyphCols> glyphs = Prepare(font);
            // space: blank columns wider than the usual gap between letters
            PixelFont.Glyph sp = font.Get(' ');
            int spaceGap = Math.Max(2, sp.A);

            ReadResult best = res;
            int maxTop = 0, maxDesc = 0;
            foreach (GlyphCols gc in glyphs) { maxTop = Math.Max(maxTop, gc.Y); maxDesc = Math.Max(maxDesc, gc.H - gc.Y); }
            for (int baseline = 3; baseline <= nh + 3; baseline++)
            {
                ReadResult rr = DecodeRow(cols, nw, nh, baseline, glyphs, spaceGap, ink, maxTop, maxDesc);
                if (rr.Score > best.Score) best = rr;
            }
            return best;
        }

        // Dynamic programming over columns: cost[c] = cheapest way to explain columns [0, c).
        static ReadResult DecodeRow(uint[] cols, int nw, int nh, int baseline, List<GlyphCols> glyphs, int spaceGap, int ink, int maxTop, int maxDesc)
        {
            ReadResult res = new ReadResult();
            int[] cost = new int[nw + 1];
            int[] from = new int[nw + 1];
            GlyphCols[] how = new GlyphCols[nw + 1];
            for (int i = 1; i <= nw; i++) cost[i] = int.MaxValue / 2;
            cost[0] = 0;
            uint all = nh >= 32 ? 0xFFFFFFFFu : (1u << nh) - 1;
            for (int c = 0; c < nw; c++)
            {
                if (cost[c] >= int.MaxValue / 2) continue;
                // leave a column empty: costs its ink
                int skip = cost[c] + Pop(cols[c] & all) * 2;
                if (skip < cost[c + 1]) { cost[c + 1] = skip; from[c + 1] = c; how[c + 1] = null; }
                if (cols[c] == 0) continue; // letters start on ink
                foreach (GlyphCols gc in glyphs)
                {
                    if (c + gc.W > nw) continue;
                    int shift = baseline - gc.Y; // row of the glyph's top
                    if (shift < 0 || shift + gc.H > nh + 1) continue;
                    int miss = 0, noise = 0, limit = Math.Max(2, gc.Ink / 6);
                    // rows the letter covers must match; stray pixels above/below it (a neighbouring
                    // object poking into the line) only cost a little
                    uint band = (gc.H >= 32 ? 0xFFFFFFFFu : ((1u << gc.H) - 1)) << shift;
                    for (int k = 0; k < gc.W && miss <= limit; k++)
                    {
                        uint want = (gc.Cols[k] << shift) & all;
                        miss += Pop((cols[c + k] ^ want) & band & all);
                        noise += Pop(cols[c + k] & ~band & all);
                    }
                    if (miss > limit) continue;
                    int cc = cost[c] + miss * 3 + noise + 1 + (gc.Weak ? 1 : 0);
                    int e = c + gc.W;
                    if (cc < cost[e]) { cost[e] = cc; from[e] = c; how[e] = gc; }
                }
            }
            // rebuild the text
            int pos = nw, blank = 0, explained = 0, first = -1, last = -1;
            List<object> seq = new List<object>();
            while (pos > 0)
            {
                GlyphCols gc = how[pos];
                int f = from[pos];
                seq.Add(gc == null ? (object)pos : gc);
                pos = f;
            }
            seq.Reverse();
            StringBuilder sb = new StringBuilder();
            int col = 0;
            foreach (object o in seq)
            {
                GlyphCols gc = o as GlyphCols;
                if (gc == null) { blank++; col++; continue; }
                if (first >= 0 && blank >= spaceGap + 1) sb.Append(' ');
                if (first < 0) first = col;
                sb.Append(gc.Ch);
                explained += gc.Weak ? gc.Ink / 2 : gc.Ink;
                col += gc.W;
                last = col - 1;
                blank = 0;
            }
            res.Text = sb.ToString();
            // share of the ink in the text's own rows that the letters explain
            int top = Math.Max(0, baseline - maxTop), bottom = Math.Min(nh - 1, baseline + maxDesc);
            uint rows = 0;
            for (int j = top; j <= bottom; j++) rows |= 1u << j;
            int bandInk = 0;
            for (int i = 0; i < nw; i++) bandInk += Pop(cols[i] & rows);
            // (a band placed beside the text, where only a few specks are, must not "explain" everything:
            // the line's own ink is most of the picture)
            double denom = Math.Max(bandInk, 0.6 * ink);
            res.Score = denom > 0 ? Math.Min(1.0, explained / denom) : 0;
            if (res.Score > 1) res.Score = 1;
            res.InkLeft = first; res.InkRight = last; res.Baseline = baseline;
            return res;
        }

        static int CountGlyphs(List<object> seq) { int n = 0; foreach (object o in seq) if (o is GlyphCols) n++; return n; }

        static int Pop(uint v)
        {
            v = v - ((v >> 1) & 0x55555555u);
            v = (v & 0x33333333u) + ((v >> 2) & 0x33333333u);
            return (int)((((v + (v >> 4)) & 0x0F0F0F0Fu) * 0x01010101u) >> 24);
        }
    }
}
