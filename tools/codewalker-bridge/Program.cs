using System.Text;
using System.Text.Json;
using CodeWalker.GameFiles;
using CodeWalker.Utils;
using Microsoft.Win32;
using SharpDX;
using System.Xml;
using DxHalf = SharpDX.Half;

namespace CodeWalkerBridge;

public static class Program
{
    private const string Magic = "CLM1";
    private const ushort Version = 2;
    private static string? LoadedGtaKeyFolder;

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

            var outputDirectory = Path.GetDirectoryName(outputPath) ?? string.Empty;
            var textureLibrary = ExportTextures(yft, inputPath, outputDirectory);

            var meshes = ExtractMeshes(yft, Path.GetFileNameWithoutExtension(inputPath), textureLibrary);
            if (meshes.Count == 0)
            {
                Console.Error.WriteLine("No meshes were extracted from the YFT.");
                return 3;
            }

            WriteClmesh(outputPath, meshes);
            var manifestPath = Path.Combine(Path.GetDirectoryName(outputPath) ?? string.Empty, "manifest.json");
            WriteManifest(manifestPath, inputPath, meshes, textureLibrary);

            var meta = new
            {
                meshCount = meshes.Count,
                vertexCount = meshes.Sum(m => m.VertexCount),
                indexCount = meshes.Sum(m => m.IndexCount),
                materialCount = meshes.Select(m => m.MaterialName).Where(n => !string.IsNullOrEmpty(n)).Distinct().Count(),
                textureCount = textureLibrary.Entries.Count,
                manifestPath,
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

    private static List<MeshData> ExtractMeshes(YftFile yft, string baseName, TextureLibrary textureLibrary)
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

                    var mesh = ExtractMesh(geom, baseName, drawableIndex, modelIndex, geomIndex, textureLibrary);
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

    private static MeshData? ExtractMesh(
        DrawableGeometry geom,
        string baseName,
        int drawableIndex,
        int modelIndex,
        int geomIndex,
        TextureLibrary textureLibrary)
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
        var uvs2 = HasComponent(info, VertexSemantics.TexCoord1) ? new float[vertexCount * 2] : null;
        var uvs3 = HasComponent(info, VertexSemantics.TexCoord2) ? new float[vertexCount * 2] : null;
        var uvs4 = HasComponent(info, VertexSemantics.TexCoord3) ? new float[vertexCount * 2] : null;

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

            if (uvs2 != null)
            {
                var uv = ReadVector2(vertexData, info, v, VertexSemantics.TexCoord1);
                var uvIndex = v * 2;
                uvs2[uvIndex] = uv.X;
                uvs2[uvIndex + 1] = uv.Y;
            }

            if (uvs3 != null)
            {
                var uv = ReadVector2(vertexData, info, v, VertexSemantics.TexCoord2);
                var uvIndex = v * 2;
                uvs3[uvIndex] = uv.X;
                uvs3[uvIndex + 1] = uv.Y;
            }

            if (uvs4 != null)
            {
                var uv = ReadVector2(vertexData, info, v, VertexSemantics.TexCoord3);
                var uvIndex = v * 2;
                uvs4[uvIndex] = uv.X;
                uvs4[uvIndex + 1] = uv.Y;
            }
        }

        var indices = BuildIndices(geom, vertexCount);
        if (indices == null || indices.Length == 0) return null;

        var materialName = GetMaterialName(geom);
        if (string.IsNullOrEmpty(materialName))
        {
            materialName = $"material_{geom.ShaderID}";
        }

        var shaderName = GetShaderName(geom);
        var shaderHash = geom.Shader?.Name.Hash ?? 0;
        var shaderFileName = geom.Shader?.FileName.ToCleanString() ?? string.Empty;
        var uvSets = new MeshUvSets(
            HasComponent(info, VertexSemantics.TexCoord0),
            HasComponent(info, VertexSemantics.TexCoord1),
            HasComponent(info, VertexSemantics.TexCoord2),
            HasComponent(info, VertexSemantics.TexCoord3)
        );
        var textureBindings = ExtractTextureBindings(geom.Shader, textureLibrary, uvSets, shaderName, materialName);
        var textureRefs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var resolvedTexturePaths = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var binding in textureBindings)
        {
            if (!string.IsNullOrWhiteSpace(binding.TextureName) && !textureRefs.ContainsKey(binding.ParamName))
            {
                textureRefs[binding.ParamName] = binding.TextureName;
            }
            if (!string.IsNullOrWhiteSpace(binding.RelativePath) && !resolvedTexturePaths.ContainsKey(binding.ParamName))
            {
                resolvedTexturePaths[binding.ParamName] = binding.RelativePath;
            }
        }
        var meshName = $"{baseName}_d{drawableIndex}_m{modelIndex}_g{geomIndex}";
        return new MeshData(
            meshName,
            materialName,
            positions,
            normals,
            uvs,
            uvs2,
            uvs3,
            uvs4,
            indices,
            shaderName,
            shaderHash,
            shaderFileName,
            geom.Shader?.RenderBucket ?? 0,
            drawableIndex,
            modelIndex,
            geomIndex,
            uvSets,
            textureBindings,
            textureRefs,
            resolvedTexturePaths
        );
    }

    private static TextureLibrary ExportTextures(YftFile yft, string inputPath, string outputDirectory)
    {
        var library = new TextureLibrary();
        var textureRoot = Path.Combine(outputDirectory, "textures");
        var exportedYtdPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var ytdPath in EnumerateSiblingYtdPaths(inputPath))
        {
            ExportYtdFromPath(ytdPath, "ytd", "ytd", textureRoot, library, exportedYtdPaths);
        }

        var vehicleContext = TryReadVehicleTextureContext(inputPath);
        foreach (var ytdPath in EnumerateResourceSharedYtdPaths(inputPath, vehicleContext))
        {
            var txdName = Path.GetFileNameWithoutExtension(ytdPath) ?? "resource";
            ExportYtdFromPath(ytdPath, "ytd", $"shared/{SanitizeFolderName(txdName)}", textureRoot, library, exportedYtdPaths);
        }

        var sharedArchive = CreateSharedTextureArchive();
        if (sharedArchive != null)
        {
            foreach (var txdName in CollectRequestedSharedTxdNames(inputPath, vehicleContext, sharedArchive))
            {
                ExportYtdFromArchive(txdName, sharedArchive, textureRoot, library);
            }
        }

        foreach (var texture in CollectEmbeddedTextures(yft))
        {
            ExportTexture(texture, "embedded", "embedded", textureRoot, library, addByName: false);
        }

        return library;
    }

    private static void ExportYtdFromPath(
        string ytdPath,
        string source,
        string folderName,
        string textureRoot,
        TextureLibrary library,
        HashSet<string> exportedYtdPaths)
    {
        if (string.IsNullOrWhiteSpace(ytdPath) || !File.Exists(ytdPath)) return;
        var fullPath = Path.GetFullPath(ytdPath);
        if (!exportedYtdPaths.Add(fullPath)) return;

        var ytd = LoadYtdFromPath(fullPath);
        if (ytd?.TextureDict?.Textures?.data_items == null) return;

        foreach (var texture in ytd.TextureDict.Textures.data_items)
        {
            ExportTexture(texture, source, folderName, textureRoot, library, addByName: true);
        }
    }

    private static void ExportYtdFromArchive(
        string txdName,
        SharedTextureArchive archive,
        string textureRoot,
        TextureLibrary library)
    {
        if (string.IsNullOrWhiteSpace(txdName)) return;
        var lookupKey = NormalizeTextureLookupKey(txdName);
        if (!archive.YtdEntries.TryGetValue(lookupKey, out var entry)) return;
        if (!archive.ExportedTxdNames.Add(lookupKey)) return;

        try
        {
            var ytd = archive.Manager.GetFile<YtdFile>(entry);
            if (ytd?.TextureDict?.Textures?.data_items == null) return;
            foreach (var texture in ytd.TextureDict.Textures.data_items)
            {
                ExportTexture(texture, "shared", $"shared/{SanitizeFolderName(txdName)}", textureRoot, library, addByName: true);
            }
        }
        catch
        {
        }
    }

    private static YtdFile? LoadYtdFromPath(string ytdPath)
    {
        if (string.IsNullOrWhiteSpace(ytdPath) || !File.Exists(ytdPath)) return null;

        try
        {
            var ytd = new YtdFile();
            ytd.Load(File.ReadAllBytes(ytdPath));
            return ytd;
        }
        catch
        {
            return null;
        }
    }

    private static IEnumerable<string> EnumerateSiblingYtdPaths(string inputPath)
    {
        var path = new FileInfo(inputPath);
        var stem = Path.GetFileNameWithoutExtension(path.Name);
        var parent = path.DirectoryName ?? string.Empty;
        var candidates = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void addCandidate(string? nextPath)
        {
            if (string.IsNullOrWhiteSpace(nextPath)) return;
            if (!File.Exists(nextPath)) return;
            if (seen.Add(nextPath)) candidates.Add(nextPath);
        }

        addCandidate(Path.Combine(parent, $"{stem}.ytd"));

        if (stem.EndsWith("_hi", StringComparison.OrdinalIgnoreCase))
        {
            var stripped = stem[..^3];
            addCandidate(Path.Combine(parent, $"{stripped}+hi.ytd"));
            addCandidate(Path.Combine(parent, $"{stripped}.ytd"));
        }
        else if (stem.EndsWith("+hi", StringComparison.OrdinalIgnoreCase))
        {
            var stripped = stem[..^3];
            addCandidate(Path.Combine(parent, $"{stripped}_hi.ytd"));
            addCandidate(Path.Combine(parent, $"{stripped}.ytd"));
        }
        else
        {
            addCandidate(Path.Combine(parent, $"{stem}+hi.ytd"));
        }

        return candidates;
    }

    private static VehicleTextureContext? TryReadVehicleTextureContext(string inputPath)
    {
        try
        {
            var modelName = GetInputModelStem(inputPath);
            if (string.IsNullOrWhiteSpace(modelName)) return null;

            var resourceRoot = FindResourceRoot(inputPath);
            if (string.IsNullOrWhiteSpace(resourceRoot)) return null;

            var dataDirectory = Path.Combine(resourceRoot, "data");
            if (!Directory.Exists(dataDirectory)) return null;

            var context = new VehicleTextureContext(modelName, resourceRoot);

            foreach (var vehiclesMetaPath in Directory.GetFiles(dataDirectory, "*vehicles.meta", SearchOption.AllDirectories))
            {
                TryPopulateVehicleContextFromVehiclesMeta(vehiclesMetaPath, context);
            }

            foreach (var gtxdMetaPath in Directory.GetFiles(dataDirectory, "*gtxd.meta", SearchOption.AllDirectories))
            {
                TryPopulateVehicleContextFromGtxdMeta(gtxdMetaPath, context);
            }

            return context;
        }
        catch
        {
            return null;
        }
    }

    private static string GetInputModelStem(string inputPath)
    {
        var stem = Path.GetFileNameWithoutExtension(inputPath) ?? string.Empty;
        if (stem.EndsWith("_hi", StringComparison.OrdinalIgnoreCase)) return stem[..^3];
        if (stem.EndsWith("+hi", StringComparison.OrdinalIgnoreCase)) return stem[..^3];
        return stem;
    }

    private static string? FindResourceRoot(string inputPath)
    {
        var directory = Path.GetDirectoryName(inputPath);
        while (!string.IsNullOrWhiteSpace(directory))
        {
            if (File.Exists(Path.Combine(directory, "fxmanifest.lua")) || File.Exists(Path.Combine(directory, "__resource.lua")))
            {
                return directory;
            }

            var parent = Directory.GetParent(directory);
            if (parent == null) break;
            directory = parent.FullName;
        }
        return null;
    }

    private static void TryPopulateVehicleContextFromVehiclesMeta(string filePath, VehicleTextureContext context)
    {
        try
        {
            var document = new XmlDocument();
            document.Load(filePath);

            var root = document.SelectSingleNode("CVehicleModelInfo__InitDataList");
            if (root == null) return;

            var residentTxd = root.SelectSingleNode("residentTxd")?.InnerText?.Trim();
            if (!string.IsNullOrWhiteSpace(residentTxd))
            {
                context.AddResidentTxd(residentTxd);
            }

            var initItems = document.SelectNodes("CVehicleModelInfo__InitDataList/InitDatas/Item | CVehicleModelInfo__InitDataList/InitDatas/item");
            if (initItems != null)
            {
                foreach (XmlNode item in initItems)
                {
                    var modelName = item.SelectSingleNode("modelName")?.InnerText?.Trim();
                    if (!string.Equals(modelName, context.ModelName, StringComparison.OrdinalIgnoreCase)) continue;

                    var txdName = item.SelectSingleNode("txdName")?.InnerText?.Trim();
                    if (!string.IsNullOrWhiteSpace(txdName))
                    {
                        context.CurrentTxdName = txdName;
                    }
                    break;
                }
            }

            var relationships = document.SelectNodes("CVehicleModelInfo__InitDataList/txdRelationships/Item | CVehicleModelInfo__InitDataList/txdRelationships/item");
            if (relationships == null) return;
            foreach (XmlNode item in relationships)
            {
                var parent = item.SelectSingleNode("parent")?.InnerText?.Trim();
                var child = item.SelectSingleNode("child")?.InnerText?.Trim();
                context.AddRelationship(child, parent);
            }
        }
        catch
        {
        }
    }

    private static void TryPopulateVehicleContextFromGtxdMeta(string filePath, VehicleTextureContext context)
    {
        try
        {
            var document = new XmlDocument();
            document.Load(filePath);
            var relationships = document.SelectNodes("CMapParentTxds/txdRelationships/Item | CMapParentTxds/txdRelationships/item");
            if (relationships == null) return;
            foreach (XmlNode item in relationships)
            {
                var parent = item.SelectSingleNode("parent")?.InnerText?.Trim();
                var child = item.SelectSingleNode("child")?.InnerText?.Trim();
                context.AddRelationship(child, parent);
            }
        }
        catch
        {
        }
    }

    private static IEnumerable<string> EnumerateResourceSharedYtdPaths(string inputPath, VehicleTextureContext? context)
    {
        if (context == null || string.IsNullOrWhiteSpace(context.ResourceRoot)) yield break;

        var streamDirectory = Path.Combine(context.ResourceRoot, "stream");
        if (!Directory.Exists(streamDirectory)) yield break;

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var txdName in context.EnumerateRequestedTxdNames())
        {
            foreach (var suffix in new[] { ".ytd", "+hi.ytd", "_hi.ytd" })
            {
                var candidate = Path.Combine(streamDirectory, $"{txdName}{suffix}");
                if (!File.Exists(candidate)) continue;
                if (seen.Add(candidate)) yield return candidate;
            }
        }
    }

    private static IEnumerable<string> CollectRequestedSharedTxdNames(
        string inputPath,
        VehicleTextureContext? context,
        SharedTextureArchive archive)
    {
        var requested = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        void addName(string? name)
        {
            if (string.IsNullOrWhiteSpace(name)) return;
            if (seen.Add(name)) requested.Add(name);
        }

        if (context != null)
        {
            foreach (var txdName in context.EnumerateRequestedTxdNames())
            {
                addName(txdName);

                var nextParent = txdName;
                var guard = 0;
                while (!string.IsNullOrWhiteSpace(nextParent) && archive.ParentRelationships.TryGetValue(NormalizeTextureLookupKey(nextParent), out var parentName))
                {
                    if (!seen.Add(parentName)) break;
                    requested.Add(parentName);
                    nextParent = parentName;
                    guard += 1;
                    if (guard > 12) break;
                }
            }
        }

        addName("vehshare");
        return requested;
    }

    private static SharedTextureArchive? CreateSharedTextureArchive()
    {
        var gtaFolder = AutoDetectGtaFolder();
        if (string.IsNullOrWhiteSpace(gtaFolder) || !Directory.Exists(gtaFolder)) return null;

        try
        {
            EnsureGtaArchiveKeys(gtaFolder);

            var manager = new RpfManager
            {
                BuildExtendedJenkIndex = false,
                EnableMods = false,
                ExcludePaths = new[] { "installers", "_commonredist" },
            };
            manager.Init(gtaFolder, false, _ => { }, _ => { }, buildIndex: false);

            var ytdEntries = new Dictionary<string, RpfFileEntry>(StringComparer.OrdinalIgnoreCase);
            var ytdEntryPriority = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            var parentRelationships = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

            foreach (var rpf in manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
            {
                if (rpf.AllEntries == null) continue;
                foreach (var rawEntry in rpf.AllEntries)
                {
                    if (rawEntry is not RpfFileEntry entry) continue;

                    if (entry.NameLower.EndsWith(".ytd", StringComparison.OrdinalIgnoreCase))
                    {
                        var shortName = Path.GetFileNameWithoutExtension(entry.NameLower) ?? string.Empty;
                        if (string.IsNullOrWhiteSpace(shortName)) continue;
                        var priority = GetArchiveEntryPriority(entry.Path);
                        if (!ytdEntries.TryGetValue(shortName, out var existing) || priority >= ytdEntryPriority[shortName])
                        {
                            ytdEntries[shortName] = entry;
                            ytdEntryPriority[shortName] = priority;
                        }
                    }
                    else if (entry.NameLower == "vehicles.meta")
                    {
                        try
                        {
                            var file = manager.GetFile<VehiclesFile>(entry);
                            if (file?.TxdRelationships != null)
                            {
                                foreach (var relationship in file.TxdRelationships)
                                {
                                    var child = NormalizeTextureLookupKey(relationship.Key);
                                    var parent = NormalizeTextureLookupKey(relationship.Value);
                                    if (!string.IsNullOrWhiteSpace(child) && !string.IsNullOrWhiteSpace(parent) && !parentRelationships.ContainsKey(child))
                                    {
                                        parentRelationships[child] = parent;
                                    }
                                }
                            }
                        }
                        catch
                        {
                        }
                    }
                    else if (entry.NameLower == "gtxd.ymt" || entry.NameLower == "gtxd.meta" || entry.NameLower == "mph4_gtxd.ymt")
                    {
                        try
                        {
                            var file = manager.GetFile<GtxdFile>(entry);
                            if (file?.TxdRelationships != null)
                            {
                                foreach (var relationship in file.TxdRelationships)
                                {
                                    var child = NormalizeTextureLookupKey(relationship.Key);
                                    var parent = NormalizeTextureLookupKey(relationship.Value);
                                    if (!string.IsNullOrWhiteSpace(child) && !string.IsNullOrWhiteSpace(parent) && !parentRelationships.ContainsKey(child))
                                    {
                                        parentRelationships[child] = parent;
                                    }
                                }
                            }
                        }
                        catch
                        {
                        }
                    }
                }
            }

            return new SharedTextureArchive(manager, ytdEntries, parentRelationships);
        }
        catch
        {
            return null;
        }
    }

    private static void EnsureGtaArchiveKeys(string gtaFolder)
    {
        var normalizedFolder = Path.GetFullPath(gtaFolder);
        if (!string.IsNullOrWhiteSpace(LoadedGtaKeyFolder) && string.Equals(LoadedGtaKeyFolder, normalizedFolder, StringComparison.OrdinalIgnoreCase))
        {
            GTA5Hash.LUT = GTA5Keys.PC_LUT;
            return;
        }

        GTA5Keys.LoadFromPath(normalizedFolder, gen9: false, key: null);
        GTA5Hash.LUT = GTA5Keys.PC_LUT;
        LoadedGtaKeyFolder = normalizedFolder;
    }

    private static int GetArchiveEntryPriority(string path)
    {
        var score = 0;
        var normalized = (path ?? string.Empty).ToLowerInvariant();
        if (normalized.Contains("mods\\")) score += 40;
        if (normalized.StartsWith("update\\") || normalized.Contains("\\update\\")) score += 20;
        if (normalized.Contains("dlcpacks")) score += 10;
        return score;
    }

    private static string? AutoDetectGtaFolder()
    {
        var candidates = new List<string?>
        {
            @"C:\Program Files\Rockstar Games\Grand Theft Auto V",
            @"C:\Program Files (x86)\Steam\steamapps\common\Grand Theft Auto V",
            @"C:\Program Files\Epic Games\GTAV",
        };

        if (OperatingSystem.IsWindows())
        {
            candidates.Insert(0, TryReadRegistryString(RegistryHive.LocalMachine, RegistryView.Registry32, @"Software\Rockstar Games\GTAV", "InstallFolderSteam"));
            candidates.Insert(1, TryReadRegistryString(RegistryHive.LocalMachine, RegistryView.Registry32, @"Software\Rockstar Games\Grand Theft Auto V", "InstallFolder"));
            candidates.Insert(2, TryReadRegistryString(RegistryHive.CurrentUser, RegistryView.Default, @"Software\NewTechnologyStudio\OpenIV.exe\BrowseForFolder", "game_path_Five_pc"));
        }

        foreach (var steamLibrary in EnumerateSteamLibraryPaths())
        {
            candidates.Add(Path.Combine(steamLibrary, @"steamapps\common\Grand Theft Auto V"));
        }

        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
            candidates.Add(Path.Combine(drive.RootDirectory.FullName, @"SteamLibrary\steamapps\common\Grand Theft Auto V"));
            candidates.Add(Path.Combine(drive.RootDirectory.FullName, @"Games\Grand Theft Auto V"));
            candidates.Add(Path.Combine(drive.RootDirectory.FullName, @"Rockstar Games\Grand Theft Auto V"));
        }

        foreach (var candidate in candidates)
        {
            if (IsValidGtaFolder(candidate)) return candidate;
        }

        return null;
    }

    private static string? TryReadRegistryString(RegistryHive hive, RegistryView view, string subKey, string valueName)
    {
        if (!OperatingSystem.IsWindows()) return null;
        try
        {
            using var baseKey = RegistryKey.OpenBaseKey(hive, view);
            using var key = baseKey.OpenSubKey(subKey);
            return key?.GetValue(valueName) as string;
        }
        catch
        {
            return null;
        }
    }

    private static IEnumerable<string> EnumerateSteamLibraryPaths()
    {
        if (!OperatingSystem.IsWindows()) yield break;

        var installPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var installPath in new[]
        {
            TryReadRegistryString(RegistryHive.LocalMachine, RegistryView.Registry32, @"Software\Valve\Steam", "InstallPath"),
            TryReadRegistryString(RegistryHive.LocalMachine, RegistryView.Registry64, @"Software\Valve\Steam", "InstallPath"),
            TryReadRegistryString(RegistryHive.CurrentUser, RegistryView.Default, @"Software\Valve\Steam", "InstallPath"),
        })
        {
            if (!string.IsNullOrWhiteSpace(installPath)) installPaths.Add(installPath);
        }

        foreach (var installPath in installPaths)
        {
            var libraryFile = Path.Combine(installPath, @"steamapps\libraryfolders.vdf");
            if (!File.Exists(libraryFile)) continue;

            foreach (var line in File.ReadLines(libraryFile))
            {
                var trimmed = line.Trim();
                if (!trimmed.Contains("\"path\"", StringComparison.OrdinalIgnoreCase)) continue;
                var segments = trimmed.Split('"', StringSplitOptions.RemoveEmptyEntries);
                if (segments.Length < 4) continue;
                var libraryPath = segments[3].Replace("\\\\", "\\");
                if (!string.IsNullOrWhiteSpace(libraryPath)) yield return libraryPath;
            }
        }
    }

    private static bool IsValidGtaFolder(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return false;
        return Directory.Exists(folder) && File.Exists(Path.Combine(folder, "gta5.exe"));
    }

    private static string SanitizeFolderName(string name)
    {
        var value = string.IsNullOrWhiteSpace(name) ? "shared" : name.Trim();
        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if (ch == '/' || ch == '\\')
            {
                builder.Append('_');
                continue;
            }
            builder.Append(Array.IndexOf(Path.GetInvalidFileNameChars(), ch) >= 0 ? '_' : ch);
        }
        return builder.Length > 0 ? builder.ToString() : "shared";
    }

    private static IEnumerable<Texture> CollectEmbeddedTextures(YftFile yft)
    {
        var textures = new List<Texture>();
        var seen = new HashSet<Texture>();
        var fragment = yft.Fragment;
        if (fragment == null) return textures;

        var drawables = new List<DrawableBase>();
        if (fragment.Drawable != null) drawables.Add(fragment.Drawable);
        if (fragment.DrawableCloth != null) drawables.Add(fragment.DrawableCloth);
        if (fragment.DrawableArray?.data_items != null)
        {
            foreach (var drawable in fragment.DrawableArray.data_items)
            {
                if (drawable != null) drawables.Add(drawable);
            }
        }

        foreach (var drawable in drawables)
        {
            var dictionary = drawable?.ShaderGroup?.TextureDictionary;
            var items = dictionary?.Textures?.data_items;
            if (items == null) continue;
            foreach (var texture in items)
            {
                if (texture == null || !seen.Add(texture)) continue;
                textures.Add(texture);
            }
        }

        return textures;
    }

    private static void ExportTexture(
        Texture? texture,
        string source,
        string folderName,
        string textureRoot,
        TextureLibrary library,
        bool addByName)
    {
        if (texture == null) return;
        if (library.ByInstance.ContainsKey(texture)) return;

        var textureName = GetTextureName(texture);
        if (string.IsNullOrWhiteSpace(textureName)) return;

        var relativeFolder = string.IsNullOrWhiteSpace(folderName) ? source : folderName;
        var sourceFolder = Path.Combine(textureRoot, relativeFolder.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(sourceFolder);

        var safeName = SanitizeFileName(textureName);
        var fileName = EnsureUniqueFileName(sourceFolder, safeName, library.UsedRelativePaths);
        var absolutePath = Path.Combine(sourceFolder, fileName);

        try
        {
            var dds = DDSIO.GetDDSFile(texture);
            File.WriteAllBytes(absolutePath, dds);
        }
        catch
        {
            return;
        }

        var relativePath = ToManifestPath(Path.Combine("textures", relativeFolder, fileName));
        var entry = new ExportedTextureEntry(
            textureName,
            source,
            relativePath,
            texture.NameHash
        );

        library.Entries.Add(entry);
        library.ByInstance[texture] = entry;

        if (addByName)
        {
            var key = NormalizeTextureLookupKey(textureName);
            if (!library.ByName.ContainsKey(key))
            {
                library.ByName[key] = entry;
            }
        }
    }

    private static List<MeshTextureBinding> ExtractTextureBindings(
        ShaderFX? shader,
        TextureLibrary textureLibrary,
        MeshUvSets uvSets,
        string shaderName,
        string materialName)
    {
        var bindings = new List<MeshTextureBinding>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var parameters = shader?.ParametersList?.Parameters;
        var hashes = shader?.ParametersList?.Hashes;
        if (parameters == null || hashes == null) return bindings;

        var count = Math.Min(parameters.Length, hashes.Length);
        for (var index = 0; index < count; index += 1)
        {
            var param = parameters[index];
            if (param == null || param.DataType != 0) continue;
            if (param.Data is not TextureBase textureBase) continue;

            var paramName = GetParamName(hashes[index]);
            if (string.IsNullOrWhiteSpace(paramName)) continue;

            var textureName = GetTextureName(textureBase);
            var resolved = ResolveTextureEntry(textureBase, textureLibrary);
            var usage = ClassifyTextureUsage(paramName, textureName);
            var signature = $"{paramName}::{textureName}::{resolved?.RelativePath ?? string.Empty}::{usage}";
            if (!seen.Add(signature)) continue;
            var uvSet = ResolveTextureUvSet(paramName, textureName, shaderName, materialName, uvSets);

            bindings.Add(new MeshTextureBinding(
                paramName,
                textureName,
                resolved?.RelativePath ?? string.Empty,
                resolved?.Source ?? string.Empty,
                resolved?.NameHash ?? textureBase.NameHash,
                usage,
                uvSet
            ));
        }

        return bindings;
    }

    private static int? ResolveTextureUvSet(
        string paramName,
        string textureName,
        string shaderName,
        string materialName,
        MeshUvSets uvSets)
    {
        var param = (paramName ?? string.Empty).Trim().ToLowerInvariant();
        var texture = (textureName ?? string.Empty).Trim().ToLowerInvariant();
        var shader = (shaderName ?? string.Empty).Trim().ToLowerInvariant();
        var material = (materialName ?? string.Empty).Trim().ToLowerInvariant();
        var combined = $"{param} {texture} {shader} {material}";

        var suffixUvSet = TryGetUvSetFromParamSuffix(param);
        if (suffixUvSet.HasValue && HasUvSet(uvSets, suffixUvSet.Value))
        {
            return suffixUvSet.Value;
        }

        if (HasUvSet(uvSets, 1) &&
            (param.Contains("diffusesampler2") ||
             param.Contains("damagesampler2") ||
             param.Contains("detailsampler2") ||
             param.Contains("bumpsampler2") ||
             param.Contains("specsampler2") ||
             combined.Contains(" sign") ||
             combined.Contains("_sign") ||
             combined.Contains("decal") ||
             combined.Contains("logo") ||
             combined.Contains("wrap") ||
             combined.Contains("livery") ||
             combined.Contains("tplt") ||
             combined.Contains("template")))
        {
            return 1;
        }

        if (HasUvSet(uvSets, 2) &&
            (param.Contains("diffusesampler3") ||
             param.Contains("detailsampler3") ||
             param.Contains("bumpsampler3") ||
             param.Contains("specsampler3") ||
             combined.Contains("uv3") ||
             combined.Contains("texcoord2")))
        {
            return 2;
        }

        if (HasUvSet(uvSets, 3) &&
            (param.Contains("diffusesampler4") ||
             param.Contains("detailsampler4") ||
             param.Contains("bumpsampler4") ||
             param.Contains("specsampler4") ||
             combined.Contains("uv4") ||
             combined.Contains("texcoord3")))
        {
            return 3;
        }

        if (HasUvSet(uvSets, 0)) return 0;
        return GetFirstAvailableUvSet(uvSets);
    }

    private static int? TryGetUvSetFromParamSuffix(string paramName)
    {
        if (string.IsNullOrWhiteSpace(paramName)) return null;
        var lastChar = paramName[paramName.Length - 1];
        if (!char.IsDigit(lastChar)) return null;
        var uvSet = (int)char.GetNumericValue(lastChar) - 1;
        return uvSet is >= 0 and <= 3 ? uvSet : null;
    }

    private static bool HasUvSet(MeshUvSets uvSets, int index) => index switch
    {
        0 => uvSets.Uv0,
        1 => uvSets.Uv1,
        2 => uvSets.Uv2,
        3 => uvSets.Uv3,
        _ => false,
    };

    private static int? GetFirstAvailableUvSet(MeshUvSets uvSets)
    {
        if (uvSets.Uv0) return 0;
        if (uvSets.Uv1) return 1;
        if (uvSets.Uv2) return 2;
        if (uvSets.Uv3) return 3;
        return null;
    }

    private static ExportedTextureEntry? ResolveTextureEntry(TextureBase textureBase, TextureLibrary textureLibrary)
    {
        if (textureBase is Texture texture && textureLibrary.ByInstance.TryGetValue(texture, out var embedded))
        {
            return embedded;
        }

        var lookupName = GetTextureName(textureBase);
        if (!string.IsNullOrWhiteSpace(lookupName) && textureLibrary.ByName.TryGetValue(NormalizeTextureLookupKey(lookupName), out var named))
        {
            return named;
        }

        return null;
    }

    private static string ClassifyTextureUsage(string paramName, string textureName)
    {
        var raw = $"{paramName} {textureName}".Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(raw)) return "unknown";

        if (raw.Contains("dirt") || raw.Contains("mud") || raw.Contains("grime")) return "dirt";
        if (raw.Contains("normal") || raw.Contains("bump") || raw.Contains("nrm")) return "normal";
        if (raw.Contains("emissive") || raw.Contains("glow") || raw.Contains("light")) return "emissive";
        if (raw.Contains("spec") || raw.Contains("gloss") || raw.Contains("reflect")) return "specular";
        if (raw.Contains("detail")) return "detail";
        if (raw.Contains("mask") || raw.Contains("control") || raw.Contains("palette") || raw.Contains("lookup")) return "mask";
        if (raw.Contains("ao") || raw.Contains("ambient")) return "ambientOcclusion";
        return "baseColor";
    }

    private static string GetTextureName(TextureBase texture)
    {
        if (!string.IsNullOrWhiteSpace(texture.Name)) return texture.Name;
        return texture.NameHash != 0 ? $"hash_{texture.NameHash:X8}" : string.Empty;
    }

    private static string NormalizeTextureLookupKey(string name) => (name ?? string.Empty).Trim().ToLowerInvariant();

    private static string SanitizeFileName(string name)
    {
        var value = string.IsNullOrWhiteSpace(name) ? "texture" : name.Trim();
        var builder = new StringBuilder(value.Length);
        var invalidChars = Path.GetInvalidFileNameChars();
        foreach (var ch in value)
        {
            builder.Append(Array.IndexOf(invalidChars, ch) >= 0 ? '_' : ch);
        }
        return builder.Length > 0 ? builder.ToString() : "texture";
    }

    private static string EnsureUniqueFileName(string folder, string baseName, HashSet<string> usedRelativePaths)
    {
        var sourceFolder = Path.GetFileName(folder) ?? string.Empty;
        var candidate = $"{baseName}.dds";
        var suffix = 1;
        while (true)
        {
            var fullPath = Path.Combine(folder, candidate);
            var relativePath = ToManifestPath(Path.Combine("textures", sourceFolder, candidate));
            if (!File.Exists(fullPath) && usedRelativePaths.Add(relativePath))
            {
                return candidate;
            }
            candidate = $"{baseName}_{suffix}.dds";
            suffix += 1;
        }
    }

    private static string ToManifestPath(string path) => path.Replace('\\', '/');

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

    private static string GetShaderName(DrawableGeometry geom)
    {
        if (geom.Shader == null) return string.Empty;
        var shaderName = geom.Shader.Name.ToCleanString();
        if (!string.IsNullOrEmpty(shaderName)) return shaderName;
        var shaderHex = geom.Shader.Name.Hex;
        return string.IsNullOrEmpty(shaderHex) ? string.Empty : $"hash_{shaderHex}";
    }

    private static Dictionary<string, string> ExtractTextureRefs(ShaderFX? shader)
    {
        var refs = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var parameters = shader?.ParametersList?.Parameters;
        var hashes = shader?.ParametersList?.Hashes;
        if (parameters == null || hashes == null) return refs;

        var count = Math.Min(parameters.Length, hashes.Length);
        for (var index = 0; index < count; index += 1)
        {
            var param = parameters[index];
            if (param == null || param.DataType != 0) continue;
            if (param.Data is not TextureBase texture) continue;

            var paramName = GetParamName(hashes[index]);
            if (string.IsNullOrWhiteSpace(paramName) || refs.ContainsKey(paramName)) continue;

            var textureName = !string.IsNullOrWhiteSpace(texture.Name)
                ? texture.Name
                : texture.NameHash != 0
                    ? $"hash_{texture.NameHash:X8}"
                    : string.Empty;

            if (string.IsNullOrWhiteSpace(textureName)) continue;
            refs[paramName] = textureName;
        }

        return refs;
    }

    private static string GetParamName(MetaName hash)
    {
        var name = hash.ToString()?.Trim() ?? string.Empty;
        if (!string.IsNullOrEmpty(name) && !uint.TryParse(name, out _)) return name;
        var value = (uint)hash;
        return value == 0 ? string.Empty : $"hash_{value:X8}";
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
            if (mesh.Uvs2 != null) flags |= 0x4;
            if (mesh.Uvs3 != null) flags |= 0x8;
            if (mesh.Uvs4 != null) flags |= 0x10;
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
            if ((flags & 0x4) != 0 && mesh.Uvs2 != null)
            {
                WriteFloatArray(writer, mesh.Uvs2);
            }
            if ((flags & 0x8) != 0 && mesh.Uvs3 != null)
            {
                WriteFloatArray(writer, mesh.Uvs3);
            }
            if ((flags & 0x10) != 0 && mesh.Uvs4 != null)
            {
                WriteFloatArray(writer, mesh.Uvs4);
            }
            WriteUIntArray(writer, mesh.Indices);
        }
    }

    private static void WriteManifest(string manifestPath, string inputPath, List<MeshData> meshes, TextureLibrary textureLibrary)
    {
        var directory = Path.GetDirectoryName(manifestPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var manifest = new
        {
            version = 3,
            inputPath,
            generatedAtUtc = DateTime.UtcNow,
            meshCount = meshes.Count,
            textureCount = textureLibrary.Entries.Count,
            textures = textureLibrary.Entries.Select(texture => new
            {
                name = texture.Name,
                source = texture.Source,
                relativePath = texture.RelativePath,
                nameHash = texture.NameHash,
            }),
            meshes = meshes.Select(mesh => new
            {
                name = mesh.Name,
                materialName = mesh.MaterialName,
                shaderName = mesh.ShaderName,
                shaderHash = mesh.ShaderHash,
                shaderFileName = mesh.ShaderFileName,
                renderBucket = mesh.RenderBucket,
                drawableIndex = mesh.DrawableIndex,
                modelIndex = mesh.ModelIndex,
                geometryIndex = mesh.GeometryIndex,
                uvSets = mesh.UvSets,
                textureBindings = mesh.TextureBindings.Select(binding => new
                {
                    paramName = binding.ParamName,
                    textureName = binding.TextureName,
                    relativePath = binding.RelativePath,
                    source = binding.Source,
                    nameHash = binding.NameHash,
                    usage = binding.Usage,
                    uvSet = binding.UvSet,
                }),
                textureRefs = mesh.TextureRefs,
                resolvedTexturePaths = mesh.ResolvedTexturePaths,
            }),
        };

        var json = JsonSerializer.Serialize(manifest, new JsonSerializerOptions
        {
            WriteIndented = true,
        });
        File.WriteAllText(manifestPath, json);
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
    public MeshData(
        string name,
        string materialName,
        float[] positions,
        float[]? normals,
        float[]? uvs,
        float[]? uvs2,
        float[]? uvs3,
        float[]? uvs4,
        uint[] indices,
        string shaderName,
        uint shaderHash,
        string shaderFileName,
        byte renderBucket,
        int drawableIndex,
        int modelIndex,
        int geometryIndex,
        MeshUvSets uvSets,
        List<MeshTextureBinding> textureBindings,
        Dictionary<string, string> textureRefs,
        Dictionary<string, string> resolvedTexturePaths)
    {
        Name = name;
        MaterialName = materialName;
        Positions = positions;
        Normals = normals;
        Uvs = uvs;
        Uvs2 = uvs2;
        Uvs3 = uvs3;
        Uvs4 = uvs4;
        Indices = indices;
        ShaderName = shaderName;
        ShaderHash = shaderHash;
        ShaderFileName = shaderFileName;
        RenderBucket = renderBucket;
        DrawableIndex = drawableIndex;
        ModelIndex = modelIndex;
        GeometryIndex = geometryIndex;
        UvSets = uvSets;
        TextureBindings = textureBindings;
        TextureRefs = textureRefs;
        ResolvedTexturePaths = resolvedTexturePaths;
    }

    public string Name { get; }
    public string MaterialName { get; }
    public float[] Positions { get; }
    public float[]? Normals { get; }
    public float[]? Uvs { get; }
    public float[]? Uvs2 { get; }
    public float[]? Uvs3 { get; }
    public float[]? Uvs4 { get; }
    public uint[] Indices { get; }
    public string ShaderName { get; }
    public uint ShaderHash { get; }
    public string ShaderFileName { get; }
    public byte RenderBucket { get; }
    public int DrawableIndex { get; }
    public int ModelIndex { get; }
    public int GeometryIndex { get; }
    public MeshUvSets UvSets { get; }
    public List<MeshTextureBinding> TextureBindings { get; }
    public Dictionary<string, string> TextureRefs { get; }
    public Dictionary<string, string> ResolvedTexturePaths { get; }

    public int VertexCount => Positions.Length / 3;
    public int IndexCount => Indices.Length;
}

public sealed record MeshUvSets(bool Uv0, bool Uv1, bool Uv2, bool Uv3);

public sealed record MeshTextureBinding(
    string ParamName,
    string TextureName,
    string RelativePath,
    string Source,
    uint NameHash,
    string Usage,
    int? UvSet);

public sealed class TextureLibrary
{
    public List<ExportedTextureEntry> Entries { get; } = new();
    public Dictionary<Texture, ExportedTextureEntry> ByInstance { get; } = new();
    public Dictionary<string, ExportedTextureEntry> ByName { get; } = new(StringComparer.OrdinalIgnoreCase);
    public HashSet<string> UsedRelativePaths { get; } = new(StringComparer.OrdinalIgnoreCase);
}

public sealed record ExportedTextureEntry(string Name, string Source, string RelativePath, uint NameHash);

public sealed class VehicleTextureContext
{
    public VehicleTextureContext(string modelName, string resourceRoot)
    {
        ModelName = modelName;
        CurrentTxdName = modelName;
        ResourceRoot = resourceRoot;
    }

    public string ModelName { get; }
    public string CurrentTxdName { get; set; }
    public string ResourceRoot { get; }
    public string ResidentTxd { get; private set; } = string.Empty;
    public Dictionary<string, string> Relationships { get; } = new(StringComparer.OrdinalIgnoreCase);

    public void AddResidentTxd(string? txdName)
    {
        if (!string.IsNullOrWhiteSpace(txdName)) ResidentTxd = txdName.Trim();
    }

    public void AddRelationship(string? child, string? parent)
    {
        if (string.IsNullOrWhiteSpace(child) || string.IsNullOrWhiteSpace(parent)) return;
        if (!Relationships.ContainsKey(child))
        {
            Relationships[child] = parent;
        }
    }

    public IEnumerable<string> EnumerateRequestedTxdNames()
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(CurrentTxdName) && seen.Add(CurrentTxdName)) yield return CurrentTxdName;

        var next = CurrentTxdName;
        var guard = 0;
        while (!string.IsNullOrWhiteSpace(next) && Relationships.TryGetValue(next, out var parent))
        {
            if (!seen.Add(parent)) break;
            yield return parent;
            next = parent;
            guard += 1;
            if (guard > 12) break;
        }

        if (!string.IsNullOrWhiteSpace(ResidentTxd) && seen.Add(ResidentTxd)) yield return ResidentTxd;
    }
}

public sealed record SharedTextureArchive(
    RpfManager Manager,
    Dictionary<string, RpfFileEntry> YtdEntries,
    Dictionary<string, string> ParentRelationships)
{
    public HashSet<string> ExportedTxdNames { get; } = new(StringComparer.OrdinalIgnoreCase);
}
