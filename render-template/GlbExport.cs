using UnityEngine;
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

// 外部パッケージ非依存の最小GLB(glTF2.0 binary)エクスポータ。
// SkinnedMesh/MeshRenderer をベイクしてワールド座標で書き出し、_MainTex を baseColorTexture に。
// KHR_materials_unlit + doubleSided + alphaMask で、ライト無しのブラウザ表示でも見栄えするようにする。
// 静止プレビュー用途(スキニング/アニメは持たない)。
public static class GlbExport
{
    static List<object> bufferViews;
    static List<object> accessors;
    static List<object> meshesPrims;
    static List<object> materialsJ;
    static List<object> texturesJ;
    static List<object> imagesJ;
    static List<byte>   bin;
    static Dictionary<Material,int> matMap;
    static Dictionary<Texture2D,int> imgMap;
    static int maxTex;

    public static void Export(GameObject root, string path, int maxTexSize = 1024)
    {
        bufferViews = new List<object>();
        accessors   = new List<object>();
        meshesPrims = new List<object>();
        materialsJ  = new List<object>();
        texturesJ   = new List<object>();
        imagesJ     = new List<object>();
        bin         = new List<byte>();
        matMap      = new Dictionary<Material,int>();
        imgMap      = new Dictionary<Texture2D,int>();
        maxTex      = maxTexSize;

        var renderers = root.GetComponentsInChildren<Renderer>(true);
        foreach (var r in renderers)
        {
            try { AddRenderer(r); }
            catch (Exception e) { Debug.LogWarning("glb skip renderer " + r.name + ": " + e.Message); }
        }
        if (meshesPrims.Count == 0) { Debug.LogWarning("glb: no primitives"); return; }

        WriteGlb(path);
    }

    static void AddRenderer(Renderer r)
    {
        Mesh mesh; Matrix4x4 m;
        if (r is SkinnedMeshRenderer smr)
        {
            if (smr.sharedMesh == null) return;
            mesh = new Mesh(); smr.BakeMesh(mesh, false);      // useScale=false → 後でlocalToWorldでスケール込み変換
            m = smr.transform.localToWorldMatrix;
        }
        else if (r is MeshRenderer)
        {
            var mf = r.GetComponent<MeshFilter>();
            if (mf == null || mf.sharedMesh == null) return;
            mesh = mf.sharedMesh; m = r.transform.localToWorldMatrix;
        }
        else return;

        var verts = mesh.vertices; var norms = mesh.normals; var uvs = mesh.uv;
        int n = verts.Length;
        bool hasN = norms != null && norms.Length == n;
        bool hasUV = uvs != null && uvs.Length == n;

        var pos = new byte[n * 12]; var nrm = new byte[n * 12]; var uv = new byte[n * 8];
        Vector3 mn = new Vector3(float.MaxValue, float.MaxValue, float.MaxValue);
        Vector3 mx = new Vector3(float.MinValue, float.MinValue, float.MinValue);
        for (int i = 0; i < n; i++)
        {
            Vector3 w = m.MultiplyPoint3x4(verts[i]); w.z = -w.z;   // Unity(左手) → glTF(右手): Z反転
            PutF(pos, i * 12, w.x); PutF(pos, i * 12 + 4, w.y); PutF(pos, i * 12 + 8, w.z);
            mn = Vector3.Min(mn, w); mx = Vector3.Max(mx, w);
            Vector3 nv = hasN ? m.MultiplyVector(norms[i]).normalized : Vector3.up; nv.z = -nv.z;
            PutF(nrm, i * 12, nv.x); PutF(nrm, i * 12 + 4, nv.y); PutF(nrm, i * 12 + 8, nv.z);
            Vector2 t = hasUV ? uvs[i] : Vector2.zero;
            PutF(uv, i * 8, t.x); PutF(uv, i * 8 + 4, 1f - t.y);   // V反転
        }
        int accP = AddAccessor(AddView(pos, 34962), 5126, n, "VEC3",
                               new float[]{mn.x,mn.y,mn.z}, new float[]{mx.x,mx.y,mx.z});
        int accN = AddAccessor(AddView(nrm, 34962), 5126, n, "VEC3");
        int accU = AddAccessor(AddView(uv, 34962), 5126, n, "VEC2");

        var mats = r.sharedMaterials;
        for (int s = 0; s < mesh.subMeshCount; s++)
        {
            int[] tri = mesh.GetTriangles(s);
            var ib = new byte[tri.Length * 4];
            for (int t = 0; t < tri.Length; t += 3)   // Z反転に合わせ巻き順を反転
            { PutU(ib, t * 4, (uint)tri[t]); PutU(ib, (t + 1) * 4, (uint)tri[t + 2]); PutU(ib, (t + 2) * 4, (uint)tri[t + 1]); }
            int accI = AddAccessor(AddView(ib, 34963), 5125, tri.Length, "SCALAR");
            Material mat = (mats != null && s < mats.Length) ? mats[s] : null;
            int matIdx = mat != null ? MatIndex(mat) : -1;

            var prim = new Dictionary<string, object> {
                {"attributes", new Dictionary<string,object>{{"POSITION",accP},{"NORMAL",accN},{"TEXCOORD_0",accU}}},
                {"indices", accI}, {"mode", 4}
            };
            if (matIdx >= 0) prim["material"] = matIdx;
            meshesPrims.Add(prim);
        }
    }

    static int MatIndex(Material mat)
    {
        if (matMap.TryGetValue(mat, out var mi)) return mi;
        Color col = Color.white;
        if (mat.HasProperty("_Color")) col = mat.GetColor("_Color");
        else if (mat.HasProperty("_BaseColor")) col = mat.GetColor("_BaseColor");
        Texture tex = null;
        if (mat.HasProperty("_MainTex")) tex = mat.GetTexture("_MainTex");
        if (tex == null && mat.HasProperty("_BaseMap")) tex = mat.GetTexture("_BaseMap");

        var pbr = new Dictionary<string, object> {
            {"baseColorFactor", new float[]{col.r, col.g, col.b, col.a}},
            {"metallicFactor", 0f}, {"roughnessFactor", 1f}
        };
        if (tex is Texture2D t2d)
            pbr["baseColorTexture"] = new Dictionary<string, object> { {"index", TexIndex(t2d)} };

        var d = new Dictionary<string, object> {
            {"name", mat.name}, {"pbrMetallicRoughness", pbr}, {"doubleSided", true},
            {"alphaMode", "MASK"}, {"alphaCutoff", 0.5f},
            {"extensions", new Dictionary<string,object>{ {"KHR_materials_unlit", new Dictionary<string,object>()} }}
        };
        materialsJ.Add(d); int idx = materialsJ.Count - 1; matMap[mat] = idx; return idx;
    }

    static int TexIndex(Texture2D t)
    {
        int img;
        if (!imgMap.TryGetValue(t, out img))
        {
            byte[] png = EncodeTex(t);
            int bv = AddView(png, null);
            imagesJ.Add(new Dictionary<string, object> { {"bufferView", bv}, {"mimeType", "image/png"}, {"name", t.name} });
            img = imagesJ.Count - 1; imgMap[t] = img;
        }
        texturesJ.Add(new Dictionary<string, object> { {"source", img}, {"sampler", 0} });
        return texturesJ.Count - 1;
    }

    static byte[] EncodeTex(Texture tex)
    {
        int w = tex.width, h = tex.height;
        float s = Mathf.Min(1f, (float)maxTex / Mathf.Max(w, h));
        int tw = Mathf.Max(1, Mathf.RoundToInt(w * s)), th = Mathf.Max(1, Mathf.RoundToInt(h * s));
        var rt = RenderTexture.GetTemporary(tw, th, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        var prev = RenderTexture.active;
        Graphics.Blit(tex, rt);
        RenderTexture.active = rt;
        var t2 = new Texture2D(tw, th, TextureFormat.RGBA32, false);
        t2.ReadPixels(new Rect(0, 0, tw, th), 0, 0); t2.Apply();
        RenderTexture.active = prev; RenderTexture.ReleaseTemporary(rt);
        byte[] png = t2.EncodeToPNG();
        UnityEngine.Object.DestroyImmediate(t2);
        return png;
    }

    // ---- glTF buffer helpers ----
    static int AddView(byte[] data, int? target)
    {
        while (bin.Count % 4 != 0) bin.Add(0);
        int off = bin.Count;
        bin.AddRange(data);
        var bv = new Dictionary<string, object> { {"buffer", 0}, {"byteOffset", off}, {"byteLength", data.Length} };
        if (target.HasValue) bv["target"] = target.Value;
        bufferViews.Add(bv); return bufferViews.Count - 1;
    }

    static int AddAccessor(int view, int compType, int count, string type, float[] min = null, float[] max = null)
    {
        var a = new Dictionary<string, object> { {"bufferView", view}, {"componentType", compType}, {"count", count}, {"type", type} };
        if (min != null) a["min"] = min;
        if (max != null) a["max"] = max;
        accessors.Add(a); return accessors.Count - 1;
    }

    static void PutF(byte[] b, int o, float v) { var t = BitConverter.GetBytes(v); b[o]=t[0]; b[o+1]=t[1]; b[o+2]=t[2]; b[o+3]=t[3]; }
    static void PutU(byte[] b, int o, uint v)  { var t = BitConverter.GetBytes(v); b[o]=t[0]; b[o+1]=t[1]; b[o+2]=t[2]; b[o+3]=t[3]; }

    static void WriteGlb(string path)
    {
        var gltf = new Dictionary<string, object> {
            {"asset", new Dictionary<string,object>{ {"version","2.0"}, {"generator","HangarGlbExport"} }},
            {"extensionsUsed", new List<object>{ "KHR_materials_unlit" }},
            {"scene", 0},
            {"scenes", new List<object>{ new Dictionary<string,object>{ {"nodes", new int[]{0}} } }},
            {"nodes",  new List<object>{ new Dictionary<string,object>{ {"mesh", 0} } }},
            {"meshes", new List<object>{ new Dictionary<string,object>{ {"primitives", meshesPrims} } }},
            {"accessors", accessors},
            {"bufferViews", bufferViews},
            {"buffers", new List<object>{ new Dictionary<string,object>{ {"byteLength", bin.Count} } }},
            {"samplers", new List<object>{ new Dictionary<string,object>{ {"magFilter",9729},{"minFilter",9987},{"wrapS",10497},{"wrapT",10497} } }},
        };
        if (materialsJ.Count > 0) gltf["materials"] = materialsJ;
        if (texturesJ.Count  > 0) gltf["textures"]  = texturesJ;
        if (imagesJ.Count    > 0) gltf["images"]    = imagesJ;

        var sb = new StringBuilder(); Json(sb, gltf);
        byte[] json = Encoding.UTF8.GetBytes(sb.ToString());
        int jsonPad = (4 - (json.Length % 4)) % 4;
        int binPad  = (4 - (bin.Count % 4)) % 4;
        int total = 12 + 8 + json.Length + jsonPad + 8 + bin.Count + binPad;

        using (var fs = new FileStream(path, FileMode.Create))
        using (var bw = new BinaryWriter(fs))
        {
            bw.Write(0x46546C67); bw.Write(2); bw.Write(total);          // header: 'glTF', ver2, length
            bw.Write(json.Length + jsonPad); bw.Write(0x4E4F534A);       // JSON chunk
            bw.Write(json); for (int i = 0; i < jsonPad; i++) bw.Write((byte)0x20);
            bw.Write(bin.Count + binPad); bw.Write(0x004E4942);          // BIN chunk
            bw.Write(bin.ToArray()); for (int i = 0; i < binPad; i++) bw.Write((byte)0x00);
        }
        Debug.Log($"glb: prims={meshesPrims.Count} mats={materialsJ.Count} imgs={imagesJ.Count} bytes={total}");
    }

    static void Json(StringBuilder sb, object o)
    {
        switch (o)
        {
            case null: sb.Append("null"); break;
            case string s:
                sb.Append('"');
                foreach (char c in s) { if (c == '"' || c == '\\') sb.Append('\\'); sb.Append(c); }
                sb.Append('"'); break;
            case bool b: sb.Append(b ? "true" : "false"); break;
            case int i: sb.Append(i.ToString(CultureInfo.InvariantCulture)); break;
            case float f: sb.Append(f.ToString("R", CultureInfo.InvariantCulture)); break;
            case int[] ia:
                sb.Append('['); for (int k = 0; k < ia.Length; k++) { if (k > 0) sb.Append(','); sb.Append(ia[k].ToString(CultureInfo.InvariantCulture)); } sb.Append(']'); break;
            case float[] fa:
                sb.Append('['); for (int k = 0; k < fa.Length; k++) { if (k > 0) sb.Append(','); sb.Append(fa[k].ToString("R", CultureInfo.InvariantCulture)); } sb.Append(']'); break;
            case Dictionary<string, object> d:
                sb.Append('{'); bool first = true;
                foreach (var kv in d) { if (kv.Value == null) continue; if (!first) sb.Append(','); first = false; Json(sb, kv.Key); sb.Append(':'); Json(sb, kv.Value); }
                sb.Append('}'); break;
            case List<object> l:
                sb.Append('['); for (int k = 0; k < l.Count; k++) { if (k > 0) sb.Append(','); Json(sb, l[k]); } sb.Append(']'); break;
            default: throw new Exception("json: unsupported " + o.GetType());
        }
    }
}
