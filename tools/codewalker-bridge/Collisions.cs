using System.Text.Json.Serialization;
using CodeWalker.GameFiles;
using SharpDX;

namespace CodeWalkerBridge;

public static partial class Program
{
    private const int MaxCollisionTriangles = 1_000_000;
    private const int MaxCollisionPrimitives = 100_000;
    private const int MaxCollisionDepth = 8;

    private static string[]? CollisionMaterialNames;
    private static bool CollisionMaterialNamesResolved;

    private sealed class CollisionMesh
    {
        [JsonPropertyName("source")] public string Source { get; init; } = "";
        [JsonPropertyName("drawableIndex")] public int? DrawableIndex { get; init; }
        [JsonPropertyName("child")] public int? Child { get; init; }
        [JsonPropertyName("material")] public int Material { get; init; }
        [JsonPropertyName("positions")] public List<float> Positions { get; } = new();
        [JsonPropertyName("indices")] public List<int> Indices { get; } = new();
        [JsonIgnore] public Dictionary<int, int> VertexMap { get; } = new();
    }

    private sealed record CollisionPrimitive(
        [property: JsonPropertyName("kind")] string Kind,
        [property: JsonPropertyName("source")] string Source,
        [property: JsonPropertyName("drawableIndex")] int? DrawableIndex,
        [property: JsonPropertyName("child")] int? Child,
        [property: JsonPropertyName("material")] int Material,
        [property: JsonPropertyName("center"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[]? Center = null,
        [property: JsonPropertyName("radius"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float? Radius = null,
        [property: JsonPropertyName("a"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[]? A = null,
        [property: JsonPropertyName("b"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[]? B = null,
        [property: JsonPropertyName("corner"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[]? Corner = null,
        [property: JsonPropertyName("edges"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] float[][]? Edges = null);

    private sealed class CollisionResult
    {
        public List<CollisionMesh> Meshes { get; } = new();
        public List<CollisionPrimitive> Primitives { get; } = new();
        public Dictionary<(string, int?, int?, int), CollisionMesh> MeshIndex { get; } = new();
        public HashSet<int> Materials { get; } = new();
        public List<string> Warnings { get; } = new();
        public int Triangles { get; set; }
        public int SkippedTriangles { get; set; }
        public bool Truncated { get; set; }
    }

    private static object ReadCollisions(string inputPath)
    {
        LoadJenkIndexStrings();
        var data = File.ReadAllBytes(inputPath);
        var source = LoadModelSource(inputPath, data);
        var result = new CollisionResult();

        var collected = new HashSet<Bounds>(ReferenceEqualityComparer.Instance);
        var physics = source.Fragment?.PhysicsLODGroup?.PhysicsLOD1;
        if (physics?.Bound != null)
        {
            collected.Add(physics.Bound);
            CollectBounds(result, physics.Bound, Matrix.Identity, "physics", null, null, 0);
        }
        for (var index = 0; index < source.Drawables.Count; index += 1)
        {
            var bound = source.Drawables[index] switch
            {
                Drawable plain => plain.Bound,
                FragDrawable fragment => fragment.Bound,
                _ => null,
            };
            if (bound != null && collected.Add(bound))
            {
                CollectBounds(result, bound, Matrix.Identity, "drawable", index, null, 0);
            }
        }
        if (result.SkippedTriangles > 0)
        {
            result.Warnings.Add($"{result.SkippedTriangles} collision triangles have damaged values and were left out.");
        }

        var names = GetCollisionMaterialNames();
        var materials = result.Materials.OrderBy(index => index).Select(index => new
        {
            index,
            name = names != null && index < names.Length ? names[index] : null,
        }).ToList();

        return new
        {
            format = source.Format,
            meshes = result.Meshes,
            primitives = result.Primitives,
            materials,
            triangles = result.Triangles,
            truncated = result.Truncated,
            warnings = result.Warnings,
        };
    }

    private static void CollectBounds(CollisionResult result, Bounds bound, Matrix transform, string source, int? drawableIndex, int? child, int depth)
    {
        if (depth > MaxCollisionDepth)
        {
            result.Warnings.Add("Collision bounds nest too deeply; the deepest were left out.");
            return;
        }

        var material = (int)bound.MaterialIndex;
        switch (bound)
        {
            case BoundComposite composite:
            {
                var children = composite.Children?.data_items;
                if (children == null) return;
                for (var index = 0; index < children.Length; index += 1)
                {
                    if (children[index] is not { } item) continue;
                    CollectBounds(result, item, item.Transform * transform, source, drawableIndex, child ?? index, depth + 1);
                }
                break;
            }
            case BoundGeometry geometry:
                CollectGeometry(result, geometry, transform, source, drawableIndex, child);
                break;
            case BoundBox box:
            {
                var extent = Extent(box);
                AddPrimitive(result, new CollisionPrimitive("box", source, drawableIndex, child, material,
                    Corner: Point(box.BoxMin, transform),
                    Edges: new[]
                    {
                        Direction(new Vector3(extent.X, 0, 0), transform),
                        Direction(new Vector3(0, extent.Y, 0), transform),
                        Direction(new Vector3(0, 0, extent.Z), transform),
                    }));
                break;
            }
            case BoundSphere sphere:
                AddPrimitive(result, new CollisionPrimitive("sphere", source, drawableIndex, child, material,
                    Center: Point(sphere.SphereCenter, transform), Radius: sphere.SphereRadius));
                break;
            case BoundCapsule capsule:
            {
                var extent = capsule.SphereRadius - capsule.Margin;
                AddPrimitive(result, new CollisionPrimitive("capsule", source, drawableIndex, child, material,
                    A: Point(capsule.SphereCenter - new Vector3(0, extent, 0), transform),
                    B: Point(capsule.SphereCenter + new Vector3(0, extent, 0), transform),
                    Radius: capsule.Margin));
                break;
            }
            case BoundCylinder cylinder:
            {
                var extent = Extent(cylinder);
                AddPrimitive(result, new CollisionPrimitive("cylinder", source, drawableIndex, child, material,
                    A: Point(cylinder.SphereCenter - new Vector3(0, extent.Y * 0.5f, 0), transform),
                    B: Point(cylinder.SphereCenter + new Vector3(0, extent.Y * 0.5f, 0), transform),
                    Radius: extent.X * 0.5f));
                break;
            }
            case BoundDisc disc:
                AddPrimitive(result, new CollisionPrimitive("cylinder", source, drawableIndex, child, material,
                    A: Point(disc.SphereCenter - new Vector3(disc.Margin, 0, 0), transform),
                    B: Point(disc.SphereCenter + new Vector3(disc.Margin, 0, 0), transform),
                    Radius: disc.SphereRadius));
                break;
            default:
                result.Warnings.Add($"A {bound.Type} collision bound is not shown.");
                break;
        }
    }

    private static void CollectGeometry(CollisionResult result, BoundGeometry geometry, Matrix transform, string source, int? drawableIndex, int? child)
    {
        var polygons = geometry.Polygons;
        var vertices = geometry.Vertices;
        if (polygons == null || vertices == null) return;

        Vector3 vertex(int index) => Vector3.TransformCoordinate(geometry.GetVertex(index) + geometry.CenterGeom, transform);
        float[] point(int index) => ToArray(vertex(index));
        bool valid(int index) => index >= 0 && index < vertices.Length;

        for (var polyIndex = 0; polyIndex < polygons.Length; polyIndex += 1)
        {
            var polygon = polygons[polyIndex];
            if (polygon == null) continue;
            var material = (int)geometry.GetMaterial(polyIndex).Type.Index;
            switch (polygon)
            {
                case BoundPolygonTriangle triangle:
                    AddTriangle(result, new[] { triangle.vertIndex1, triangle.vertIndex2, triangle.vertIndex3 }, vertex, valid, source, drawableIndex, child, material);
                    break;
                case BoundPolygonSphere sphere when valid(sphere.sphereIndex):
                    AddPrimitive(result, new CollisionPrimitive("sphere", source, drawableIndex, child, material,
                        Center: point(sphere.sphereIndex), Radius: sphere.sphereRadius));
                    break;
                case BoundPolygonCapsule capsule when valid(capsule.capsuleIndex1) && valid(capsule.capsuleIndex2):
                    AddPrimitive(result, new CollisionPrimitive("capsule", source, drawableIndex, child, material,
                        A: point(capsule.capsuleIndex1), B: point(capsule.capsuleIndex2), Radius: capsule.capsuleRadius));
                    break;
                case BoundPolygonCylinder cylinder when valid(cylinder.cylinderIndex1) && valid(cylinder.cylinderIndex2):
                    AddPrimitive(result, new CollisionPrimitive("cylinder", source, drawableIndex, child, material,
                        A: point(cylinder.cylinderIndex1), B: point(cylinder.cylinderIndex2), Radius: cylinder.cylinderRadius));
                    break;
                case BoundPolygonBox box when valid(box.boxIndex1) && valid(box.boxIndex2) && valid(box.boxIndex3) && valid(box.boxIndex4):
                {
                    var p1 = vertex(box.boxIndex1);
                    var p2 = vertex(box.boxIndex2);
                    var p3 = vertex(box.boxIndex3);
                    var p4 = vertex(box.boxIndex4);
                    var half = ((p3 + p4) - (p1 + p2)) * 0.5f;
                    AddPrimitive(result, new CollisionPrimitive("box", source, drawableIndex, child, material,
                        Corner: ToArray(p1),
                        Edges: new[] { ToArray(half), ToArray(p3 - half - p1), ToArray(p4 - half - p1) }));
                    break;
                }
            }
        }
    }

    private static void AddTriangle(CollisionResult result, int[] corners, Func<int, Vector3> vertex, Func<int, bool> valid, string source, int? drawableIndex, int? child, int material)
    {
        if (result.Triangles >= MaxCollisionTriangles)
        {
            result.Truncated = true;
            return;
        }
        if (!corners.All(valid))
        {
            result.SkippedTriangles += 1;
            return;
        }
        var points = corners.Select(vertex).ToArray();
        if (!points.All(IsFinite))
        {
            result.SkippedTriangles += 1;
            return;
        }

        var key = (source, drawableIndex, child, material);
        if (!result.MeshIndex.TryGetValue(key, out var mesh))
        {
            mesh = new CollisionMesh { Source = source, DrawableIndex = drawableIndex, Child = child, Material = material };
            result.MeshIndex[key] = mesh;
            result.Meshes.Add(mesh);
            result.Materials.Add(material);
        }
        for (var i = 0; i < 3; i += 1)
        {
            if (!mesh.VertexMap.TryGetValue(corners[i], out var local))
            {
                local = mesh.Positions.Count / 3;
                mesh.VertexMap[corners[i]] = local;
                mesh.Positions.Add(points[i].X);
                mesh.Positions.Add(points[i].Y);
                mesh.Positions.Add(points[i].Z);
            }
            mesh.Indices.Add(local);
        }
        result.Triangles += 1;
    }

    private static void AddPrimitive(CollisionResult result, CollisionPrimitive primitive)
    {
        if (result.Primitives.Count >= MaxCollisionPrimitives)
        {
            result.Truncated = true;
            return;
        }
        var numbers = new[] { primitive.Center, primitive.A, primitive.B, primitive.Corner }
            .Where(values => values != null)
            .SelectMany(values => values!)
            .Concat(primitive.Edges?.SelectMany(edge => edge) ?? Enumerable.Empty<float>())
            .Append(primitive.Radius ?? 0f);
        if (!numbers.All(float.IsFinite))
        {
            result.Warnings.Add($"A {primitive.Kind} collision shape has damaged values and was left out.");
            return;
        }
        result.Primitives.Add(primitive);
        result.Materials.Add(primitive.Material);
    }

    private static float[] Point(Vector3 value, Matrix transform) => ToArray(Vector3.TransformCoordinate(value, transform));

    private static float[] Direction(Vector3 value, Matrix transform) => ToArray(Vector3.TransformNormal(value, transform));

    private static Vector3 Extent(Bounds bound)
    {
        var size = bound.BoxMax - bound.BoxMin;
        return new Vector3(Math.Abs(size.X), Math.Abs(size.Y), Math.Abs(size.Z));
    }

    private static float[] ToArray(Vector3 value) => new[] { value.X, value.Y, value.Z };

    private static string[]? GetCollisionMaterialNames()
    {
        if (CollisionMaterialNamesResolved) return CollisionMaterialNames;
        CollisionMaterialNamesResolved = true;
        var archive = GetSharedTextureArchive();
        if (archive == null) return null;
        try
        {
            var text = archive.Manager.GetFileUTF8Text(@"update\update.rpf\common\data\materials\materials.dat");
            if (string.IsNullOrEmpty(text)) text = archive.Manager.GetFileUTF8Text(@"common.rpf\data\materials\materials.dat");
            if (string.IsNullOrEmpty(text)) return null;
            CollisionMaterialNames = text.Split('\n')
                .Skip(1)
                .Where(line => line.Length >= 20 && line[0] != '#')
                .Select(line => line.Split(new[] { '\t', ' ' }, StringSplitOptions.RemoveEmptyEntries))
                .Where(parts => parts.Length >= 10)
                .Select(parts => parts[0].Trim())
                .ToArray();
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[collisions] materials.dat could not be read: {ex.Message}");
        }
        return CollisionMaterialNames;
    }
}
