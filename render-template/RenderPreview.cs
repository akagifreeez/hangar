using UnityEngine;
using UnityEditor;
using System;
using System.IO;
using System.Linq;
using System.Collections.Generic;

// 任意の .unitypackage 展開物から、レンダラ(Skinned/Mesh)を持つprefabを
// レンダラ数の多い順に最大 MAX_PREFABS 個まで個別に選定し、それぞれを
// 本物のlilToンで多角度PNG(model{i}_*.png) + 軽量GLB(model{i}.glb)に焼く。
// index0 が代表(従来のhero相当)。マニフェスト previews.txt(index\t名前\tレンダラ数)も出す。
public static class RenderPreview
{
    const int MAX_PREFABS = 8;   // 1パッケージあたりの個別プレビュー上限(レンダ時間とビューア肥大の兼ね合い)

    public static void Run()
    {
        try { RunInner(); }
        catch (Exception e) { Debug.LogError("RenderPreview FAILED: " + e); EditorApplication.Exit(2); }
    }

    static void RunInner()
    {
        var args = Environment.GetCommandLineArgs();
        string outDir = GetArg(args, "--out") ?? "out";
        Directory.CreateDirectory(outDir);

        AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);

        // 候補prefab = インスタンス化してレンダラ(Skinned/Mesh)を1つ以上持つもの
        var cands = new List<(GameObject prefab, string name, int count)>();
        foreach (var g in AssetDatabase.FindAssets("t:Prefab", new[] { "Assets" }))
        {
            var path = AssetDatabase.GUIDToAssetPath(g);
            var prefab = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            if (prefab == null) continue;
            GameObject inst = null;
            try
            {
                inst = (GameObject)UnityEngine.Object.Instantiate(prefab);
                int c = inst.GetComponentsInChildren<Renderer>(true).Count(r => r is SkinnedMeshRenderer || r is MeshRenderer);
                if (c > 0) cands.Add((prefab, prefab.name, c));
            }
            catch { }
            finally { if (inst != null) UnityEngine.Object.DestroyImmediate(inst); }
        }

        // prefabが無ければ、FBX(モデル)を代表に1個だけ(従来挙動)
        if (cands.Count == 0)
        {
            var models = AssetDatabase.FindAssets("t:Model", new[] { "Assets" });
            if (models.Length > 0)
            {
                var m = AssetDatabase.LoadAssetAtPath<GameObject>(AssetDatabase.GUIDToAssetPath(models[0]));
                if (m != null) cands.Add((m, m.name, 0));
            }
        }
        if (cands.Count == 0) { Debug.LogWarning("RenderPreview: no prefab/model"); EditorApplication.Exit(3); return; }

        // レンダラ数の多い順 → 上限N個。index0 が代表(=従来のhero)。
        var chosen = cands.OrderByDescending(c => c.count).ThenBy(c => c.name).Take(MAX_PREFABS).ToList();

        RenderSettings.ambientMode = UnityEngine.Rendering.AmbientMode.Flat;
        RenderSettings.ambientLight = new Color(0.5f, 0.5f, 0.55f);

        var manifest = new List<string>();
        for (int i = 0; i < chosen.Count; i++)
        {
            var c = chosen[i];
            Debug.Log("RenderPreview: [" + i + "] " + c.name + " (renderers " + c.count + ")");
            RenderOne(c.prefab, outDir, "model" + i);
            // 名前のタブ/改行はマニフェスト区切りと衝突するので除去
            var safeName = (c.name ?? "").Replace("\t", " ").Replace("\n", " ").Replace("\r", " ");
            manifest.Add(i + "\t" + safeName + "\t" + c.count);
        }
        File.WriteAllText(Path.Combine(outDir, "previews.txt"), string.Join("\n", manifest));
        Debug.Log("RenderPreview: DONE " + chosen.Count + " prefab(s) -> " + outDir);
        EditorApplication.Exit(0);
    }

    static void RenderOne(GameObject prefab, string outDir, string baseName)
    {
        var go = (GameObject)UnityEngine.Object.Instantiate(prefab);
        go.transform.SetPositionAndRotation(Vector3.zero, Quaternion.identity);

        var rends = go.GetComponentsInChildren<Renderer>(true).Where(r => r is SkinnedMeshRenderer || r is MeshRenderer).ToArray();
        if (rends.Length == 0) { Debug.LogWarning("no renderers"); UnityEngine.Object.DestroyImmediate(go); return; }

        Bounds b = new Bounds(rends[0].bounds.center, Vector3.zero);
        bool init = false;
        foreach (var r in rends)
        {
            Bounds rb = r.bounds;
            if (rb.size == Vector3.zero && r is SkinnedMeshRenderer smr && smr.sharedMesh != null)
            {
                var lb = smr.sharedMesh.bounds;
                rb = new Bounds(smr.transform.TransformPoint(lb.center), Vector3.Scale(lb.size, smr.transform.lossyScale));
            }
            if (rb.size == Vector3.zero) continue;
            if (!init) { b = rb; init = true; } else b.Encapsulate(rb);
        }
        if (!init) { b = new Bounds(go.transform.position, Vector3.one); }

        var lgo = new GameObject("L");
        var light = lgo.AddComponent<Light>();
        light.type = LightType.Directional; light.intensity = 1.15f; light.color = Color.white;
        lgo.transform.rotation = Quaternion.Euler(30f, 155f, 0f);

        var cgo = new GameObject("Cam");
        var cam = cgo.AddComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = new Color(0.16f, 0.16f, 0.18f, 1f);
        cam.fieldOfView = 28f; cam.nearClipPlane = 0.01f; cam.farClipPlane = 5000f;

        const int RES = 1024;
        var rt = new RenderTexture(RES, RES, 24, RenderTextureFormat.ARGB32) { antiAliasing = 4 };
        cam.targetTexture = rt;

        float radius = Mathf.Max(b.extents.magnitude, 0.05f);
        float dist = radius / Mathf.Sin(Mathf.Deg2Rad * cam.fieldOfView * 0.5f) * 1.08f;
        float[] yaws = { 0f, 35f, 90f, 180f };
        string[] tags = { "front", "34", "side", "back" };
        for (int i = 0; i < yaws.Length; i++)
        {
            float y = yaws[i] * Mathf.Deg2Rad;
            Vector3 dir = new Vector3(Mathf.Sin(y), 0f, Mathf.Cos(y));
            cgo.transform.position = b.center + dir * dist + Vector3.up * (radius * 0.04f);
            cgo.transform.LookAt(b.center);
            cam.Render();
            var prev = RenderTexture.active; RenderTexture.active = rt;
            var tex = new Texture2D(RES, RES, TextureFormat.RGBA32, false);
            tex.ReadPixels(new Rect(0, 0, RES, RES), 0, 0); tex.Apply();
            RenderTexture.active = prev;
            File.WriteAllBytes(Path.Combine(outDir, baseName + "_" + tags[i] + ".png"), tex.EncodeToPNG());
            UnityEngine.Object.DestroyImmediate(tex);
        }
        cam.targetTexture = null; rt.Release();

        try { GlbExport.Export(go, Path.Combine(outDir, baseName + ".glb"), 1024); Debug.Log("glb exported"); }
        catch (Exception e) { Debug.LogError("glb export fail: " + e); }

        UnityEngine.Object.DestroyImmediate(go);
        UnityEngine.Object.DestroyImmediate(lgo);
        UnityEngine.Object.DestroyImmediate(cgo);
    }

    static string GetArg(string[] a, string k)
    {
        for (int i = 0; i < a.Length - 1; i++) if (a[i] == k) return a[i + 1];
        return null;
    }
}
