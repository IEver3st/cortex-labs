using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using CodeWalker.GameFiles;
using CodeWalker.Utils;
using Microsoft.Win32;
using SharpDX;
using System.Xml;
using System.Security.Cryptography;
using DxHalf = SharpDX.Half;

namespace CodeWalkerBridge;

public static partial class Program
{
    private const string Magic = "CLM1";
    private const ushort Version = 3;
    private static string? LoadedGtaKeyFolder;

    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static bool JenkIndexLoaded;
    private static bool SharedArchiveResolved;
    private static SharedTextureArchive? SharedArchive;
    private static readonly Dictionary<string, Dictionary<string, RpfFileEntry>> PedIndexCache = new(StringComparer.OrdinalIgnoreCase);

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        if (args.Any(arg => string.Equals(arg, "--serve", StringComparison.OrdinalIgnoreCase)))
        {
            return RunServe();
        }

        var inputPath = GetArg(args, "--input");
        var outputPath = GetArg(args, "--output");
        if (string.IsNullOrWhiteSpace(inputPath) || string.IsNullOrWhiteSpace(outputPath))
        {
            Console.Error.WriteLine("Usage: CodeWalkerBridge --input <file.yft|ydr|ydd> --output <file.clmesh>");
            Console.Error.WriteLine("       CodeWalkerBridge --serve");
            return 2;
        }

        try
        {
            // stdout carries only the JSON summary; CodeWalker.Core diagnostics go to stderr.
            var summaryOut = Console.Out;
            Console.SetOut(Console.Error);
            var meta = ParseYft(inputPath, outputPath);
            summaryOut.WriteLine(JsonSerializer.Serialize(meta, JsonOptions));
            summaryOut.Flush();
            return 0;
        }
        catch (BridgeException ex)
        {
            Console.Error.WriteLine(ex.Message);
            return ex.ExitCode;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.ToString());
            return 1;
        }
    }

    /// Serve mode: one JSON request per stdin line, one JSON response per stdout line.
    /// stdout carries protocol lines only; CodeWalker.Core diagnostics are redirected to stderr.
    private static int RunServe()
    {
        var protocolOut = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        Console.SetOut(Console.Error);
        using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));

        string? line;
        while ((line = input.ReadLine()) != null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;

            long id = 0;
            string response;
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                if (root.TryGetProperty("id", out var idElement) && idElement.ValueKind == JsonValueKind.Number)
                {
                    id = idElement.GetInt64();
                }
                var op = root.TryGetProperty("op", out var opElement) ? opElement.GetString() ?? string.Empty : string.Empty;
                var result = Dispatch(op, root);
                response = JsonSerializer.Serialize(new { id, ok = true, result }, JsonOptions);
            }
            catch (Exception ex)
            {
                var message = ex is BridgeException ? ex.Message : $"{ex.GetType().Name}: {ex.Message}";
                Console.Error.WriteLine($"[serve] request {id} failed: {(ex is BridgeException ? ex.Message : ex.ToString())}");
                response = JsonSerializer.Serialize(new { id, ok = false, error = message }, JsonOptions);
            }

            protocolOut.WriteLine(response);
        }

        return 0;
    }

    private static object Dispatch(string op, JsonElement request)
    {
        switch (op)
        {
            case "ping":
                return new { };
            case "warmSharedTextures":
                // Builds the shared texture index the first parse would otherwise wait on.
                return new { available = GetSharedTextureArchive() != null };
            case "parseYft":
                return ParseYft(RequireString(request, "input"), RequireString(request, "output"));
            case "readCollisions":
                return ReadCollisions(RequireString(request, "input"));
            case "listPedAssets":
                return ListPedAssets(RequireString(request, "ped"));
            case "searchPeds":
                return SearchPeds(RequireString(request, "query"));
            case "describeGamePed":
                return DescribeGamePed(RequireString(request, "ped"));
            case "describePedFiles":
                return DescribePedFiles(request);
            case "exportPedAsset":
                return ExportPedAsset(
                    RequireString(request, "ped"),
                    RequireString(request, "folder", allowEmpty: true),
                    RequireString(request, "file"),
                    RequireString(request, "outputDir"));
            case "exportYtd":
                return ExportYtd(RequireString(request, "path"), RequireString(request, "outputDir"));
            case "writeYtdTextures":
                return WriteYtdTextures(request);
            case "readPedVariation":
                return ReadPedVariation(RequireString(request, "path"));
            case "writePedVariation":
                return WritePedVariation(request);
            case "writeCreatureMetadata":
                return WriteCreatureMetadata(request);
            case "exportPlateTextures":
                return ExportPlateTextures(RequireString(request, "outputDir"));
            case "listPedClips":
                return ListPedClips(RequireString(request, "dict"));
            case "exportPedClip":
                return ExportPedClip(RequireString(request, "dict"), RequireString(request, "clip"));
            case "searchAnimDicts":
                return SearchAnimDicts(RequireString(request, "query"));
            case "listClipFile":
                return ListClipFile(RequireString(request, "ycdPath"));
            case "exportClipFile":
                return ExportClipFile(RequireString(request, "ycdPath"), RequireString(request, "clip"));
            case "searchGameProps":
                return SearchGameProps(RequireString(request, "query"));
            case "exportGameProp":
                return ExportGameProp(RequireString(request, "name"), RequireString(request, "outputDir"));
            case "listGameVehicles":
                return ListGameVehicles();
            case "exportGameVehicle":
                return ExportGameVehicle(RequireString(request, "name"), RequireString(request, "outputDir"));
            case "exportGameVehicleMods":
                return ExportGameVehicleMods(RequireString(request, "name"), RequireString(request, "outputDir"));
            case "lookupGameText":
                return LookupGameText(request);
            case "exportModelClip":
                return ExportModelClip(
                    RequireString(request, "dict"),
                    RequireString(request, "clip"),
                    RequireString(request, "ycdPath", allowEmpty: true));
            default:
                throw new BridgeException($"Unknown op '{op}'.");
        }
    }

    private static string RequireString(JsonElement request, string name, bool allowEmpty = false)
    {
        if (!request.TryGetProperty(name, out var element) || element.ValueKind != JsonValueKind.String)
        {
            throw new BridgeException($"Missing string parameter '{name}'.");
        }
        var value = element.GetString() ?? string.Empty;
        if (!allowEmpty && string.IsNullOrWhiteSpace(value))
        {
            throw new BridgeException($"Parameter '{name}' must not be empty.");
        }
        return value;
    }

    /// A parsed model file: a fragment (.yft), a single drawable (.ydr), or a
    /// drawable dictionary (.ydd). Drawables are listed in file order and their
    /// position is the manifest drawableIndex.
    private sealed record ModelSource(
        string Format,
        FragType? Fragment,
        List<DrawableBase> Drawables,
        List<string> DrawableNames,
        List<DrawableBase> TextureOwners,
        List<ModelLightData> Lights);

    private static ModelSource LoadModelSource(string inputPath, byte[] data)
    {
        var extension = Path.GetExtension(inputPath).ToLowerInvariant();
        switch (extension)
        {
            case ".yft":
            {
                var yft = new YftFile();
                yft.Load(data);
                var fragment = yft.Fragment ?? throw new BridgeException("The YFT has no fragment data.", 3);
                var drawables = FragmentDrawables(fragment);
                var names = drawables.Select((drawable, index) => DrawableLabel(drawable, index)).ToList();
                var lights = CollectModelLights(fragment.LightAttributes?.data_items, fragment.Drawable?.Skeleton, 0);
                return new ModelSource("yft", fragment, drawables, names, FragmentTextureOwners(fragment), lights);
            }
            case ".ydr":
            {
                var ydr = new YdrFile();
                ydr.Load(data);
                var drawable = ydr.Drawable ?? throw new BridgeException("The YDR has no drawable.", 3);
                var lights = CollectModelLights(drawable.LightAttributes?.data_items, drawable.Skeleton, 0);
                return new ModelSource("ydr", null, new List<DrawableBase> { drawable },
                    new List<string> { DrawableLabel(drawable, 0) }, new List<DrawableBase> { drawable }, lights);
            }
            case ".ydd":
            {
                var ydd = new YddFile();
                ydd.Load(data);
                // File order, not the hash-keyed Dict, so drawableIndex is stable.
                var items = ydd.DrawableDict?.Drawables?.data_items?.Where(drawable => drawable != null).ToList()
                    ?? new List<Drawable>();
                if (items.Count == 0) throw new BridgeException("The YDD has no drawables.", 3);
                var drawables = items.Cast<DrawableBase>().ToList();
                var lights = new List<ModelLightData>();
                for (var index = 0; index < items.Count; index += 1)
                {
                    lights.AddRange(CollectModelLights(items[index].LightAttributes?.data_items, items[index].Skeleton, index));
                }
                return new ModelSource("ydd", null, drawables,
                    items.Select((drawable, index) => DrawableLabel(drawable, index)).ToList(), drawables, lights);
            }
            default:
                throw new BridgeException($"Unsupported model type '{extension}'. Expected .yft, .ydr or .ydd.", 2);
        }
    }

    private static string DrawableLabel(DrawableBase drawable, int index)
    {
        var name = drawable switch
        {
            Drawable plain => plain.Name,
            FragDrawable fragment => fragment.Name,
            _ => null,
        };
        return string.IsNullOrWhiteSpace(name) ? $"drawable_{index}" : name.Trim();
    }

    private static object ParseYft(string inputPath, string outputPath)
    {
        var context = new ParseContext();
        CurrentParse = context;
        try
        {
            LoadJenkIndexStrings();
            var data = File.ReadAllBytes(inputPath);
            var source = LoadModelSource(inputPath, data);

            var outputDirectory = Path.GetDirectoryName(outputPath) ?? string.Empty;
            var textureLibrary = ExportTextures(source, inputPath, outputDirectory);

            var baseName = Path.GetFileNameWithoutExtension(inputPath);
            var meshes = source.Fragment != null
                ? ExtractMeshes(source.Fragment, baseName, textureLibrary)
                : ExtractDrawableMeshes(source.Drawables, baseName, textureLibrary, null, out _);
            if (meshes.Count == 0)
            {
                throw new BridgeException($"No meshes were extracted from the {source.Format.ToUpperInvariant()}.", 3);
            }

            WriteClmesh(outputPath, meshes);
            var manifestPath = Path.Combine(outputDirectory, "manifest.json");
            var inputs = context.Inputs.Values.ToList();
            WriteManifest(manifestPath, inputPath, source, meshes, textureLibrary, CollectLightBones(source.Fragment?.Drawable?.Skeleton),
                CollectSkeleton(source.Fragment?.Drawable), inputs);

            return new
            {
                meshCount = meshes.Count,
                vertexCount = meshes.Sum(m => m.VertexCount),
                indexCount = meshes.Sum(m => m.IndexCount),
                materialCount = meshes.Select(m => m.MaterialName).Where(n => !string.IsNullOrEmpty(n)).Distinct().Count(),
                textureCount = textureLibrary.Entries.Count,
                manifestPath,
                warnings = context.Warnings,
                inputs,
            };
        }
        finally
        {
            CurrentParse = null;
        }
    }

    /// What one model parse depended on and what it had to skip. The host reuses
    /// a cached parse only while every recorded input is unchanged, and shows the
    /// warnings next to the model.
    private sealed class ParseContext
    {
        public List<string> Warnings { get; } = new();
        public Dictionary<string, ParseInput> Inputs { get; } = new(StringComparer.OrdinalIgnoreCase);
    }

    /// A file a parse read (`MtimeMs`/`Size` as the host's stat reports them) or a
    /// candidate it looked for and did not find (`Missing`).
    private sealed record ParseInput(
        [property: JsonPropertyName("path")] string Path,
        [property: JsonPropertyName("mtimeMs"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? MtimeMs,
        [property: JsonPropertyName("size"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)] long? Size,
        [property: JsonPropertyName("missing"), JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)] bool Missing);

    private const int MaxParseWarnings = 200;

    // Serve mode handles one request at a time, so the parse in progress is global.
    private static ParseContext? CurrentParse;

    /// A texture or texture source the parse skipped. Short, names the file, never
    /// includes file contents.
    private static void Warn(string message)
    {
        Console.Error.WriteLine($"[parse] {message}");
        if (CurrentParse == null || CurrentParse.Warnings.Count >= MaxParseWarnings) return;
        CurrentParse.Warnings.Add(message);
    }

    private static string ShortReason(Exception ex)
    {
        var reason = ex.Message.ReplaceLineEndings(" ").Trim();
        return reason.Length <= 160 ? reason : reason[..157] + "...";
    }

    /// Records a file the current parse depends on. Call it before reading the file,
    /// so an edit that races the read leaves the entry stale rather than hiding it.
    private static void RecordInput(string path)
    {
        if (CurrentParse == null || string.IsNullOrWhiteSpace(path)) return;
        string fullPath;
        try
        {
            fullPath = Path.GetFullPath(path);
            var info = new FileInfo(fullPath);
            CurrentParse.Inputs[fullPath] = info.Exists
                ? new ParseInput(fullPath,
                    Math.Max(0, (info.LastWriteTimeUtc - DateTime.UnixEpoch).Ticks / TimeSpan.TicksPerMillisecond),
                    info.Length, false)
                : new ParseInput(fullPath, null, null, true);
        }
        catch (Exception)
        {
            // Unstattable: record it without an identity so the entry is never reused.
            CurrentParse.Inputs[path] = new ParseInput(path, null, null, false);
        }
    }

    private static Dictionary<string, RpfFileEntry> GetPedIndex(string ped)
    {
        if (PedIndexCache.TryGetValue(ped, out var cached)) return cached;

        var archive = GetSharedTextureArchive()
            ?? throw new BridgeException("GTA V installation was not found, so ped assets cannot be listed.");

        var index = new Dictionary<string, RpfFileEntry>(StringComparer.OrdinalIgnoreCase);
        var priorities = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var pedLower = ped.Trim().ToLowerInvariant();
        var pedPrefix = pedLower + "_";

        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                var ext = Path.GetExtension(name);
                var folder = entry.Parent?.NameLower ?? string.Empty;

                var isComponent = (ext == ".ydd" || ext == ".ytd")
                    && (folder == pedLower || folder.StartsWith(pedPrefix, StringComparison.Ordinal));
                // The ped's own files: skeleton, variations, and for component peds the
                // drawable and texture dictionaries (<ped>_p for props).
                var isPedRoot = ((ext == ".yft" || ext == ".ydd" || ext == ".ytd" || ext == ".ymt") && name == pedLower + ext)
                    || ((ext == ".ydd" || ext == ".ytd") && name == pedLower + "_p" + ext);
                if (!isComponent && !isPedRoot) continue;

                var key = PedAssetKey(folder, name);
                var priority = GetArchiveEntryPriority(entry.Path);
                if (!index.ContainsKey(key) || priority >= priorities[key])
                {
                    index[key] = entry;
                    priorities[key] = priority;
                }
            }
        }

        PedIndexCache[ped] = index;
        return index;
    }

    private static string PedAssetKey(string folder, string file) => $"{folder.ToLowerInvariant()}/{file.ToLowerInvariant()}";

    private static object ListPedAssets(string ped)
    {
        var index = GetPedIndex(ped);
        var entries = index.Values
            .Select(entry => new
            {
                folder = entry.Parent?.NameLower ?? string.Empty,
                file = entry.NameLower ?? string.Empty,
                kind = Path.GetExtension(entry.NameLower ?? string.Empty).TrimStart('.'),
                rpfPath = entry.Path,
                size = entry.GetFileSize(),
            })
            .OrderBy(item => item.folder, StringComparer.Ordinal)
            .ThenBy(item => item.file, StringComparer.Ordinal)
            .ToList();
        return new { ped, entries, collections = ListPedCollections(ped) };
    }

    private static void ValidatePathSegment(string value, string name, bool allowEmpty)
    {
        if (string.IsNullOrEmpty(value))
        {
            if (allowEmpty) return;
            throw new BridgeException($"Parameter '{name}' must not be empty.");
        }
        if (value == "." || value.Contains("..") || value.IndexOfAny(new[] { '/', '\\', ':' }) >= 0)
        {
            throw new BridgeException($"Parameter '{name}' must be a single path segment.");
        }
    }

    private static object ExportPedAsset(string ped, string folder, string file, string outputDir)
    {
        ValidatePathSegment(folder, "folder", allowEmpty: true);
        ValidatePathSegment(file, "file", allowEmpty: false);

        var index = GetPedIndex(ped);
        if (!index.TryGetValue(PedAssetKey(folder, file), out var entry))
        {
            throw new BridgeException($"Ped asset '{folder}/{file}' was not found for '{ped}'.");
        }

        var archive = GetSharedTextureArchive()
            ?? throw new BridgeException("GTA V installation was not found.");
        var fileName = entry.NameLower ?? file.ToLowerInvariant();
        var targetFolder = string.IsNullOrEmpty(folder) ? outputDir : Path.Combine(outputDir, folder.ToLowerInvariant());

        if (Path.GetExtension(fileName) == ".ytd")
        {
            var dir = Path.Combine(targetFolder, Path.GetFileNameWithoutExtension(fileName));
            var cached = TryReadTextureListing(dir);
            if (cached != null) return cached;

            var ytd = archive.Manager.GetFile<YtdFile>(entry)
                ?? throw new BridgeException($"Failed to load texture dictionary '{entry.Path}'.");
            return ExportTextureDictionary(ytd, dir);
        }

        var targetPath = Path.Combine(targetFolder, fileName);
        if (File.Exists(targetPath)) return new { path = targetPath };

        WriteRawEntry(entry, targetPath);
        return new { path = targetPath };
    }

    private static object ExportYtd(string path, string outputDir)
    {
        if (!File.Exists(path)) throw new BridgeException($"Texture dictionary not found: {path}");
        var cached = TryReadTextureListing(outputDir);
        if (cached != null) return cached;

        var ytd = LoadYtdFromPath(path, out var loadError)
            ?? throw new BridgeException($"Failed to load texture dictionary {Path.GetFileName(path)}: {loadError}");
        return ExportTextureDictionary(ytd, outputDir);
    }

    private const string TextureListingFileName = "textures.json";

    private static TextureListing? TryReadTextureListing(string dir)
    {
        var listingPath = Path.Combine(dir, TextureListingFileName);
        if (!File.Exists(listingPath)) return null;
        try
        {
            var listing = JsonSerializer.Deserialize<TextureListing>(File.ReadAllText(listingPath), JsonOptions);
            if (listing?.Textures == null) return null;
            if (listing.Textures.Any(texture => string.IsNullOrEmpty(texture.Path) || !File.Exists(texture.Path))) return null;
            return listing with { Dir = dir, Warnings = listing.Warnings ?? new List<string>() };
        }
        catch
        {
            return null;
        }
    }

    // Plate backgrounds (plate01..., yankton_plate, DLC plates), their normal maps,
    // and the plate font atlas.
    private static readonly System.Text.RegularExpressions.Regex PlateTexturePattern = new(
        @"^(vehicle_generic_plate_font|[a-z0-9]*plate\d*|plate_[a-z0-9_]+|[a-z0-9]+_plate)(_n)?$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private const string PlateListingFileName = "plates.json";

    /// License plate textures from every vehshare.ytd in the archives (base game,
    /// update and DLC packs; highest priority first so newer copies win), plus the
    /// game's plate definitions from carcols.ymt: per plate index, the background
    /// and normal map, font colour and outline, text extents and letter count.
    private static object ExportPlateTextures(string outputDir)
    {
        var cached = TryReadPlateListing(outputDir);
        if (cached != null) return cached;
        var archive = GetSharedTextureArchive()
            ?? throw new BridgeException("GTA V installation was not found.");
        var entries = (archive.Manager.AllRpfs ?? new List<RpfFile>())
            .SelectMany(rpf => rpf.AllEntries ?? new List<RpfEntry>())
            .OfType<RpfFileEntry>()
            .ToList();
        var sources = entries
            .Where(entry => entry.NameLower == "vehshare.ytd")
            .OrderByDescending(entry => GetArchiveEntryPriority(entry.Path))
            .ToList();
        if (sources.Count == 0) throw new BridgeException("vehshare.ytd was not found in the GTA V archives.");
        Directory.CreateDirectory(outputDir);
        var merged = new Dictionary<string, TextureListingEntry>(StringComparer.OrdinalIgnoreCase);
        for (var index = 0; index < sources.Count; index += 1)
        {
            var ytd = archive.Manager.GetFile<YtdFile>(sources[index]);
            if (ytd == null) continue;
            var listing = ExportTextureDictionary(ytd, Path.Combine(outputDir, $"vehshare_{index}"), texture =>
                PlateTexturePattern.IsMatch(texture) && !merged.ContainsKey(texture));
            foreach (var texture in listing.Textures) merged.TryAdd(texture.Name, texture);
        }

        // Plate definitions: the highest-priority carcols.ymt that defines plates.
        var byHash = merged.Keys.ToDictionary(name => JenkHash.GenHash(name.ToLowerInvariant()), name => name);
        string? nameOf(MetaHash hash) => byHash.TryGetValue((uint)hash, out var name) ? name : null;
        string hexColor(uint argb) => $"#{argb & 0xFFFFFF:x6}";
        object? definitions = null;
        foreach (var entry in entries.Where(entry => entry.NameLower == "carcols.ymt").OrderByDescending(entry => GetArchiveEntryPriority(entry.Path)))
        {
            CarColsFile? carcols;
            try { carcols = archive.Manager.GetFile<CarColsFile>(entry); }
            catch { continue; }
            var plates = carcols?.VehicleModelInfo?.VehiclePlates;
            if (plates?.Textures == null || plates.Textures.Length == 0) continue;
            definitions = new
            {
                source = entry.Path,
                defaultIndex = plates.DefaultTexureIndex,
                numericOffset = plates.NumericOffset,
                alphabeticOffset = plates.AlphabeticOffset,
                spaceOffset = plates.SpaceOffset,
                plates = plates.Textures.Select((plate, index) => new
                {
                    index,
                    diffuse = nameOf(plate.DiffuseMapName),
                    normal = nameOf(plate.NormalMapName),
                    fontExtents = new[] { plate.FontExtents.X, plate.FontExtents.Y, plate.FontExtents.Z, plate.FontExtents.W },
                    maxLetters = new[] { plate.MaxLettersOnPlate.X, plate.MaxLettersOnPlate.Y },
                    fontColor = hexColor(plate.FontColor),
                    fontOutlineColor = hexColor(plate.FontOutlineColor),
                    fontOutline = plate.IsFontOutlineEnabled,
                    fontOutlineDepth = new[] { plate.FontOutlineMinMaxDepth.X, plate.FontOutlineMinMaxDepth.Y },
                }).ToArray(),
            };
            break;
        }

        var result = new
        {
            dir = outputDir,
            textures = merged.Values.OrderBy(texture => texture.Name, StringComparer.OrdinalIgnoreCase).ToList(),
            definitions,
        };
        File.WriteAllText(Path.Combine(outputDir, PlateListingFileName), JsonSerializer.Serialize(result, JsonOptions));
        return result;
    }

    private static JsonElement? TryReadPlateListing(string dir)
    {
        var path = Path.Combine(dir, PlateListingFileName);
        if (!File.Exists(path)) return null;
        try
        {
            using var document = JsonDocument.Parse(File.ReadAllText(path));
            var root = document.RootElement;
            if (!root.TryGetProperty("textures", out var textures) || textures.ValueKind != JsonValueKind.Array) return null;
            foreach (var texture in textures.EnumerateArray())
            {
                if (!texture.TryGetProperty("path", out var texturePath) || !File.Exists(texturePath.GetString())) return null;
            }
            return root.Clone();
        }
        catch
        {
            return null;
        }
    }

    private static TextureListing ExportTextureDictionary(YtdFile ytd, string dir, Func<string, bool>? include = null)
    {
        var textures = ytd.TextureDict?.Textures?.data_items ?? Array.Empty<Texture>();
        Directory.CreateDirectory(dir);

        var usedNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var exported = new List<TextureListingEntry>();
        var warnings = new List<string>();
        foreach (var texture in textures)
        {
            if (texture == null) continue;
            var textureName = GetTextureName(texture);
            if (string.IsNullOrWhiteSpace(textureName)) continue;
            if (include != null && !include(textureName)) continue;

            var baseName = SanitizeFileName(textureName);
            var fileName = $"{baseName}.dds";
            var suffix = 1;
            while (!usedNames.Add(fileName))
            {
                fileName = $"{baseName}_{suffix}.dds";
                suffix += 1;
            }

            var absolutePath = Path.Combine(dir, fileName);
            try
            {
                File.WriteAllBytes(absolutePath, DDSIO.GetDDSFile(texture));
            }
            catch (Exception ex)
            {
                var warning = $"Texture '{textureName}' could not be exported: {ShortReason(ex)}";
                Console.Error.WriteLine($"[textures] {warning}");
                if (warnings.Count < MaxParseWarnings) warnings.Add(warning);
                continue;
            }
            exported.Add(new TextureListingEntry(textureName, absolutePath));
        }

        var listing = new TextureListing(dir, exported, warnings);
        File.WriteAllText(Path.Combine(dir, TextureListingFileName), JsonSerializer.Serialize(listing, JsonOptions));
        return listing;
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
        if (JenkIndexLoaded) return;
        JenkIndexLoaded = true;
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

    private static List<DrawableBase> FragmentDrawables(FragType fragment)
    {
        var drawables = new List<DrawableBase>();
        if (fragment.Drawable != null) drawables.Add(fragment.Drawable);
        if (fragment.DrawableArray?.data_items != null)
        {
            foreach (var drawable in fragment.DrawableArray.data_items)
            {
                if (drawable != null) drawables.Add(drawable);
            }
        }
        return drawables;
    }

    private static List<MeshData> ExtractMeshes(FragType fragment, string baseName, TextureLibrary textureLibrary)
    {
        var meshes = ExtractDrawableMeshes(FragmentDrawables(fragment), baseName, textureLibrary, fragment.Drawable?.Skeleton, out var drawableIndex);

        foreach (var wheel in CollectWheelInstances(fragment))
        {
            var models = EnumerateDrawableModels(wheel.Drawable).ToArray();
            for (var modelIndex = 0; modelIndex < models.Length; modelIndex += 1)
            {
                var (lodLevel, lodModelIndex, model) = models[modelIndex];
                if (model?.Geometries == null) continue;

                for (var geomIndex = 0; geomIndex < model.Geometries.Length; geomIndex += 1)
                {
                    var geom = model.Geometries[geomIndex];
                    if (geom == null) continue;

                    var mesh = ExtractMesh(
                        geom,
                        $"{baseName}_{wheel.BoneName}",
                        drawableIndex,
                        modelIndex,
                        lodLevel,
                        lodModelIndex,
                        geomIndex,
                        textureLibrary);
                    if (mesh == null) continue;
                    TransformMesh(mesh, wheel.Transform);
                    mesh.Part = "wheel";
                    mesh.PartName = wheel.BoneName;
                    mesh.PartOrigin = new[] { wheel.Transform.M41, wheel.Transform.M42, wheel.Transform.M43 };
                    mesh.BoneChain = new[] { wheel.BoneName };
                    meshes.Add(mesh);
                }
            }

            drawableIndex += 1;
        }

        return meshes;
    }

    /// Meshes of every drawable in order; `nextDrawableIndex` is one past the last.
    /// Meshes of the drawable that owns `poseSkeleton` (the manifest skeleton) also
    /// carry their bone index and, where vertices blend several bones, skin weights.
    private static List<MeshData> ExtractDrawableMeshes(
        IReadOnlyList<DrawableBase> drawables,
        string baseName,
        TextureLibrary textureLibrary,
        Skeleton? poseSkeleton,
        out int nextDrawableIndex)
    {
        var meshes = new List<MeshData>();
        var drawableIndex = 0;
        foreach (var drawable in drawables)
        {
            if (drawable.AllModels == null || drawable.AllModels.Length == 0)
            {
                drawable.BuildAllModels();
            }

            var models = EnumerateDrawableModels(drawable).ToArray();
            for (var modelIndex = 0; modelIndex < models.Length; modelIndex += 1)
            {
                var (lodLevel, lodModelIndex, model) = models[modelIndex];
                if (model?.Geometries == null) continue;

                for (var geomIndex = 0; geomIndex < model.Geometries.Length; geomIndex += 1)
                {
                    var geom = model.Geometries[geomIndex];
                    if (geom == null) continue;

                    var mesh = ExtractMesh(
                        geom,
                        baseName,
                        drawableIndex,
                        modelIndex,
                        lodLevel,
                        lodModelIndex,
                        geomIndex,
                        textureLibrary);
                    if (mesh != null)
                    {
                        var posable = poseSkeleton != null && ReferenceEquals(drawable.Skeleton, poseSkeleton);
                        meshes.AddRange(SplitExtraMeshes(mesh, geom, drawable.Skeleton, model.BoneIndex, posable));
                    }
                }
            }

            drawableIndex += 1;
        }

        nextDrawableIndex = drawableIndex;
        return meshes;
    }

    // Physics child bone tags for vehicle wheels, matching CodeWalker's fragment renderer.
    private static readonly Dictionary<ushort, (string Name, bool Front, bool Right)> WheelBoneTags = new()
    {
        [27922] = ("wheel_lf", true, false),
        [26418] = ("wheel_rf", true, true),
        [29921] = ("wheel_lm1", false, false),
        [29922] = ("wheel_lm2", false, false),
        [29923] = ("wheel_lm3", false, false),
        [27902] = ("wheel_lr", false, false),
        [5857] = ("wheel_rm1", false, true),
        [5858] = ("wheel_rm2", false, true),
        [5859] = ("wheel_rm3", false, true),
        [26398] = ("wheel_rr", false, true),
    };

    private sealed record WheelInstance(string BoneName, DrawableBase Drawable, Matrix Transform);

    /// GTA stores vehicle wheels outside the main drawable: each wheel is a physics
    /// child placed by FragTransforms, and usually only one front and one rear child
    /// carries geometry that the game instances onto the remaining wheel bones.
    private static List<WheelInstance> CollectWheelInstances(FragType fragment)
    {
        var result = new List<WheelInstance>();
        var lod = fragment.PhysicsLODGroup?.PhysicsLOD1;
        var children = lod?.Children?.data_items;
        if (lod == null || children == null) return result;

        static bool hasModels(DrawableBase? drawable)
        {
            if (drawable == null) return false;
            if (drawable.AllModels == null || drawable.AllModels.Length == 0) drawable.BuildAllModels();
            return drawable.AllModels?.Any(model => model?.Geometries?.Length > 0) == true;
        }

        DrawableBase? front = null;
        DrawableBase? rear = null;
        foreach (var child in children)
        {
            if (child == null || !WheelBoneTags.TryGetValue(child.BoneTag, out var tag) || !hasModels(child.Drawable1)) continue;
            if (tag.Front) front ??= child.Drawable1;
            else rear ??= child.Drawable1;
        }
        if (front == null && rear == null) return result;

        var matrices = lod.FragTransforms?.Matrices;
        for (var index = 0; index < children.Length; index += 1)
        {
            var child = children[index];
            if (child == null || !WheelBoneTags.TryGetValue(child.BoneTag, out var tag)) continue;
            var drawable = hasModels(child.Drawable1) ? child.Drawable1 : (tag.Front ? front ?? rear : rear ?? front);
            // Without the child's transform the wheel position is unknown; omit it rather than guess.
            if (drawable == null || matrices == null || index >= matrices.Length) continue;

            var transform = matrices[index];
            // Physics transforms are affine 3x4 data; the fourth column is not a projective row.
            transform.M14 = 0; transform.M24 = 0; transform.M34 = 0; transform.M44 = 1;
            transform.M41 += lod.PositionOffset.X;
            transform.M42 += lod.PositionOffset.Y;
            transform.M43 += lod.PositionOffset.Z;
            if (tag.Right)
            {
                // Right-side wheels reuse left-facing geometry rotated 180 degrees about the forward axis.
                transform.M11 = -1; transform.M12 = 0; transform.M13 = 0;
                transform.M21 = 0; transform.M22 = 1; transform.M23 = 0;
                transform.M31 = 0; transform.M32 = 0; transform.M33 = -1;
            }
            if (!transform.ToArray().All(float.IsFinite))
            {
                Warn($"Wheel '{tag.Name}' has a damaged transform and was left out.");
                continue;
            }
            result.Add(new WheelInstance(tag.Name, drawable, transform));
        }

        return result;
    }

    private static void TransformMesh(MeshData mesh, Matrix transform)
    {
        var positions = mesh.Positions;
        for (var i = 0; i + 2 < positions.Length; i += 3)
        {
            var point = Vector3.TransformCoordinate(new Vector3(positions[i], positions[i + 1], positions[i + 2]), transform);
            positions[i] = point.X; positions[i + 1] = point.Y; positions[i + 2] = point.Z;
        }

        var normals = mesh.Normals;
        if (normals != null)
        {
            for (var i = 0; i + 2 < normals.Length; i += 3)
            {
                var normal = Vector3.Normalize(Vector3.TransformNormal(new Vector3(normals[i], normals[i + 1], normals[i + 2]), transform));
                normals[i] = normal.X; normals[i + 1] = normal.Y; normals[i + 2] = normal.Z;
            }
        }

        // A mirroring transform flips triangle winding; restore front faces.
        if (transform.Determinant() < 0)
        {
            var indices = mesh.Indices;
            for (var i = 0; i + 2 < indices.Length; i += 3)
            {
                (indices[i + 1], indices[i + 2]) = (indices[i + 2], indices[i + 1]);
            }
        }
    }

    private static int? ExtraForBone(Skeleton? skeleton, int index)
    {
        var bones = skeleton?.Bones?.Items;
        for (var guard = 0; bones != null && index >= 0 && index < bones.Length && guard < bones.Length; guard++)
        {
            var bone = bones[index];
            if (bone.Name?.StartsWith("extra_", StringComparison.OrdinalIgnoreCase) == true)
            {
                var suffix = bone.Name[6..];
                if (int.TryParse(suffix, out var extra)) return extra;
                if (suffix.Equals("ten", StringComparison.OrdinalIgnoreCase)) return 10;
            }
            if (bone.ParentIndex == index) break;
            index = bone.ParentIndex;
        }
        return null;
    }

    /// Bone names from `index` up to the skeleton root. Mod kits hide stock parts
    /// by bone name (carcols turnOffBones), and hiding a bone hides its children.
    private static string[]? BoneChain(Skeleton? skeleton, int index)
    {
        var bones = skeleton?.Bones?.Items;
        if (bones == null || index < 0 || index >= bones.Length) return null;
        var chain = new List<string>();
        for (var guard = 0; index >= 0 && index < bones.Length && guard < bones.Length; guard++)
        {
            var bone = bones[index];
            if (!string.IsNullOrWhiteSpace(bone.Name)) chain.Add(bone.Name);
            if (bone.ParentIndex == index) break;
            index = bone.ParentIndex;
        }
        return chain.Count > 0 ? chain.ToArray() : null;
    }

    /// The single bone every vertex in `vertices` is dominantly bound to; -1
    /// when the vertices span several bones.
    private static int SharedBone(int[] vertexBones, IEnumerable<uint> vertices)
    {
        var shared = -1;
        foreach (var vertex in vertices)
        {
            var bone = vertex < vertexBones.Length ? vertexBones[vertex] : -1;
            if (bone < 0) return -1;
            if (shared < 0) shared = bone;
            else if (shared != bone) return -1;
        }
        return shared;
    }

    // Bones the game drives as vehicle lights. Siren bones flash and rotate from the
    // carcols siren settings; the others carry headlight, tail, brake, indicator and
    // reversing light positions.
    private static readonly System.Text.RegularExpressions.Regex LightBonePattern = new(
        @"^(siren\d+|siren_glass\d+|headlight_[lr]|taillight_[lr]|indicator_[lr][fr]|brakelight_[lrm]|reversinglight_[lr]|extralight_\d+|interiorlight)$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    // Front hub and wheel bones turn with the steering. Body geometry skinned to
    // them (brake calipers, rotors) has to turn with the wheel drawable.
    private static readonly HashSet<string> SteerBones = new(StringComparer.OrdinalIgnoreCase) { "hub_lf", "hub_rf", "wheel_lf", "wheel_rf" };

    private static string? SteerBoneFor(Skeleton? skeleton, int index)
    {
        var bones = skeleton?.Bones?.Items;
        for (var guard = 0; bones != null && index >= 0 && index < bones.Length && guard < bones.Length; guard++)
        {
            var bone = bones[index];
            if (bone.Name != null && SteerBones.Contains(bone.Name)) return bone.Name.ToLowerInvariant();
            if (bone.ParentIndex == index) break;
            index = bone.ParentIndex;
        }
        return null;
    }

    private static string? LightForBone(Skeleton? skeleton, int index)
    {
        var bones = skeleton?.Bones?.Items;
        for (var guard = 0; bones != null && index >= 0 && index < bones.Length && guard < bones.Length; guard++)
        {
            var bone = bones[index];
            if (bone.Name != null && LightBonePattern.IsMatch(bone.Name)) return bone.Name.ToLowerInvariant();
            if (bone.ParentIndex == index) break;
            index = bone.ParentIndex;
        }
        return null;
    }

    /// Model-space position and orientation of every light bone, so the viewer can
    /// place siren light sources and rotate beacons about their pivot.
    private static List<LightBoneData> CollectLightBones(Skeleton? skeleton)
    {
        var result = new List<LightBoneData>();
        var bones = skeleton?.Bones?.Items;
        if (bones == null) return result;
        var world = new Matrix?[bones.Length];
        Matrix Resolve(int index, int depth)
        {
            if (world[index] is { } cached) return cached;
            var bone = bones[index];
            var local = Matrix.AffineTransformation(1.0f, bone.Rotation, bone.Translation);
            var parent = bone.ParentIndex;
            var matrix = parent >= 0 && parent < bones.Length && parent != index && depth < bones.Length
                ? local * Resolve(parent, depth + 1)
                : local;
            world[index] = matrix;
            return matrix;
        }
        for (var i = 0; i < bones.Length; i++)
        {
            var bone = bones[i];
            if (bone?.Name == null || !LightBonePattern.IsMatch(bone.Name)) continue;
            var matrix = Resolve(i, 0);
            if (!matrix.Decompose(out _, out var rotation, out var translation)) continue;
            if (!IsFinite(translation) || !float.IsFinite(rotation.X) || !float.IsFinite(rotation.Y)
                || !float.IsFinite(rotation.Z) || !float.IsFinite(rotation.W))
            {
                Warn($"Light bone '{bone.Name}' has a damaged transform and was left out.");
                continue;
            }
            result.Add(new LightBoneData(bone.Name.ToLowerInvariant(), i,
                new[] { translation.X, translation.Y, translation.Z },
                new[] { rotation.X, rotation.Y, rotation.Z, rotation.W }));
        }
        return result;
    }

    /// The manifest skeleton: bind transforms keyed by index, plus joint limits
    /// keyed by bone tag as the resource stores them.
    private static SkeletonData? CollectSkeleton(DrawableBase? drawable)
    {
        var bones = drawable?.Skeleton?.Bones?.Items;
        if (bones == null || bones.Length == 0) return null;
        var result = new List<SkeletonBoneData>(bones.Length);
        for (var i = 0; i < bones.Length; i++)
        {
            var bone = bones[i];
            var parent = bone == null || bone.ParentIndex == i || bone.ParentIndex >= bones.Length ? -1 : bone.ParentIndex;
            var translation = bone?.Translation ?? Vector3.Zero;
            var rotation = bone?.Rotation ?? Quaternion.Identity;
            result.Add(new SkeletonBoneData(bone?.Name ?? string.Empty, bone?.Tag ?? 0, parent,
                new[] { translation.X, translation.Y, translation.Z },
                new[] { rotation.X, rotation.Y, rotation.Z, rotation.W }));
        }
        var joints = new List<JointLimitData>();
        foreach (var limit in drawable!.Joints?.RotationLimits ?? Array.Empty<JointRotationLimit_s>())
        {
            joints.Add(new JointLimitData(limit.BoneId, "rotation",
                new[] { limit.Min.X, limit.Min.Y, limit.Min.Z }, new[] { limit.Max.X, limit.Max.Y, limit.Max.Z }));
        }
        foreach (var limit in drawable.Joints?.TranslationLimits ?? Array.Empty<JointTranslationLimit_s>())
        {
            joints.Add(new JointLimitData((int)limit.BoneId, "translation",
                new[] { limit.Min.X, limit.Min.Y, limit.Min.Z }, new[] { limit.Max.X, limit.Max.Y, limit.Max.Z }));
        }
        return new SkeletonData(result, joints);
    }

    /// Lights authored into a drawable or fragment (flashlight cones, lamp bulbs),
    /// in model space. A light on a bone follows the bone's bind transform, as
    /// CodeWalker's deferred light pass applies it. Colour stays 0-255 and the cone
    /// angles stay in degrees as stored; the viewer decides how to render them.
    private static List<ModelLightData> CollectModelLights(LightAttributes[]? lights, Skeleton? skeleton, int drawableIndex)
    {
        var result = new List<ModelLightData>();
        if (lights == null) return result;
        var bones = skeleton?.Bones?.Items;
        var world = bones == null ? null : new Matrix?[bones.Length];
        Matrix Resolve(int index, int depth)
        {
            if (world![index] is { } cached) return cached;
            var bone = bones![index];
            var local = Matrix.AffineTransformation(1.0f, bone.Rotation, bone.Translation);
            var parent = bone.ParentIndex;
            var matrix = parent >= 0 && parent < bones.Length && parent != index && depth < bones.Length
                ? local * Resolve(parent, depth + 1)
                : local;
            world[index] = matrix;
            return matrix;
        }

        for (var index = 0; index < lights.Length; index += 1)
        {
            var light = lights[index];
            if (light == null) continue;
            var type = light.Type switch
            {
                LightType.Point => "point",
                LightType.Spot => "spot",
                LightType.Capsule => "capsule",
                _ => null,
            };
            if (type == null) continue;

            var position = light.Position;
            var direction = light.Direction;
            var tangent = light.Tangent;
            var boneIndex = bones == null ? -1 : Array.FindIndex(bones, bone => bone != null && bone.Tag == light.BoneId);
            if (boneIndex >= 0)
            {
                var matrix = Resolve(boneIndex, 0);
                position = Vector3.TransformCoordinate(position, matrix);
                direction = Vector3.TransformNormal(direction, matrix);
                tangent = Vector3.TransformNormal(tangent, matrix);
            }
            if (!IsFinite(position) || !IsFinite(direction) || !IsFinite(tangent) || !IsFinite(light.Extent)
                || !new[] { light.Intensity, light.Falloff, light.FalloffExponent, light.ConeInnerAngle, light.ConeOuterAngle,
                    light.CoronaSize, light.CoronaIntensity, light.VolumeIntensity, light.VolumeSizeScale }.All(float.IsFinite)) continue;

            result.Add(new ModelLightData(
                drawableIndex,
                index,
                type,
                new[] { position.X, position.Y, position.Z },
                new[] { direction.X, direction.Y, direction.Z },
                new[] { tangent.X, tangent.Y, tangent.Z },
                new[] { (int)light.ColorR, (int)light.ColorG, (int)light.ColorB },
                light.Intensity,
                light.Falloff,
                light.FalloffExponent,
                Math.Min(light.ConeInnerAngle, light.ConeOuterAngle),
                Math.Max(light.ConeInnerAngle, light.ConeOuterAngle),
                new[] { light.Extent.X, light.Extent.Y, light.Extent.Z },
                light.Flags,
                light.TimeFlags,
                light.Flashiness,
                light.CoronaSize,
                light.CoronaIntensity,
                light.VolumeIntensity,
                light.VolumeSizeScale,
                boneIndex >= 0 ? light.BoneId : null));
        }
        return result;
    }

    private static bool IsFinite(Vector3 value) =>
        float.IsFinite(value.X) && float.IsFinite(value.Y) && float.IsFinite(value.Z);

    /// Separates triangles attached to an extra or a light bone into their own
    /// meshes so the viewer can toggle extras and drive each light on its own.
    private static IEnumerable<MeshData> SplitExtraMeshes(MeshData mesh, DrawableGeometry geometry, Skeleton? skeleton, int modelBone, bool posable)
    {
        var data = geometry.VertexData;
        var info = data?.Info;
        if (data == null || info == null || !HasComponent(info, VertexSemantics.BlendIndices)
            || !HasComponent(info, VertexSemantics.BlendWeights)
            || info.GetComponentType((int)VertexSemantics.BlendIndices) is not (VertexComponentType.UByte4 or VertexComponentType.Colour)
            || info.GetComponentType((int)VertexSemantics.BlendWeights) is not (VertexComponentType.UByte4 or VertexComponentType.Colour))
        {
            mesh.ExtraIndex = ExtraForBone(skeleton, modelBone);
            mesh.LightBone = LightForBone(skeleton, modelBone);
            mesh.LightId = SharedLightId(mesh.VertexLightIds, mesh.Indices);
            mesh.BoneChain = BoneChain(skeleton, modelBone);
            mesh.BoneIndex = posable && modelBone >= 0 && modelBone < (skeleton?.Bones?.Items?.Length ?? 0) ? modelBone : null;
            SetSteerPart(mesh, SteerBoneFor(skeleton, modelBone));
            return new[] { mesh };
        }
        var boneCount = skeleton?.Bones?.Items?.Length ?? 0;
        var boneExtras = Enumerable.Range(0, boneCount).Select(index => ExtraForBone(skeleton, index)).ToArray();
        var boneLights = Enumerable.Range(0, boneCount).Select(index => LightForBone(skeleton, index)).ToArray();
        var boneSteers = Enumerable.Range(0, boneCount).Select(index => SteerBoneFor(skeleton, index)).ToArray();
        var extras = new int?[data.VertexCount];
        var lights = new string?[data.VertexCount];
        var steers = new string?[data.VertexCount];
        var vertexBones = Enumerable.Repeat(-1, data.VertexCount).ToArray();
        // Skeleton bone and weight per influence. Kept only where a vertex blends
        // several bones: single-bone parts pose as a whole from BoneIndex.
        var skinIndices = posable ? new ushort[data.VertexCount * 4] : null;
        var skinWeights = posable ? new byte[data.VertexCount * 4] : null;
        var blended = false;
        for (var vertex = 0; vertex < extras.Length; vertex++)
        {
            var indices = data.GetUByte4(vertex, (int)VertexSemantics.BlendIndices);
            var weights = data.GetUByte4(vertex, (int)VertexSemantics.BlendWeights);
            if (skinIndices != null && skinWeights != null)
            {
                var influences = 0;
                for (var slot = 0; slot < 4; slot++)
                {
                    var influence = slot switch { 0 => weights.R, 1 => weights.G, 2 => weights.B, _ => weights.A };
                    int skinBone = slot switch { 0 => indices.R, 1 => indices.G, 2 => indices.B, _ => indices.A };
                    if (geometry.BoneIds?.Length > 0) skinBone = skinBone < geometry.BoneIds.Length ? geometry.BoneIds[skinBone] : -1;
                    if (influence == 0 || skinBone < 0 || skinBone >= boneCount) continue;
                    skinIndices[vertex * 4 + slot] = (ushort)skinBone;
                    skinWeights[vertex * 4 + slot] = influence;
                    influences += 1;
                }
                if (influences > 1) blended = true;
            }
            var bone = (int)indices.R;
            var weight = weights.R;
            if (weights.G > weight) { bone = indices.G; weight = weights.G; }
            if (weights.B > weight) { bone = indices.B; weight = weights.B; }
            if (weights.A > weight) { bone = indices.A; weight = weights.A; }
            if (weight == 0) continue;
            if (geometry.BoneIds?.Length > 0)
            {
                if (bone >= geometry.BoneIds.Length) continue;
                bone = geometry.BoneIds[bone];
            }
            vertexBones[vertex] = bone;
            extras[vertex] = boneExtras.ElementAtOrDefault(bone);
            lights[vertex] = boneLights.ElementAtOrDefault(bone);
            steers[vertex] = boneSteers.ElementAtOrDefault(bone);
        }
        var lightIds = mesh.VertexLightIds;
        var groups = new Dictionary<(int Extra, string Light, string Steer, int LightId, int Bone), List<uint>>();
        for (var i = 0; i + 2 < mesh.Indices.Length; i += 3)
        {
            var a = mesh.Indices[i]; var b = mesh.Indices[i + 1]; var c = mesh.Indices[i + 2];
            if (a >= extras.Length || b >= extras.Length || c >= extras.Length) return new[] { mesh };
            var extra = extras[a];
            var light = lights[a];
            // Mixed attachments stay with the shared part, preserving the boundary.
            var extraKey = extra.HasValue && extra == extras[b] && extra == extras[c] ? extra.Value : -1;
            var lightKey = light != null && light == lights[b] && light == lights[c] ? light : "";
            var steer = steers[a];
            var steerKey = steer != null && steer == steers[b] && steer == steers[c] ? steer : "";
            var lightIdKey = lightIds != null && a < lightIds.Length && b < lightIds.Length && c < lightIds.Length
                && lightIds[a] == lightIds[b] && lightIds[a] == lightIds[c] ? lightIds[a] : -1;
            // Mod kits hide stock parts by bone (carcols turnOffBones) and parts are
            // often skinned into one geometry, so body triangles split by bone too.
            var body = extraKey < 0 && lightKey.Length == 0 && steerKey.Length == 0 && lightIdKey <= 0;
            var boneKey = body && vertexBones[a] >= 0 && vertexBones[a] == vertexBones[b] && vertexBones[a] == vertexBones[c] ? vertexBones[a] : -1;
            var key = (extraKey, lightKey, steerKey, lightIdKey, boneKey);
            if (!groups.TryGetValue(key, out var list)) groups[key] = list = new List<uint>();
            list.Add(a); list.Add(b); list.Add(c);
        }
        if (groups.Count == 0) return new[] { mesh };
        if (blended)
        {
            mesh.SkinIndices = skinIndices;
            mesh.SkinWeights = skinWeights;
        }
        // A mesh wholly on one extra still goes through SubsetMesh so it keeps the
        // "_extra_N" name earlier caches used.
        if (groups.Count == 1 && groups.Keys.First().Extra < 0)
        {
            var only = groups.Keys.First();
            mesh.ExtraIndex = null;
            mesh.LightBone = only.Light.Length == 0 ? null : only.Light;
            mesh.LightId = only.LightId < 0 ? null : only.LightId;
            var onlyBone = SharedBone(vertexBones, mesh.Indices);
            mesh.BoneChain = onlyBone < 0 ? null : BoneChain(skeleton, onlyBone);
            mesh.BoneIndex = posable && onlyBone >= 0 ? onlyBone : null;
            DropRigidSkin(mesh);
            SetSteerPart(mesh, only.Steer.Length == 0 ? null : only.Steer);
            return new[] { mesh };
        }
        // Body groups keep the "_body" name when there is only one; once bones
        // split them, each bone's group is named after its bone.
        var bodyGroups = groups.Keys.Count(key => key.Extra < 0 && key.Light.Length == 0 && key.Steer.Length == 0 && key.LightId <= 0);
        var boneNames = skeleton?.Bones?.Items;
        return groups.Select(group =>
        {
            var extra = group.Key.Extra < 0 ? (int?)null : group.Key.Extra;
            var light = group.Key.Light.Length == 0 ? null : group.Key.Light;
            var steer = group.Key.Steer.Length == 0 ? null : group.Key.Steer;
            var lightId = group.Key.LightId < 0 ? (int?)null : group.Key.LightId;
            var bone = group.Key.Bone;
            var boneSuffix = bodyGroups > 1 && bone >= 0 ? BoneSuffix(boneNames, bone) : null;
            var subset = SubsetMesh(mesh, group.Value, extra, light, steer, lightId, boneSuffix);
            SetSteerPart(subset, steer);
            var sharedBone = SharedBone(vertexBones, group.Value);
            subset.BoneChain = sharedBone < 0 ? null : BoneChain(skeleton, sharedBone);
            subset.BoneIndex = posable && sharedBone >= 0 ? sharedBone : null;
            DropRigidSkin(subset);
            return subset;
        }).ToArray();
    }

    /// Skin weights matter only where a vertex blends bones; a mesh whose
    /// vertices each follow one bone is posed rigidly and stays cheaper.
    private static void DropRigidSkin(MeshData mesh)
    {
        var weights = mesh.SkinWeights;
        if (weights == null) return;
        for (var i = 0; i + 3 < weights.Length; i += 4)
        {
            var influences = (weights[i] > 0 ? 1 : 0) + (weights[i + 1] > 0 ? 1 : 0) + (weights[i + 2] > 0 ? 1 : 0) + (weights[i + 3] > 0 ? 1 : 0);
            if (influences > 1) return;
        }
        mesh.SkinIndices = null;
        mesh.SkinWeights = null;
    }

    private static void SetSteerPart(MeshData mesh, string? steerBone)
    {
        if (steerBone == null) return;
        mesh.Part = "hub";
        mesh.PartName = steerBone;
    }

    /// The light id every vertex referenced by `indices` shares; null when they differ.
    private static int? SharedLightId(byte[]? lightIds, uint[] indices)
    {
        if (lightIds == null || indices.Length == 0) return null;
        int? shared = null;
        foreach (var index in indices)
        {
            if (index >= lightIds.Length) return null;
            if (shared == null) shared = lightIds[index];
            else if (shared != lightIds[index]) return null;
        }
        return shared;
    }

    /// Mesh-name suffix for a bone's body group: the bone name, or its index when
    /// the name is missing or not filename-safe.
    private static string BoneSuffix(Bone[]? bones, int index)
    {
        var name = bones != null && index < bones.Length ? bones[index]?.Name : null;
        return !string.IsNullOrWhiteSpace(name) && name.All(ch => char.IsLetterOrDigit(ch) || ch == '_')
            ? name.ToLowerInvariant()
            : $"bone{index}";
    }

    private static MeshData SubsetMesh(MeshData source, List<uint> indices, int? extra, string? light, string? steer = null, int? lightId = null, string? bone = null)
    {
        var vertices = new List<int>();
        var remap = new Dictionary<uint, uint>();
        var output = indices.Select(index => {
            if (!remap.TryGetValue(index, out var mapped))
            {
                mapped = (uint)vertices.Count;
                remap[index] = mapped;
                vertices.Add((int)index);
            }
            return mapped;
        }).ToArray();
        float[]? copy(float[]? data, int stride)
        {
            if (data == null) return null;
            var result = new float[vertices.Count * stride];
            for (var i = 0; i < vertices.Count; i++) Array.Copy(data, vertices[i] * stride, result, i * stride, stride);
            return result;
        }
        byte[]? copyBytes(byte[]? data, int stride = 1)
        {
            if (data == null) return null;
            var result = new byte[vertices.Count * stride];
            for (var i = 0; i < vertices.Count; i++) Array.Copy(data, vertices[i] * stride, result, i * stride, stride);
            return result;
        }
        ushort[]? copyShorts(ushort[]? data, int stride)
        {
            if (data == null) return null;
            var result = new ushort[vertices.Count * stride];
            for (var i = 0; i < vertices.Count; i++) Array.Copy(data, vertices[i] * stride, result, i * stride, stride);
            return result;
        }
        var lightName = light ?? (lightId is > 0 ? $"light{lightId}" : null);
        var suffix = (extra.HasValue ? $"_extra_{extra}" : lightName == null && steer == null ? "_body" : "") + (lightName != null ? $"_{lightName}" : "")
            + (steer != null ? $"_brake_{steer}" : "") + (bone != null ? $"_{bone}" : "");
        return new MeshData(source.Name + suffix, source.MaterialName,
            copy(source.Positions, 3)!, copy(source.Normals, 3), copy(source.Uvs, 2), copy(source.Uvs2, 2), copy(source.Uvs3, 2), copy(source.Uvs4, 2), output,
            source.ShaderName, source.ShaderHash, source.ShaderFileName, source.RenderBucket,
            source.DrawableIndex, source.ModelIndex, source.LodLevel, source.LodModelIndex, source.GeometryIndex,
            source.UvSets, source.TextureBindings, source.TextureRefs, source.ResolvedTexturePaths)
        {
            ExtraIndex = extra,
            LightBone = light,
            LightId = lightId,
            DiffuseColor = source.DiffuseColor,
            EmissiveMultiplier = source.EmissiveMultiplier,
            VertexLightIds = copyBytes(source.VertexLightIds),
            SkinIndices = copyShorts(source.SkinIndices, 4),
            SkinWeights = copyBytes(source.SkinWeights, 4),
        };
    }

    private static IEnumerable<(string LodLevel, int LodModelIndex, DrawableModel Model)> EnumerateDrawableModels(DrawableBase drawable)
    {
        var emitted = false;

        IEnumerable<(string LodLevel, DrawableModel[]? Models)> levels = new[]
        {
            ("high", drawable.DrawableModels?.High),
            ("med", drawable.DrawableModels?.Med),
            ("low", drawable.DrawableModels?.Low),
            ("vlow", drawable.DrawableModels?.VLow),
            ("extra", drawable.DrawableModels?.Extra),
        };

        foreach (var (lodLevel, models) in levels)
        {
            if (models == null) continue;
            for (var index = 0; index < models.Length; index += 1)
            {
                var model = models[index];
                if (model == null) continue;
                emitted = true;
                yield return (lodLevel, index, model);
            }
        }

        if (emitted) yield break;
        var fallbackModels = drawable.AllModels ?? Array.Empty<DrawableModel>();
        for (var index = 0; index < fallbackModels.Length; index += 1)
        {
            var model = fallbackModels[index];
            if (model != null) yield return ("unknown", index, model);
        }
    }

    private static MeshData? ExtractMesh(
        DrawableGeometry geom,
        string baseName,
        int drawableIndex,
        int modelIndex,
        string lodLevel,
        int lodModelIndex,
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
        // vehicle_lightsemissive* stores the light id (1 headlight_l ... 17 extralight_4,
        // 0 always on) in the alpha of vertex colour0.
        var lightIds = GetShaderName(geom).Contains("lightsemissive", StringComparison.OrdinalIgnoreCase)
            && HasComponent(info, VertexSemantics.Colour0)
            && info.GetComponentType((int)VertexSemantics.Colour0) is VertexComponentType.Colour or VertexComponentType.UByte4
                ? new byte[vertexCount] : null;

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

            if (lightIds != null)
            {
                lightIds[v] = vertexData.GetUByte4(v, (int)VertexSemantics.Colour0).A;
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
            lodLevel,
            lodModelIndex,
            geomIndex,
            uvSets,
            textureBindings,
            textureRefs,
            resolvedTexturePaths
        )
        {
            DiffuseColor = ExtractDiffuseColor(geom.Shader),
            EmissiveMultiplier = ExtractEmissiveMultiplier(geom.Shader),
            VertexLightIds = lightIds,
        };
    }

    private const uint MatDiffuseColorHash = 408880252;

    /// emissiveMultiplier (x) on emissive shaders: how bright the game draws the
    /// emissive texture. Null when the shader has no such parameter.
    private static float? ExtractEmissiveMultiplier(ShaderFX? shader)
    {
        var parameters = shader?.ParametersList?.Parameters;
        var hashes = shader?.ParametersList?.Hashes;
        if (parameters == null || hashes == null) return null;
        var count = Math.Min(parameters.Length, hashes.Length);
        for (var index = 0; index < count; index += 1)
        {
            if ((uint)hashes[index] != (uint)ShaderParamNames.emissiveMultiplier) continue;
            if (parameters[index]?.DataType != 1 || parameters[index].Data is not Vector4 value) return null;
            return float.IsFinite(value.X) ? value.X : null;
        }
        return null;
    }

    /// matDiffuseColor is what the game reads for vehicle paint: (2, layer, 0) selects a
    /// paint layer (1 primary, 2 secondary, 3 pearlescent, 4 wheel, 5 default, 6 trim,
    /// 7 dashboard); any other value is a fixed color.
    private static float[]? ExtractDiffuseColor(ShaderFX? shader)
    {
        var parameters = shader?.ParametersList?.Parameters;
        var hashes = shader?.ParametersList?.Hashes;
        if (parameters == null || hashes == null) return null;

        var count = Math.Min(parameters.Length, hashes.Length);
        for (var index = 0; index < count; index += 1)
        {
            if ((uint)hashes[index] != MatDiffuseColorHash) continue;
            if (parameters[index]?.DataType != 1 || parameters[index].Data is not Vector4 value) return null;
            // A damaged value is unknown, not black: leave the colour to the material.
            if (!float.IsFinite(value.X) || !float.IsFinite(value.Y) || !float.IsFinite(value.Z) || !float.IsFinite(value.W)) return null;
            return new[] { value.X, value.Y, value.Z, value.W };
        }
        return null;
    }

    private static TextureLibrary ExportTextures(ModelSource source, string inputPath, string outputDirectory)
    {
        var library = new TextureLibrary();
        var textureRoot = Path.Combine(outputDirectory, "textures");
        var exportedYtdPaths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        // A dictionary the resource streams replaces the game's dictionary of that
        // name, as streaming does in game, so the game copy is never a fallback for
        // it; its parents and vehshare still are.
        var resourceTxdNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var ytdPath in EnumerateSiblingYtdPaths(inputPath))
        {
            resourceTxdNames.Add(Path.GetFileNameWithoutExtension(ytdPath));
            ExportYtdFromPath(ytdPath, "ytd", "ytd", textureRoot, library, exportedYtdPaths);
        }

        // Vehicle texture chains come from vehicles.meta; props name theirs in a .ytyp archetype.
        var vehicleContext = source.Fragment != null ? TryReadVehicleTextureContext(inputPath) : null;
        foreach (var ytdPath in EnumerateResourceSharedYtdPaths(inputPath, vehicleContext))
        {
            var txdName = Path.GetFileNameWithoutExtension(ytdPath) ?? "resource";
            resourceTxdNames.Add(txdName);
            ExportYtdFromPath(ytdPath, "ytd", $"shared/{SanitizeFolderName(txdName)}", textureRoot, library, exportedYtdPaths);
        }

        var archetypeTxds = source.Fragment == null ? FindArchetypeTextureDictionaries(inputPath, source.Format) : new List<uint>();
        foreach (var ytdPath in FindResourceYtdsByHash(inputPath, archetypeTxds))
        {
            var txdName = Path.GetFileNameWithoutExtension(ytdPath) ?? "archetype";
            resourceTxdNames.Add(txdName);
            ExportYtdFromPath(ytdPath, "ytd", $"shared/{SanitizeFolderName(txdName)}", textureRoot, library, exportedYtdPaths);
        }

        var sharedArchive = GetSharedTextureArchive();
        if (sharedArchive != null)
        {
            var exportedTxdNames = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var requested = source.Fragment != null
                ? CollectRequestedSharedTxdNames(inputPath, vehicleContext, sharedArchive)
                : CollectPropSharedTxdNames(inputPath, archetypeTxds, sharedArchive);
            foreach (var txdName in requested)
            {
                if (resourceTxdNames.Contains(txdName)) continue;
                ExportYtdFromArchive(txdName, sharedArchive, textureRoot, library, exportedTxdNames);
            }
        }

        foreach (var texture in CollectEmbeddedTextures(source.TextureOwners))
        {
            ExportTexture(texture, "embedded", "embedded", textureRoot, library, addByName: false, Path.GetFileName(inputPath));
        }

        return library;
    }

    private const int ArchetypeScanFileLimit = 256;
    private const long ArchetypeScanMaxBytes = 32L * 1024 * 1024;

    private static IEnumerable<string> EnumerateResourceFiles(string inputPath, string pattern, int limit)
    {
        var resourceRoot = FindResourceRoot(inputPath);
        var root = resourceRoot ?? Path.GetDirectoryName(Path.GetFullPath(inputPath));
        if (string.IsNullOrWhiteSpace(root) || !Directory.Exists(root)) return Array.Empty<string>();
        var options = new EnumerationOptions
        {
            // Without a resource manifest only the model's own folder is searched.
            RecurseSubdirectories = resourceRoot != null,
            MaxRecursionDepth = 6,
            IgnoreInaccessible = true,
            MatchCasing = MatchCasing.CaseInsensitive,
        };
        try
        {
            return Directory.EnumerateFiles(root, pattern, options).Take(limit).ToList();
        }
        catch
        {
            return Array.Empty<string>();
        }
    }

    /// Texture dictionary hashes named by .ytyp archetypes for this model: a prop's
    /// archetype (or, for a .ydd, any archetype using the dictionary) points at the
    /// shared .ytd its textures live in, which rarely matches the model name.
    private static List<uint> FindArchetypeTextureDictionaries(string inputPath, string format)
    {
        var result = new List<uint>();
        var stem = GetInputModelStem(inputPath).ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(stem)) return result;
        var modelHash = JenkHash.GenHash(stem);
        foreach (var ytypPath in EnumerateResourceFiles(inputPath, "*.ytyp", ArchetypeScanFileLimit))
        {
            RecordInput(ytypPath);
            try
            {
                if (new FileInfo(ytypPath).Length > ArchetypeScanMaxBytes) continue;
                var ytyp = new YtypFile();
                ytyp.Load(File.ReadAllBytes(ytypPath));
                foreach (var archetype in ytyp.AllArchetypes ?? Array.Empty<Archetype>())
                {
                    if (archetype == null) continue;
                    var matches = (uint)archetype.Hash == modelHash
                        || (format == "ydd" && (uint)archetype.DrawableDict == modelHash);
                    var txd = (uint)archetype.TextureDict;
                    if (matches && txd != 0 && !result.Contains(txd)) result.Add(txd);
                }
            }
            catch (Exception ex)
            {
                Warn($"{Path.GetFileName(ytypPath)} could not be read, so its texture dictionary names were skipped: {ShortReason(ex)}");
            }
        }
        return result;
    }

    private static IEnumerable<string> FindResourceYtdsByHash(string inputPath, List<uint> hashes)
    {
        if (hashes.Count == 0) return Array.Empty<string>();
        var found = new List<string>();
        foreach (var ytdPath in EnumerateResourceFiles(inputPath, "*.ytd", 4096))
        {
            var stem = Path.GetFileNameWithoutExtension(ytdPath)?.ToLowerInvariant() ?? string.Empty;
            if (hashes.Contains(JenkHash.GenHash(stem))) found.Add(ytdPath);
        }
        return found;
    }

    /// Game dictionaries for a prop: its archetype dictionaries (by name, or by hash
    /// against the archive's dictionary names), the model's own name, and every
    /// parent dictionary those inherit from.
    private static IEnumerable<string> CollectPropSharedTxdNames(string inputPath, List<uint> archetypeTxds, SharedTextureArchive archive)
    {
        var requested = new List<string>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        void addWithParents(string? name)
        {
            var next = name;
            var guard = 0;
            while (!string.IsNullOrWhiteSpace(next) && seen.Add(next) && guard < 12)
            {
                requested.Add(next);
                next = archive.ParentRelationships.TryGetValue(NormalizeTextureLookupKey(next), out var parent) ? parent : null;
                guard += 1;
            }
        }

        if (archetypeTxds.Count > 0)
        {
            var pending = new HashSet<uint>(archetypeTxds);
            foreach (var hash in archetypeTxds)
            {
                var name = JenkIndex.TryGetString(hash);
                if (string.IsNullOrEmpty(name)) continue;
                addWithParents(name);
                pending.Remove(hash);
            }
            if (pending.Count > 0)
            {
                foreach (var key in archive.YtdEntries.Keys)
                {
                    if (pending.Remove(JenkHash.GenHash(key))) addWithParents(key);
                    if (pending.Count == 0) break;
                }
            }
        }
        addWithParents(GetInputModelStem(inputPath).ToLowerInvariant());
        return requested;
    }

    private static void ExportYtdFromPath(
        string ytdPath,
        string source,
        string folderName,
        string textureRoot,
        TextureLibrary library,
        HashSet<string> exportedYtdPaths)
    {
        if (string.IsNullOrWhiteSpace(ytdPath)) return;
        RecordInput(ytdPath);
        if (!File.Exists(ytdPath)) return;
        var fullPath = Path.GetFullPath(ytdPath);
        if (!exportedYtdPaths.Add(fullPath)) return;

        var fileName = Path.GetFileName(fullPath);
        var ytd = LoadYtdFromPath(fullPath, out var loadError);
        if (ytd == null)
        {
            Warn($"{fileName} could not be read, so its textures are missing: {loadError}");
            return;
        }
        if (ytd.TextureDict?.Textures?.data_items == null) return;

        foreach (var texture in ytd.TextureDict.Textures.data_items)
        {
            ExportTexture(texture, source, folderName, textureRoot, library, addByName: true, fileName);
        }
    }

    private static void ExportYtdFromArchive(
        string txdName,
        SharedTextureArchive archive,
        string textureRoot,
        TextureLibrary library,
        HashSet<string> exportedTxdNames)
    {
        if (string.IsNullOrWhiteSpace(txdName)) return;
        var lookupKey = NormalizeTextureLookupKey(txdName);
        if (!archive.YtdEntries.TryGetValue(lookupKey, out var entry)) return;
        if (!exportedTxdNames.Add(lookupKey)) return;

        try
        {
            var ytd = archive.Manager.GetFile<YtdFile>(entry);
            if (ytd?.TextureDict?.Textures?.data_items == null) return;
            foreach (var texture in ytd.TextureDict.Textures.data_items)
            {
                ExportTexture(texture, "shared", $"shared/{SanitizeFolderName(txdName)}", textureRoot, library, addByName: true, $"{txdName}.ytd (game files)");
            }
        }
        catch (Exception ex)
        {
            Warn($"Game texture dictionary {txdName}.ytd could not be read: {ShortReason(ex)}");
        }
    }

    private static YtdFile? LoadYtdFromPath(string ytdPath, out string? error)
    {
        error = null;
        if (string.IsNullOrWhiteSpace(ytdPath) || !File.Exists(ytdPath))
        {
            error = "the file does not exist";
            return null;
        }

        try
        {
            var ytd = new YtdFile();
            ytd.Load(File.ReadAllBytes(ytdPath));
            return ytd;
        }
        catch (Exception ex)
        {
            error = ShortReason(ex);
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
            // Absent candidates count too: adding one later must refresh the parse.
            RecordInput(nextPath);
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
                RecordInput(vehiclesMetaPath);
                TryPopulateVehicleContextFromVehiclesMeta(vehiclesMetaPath, context);
            }

            foreach (var gtxdMetaPath in Directory.GetFiles(dataDirectory, "*gtxd.meta", SearchOption.AllDirectories))
            {
                RecordInput(gtxdMetaPath);
                TryPopulateVehicleContextFromGtxdMeta(gtxdMetaPath, context);
            }

            return context;
        }
        catch (Exception ex)
        {
            Warn($"The resource's data folder could not be read, so its texture dictionary names were skipped: {ShortReason(ex)}");
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
        catch (Exception ex)
        {
            Warn($"{Path.GetFileName(filePath)} could not be read, so its texture dictionary names were skipped: {ShortReason(ex)}");
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
        catch (Exception ex)
        {
            Warn($"{Path.GetFileName(filePath)} could not be read, so its texture dictionary names were skipped: {ShortReason(ex)}");
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
                RecordInput(candidate);
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

    /// The RPF scan is the slowest part of a request; cache it for the lifetime of the process.
    private static SharedTextureArchive? GetSharedTextureArchive()
    {
        if (SharedArchiveResolved) return SharedArchive;
        SharedArchive = CreateSharedTextureArchive();
        SharedArchiveResolved = true;
        return SharedArchive;
    }

    private static SharedTextureArchive? CreateSharedTextureArchive()
    {
        var gtaFolder = AutoDetectGtaFolder();
        if (string.IsNullOrWhiteSpace(gtaFolder) || !Directory.Exists(gtaFolder))
        {
            Console.Error.WriteLine("[archive] GTA V installation folder was not detected; shared textures and ped assets are unavailable.");
            return null;
        }

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
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[archive] Failed to index GTA V archives: {ex.Message}");
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

    private static List<DrawableBase> FragmentTextureOwners(FragType fragment)
    {
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
        var children = fragment.PhysicsLODGroup?.PhysicsLOD1?.Children?.data_items;
        if (children != null)
        {
            foreach (var child in children)
            {
                if (child?.Drawable1 != null) drawables.Add(child.Drawable1);
            }
        }
        return drawables;
    }

    private static IEnumerable<Texture> CollectEmbeddedTextures(IEnumerable<DrawableBase> drawables)
    {
        var textures = new List<Texture>();
        var seen = new HashSet<Texture>();
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
        bool addByName,
        string origin)
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

        string relativePath;
        try
        {
            var dds = DDSIO.GetDDSFile(texture);
            if (source == "shared")
            {
                var cacheRoot = Directory.GetParent(textureRoot)?.Parent?.FullName
                    ?? throw new IOException("Texture cache root is unavailable.");
                var sharedDir = Path.Combine(cacheRoot, ".shared-textures");
                Directory.CreateDirectory(sharedDir);
                var hash = Convert.ToHexStringLower(SHA256.HashData(dds));
                var sharedPath = Path.Combine(sharedDir, hash + ".dds");
                if (!File.Exists(sharedPath))
                {
                    var stagingPath = sharedPath + "." + Guid.NewGuid().ToString("N") + ".tmp";
                    try
                    {
                        File.WriteAllBytes(stagingPath, dds);
                        try { File.Move(stagingPath, sharedPath); }
                        catch (IOException) when (File.Exists(sharedPath)) { }
                    }
                    finally { if (File.Exists(stagingPath)) File.Delete(stagingPath); }
                }
                // Protect a reused object while this request assembles its manifest.
                File.SetLastWriteTimeUtc(sharedPath, DateTime.UtcNow);
                relativePath = ToManifestPath(Path.GetRelativePath(Directory.GetParent(textureRoot)!.FullName, sharedPath));
            }
            else
            {
                File.WriteAllBytes(absolutePath, dds);
                relativePath = ToManifestPath(Path.Combine("textures", relativeFolder, fileName));
            }
        }
        catch (Exception ex)
        {
            Warn($"Texture '{textureName}' from {origin} could not be exported: {ShortReason(ex)}");
            return;
        }

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
        var param = (paramName ?? string.Empty).Trim().ToLowerInvariant();
        var texture = (textureName ?? string.Empty).Trim().ToLowerInvariant();
        if (string.IsNullOrWhiteSpace(param) && string.IsNullOrWhiteSpace(texture)) return "unknown";

        // Shader parameter names are authoritative. A diffuse binding can
        // legitimately point at a file containing "spec" or "emissive".
        if (param.Contains("diffuse") || param.Contains("albedo") || param.Contains("basecolor") || param.Contains("platebg") || param.Contains("fontsampler")) return "baseColor";
        if (param.Contains("normal") || param.Contains("bump")) return "normal";
        if (param.Contains("spec") || param.Contains("gloss") || param.Contains("reflect")) return "specular";
        if (param.Contains("emissive") || param.Contains("emiss") || param.Contains("glow")) return "emissive";
        if (param.Contains("dirt") || param.Contains("mud")) return "dirt";
        if (param.Contains("detail")) return "detail";
        if (param.Contains("mask") || param.Contains("control") || param.Contains("palette") || param.Contains("lookup")) return "mask";
        if (param.Contains("ao") || param.Contains("ambient")) return "ambientOcclusion";

        if (texture.Contains("dirt") || texture.Contains("mud") || texture.Contains("grime")) return "dirt";
        if (texture.Contains("normal") || texture.Contains("bump") || texture.Contains("nrm")) return "normal";
        if (texture.Contains("emissive") || texture.Contains("glow") || texture.Contains("light")) return "emissive";
        if (texture.Contains("spec") || texture.Contains("gloss") || texture.Contains("reflect")) return "specular";
        if (texture.Contains("detail")) return "detail";
        if (texture.Contains("mask") || texture.Contains("control") || texture.Contains("palette") || texture.Contains("lookup")) return "mask";
        if (texture.Contains("ao") || texture.Contains("ambient")) return "ambientOcclusion";
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
        if (meshes.Count > ushort.MaxValue)
        {
            throw new BridgeException(
                $"The model has {meshes.Count} meshes; the mesh cache format holds at most {ushort.MaxValue}.", 3);
        }

        var directory = Path.GetDirectoryName(outputPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        // Written beside the target and moved into place, so a crash or kill never
        // leaves a truncated mesh under the final name.
        var stagingPath = outputPath + ".tmp";
        try
        {
            using (var stream = new FileStream(stagingPath, FileMode.Create, FileAccess.Write, FileShare.None))
            using (var writer = new BinaryWriter(stream, Encoding.UTF8, false))
            {
                WriteClmeshBody(writer, meshes);
            }
            File.Move(stagingPath, outputPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(stagingPath)) File.Delete(stagingPath);
        }
    }

    private static void WriteClmeshBody(BinaryWriter writer, List<MeshData> meshes)
    {
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
            var skinned = mesh.SkinIndices?.Length == mesh.VertexCount * 4 && mesh.SkinWeights?.Length == mesh.VertexCount * 4;
            if (skinned) flags |= 0x20;
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
            if (skinned)
            {
                foreach (var bone in mesh.SkinIndices!) writer.Write(bone);
                writer.Write(mesh.SkinWeights!);
            }
            WriteUIntArray(writer, mesh.Indices);
        }
    }

    private static void WriteManifest(string manifestPath, string inputPath, ModelSource source, List<MeshData> meshes, TextureLibrary textureLibrary, List<LightBoneData> lightBones, SkeletonData? skeleton, List<ParseInput> inputs)
    {
        var directory = Path.GetDirectoryName(manifestPath);
        if (!string.IsNullOrEmpty(directory))
        {
            Directory.CreateDirectory(directory);
        }

        var manifest = new
        {
            version = 12,
            inputPath,
            inputs,
            sourceFormat = source.Format,
            generatedAtUtc = DateTime.UtcNow,
            meshCount = meshes.Count,
            textureCount = textureLibrary.Entries.Count,
            lightBones = lightBones.Select(bone => new
            {
                name = bone.Name,
                index = bone.Index,
                position = bone.Position,
                rotation = bone.Rotation,
            }),
            skeleton = skeleton == null ? null : new
            {
                bones = skeleton.Bones.Select(bone => new
                {
                    name = bone.Name,
                    tag = bone.Tag,
                    parent = bone.Parent,
                    translation = bone.Translation,
                    rotation = bone.Rotation,
                }),
                joints = skeleton.Joints.Select(joint => new
                {
                    bone = joint.Bone,
                    kind = joint.Kind,
                    min = joint.Min,
                    max = joint.Max,
                }),
            },
            drawables = source.DrawableNames.Select((name, index) => new { index, name }),
            lights = source.Lights.Select(light => new
            {
                drawableIndex = light.DrawableIndex,
                index = light.Index,
                type = light.Type,
                position = light.Position,
                direction = light.Direction,
                tangent = light.Tangent,
                color = light.Color,
                intensity = light.Intensity,
                falloff = light.Falloff,
                falloffExponent = light.FalloffExponent,
                coneInnerAngle = light.ConeInnerAngle,
                coneOuterAngle = light.ConeOuterAngle,
                extent = light.Extent,
                flags = light.Flags,
                timeFlags = light.TimeFlags,
                flashiness = light.Flashiness,
                coronaSize = light.CoronaSize,
                coronaIntensity = light.CoronaIntensity,
                volumeIntensity = light.VolumeIntensity,
                volumeSizeScale = light.VolumeSizeScale,
                boneTag = light.BoneTag,
            }),
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
                lodLevel = mesh.LodLevel,
                lodModelIndex = mesh.LodModelIndex,
                geometryIndex = mesh.GeometryIndex,
                extraIndex = mesh.ExtraIndex,
                part = mesh.Part,
                partName = mesh.PartName,
                partOrigin = mesh.PartOrigin,
                boneChain = mesh.BoneChain,
                boneIndex = mesh.BoneIndex,
                lightBone = mesh.LightBone,
                lightId = mesh.LightId,
                paintLayer = mesh.PaintLayer,
                diffuseColor = mesh.PaintLayer == null ? mesh.DiffuseColor : null,
                emissiveMultiplier = mesh.EmissiveMultiplier,
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
            Converters = { new FiniteFloatConverter() },
        });
        var stagingPath = manifestPath + ".tmp";
        try
        {
            File.WriteAllText(stagingPath, json);
            File.Move(stagingPath, manifestPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(stagingPath)) File.Delete(stagingPath);
        }
    }

    /// JSON has no NaN or infinity, and a guessed stand-in would be fabricated
    /// data. Sources with a meaningful fallback filter these values earlier; any
    /// that reach the manifest fail the parse with a clear error.
    private sealed class FiniteFloatConverter : JsonConverter<float>
    {
        public override float Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
            reader.GetSingle();

        public override void Write(Utf8JsonWriter writer, float value, JsonSerializerOptions options)
        {
            if (!float.IsFinite(value))
            {
                throw new BridgeException(
                    "The model contains an invalid (NaN or infinite) number in its skeleton, light or material data, so it can't be loaded. Re-export the model and try again.", 3);
            }
            writer.WriteNumberValue(value);
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
    public int? ExtraIndex { get; set; }
    /// Vehicle part placed outside the main drawable ("wheel") and its bone name; null for body meshes.
    public string? Part { get; set; }
    public string? PartName { get; set; }
    /// Vehicle-space pivot of the part (the wheel hub, which is also the steering axis).
    public float[]? PartOrigin { get; set; }
    /// Dominant bone name followed by its ancestors; null when the mesh spans several bones.
    public string[]? BoneChain { get; set; }
    /// Lowercase light bone (siren1, siren_glass1, headlight_l, ...) every vertex is attached to; null otherwise.
    public string? LightBone { get; set; }
    /// Light id shared by every vertex (vertex colour0 alpha on vehicle_lightsemissive*); null otherwise.
    public int? LightId { get; set; }
    /// Per-vertex light ids, read for the light split only and not written to the cache.
    public byte[]? VertexLightIds { get; set; }
    /// Manifest skeleton bone every vertex follows; null when the mesh spans
    /// several bones or its drawable does not own the manifest skeleton.
    public int? BoneIndex { get; set; }
    /// Four manifest skeleton bone indices and 0-255 weights per vertex, present
    /// only when some vertex blends several bones (soft convertible roofs).
    public ushort[]? SkinIndices { get; set; }
    public byte[]? SkinWeights { get; set; }
    public float[]? DiffuseColor { get; set; }
    /// The shader's emissiveMultiplier; null when it has none.
    public float? EmissiveMultiplier { get; set; }
    public int? PaintLayer => DiffuseColor is { } color && color[0] == 2f && color[1] >= 1f && color[1] <= 7f && color[1] == MathF.Floor(color[1])
        ? (int)color[1]
        : null;
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
        string lodLevel,
        int lodModelIndex,
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
        LodLevel = lodLevel;
        LodModelIndex = lodModelIndex;
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
    public string LodLevel { get; }
    public int LodModelIndex { get; }
    public int GeometryIndex { get; }
    public MeshUvSets UvSets { get; }
    public List<MeshTextureBinding> TextureBindings { get; }
    public Dictionary<string, string> TextureRefs { get; }
    public Dictionary<string, string> ResolvedTexturePaths { get; }

    public int VertexCount => Positions.Length / 3;
    public int IndexCount => Indices.Length;
}

public sealed record MeshUvSets(bool Uv0, bool Uv1, bool Uv2, bool Uv3);

public sealed record LightBoneData(string Name, int Index, float[] Position, float[] Rotation);

/// Bind pose of every bone, local to its parent, and the joint limits the game
/// clamps animated bones to. Rotation limits are XYZ Euler radians in the bone's
/// own frame; translation limits are metres.
public sealed record SkeletonData(List<SkeletonBoneData> Bones, List<JointLimitData> Joints);

public sealed record SkeletonBoneData(string Name, int Tag, int Parent, float[] Translation, float[] Rotation);

public sealed record JointLimitData(int Bone, string Kind, float[] Min, float[] Max);

public sealed record ModelLightData(
    int DrawableIndex,
    int Index,
    string Type,
    float[] Position,
    float[] Direction,
    float[] Tangent,
    int[] Color,
    float Intensity,
    float Falloff,
    float FalloffExponent,
    float ConeInnerAngle,
    float ConeOuterAngle,
    float[] Extent,
    uint Flags,
    uint TimeFlags,
    byte Flashiness,
    float CoronaSize,
    float CoronaIntensity,
    float VolumeIntensity,
    float VolumeSizeScale,
    ushort? BoneTag);

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
    Dictionary<string, string> ParentRelationships);

public sealed record TextureListingEntry(string Name, string Path);

/// `Warnings` names textures the export skipped; null only in listings written
/// before warnings existed.
public sealed record TextureListing(string Dir, List<TextureListingEntry> Textures, List<string>? Warnings = null);

public sealed class BridgeException : Exception
{
    public BridgeException(string message, int exitCode = 1) : base(message)
    {
        ExitCode = exitCode;
    }

    public int ExitCode { get; }
}
