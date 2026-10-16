using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using CodeWalker.GameFiles;

namespace CodeWalkerBridge;

// Custom EUP Studio characters: any ped model, not only the freemode peds.
// A ped is described from its variation file (<ped>.ymt), its skeleton
// (<ped>.yft) and the drawable and texture names the variations resolve to,
// following CodeWalker's World/Ped.cs naming (<comp>_<nnn>_<u|r>, textures
// <comp>_diff_<nnn>_<letter>_<race>). The description names every file it
// refers to; the app fetches game files through exportPedAsset and reads the
// user's own files from disk.
public static partial class Program
{
    private const int MaxPedFiles = 4096;
    private const int MaxPedBones = 1024;
    private const int MaxPedDrawablesPerComponent = 255;

    private static readonly string[] PedComponentNames =
    {
        "head", "berd", "hair", "uppr", "lowr", "hand", "feet", "teef", "accs", "task", "decl", "jbib",
    };

    // eAnchorPoints order. An anchor's props are named after the first prefix
    // the files actually use.
    private static readonly string[][] PedAnchorNames =
    {
        new[] { "p_head" }, new[] { "p_eyes" }, new[] { "p_ears" }, new[] { "p_mouth" },
        new[] { "p_lhand" }, new[] { "p_rhand" }, new[] { "p_lwrist" }, new[] { "p_rwrist" },
        new[] { "p_lhip", "p_hip" }, new[] { "p_lfoot" }, new[] { "p_rfoot" },
        new[] { "ph_lhand" }, new[] { "ph_rhand" },
    };

    // A component or prop file inside a ped folder: uppr_000_u, uppr_diff_000_a_uni, p_head_000.
    private static readonly Regex PedMemberPattern = new(
        @"^(head|berd|hair|uppr|lowr|hand|feet|teef|accs|task|decl|jbib|p_[a-z]+|ph_[a-z]+)_(diff_|normal_|spec_)?\d{3}",
        RegexOptions.Compiled);

    private static HashSet<string>? PedModelNames;
    private static readonly Dictionary<string, object> GamePedDescriptions = new(StringComparer.OrdinalIgnoreCase);

    /// Race suffixes for CPVTextureData.texId, as CodeWalker maps them. Any
    /// other id falls back to whichever race the files carry.
    private static string? RaceForTexId(int texId) => texId switch
    {
        0 => "uni",
        1 => "whi",
        2 => "bla",
        3 => "chi",
        4 => "lat",
        5 => "ara",
        6 => "bal",
        7 => "jew",
        8 => "kor",
        10 => "pak",
        _ => null,
    };

    /// A file the description refers to: an archive entry (game) or a path (user).
    private sealed class PedSourceFile
    {
        public required string Stem { get; init; }
        public required string Ext { get; init; }
        public RpfFileEntry? Entry { get; init; }
        public string? Path { get; init; }
        public string Folder { get; init; } = string.Empty;
        public string Label => Entry?.NameLower ?? System.IO.Path.GetFileName(Path) ?? Stem + Ext;
    }

    private sealed class PedFileSet
    {
        public required string Ped { get; init; }
        public required string Source { get; init; }
        public PedSourceFile? Ymt { get; set; }
        public PedSourceFile? Yft { get; set; }
        public PedSourceFile? ComponentDictionary { get; set; }
        public PedSourceFile? ComponentTextures { get; set; }
        public PedSourceFile? PropDictionary { get; set; }
        public PedSourceFile? PropTextures { get; set; }
        // The parsed component dictionary, kept so a .yft-less ped reads its skeleton without parsing it again.
        public YddFile? ComponentDictionaryData { get; set; }
        public Dictionary<string, PedSourceFile> MemberDrawables { get; } = new(StringComparer.Ordinal);
        public Dictionary<string, PedSourceFile> MemberTextures { get; } = new(StringComparer.Ordinal);
        public List<string> Warnings { get; } = new();

        // Filled while describing: drawable name hashes and texture names
        // inside the dictionaries, and the refs written to `files`.
        public Dictionary<uint, PedSourceFile> DictionaryDrawables { get; } = new();
        public Dictionary<string, PedSourceFile> DictionaryTextures { get; } = new(StringComparer.Ordinal);
        public List<object> FileRefs { get; } = new();
        public Dictionary<PedSourceFile, int> FileIndex { get; } = new();
    }

    /// Every ped model in the game files: a name with both a .ymt (its
    /// variations) and a .yft (its skeleton). Cached for the process.
    private static HashSet<string> GetPedModelNames(SharedTextureArchive archive)
    {
        if (PedModelNames != null) return PedModelNames;
        var ymts = new HashSet<string>(StringComparer.Ordinal);
        var yfts = new HashSet<string>(StringComparer.Ordinal);
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                if (name.EndsWith(".ymt", StringComparison.Ordinal)) ymts.Add(name[..^4]);
                else if (name.EndsWith(".yft", StringComparison.Ordinal)) yfts.Add(name[..^4]);
            }
        }
        ymts.IntersectWith(yfts);
        PedModelNames = ymts;
        return ymts;
    }

    private static object SearchPeds(string query)
    {
        var tokens = SearchTokens(query);
        return SearchNames(GetPedModelNames(RequireArchive("game peds")), tokens, "peds");
    }

    private static object DescribeGamePed(string pedName)
    {
        var ped = ValidateModelName(pedName);
        if (GamePedDescriptions.TryGetValue(ped, out var cached)) return cached;

        var archive = RequireArchive("game peds");
        var index = GetPedIndex(ped);
        var set = new PedFileSet { Ped = ped, Source = "game" };
        var propFolder = ped + "_p";
        foreach (var (key, entry) in index)
        {
            var slash = key.IndexOf('/');
            var folder = key[..slash];
            var file = key[(slash + 1)..];
            var ext = System.IO.Path.GetExtension(file);
            var stem = file[..^ext.Length];
            var source = new PedSourceFile { Stem = stem, Ext = ext, Entry = entry, Folder = folder };
            if (folder.Length == 0)
            {
                AssignPedRoot(set, source, ped);
            }
            else if (folder == ped || folder == propFolder)
            {
                AssignPedMember(set, source);
            }
        }
        if (set.Ymt == null)
        {
            throw new BridgeException($"Ped '{ped}' was not found in the game files (no {ped}.ymt).");
        }
        if (set.Yft == null)
        {
            throw new BridgeException($"{ped}.yft is missing from the game files, so the ped's skeleton can't be read.");
        }
        var result = DescribePedFileSet(set, archive);
        GamePedDescriptions[ped] = result;
        return result;
    }

    /// The user's own ped: `files` are absolute paths to .ymt/.yft/.ydd/.ytd
    /// files (the app expands picked folders). With an empty `ped` and several
    /// .ymt files picked, only the candidates are returned so the user can pick.
    private static object DescribePedFiles(JsonElement request)
    {
        if (!request.TryGetProperty("files", out var filesElement) || filesElement.ValueKind != JsonValueKind.Array)
        {
            throw new BridgeException("Missing array parameter 'files'.");
        }
        var wanted = RequireString(request, "ped", allowEmpty: true).Trim().ToLowerInvariant();
        var paths = new List<string>();
        foreach (var item in filesElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String) throw new BridgeException("Parameter 'files' must hold strings.");
            var path = item.GetString() ?? string.Empty;
            if (path.Length == 0 || !System.IO.Path.IsPathFullyQualified(path)) throw new BridgeException("Ped files must be absolute paths.");
            paths.Add(path);
            if (paths.Count > MaxPedFiles) throw new BridgeException($"More than {MaxPedFiles} ped files were picked.");
        }
        paths.Sort(StringComparer.OrdinalIgnoreCase);

        var missing = paths.Where(path => !File.Exists(path)).ToList();
        if (missing.Count > 0)
        {
            throw new BridgeException($"Ped files not found: {string.Join(", ", missing.Take(3).Select(System.IO.Path.GetFileName))}{(missing.Count > 3 ? $" and {missing.Count - 3} more" : "")}.");
        }

        var classified = paths
            .Select(path => (Path: path, Parts: ClassifyPedFile(path)))
            .Where(item => item.Parts != null)
            .ToList();
        var candidates = classified
            .Where(item => item.Parts!.Value.Ext == ".ymt" && item.Parts.Value.Member == null)
            .Select(item => item.Parts!.Value.Owner)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToList();
        if (candidates.Count == 0)
        {
            throw new BridgeException("No ped variation file (<ped>.ymt) in the picked files. The .ymt lists the ped's components and textures; add it with the ped's other files.");
        }
        if (wanted.Length == 0)
        {
            if (candidates.Count > 1) return new { ped = "", candidates };
            wanted = candidates[0];
        }
        else if (!candidates.Contains(wanted))
        {
            throw new BridgeException($"No {wanted}.ymt in the picked files. Found: {string.Join(", ", candidates)}.");
        }

        var set = new PedFileSet { Ped = wanted, Source = "files" };
        var propOwner = wanted + "_p";
        foreach (var (path, parts) in classified)
        {
            var (owner, member, ext) = parts!.Value;
            if (owner != wanted && owner != propOwner) continue;
            if (member == null)
            {
                AssignPedRoot(set, new PedSourceFile { Stem = owner, Ext = ext, Path = path }, wanted);
            }
            else
            {
                AssignPedMember(set, new PedSourceFile { Stem = member, Ext = ext, Path = path, Folder = owner });
            }
        }
        var result = DescribePedFileSet(set, null);
        return result;
    }

    /// `<ped>.ydd` (owner ped, no member), `<ped>^uppr_000_u.ydd` (FiveM
    /// stream name) and `<ped>/uppr_000_u.ydd` (an archive folder laid out on
    /// disk). Null for files that are not ped files.
    private static (string Owner, string? Member, string Ext)? ClassifyPedFile(string path)
    {
        var ext = System.IO.Path.GetExtension(path).ToLowerInvariant();
        if (ext != ".ymt" && ext != ".yft" && ext != ".ydd" && ext != ".ytd") return null;
        var stem = System.IO.Path.GetFileNameWithoutExtension(path).ToLowerInvariant();
        var caret = stem.IndexOf('^');
        if (caret > 0 && caret < stem.Length - 1) return (stem[..caret], stem[(caret + 1)..], ext);
        if ((ext == ".ydd" || ext == ".ytd") && PedMemberPattern.IsMatch(stem))
        {
            var folder = System.IO.Path.GetFileName(System.IO.Path.GetDirectoryName(path) ?? string.Empty).ToLowerInvariant();
            return folder.Length > 0 ? (folder, stem, ext) : null;
        }
        return (stem, null, ext);
    }

    private static void AssignPedRoot(PedFileSet set, PedSourceFile file, string ped)
    {
        var prop = file.Stem == ped + "_p";
        if (file.Stem != ped && !prop) return;
        switch (file.Ext)
        {
            case ".ymt" when !prop: set.Ymt = PreferPedCopy(set, set.Ymt, file); break;
            case ".yft" when !prop: set.Yft = PreferPedCopy(set, set.Yft, file); break;
            case ".ydd":
                if (prop) set.PropDictionary = PreferPedCopy(set, set.PropDictionary, file);
                else set.ComponentDictionary = PreferPedCopy(set, set.ComponentDictionary, file);
                break;
            case ".ytd":
                if (prop) set.PropTextures = PreferPedCopy(set, set.PropTextures, file);
                else set.ComponentTextures = PreferPedCopy(set, set.ComponentTextures, file);
                break;
        }
    }

    private static void AssignPedMember(PedFileSet set, PedSourceFile file)
    {
        var target = file.Ext == ".ydd" ? set.MemberDrawables : file.Ext == ".ytd" ? set.MemberTextures : null;
        if (target == null) return;
        target[file.Stem] = target.TryGetValue(file.Stem, out var existing) ? PreferPedCopy(set, existing, file) : file;
    }

    /// Two copies of one ped file in the user's selection (a `backup` folder,
    /// say): the copy fewer folders deep, nearest the picked folder, is used;
    /// on a tie the first by path. The warning names both paths. Game files
    /// keep the first entry, as the archive index orders them.
    private static PedSourceFile PreferPedCopy(PedFileSet set, PedSourceFile? existing, PedSourceFile file)
    {
        if (existing == null) return file;
        if (existing.Path == null || file.Path == null) return existing;
        var keep = PedPathDepth(file.Path) < PedPathDepth(existing.Path) ? file : existing;
        var skipped = ReferenceEquals(keep, file) ? existing : file;
        set.Warnings.Add($"Two copies of {keep.Label}: using {keep.Path}, not {skipped.Path}.");
        return keep;
    }

    private static int PedPathDepth(string path) => path.Count(c => c == '\\' || c == '/');

    private static T LoadPedResource<T>(PedSourceFile file, SharedTextureArchive? archive, Action<T, byte[]> loadUser) where T : class, PackedFile, new()
    {
        try
        {
            if (file.Entry != null)
            {
                return archive!.Manager.GetFile<T>(file.Entry)
                    ?? throw new BridgeException($"Failed to load {file.Label} from the game files.");
            }
            var resource = new T();
            loadUser(resource, File.ReadAllBytes(file.Path!));
            return resource;
        }
        catch (Exception ex) when (ex is not BridgeException)
        {
            throw new BridgeException($"{file.Label} could not be read: {ShortReason(ex)}");
        }
    }

    private static object DescribePedFileSet(PedFileSet set, SharedTextureArchive? archive)
    {
        LoadJenkIndexStrings();
        var variation = ReadPedVariationXml(set, archive);

        if (set.ComponentDictionary != null) set.ComponentDictionaryData = IndexDictionaryDrawables(set, set.ComponentDictionary, archive);
        if (set.PropDictionary != null) IndexDictionaryDrawables(set, set.PropDictionary, archive);
        if (set.ComponentTextures != null) IndexDictionaryTextures(set, set.ComponentTextures, archive);
        if (set.PropTextures != null) IndexDictionaryTextures(set, set.PropTextures, archive);

        var (bones, skeletonFile) = ReadPedSkeleton(set, archive);
        var components = DescribePedComponents(set, variation);
        var props = DescribePedProps(set, variation);
        if (components.Count == 0)
        {
            throw new BridgeException($"{set.Ymt!.Label} lists no components for {set.Ped}.");
        }
        return new
        {
            ped = set.Ped,
            source = set.Source,
            skeleton = new { bones },
            skeletonFile,
            files = set.FileRefs,
            components,
            props,
            warnings = set.Warnings.Take(MaxParseWarnings).ToList(),
        };
    }

    /// The ped's CPedVariationInfo as XML (CodeWalker's Meta or PSO writer), so
    /// both binary layouts read through one path.
    private static XmlElement ReadPedVariationXml(PedFileSet set, SharedTextureArchive? archive)
    {
        var file = set.Ymt!;
        var ymt = LoadPedResource<YmtFile>(file, archive, (resource, data) =>
        {
            if (data.Length >= 4 && BitConverter.ToUInt32(data, 0) == 0x37435352) // RSC7
            {
                resource.Load(data);
            }
            else
            {
                resource.Load(data, new RpfBinaryFileEntry { Name = System.IO.Path.GetFileName(file.Path!), NameLower = System.IO.Path.GetFileName(file.Path!).ToLowerInvariant() });
            }
        });
        string xml;
        try
        {
            xml = ymt.Meta != null ? MetaXml.GetXml(ymt.Meta) : ymt.Pso != null ? PsoXml.GetXml(ymt.Pso) : string.Empty;
        }
        catch (Exception ex)
        {
            throw new BridgeException($"{file.Label} could not be read as a ped variation file: {ShortReason(ex)}");
        }
        var doc = new XmlDocument();
        try
        {
            if (!string.IsNullOrWhiteSpace(xml)) doc.LoadXml(xml);
        }
        catch (XmlException ex)
        {
            throw new BridgeException($"{file.Label} could not be read as a ped variation file: {ShortReason(ex)}");
        }
        var root = doc.DocumentElement;
        if (root == null || root.Name != "CPedVariationInfo")
        {
            throw new BridgeException($"{file.Label} is not a ped variation file (no CPedVariationInfo).");
        }
        return root;
    }

    private static YddFile IndexDictionaryDrawables(PedFileSet set, PedSourceFile file, SharedTextureArchive? archive)
    {
        var ydd = LoadPedResource<YddFile>(file, archive, (resource, data) => resource.Load(data));
        foreach (var hash in ydd.Dict?.Keys ?? Enumerable.Empty<uint>())
        {
            set.DictionaryDrawables.TryAdd(hash, file);
        }
        return ydd;
    }

    private static void IndexDictionaryTextures(PedFileSet set, PedSourceFile file, SharedTextureArchive? archive)
    {
        var ytd = LoadPedResource<YtdFile>(file, archive, (resource, data) => resource.Load(data));
        foreach (var texture in ytd.TextureDict?.Textures?.data_items ?? Array.Empty<Texture>())
        {
            var name = texture?.Name?.Trim().ToLowerInvariant();
            if (!string.IsNullOrEmpty(name)) set.DictionaryTextures.TryAdd(name, file);
        }
    }

    /// The bind skeleton from the .yft fragment drawable. A ped's .yft holds no
    /// geometry, only the skeleton. Without a .yft (user files), a drawable
    /// that embeds the skeleton (a head, usually) stands in.
    private static (List<SkeletonBoneData> Bones, string File) ReadPedSkeleton(PedFileSet set, SharedTextureArchive? archive)
    {
        if (set.Yft != null)
        {
            var yft = LoadPedResource<YftFile>(set.Yft, archive, (resource, data) => resource.Load(data));
            var bones = CollectSkeleton(yft.Fragment?.Drawable)?.Bones;
            if (bones == null || bones.Count == 0)
            {
                throw new BridgeException($"{set.Yft.Label} has no skeleton.");
            }
            return (ValidatePedBones(bones, set.Yft.Label), set.Yft.Label);
        }

        var candidates = new List<PedSourceFile>();
        if (set.ComponentDictionary != null) candidates.Add(set.ComponentDictionary);
        candidates.AddRange(set.MemberDrawables
            .Where(item => item.Key.StartsWith("head_", StringComparison.Ordinal))
            .OrderBy(item => item.Key, StringComparer.Ordinal)
            .Select(item => item.Value));
        foreach (var file in candidates)
        {
            var ydd = ReferenceEquals(file, set.ComponentDictionary) && set.ComponentDictionaryData != null
                ? set.ComponentDictionaryData
                : LoadPedResource<YddFile>(file, archive, (resource, data) => resource.Load(data));
            var drawable = ydd.DrawableDict?.Drawables?.data_items?.FirstOrDefault(item => item?.Skeleton?.Bones?.Items?.Length > 0);
            var bones = CollectSkeleton(drawable)?.Bones;
            if (bones != null && bones.Count > 0) return (ValidatePedBones(bones, file.Label), file.Label);
        }
        throw new BridgeException($"No skeleton for {set.Ped}: add {set.Ped}.yft with the other files.");
    }

    private static List<SkeletonBoneData> ValidatePedBones(List<SkeletonBoneData> bones, string label)
    {
        if (bones.Count > MaxPedBones) throw new BridgeException($"{label} has {bones.Count} bones; at most {MaxPedBones} are supported.");
        foreach (var bone in bones)
        {
            if (!bone.Translation.All(float.IsFinite) || !bone.Rotation.All(float.IsFinite))
            {
                throw new BridgeException($"{label} has a bone ({bone.Name}) with an invalid transform.", 3);
            }
        }
        return bones;
    }

    private static int FileRef(PedFileSet set, PedSourceFile file, bool dictionary)
    {
        if (set.FileIndex.TryGetValue(file, out var index)) return index;
        index = set.FileRefs.Count;
        var kind = file.Ext.TrimStart('.');
        set.FileRefs.Add(file.Entry != null
            ? new { kind, dictionary, folder = file.Folder, file = file.Entry.NameLower ?? file.Stem + file.Ext }
            : new { kind, dictionary, path = file.Path! });
        set.FileIndex[file] = index;
        return index;
    }

    /// A drawable by name: its own file, or an entry of the ped's dictionary.
    private static object? FindPedDrawable(PedFileSet set, string name)
    {
        var hash = JenkHash.GenHash(name);
        if (set.MemberDrawables.TryGetValue(name, out var member))
        {
            return new { name, hash, file = FileRef(set, member, false) };
        }
        if (set.DictionaryDrawables.TryGetValue(hash, out var dictionary))
        {
            return new { name, hash, file = FileRef(set, dictionary, true) };
        }
        return null;
    }

    /// A texture by name: its own .ytd, or an entry of the ped's texture dictionary.
    private static object? FindPedTexture(PedFileSet set, string name)
    {
        if (set.MemberTextures.TryGetValue(name, out var member)) return new { name, file = FileRef(set, member, false) };
        if (set.DictionaryTextures.TryGetValue(name, out var dictionary)) return new { name, file = FileRef(set, dictionary, true) };
        return null;
    }

    private static IEnumerable<string> TextureNamesWithPrefix(PedFileSet set, string prefix) =>
        set.MemberTextures.Keys.Concat(set.DictionaryTextures.Keys)
            .Where(name => name.StartsWith(prefix, StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(name => name, StringComparer.Ordinal);

    /// Diffuse for texture variant `letterIndex`: the race the .ymt names, then
    /// whichever race the files carry for that letter, then no race at all.
    private static object? FindPedDiffuse(PedFileSet set, string prefix, int letterIndex, int texId)
    {
        var letter = (char)('a' + letterIndex % 26);
        var stem = $"{prefix}{letter}";
        var race = RaceForTexId(texId);
        if (race != null && FindPedTexture(set, $"{stem}_{race}") is { } named) return named;
        foreach (var candidate in TextureNamesWithPrefix(set, stem + "_"))
        {
            if (candidate.Length == stem.Length + 4 && FindPedTexture(set, candidate) is { } any) return any;
        }
        return FindPedTexture(set, stem);
    }

    private static int XmlValue(XmlNode? parent, string name, int fallback = 0)
    {
        var value = parent?.SelectSingleNode(name)?.Attributes?["value"]?.Value;
        return int.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out var parsed) ? parsed : fallback;
    }

    private static List<XmlNode> XmlItems(XmlNode? parent, string name) =>
        parent?.SelectSingleNode(name)?.SelectNodes("Item")?.Cast<XmlNode>().ToList() ?? new List<XmlNode>();

    private static List<object> DescribePedComponents(PedFileSet set, XmlElement variation)
    {
        var avail = (variation.SelectSingleNode("availComp")?.InnerText ?? string.Empty)
            .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
            .Select(text => int.TryParse(text, out var value) ? value : -1)
            .ToList();
        if (avail.Count != PedComponentNames.Length || avail.Any(value => value < 0 || value > 255))
        {
            throw new BridgeException($"{set.Ymt!.Label} has a malformed availComp list.");
        }
        var data = XmlItems(variation, "aComponentData3");
        var components = new List<object>();
        for (var id = 0; id < PedComponentNames.Length; id++)
        {
            var slot = avail[id];
            if (slot == 255 || slot >= data.Count) continue;
            var component = PedComponentNames[id];
            var drawables = new List<object>();
            var items = XmlItems(data[slot], "aDrawblData3");
            if (items.Count > MaxPedDrawablesPerComponent) throw new BridgeException($"{set.Ymt!.Label} lists more than {MaxPedDrawablesPerComponent} {component} drawables.");
            for (var index = 0; index < items.Count; index++)
            {
                var item = items[index];
                var number = index.ToString("000");
                // propMask bits 4-5: 0 universal (_u), 1 race-dependent (_r), else _m.
                var type = (XmlValue(item, "propMask") >> 4) & 3;
                var suffixes = type switch { 0 => new[] { "u", "r" }, 1 => new[] { "r", "u" }, _ => new[] { "m", "u", "r" } };
                object? drawable = null;
                foreach (var suffix in suffixes)
                {
                    drawable = FindPedDrawable(set, $"{component}_{number}_{suffix}");
                    if (drawable != null) break;
                }
                var textures = XmlItems(item, "aTexData")
                    .Select((tex, letter) =>
                    {
                        var texId = XmlValue(tex, "texId");
                        return (object)new
                        {
                            letter = ((char)('a' + letter % 26)).ToString(),
                            texId,
                            diffuse = FindPedDiffuse(set, $"{component}_diff_{number}_", letter, texId),
                        };
                    })
                    .ToList();
                drawables.Add(new
                {
                    index,
                    name = $"{component}_{number}_{suffixes[0]}",
                    drawable,
                    textures,
                    normal = FindPedTexture(set, $"{component}_normal_{number}"),
                    specular = FindPedTexture(set, $"{component}_spec_{number}"),
                });
            }
            components.Add(new { component, id, drawables });
        }
        return components;
    }

    private static List<object> DescribePedProps(PedFileSet set, XmlElement variation)
    {
        var propInfo = variation.SelectSingleNode("propInfo");
        var byAnchor = new SortedDictionary<int, List<(int PropId, XmlNode Item)>>();
        foreach (var item in XmlItems(propInfo, "aPropMetaData"))
        {
            var anchor = XmlValue(item, "anchorId", -1);
            if (anchor < 0 || anchor >= PedAnchorNames.Length) continue;
            if (!byAnchor.TryGetValue(anchor, out var list)) byAnchor[anchor] = list = new();
            list.Add((XmlValue(item, "propId"), item));
        }
        var anchors = new List<object>();
        foreach (var (anchorId, list) in byAnchor)
        {
            var name = PedAnchorNames[anchorId]
                .FirstOrDefault(prefix => list.Any(prop => FindPedDrawable(set, $"{prefix}_{prop.PropId:000}") != null))
                ?? PedAnchorNames[anchorId][0];
            var props = list
                .OrderBy(prop => prop.PropId)
                .Select(prop =>
                {
                    var number = prop.PropId.ToString("000");
                    var textures = XmlItems(prop.Item, "texData")
                        .Select((tex, letter) =>
                        {
                            var texId = XmlValue(tex, "texId");
                            return (object)new
                            {
                                letter = ((char)('a' + letter % 26)).ToString(),
                                texId,
                                diffuse = FindPedDiffuse(set, $"{name}_diff_{number}_", letter, texId),
                            };
                        })
                        .ToList();
                    return (object)new
                    {
                        index = prop.PropId,
                        name = $"{name}_{number}",
                        drawable = FindPedDrawable(set, $"{name}_{number}"),
                        textures,
                        normal = FindPedTexture(set, $"{name}_normal_{number}"),
                        specular = FindPedTexture(set, $"{name}_spec_{number}"),
                    };
                })
                .ToList();
            anchors.Add(new { anchor = name, anchorId, props });
        }
        return anchors;
    }
}
