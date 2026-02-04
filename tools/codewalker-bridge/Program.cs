using System.Text;
using System.Text.Json;
using CodeWalker.GameFiles;
using SharpDX;
using DxHalf = SharpDX.Half;

namespace CodeWalkerBridge;

public static class Program
{
    private const string Magic = "CLM1";
    private const ushort Version = 1;

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        var inputPath = GetArg(args, "--input");
        var outputPath = GetArg(args, "--output");
        if (string.IsNullOrWhiteSpace(inputPath) || string.IsNullOrWhiteSpace(outputPath))
        {
            Console.Error.WriteLine("Usage: CodeWalkerBridge --input <file.yft> --output <file.clmesh>");
            return 2;
        }

        try
        {
            LoadJenkIndexStrings();
            var data = File.ReadAllBytes(inputPath);
            var yft = new YftFile();
            yft.Load(data);

            var meshes = ExtractMeshes(yft, Path.GetFileNameWithoutExtension(inputPath));
            if (meshes.Count == 0)
            {
                Console.Error.WriteLine("No meshes were extracted from the YFT.");
                return 3;
            }

            WriteClmesh(outputPath, meshes);

            var meta = new
            {
                meshCount = meshes.Count,
                vertexCount = meshes.Sum(m => m.VertexCount),
                indexCount = meshes.Sum(m => m.IndexCount),
                materialCount = meshes.Select(m => m.MaterialName).Where(n => !string.IsNullOrEmpty(n)).Distinct().Count()
            };
            Console.WriteLine(JsonSerializer.Serialize(meta));
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    private static string? GetArg(string[] args, string name)
    {
        for (var i = 0; i < args.Length - 1; i += 1)
        {
            if (!string.Equals(args[i], name, StringComparison.OrdinalIgnoreCase)) continue;
            return args[i + 1];
        }
        return null;
    }

    private static void LoadJenkIndexStrings()
    {
        var baseDir = AppContext.BaseDirectory;
        var stringsPath = Path.Combine(baseDir, "strings.txt");
        if (!File.Exists(stringsPath)) return;
        foreach (var line in File.ReadAllLines(stringsPath))
        {
            var str = line?.Trim();
            if (string.IsNullOrEmpty(str)) continue;
            if (str.StartsWith("//")) continue;
            JenkIndex.Ensure(str);
        }
    }

    private static List<MeshData> ExtractMeshes(YftFile yft, string baseName)
    {
        var meshes = new List<MeshData>();
        var fragment = yft.Fragment;
        if (fragment == null) return meshes;

        var drawables = new List<DrawableBase>();
        if (fragment.Drawable != null) drawables.Add(fragment.Drawable);
        if (fragment.DrawableArray?.data_items != null)
        {
            foreach (var drawable in fragment.DrawableArray.data_items)
            {
                if (drawable != null) drawables.Add(drawable);
            }
        }

        var drawableIndex = 0;
        foreach (var drawable in drawables)
        {
            if (drawable.AllModels == null || drawable.AllModels.Length == 0)
            {
                drawable.BuildAllModels();
            }

            var models = drawable.AllModels ?? Array.Empty<DrawableModel>();
            for (var modelIndex = 0; modelIndex < models.Length; modelIndex += 1)
            {
                var model = models[modelIndex];
                if (model?.Geometries == null) continue;

                for (var geomIndex = 0; geomIndex < model.Geometries.Length; geomIndex += 1)
                {
                    var geom = model.Geometries[geomIndex];
                    if (geom == null) continue;

                    var mesh = ExtractMesh(geom, baseName, drawableIndex, modelIndex, geomIndex);
                    if (mesh != null)
                    {
                        meshes.Add(mesh);
                    }
                }
            }

            drawableIndex += 1;
        }

        return meshes;
    }

    private static MeshData? ExtractMesh(DrawableGeometry geom, string baseName, int drawableIndex, int modelIndex, int geomIndex)
    {
        var vertexData = geom.VertexData;
        var info = vertexData?.Info;
        if (vertexData == null || info == null) return null;

        var vertexCount = vertexData.VertexCount;
        if (vertexCount <= 0) return null;

        var hasPosition = HasComponent(info, VertexSemantics.Position);
        if (!hasPosition) return null;

        var positions = new float[vertexCount * 3];
        var normals = HasComponent(info, VertexSemantics.Normal) ? new float[vertexCount * 3] : null;
        var uvs = HasComponent(info, VertexSemantics.TexCoord0) ? new float[vertexCount * 2] : null;

        for (var v = 0; v < vertexCount; v += 1)
        {
            var pos = ReadVector3(vertexData, info, v, VertexSemantics.Position);
            var pIndex = v * 3;
            positions[pIndex] = pos.X;
            positions[pIndex + 1] = pos.Y;
            positions[pIndex + 2] = pos.Z;

            if (normals != null)
            {
                var normal = ReadNormal(vertexData, info, v, VertexSemantics.Normal);
                normals[pIndex] = normal.X;
                normals[pIndex + 1] = normal.Y;
                normals[pIndex + 2] = normal.Z;
            }

            if (uvs != null)
            {
                var uv = ReadVector2(vertexData, info, v, VertexSemantics.TexCoord0);
                var uvIndex = v * 2;
                uvs[uvIndex] = uv.X;
                uvs[uvIndex + 1] = uv.Y;
            }
        }

        var indices = BuildIndices(geom, vertexCount);
        if (indices == null || indices.Length == 0) return null;

        var materialName = GetMaterialName(geom);
        if (string.IsNullOrEmpty(materialName))
        {
            materialName = $"material_{geom.ShaderID}";
        }

        var meshName = $"{baseName}_d{drawableIndex}_m{modelIndex}_g{geomIndex}";
        return new MeshData(meshName, materialName, positions, normals, uvs, indices);
    }

    private static bool HasComponent(VertexDeclaration info, VertexSemantics semantic)
    {
        var index = (int)semantic;
        return ((info.Flags >> index) & 0x1) == 1;
    }

    private static Vector3 ReadVector3(VertexData data, VertexDeclaration info, int vertexIndex, VertexSemantics semantic)
    {
        var index = (int)semantic;
        var type = info.GetComponentType(index);
        return type switch
        {
            VertexComponentType.Float3 => data.GetVector3(vertexIndex, index),
            VertexComponentType.Float4 => ToVector3(data.GetVector4(vertexIndex, index)),
            VertexComponentType.Half4 => ToVector3(data.GetHalf4(vertexIndex, index)),
            VertexComponentType.Half2 => ToVector3(data.GetHalf2(vertexIndex, index)),
            VertexComponentType.RGBA8SNorm => ToVector3(data.GetRGBA8SNorm(vertexIndex, index)),
            _ => data.GetVector3(vertexIndex, index)
        };
    }

    private static Vector3 ReadNormal(VertexData data, VertexDeclaration info, int vertexIndex, VertexSemantics semantic)
    {
        var index = (int)semantic;
        var type = info.GetComponentType(index);
        return type switch
        {
            VertexComponentType.RGBA8SNorm => ToVector3(data.GetRGBA8SNorm(vertexIndex, index)),
            VertexComponentType.Float3 => data.GetVector3(vertexIndex, index),
            VertexComponentType.Float4 => ToVector3(data.GetVector4(vertexIndex, index)),
            VertexComponentType.Half4 => ToVector3(data.GetHalf4(vertexIndex, index)),
            _ => data.GetVector3(vertexIndex, index)
        };
    }

    private static Vector2 ReadVector2(VertexData data, VertexDeclaration info, int vertexIndex, VertexSemantics semantic)
    {
        var index = (int)semantic;
        var type = info.GetComponentType(index);
        return type switch
        {
            VertexComponentType.Float2 => data.GetVector2(vertexIndex, index),
            VertexComponentType.Float4 => ToVector2(data.GetVector4(vertexIndex, index)),
            VertexComponentType.Half2 => ToVector2(data.GetHalf2(vertexIndex, index)),
            VertexComponentType.Half4 => ToVector2(data.GetHalf4(vertexIndex, index)),
            _ => data.GetVector2(vertexIndex, index)
        };
    }

    private static uint[]? BuildIndices(DrawableGeometry geom, int vertexCount)
    {
        var raw = geom.IndexBuffer?.Indices;
        if (raw != null && raw.Length > 0)
        {
            var indices = new uint[raw.Length];
            for (var i = 0; i < raw.Length; i += 1)
            {
                indices[i] = raw[i];
            }
            return indices;
        }

        var triCount = vertexCount / 3;
        if (triCount <= 0) return null;
        var fallback = new uint[triCount * 3];
        for (var i = 0; i < triCount * 3; i += 1)
        {
            fallback[i] = (uint)i;
        }
        return fallback;
    }

    private static string GetMaterialName(DrawableGeometry geom)
    {
        if (geom.Shader == null) return string.Empty;
        var name = geom.Shader.Name.ToCleanString();
        if (!string.IsNullOrEmpty(name)) return name;
        var hex = geom.Shader.Name.Hex;
        return string.IsNullOrEmpty(hex) ? string.Empty : $"mat_{hex}";
    }

    private static Vector3 ToVector3(Vector4 value) => new(value.X, value.Y, value.Z);

    private static Vector3 ToVector3(Half4 value)
    {
        var f = DxHalf.ConvertToFloat(new[] { value.X, value.Y, value.Z, value.W });
        return new Vector3(f[0], f[1], f[2]);
    }

    private static Vector3 ToVector3(Half2 value)
    {
        var f = DxHalf.ConvertToFloat(new[] { value.X, value.Y });
        return new Vector3(f[0], f[1], 0f);
    }

    private static Vector2 ToVector2(Vector4 value) => new(value.X, value.Y);

    private static Vector2 ToVector2(Half4 value)
    {
        var f = DxHalf.ConvertToFloat(new[] { value.X, value.Y, value.Z, value.W });
        return new Vector2(f[0], f[1]);
    }

    private static Vector2 ToVector2(Half2 value)
    {
        var f = DxHalf.ConvertToFloat(new[] { value.X, value.Y });
        return new Vector2(f[0], f[1]);
    }

    private static void WriteClmesh(string outputPath, List<MeshData> meshes)
    {
        var directory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        using var stream = new FileStream(outputPath, FileMode.Create, FileAccess.Write, FileShare.None);
        using var writer = new BinaryWriter(stream, Encoding.UTF8, false);

        writer.Write(Encoding.ASCII.GetBytes(Magic));
        writer.Write(Version);
        writer.Write((ushort)meshes.Count);

        foreach (var mesh in meshes)
        {
            WriteString(writer, mesh.Name);
            WriteString(writer, mesh.MaterialName);
            writer.Write((uint)mesh.VertexCount);
            writer.Write((uint)mesh.IndexCount);

            byte flags = 0;
            if (mesh.Normals != null) flags |= 0x1;
            if (mesh.Uvs != null) flags |= 0x2;
            writer.Write(flags);

            WriteFloatArray(writer, mesh.Positions);
            if ((flags & 0x1) != 0 && mesh.Normals != null)
            {
                WriteFloatArray(writer, mesh.Normals);
            }
            if ((flags & 0x2) != 0 && mesh.Uvs != null)
            {
                WriteFloatArray(writer, mesh.Uvs);
            }
            WriteUIntArray(writer, mesh.Indices);
        }
    }

    private static void WriteString(BinaryWriter writer, string value)
    {
        var bytes = Encoding.UTF8.GetBytes(value ?? string.Empty);
        if (bytes.Length > ushort.MaxValue)
        {
            Array.Resize(ref bytes, ushort.MaxValue);
        }
        writer.Write((ushort)bytes.Length);
        if (bytes.Length > 0)
        {
            writer.Write(bytes);
        }
    }

    private static void WriteFloatArray(BinaryWriter writer, float[] data)
    {
        var bytes = new byte[data.Length * sizeof(float)];
        Buffer.BlockCopy(data, 0, bytes, 0, bytes.Length);
        writer.Write(bytes);
    }

    private static void WriteUIntArray(BinaryWriter writer, uint[] data)
    {
        var bytes = new byte[data.Length * sizeof(uint)];
        Buffer.BlockCopy(data, 0, bytes, 0, bytes.Length);
        writer.Write(bytes);
    }
}

public sealed class MeshData
{
    public MeshData(string name, string materialName, float[] positions, float[]? normals, float[]? uvs, uint[] indices)
    {
        Name = name;
        MaterialName = materialName;
        Positions = positions;
        Normals = normals;
        Uvs = uvs;
        Indices = indices;
    }

    public string Name { get; }
    public string MaterialName { get; }
    public float[] Positions { get; }
    public float[]? Normals { get; }
    public float[]? Uvs { get; }
    public uint[] Indices { get; }

    public int VertexCount => Positions.Length / 3;
    public int IndexCount => Indices.Length;
}
