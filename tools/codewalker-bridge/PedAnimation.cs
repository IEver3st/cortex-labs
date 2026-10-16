using System.Text.RegularExpressions;
using System.Xml;
using CodeWalker.GameFiles;
using SharpDX;

namespace CodeWalkerBridge;

// Ped animation clips and DLC collection order. Kept out of Program.cs so the
// YFT/clmesh pipeline and the ped preview pipeline can change independently.
public static partial class Program
{
    private const float ClipSampleRate = 30f;
    private const int MaxClipSamples = 1800; // one minute at 30 fps
    private const int MaxClipNameLength = 128;
    private const int MaxSearchResults = 80;
    private const int MaxSearchQueryLength = 64;
    private const int MaxArchetypeYtyps = 64;

    private static readonly Regex ClipNamePattern = new("^[a-z0-9_@.\\-]+$", RegexOptions.Compiled);
    private static readonly Regex ModelNamePattern = new("^[a-z0-9_\\-]+$", RegexOptions.Compiled);
    private static readonly Regex SearchQueryPattern = new("^[a-z0-9_@.\\- ]+$", RegexOptions.Compiled);
    private static readonly Regex DlcPackPattern = new(@"dlcpacks\\([^\\]+)\\", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static Dictionary<string, RpfFileEntry>? YcdIndex;
    private static Dictionary<string, RpfFileEntry>? PropModelIndex;
    private static Dictionary<string, int>? DlcPackOrders;

    private static string ValidateClipName(string value, string name)
    {
        var lower = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (lower.Length == 0 || lower.Length > MaxClipNameLength || !ClipNamePattern.IsMatch(lower) || lower.Contains(".."))
        {
            throw new BridgeException($"Parameter '{name}' must be 1-{MaxClipNameLength} characters of a-z, 0-9, _, @, ., -.");
        }
        return lower;
    }

    /// Clip names inside a user's own .ycd are only matched against its
    /// entries, never used as paths, so any printable name is accepted.
    private static string ValidateFileClipName(string value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0 || trimmed.Length > MaxClipNameLength || trimmed.Any(char.IsControl))
        {
            throw new BridgeException($"Parameter 'clip' must be 1-{MaxClipNameLength} printable characters.");
        }
        return trimmed;
    }

    private static string ValidateModelName(string value)
    {
        var lower = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (lower.Length == 0 || lower.Length > MaxClipNameLength || !ModelNamePattern.IsMatch(lower))
        {
            throw new BridgeException($"Parameter 'name' must be 1-{MaxClipNameLength} characters of a-z, 0-9, _, -.");
        }
        return lower;
    }

    private static string[] SearchTokens(string query)
    {
        var lower = (query ?? string.Empty).Trim().ToLowerInvariant();
        if (lower.Length == 0 || lower.Length > MaxSearchQueryLength || !SearchQueryPattern.IsMatch(lower))
        {
            throw new BridgeException($"Parameter 'query' must be 1-{MaxSearchQueryLength} characters of a-z, 0-9, _, @, ., - and spaces.");
        }
        return lower.Split(' ', StringSplitOptions.RemoveEmptyEntries);
    }

    /// Names containing every token. Names that start with the first token, or
    /// carry it after a separator, rank first, then shorter names, so "phone"
    /// lists prop_phone_* ahead of v_res_phone_cabinet.
    private static object SearchNames(IEnumerable<string> names, string[] tokens, string key)
    {
        var matches = names.Where(name => tokens.All(token => name.Contains(token, StringComparison.Ordinal))).ToList();
        var first = tokens[0];
        int rank(string name) =>
            name.StartsWith(first, StringComparison.Ordinal) ? 0
            : name.Contains("_" + first, StringComparison.Ordinal) || name.Contains("@" + first, StringComparison.Ordinal) ? 1
            : 2;
        var ranked = matches
            .OrderBy(rank)
            .ThenBy(name => name.Length)
            .ThenBy(name => name, StringComparer.Ordinal)
            .Take(MaxSearchResults)
            .ToList();
        return new Dictionary<string, object> { ["query"] = string.Join(' ', tokens), [key] = ranked, ["total"] = matches.Count };
    }

    private static SharedTextureArchive RequireArchive(string feature)
    {
        return GetSharedTextureArchive()
            ?? throw new BridgeException($"GTA V installation was not found, so {feature} are unavailable.");
    }

    private static Dictionary<string, RpfFileEntry> GetYcdIndex(SharedTextureArchive archive)
    {
        if (YcdIndex != null) return YcdIndex;
        var index = new Dictionary<string, RpfFileEntry>(StringComparer.OrdinalIgnoreCase);
        var priorities = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                if (!name.EndsWith(".ycd", StringComparison.Ordinal)) continue;
                var key = name[..^4];
                var priority = GetArchiveEntryPriority(entry.Path);
                if (!index.ContainsKey(key) || priority >= priorities[key])
                {
                    index[key] = entry;
                    priorities[key] = priority;
                }
            }
        }
        YcdIndex = index;
        return index;
    }

    private static YcdFile LoadYcd(string dict)
    {
        var archive = RequireArchive("animations");
        if (!GetYcdIndex(archive).TryGetValue(dict, out var entry))
        {
            throw new BridgeException($"Animation dictionary '{dict}' was not found in the game files.");
        }
        return archive.Manager.GetFile<YcdFile>(entry)
            ?? throw new BridgeException($"Failed to load animation dictionary '{dict}'.");
    }

    private static float ClipDuration(ClipBase clip)
    {
        return clip switch
        {
            ClipAnimation single => Math.Max(0f, (single.EndTime - single.StartTime) / (single.Rate > 0 ? single.Rate : 1f)),
            ClipAnimationList list => Math.Max(0f, list.Duration),
            _ => 0f,
        };
    }

    private static object ListPedClips(string dict)
    {
        var name = ValidateClipName(dict, "dict");
        return new { dict = name, clips = ListClips(LoadYcd(name)) };
    }

    private static List<object> ListClips(YcdFile ycd)
    {
        return (ycd.ClipMapEntries ?? Array.Empty<ClipMapEntry>())
            .Select(entry => entry?.Clip)
            .Where(clip => clip != null && !string.IsNullOrEmpty(clip.ShortName))
            .Select(clip => new { name = clip!.ShortName, duration = ClipDuration(clip) })
            .OrderBy(item => item.name, StringComparer.Ordinal)
            .Cast<object>()
            .ToList();
    }

    /// Every animation dictionary in the game files whose name contains the query.
    private static object SearchAnimDicts(string query)
    {
        var tokens = SearchTokens(query);
        return SearchNames(GetYcdIndex(RequireArchive("animations")).Keys, tokens, "dicts");
    }

    /// A .ycd the user picked: their own animation, or one from a resource.
    private static YcdFile LoadYcdFile(string ycdPath)
    {
        if (string.IsNullOrWhiteSpace(ycdPath) || !ycdPath.EndsWith(".ycd", StringComparison.OrdinalIgnoreCase) || !File.Exists(ycdPath))
        {
            throw new BridgeException($"'{Path.GetFileName(ycdPath)}' is not an existing .ycd animation dictionary.");
        }
        var ycd = new YcdFile();
        try
        {
            RpfFile.LoadResourceFile(ycd, File.ReadAllBytes(ycdPath), 46);
        }
        catch (Exception ex) when (ex is not BridgeException)
        {
            throw new BridgeException($"'{Path.GetFileName(ycdPath)}' could not be read as an animation dictionary: {ex.Message}");
        }
        if (ycd.ClipDictionary == null)
        {
            throw new BridgeException($"'{Path.GetFileName(ycdPath)}' is not a readable animation dictionary.");
        }
        return ycd;
    }

    private static object ListClipFile(string ycdPath)
    {
        return new { dict = Path.GetFileNameWithoutExtension(ycdPath), clips = ListClips(LoadYcdFile(ycdPath)) };
    }

    private static object ExportClipFile(string ycdPath, string clipName)
    {
        var wanted = ValidateFileClipName(clipName);
        return SampleClip(LoadYcdFile(ycdPath), Path.GetFileNameWithoutExtension(ycdPath), wanted);
    }

    private static object ExportPedClip(string dict, string clipName)
    {
        var dictName = ValidateClipName(dict, "dict");
        var wanted = ValidateClipName(clipName, "clip");
        return SampleClip(LoadYcd(dictName), dictName, wanted);
    }

    /// A model's own clip, such as a convertible roof. The app passes the
    /// resource's streamed .ycd when it has one; otherwise the game files supply
    /// the dictionary, as they do for add-ons that reuse a base-game roof.
    private static object ExportModelClip(string dict, string clipName, string ycdPath)
    {
        var dictName = ValidateClipName(dict, "dict");
        var wanted = ValidateClipName(clipName, "clip");
        if (string.IsNullOrWhiteSpace(ycdPath)) return SampleClip(LoadYcd(dictName), dictName, wanted);
        return SampleClip(LoadYcdFile(ycdPath), dictName, wanted);
    }

    /// Samples a clip at a fixed rate into per-bone local rotation and
    /// translation tracks, keyed by bone tag. Mover (root motion) tracks are
    /// reduced to an average velocity so the preview can play in place.
    private static object SampleClip(YcdFile ycd, string dictName, string wanted)
    {
        var clip = (ycd.ClipMapEntries ?? Array.Empty<ClipMapEntry>())
            .Select(entry => entry?.Clip)
            .FirstOrDefault(item => item != null && string.Equals(item.ShortName, wanted, StringComparison.OrdinalIgnoreCase))
            ?? throw new BridgeException($"Clip '{wanted}' was not found in '{dictName}'.");

        var parts = new List<(Animation Anim, Func<double, float> Time)>();
        if (clip is ClipAnimation single && single.Animation != null)
        {
            parts.Add((single.Animation, t => single.GetPlaybackTime(t)));
        }
        if (clip is ClipAnimationList list && list.Animations != null)
        {
            foreach (var item in list.Animations)
            {
                if (item?.Animation != null) parts.Add((item.Animation, t => item.GetPlaybackTime(t)));
            }
        }
        parts.RemoveAll(part => part.Anim.BoneIds?.data_items == null || part.Anim.Sequences?.data_items == null);
        if (parts.Count == 0) throw new BridgeException($"Clip '{wanted}' has no bone animation.");

        var duration = ClipDuration(clip);
        if (duration <= 0) duration = parts[0].Anim.Duration;
        if (duration <= 0) throw new BridgeException($"Clip '{wanted}' has no duration.");
        var samples = Math.Clamp((int)Math.Round(duration * ClipSampleRate) + 1, 2, MaxClipSamples);

        var rotations = new Dictionary<ushort, float[]>();
        var translations = new Dictionary<ushort, float[]>();
        Vector3? moverStart = null;
        Vector3 moverEnd = Vector3.Zero;

        for (var s = 0; s < samples; s++)
        {
            // The last sample sits just before the loop point so the mover delta
            // spans the whole clip; playback wraps back to sample 0.
            var time = Math.Min(duration * s / (samples - 1), duration * 0.9995);
            var mover = Vector3.Zero;
            foreach (var (anim, timeOf) in parts)
            {
                var frame = anim.GetFramePosition(timeOf(time));
                var boneIds = anim.BoneIds.data_items;
                for (var i = 0; i < boneIds.Length; i++)
                {
                    var bone = boneIds[i];
                    switch (bone.Track)
                    {
                        case 0:
                        {
                            var v = anim.EvaluateVector4(frame, i, true);
                            var values = translations.TryGetValue(bone.BoneId, out var t) ? t : translations[bone.BoneId] = new float[samples * 3];
                            values[s * 3] = v.X;
                            values[s * 3 + 1] = v.Y;
                            values[s * 3 + 2] = v.Z;
                            break;
                        }
                        case 1:
                        {
                            var q = anim.EvaluateQuaternion(frame, i, true);
                            q.Normalize();
                            var values = rotations.TryGetValue(bone.BoneId, out var r) ? r : rotations[bone.BoneId] = new float[samples * 4];
                            values[s * 4] = q.X;
                            values[s * 4 + 1] = q.Y;
                            values[s * 4 + 2] = q.Z;
                            values[s * 4 + 3] = q.W;
                            break;
                        }
                        case 5:
                        {
                            var v = anim.EvaluateVector4(frame, i, true);
                            mover += new Vector3(v.X, v.Y, v.Z);
                            break;
                        }
                    }
                }
            }
            moverStart ??= mover;
            moverEnd = mover;
        }

        var moverTime = duration * 0.9995;
        var velocity = moverStart.HasValue && moverTime > 0 ? (moverEnd - moverStart.Value) / (float)moverTime : Vector3.Zero;
        return new
        {
            dict = dictName,
            clip = wanted,
            duration,
            sampleRate = (samples - 1) / duration,
            samples,
            rotations = rotations.Select(kv => new { bone = kv.Key, values = kv.Value }).ToList(),
            translations = translations.Select(kv => new { bone = kv.Key, values = kv.Value }).ToList(),
            moverVelocity = new[] { velocity.X, velocity.Y, velocity.Z },
        };
    }

    /// Game drawables (.ydr) by name, highest-priority archive first. Handheld
    /// props, weapons and map pieces are all drawables; the search ranks names.
    private static Dictionary<string, RpfFileEntry> GetPropModelIndex(SharedTextureArchive archive)
    {
        if (PropModelIndex != null) return PropModelIndex;
        var index = new Dictionary<string, RpfFileEntry>(StringComparer.OrdinalIgnoreCase);
        var priorities = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                if (!name.EndsWith(".ydr", StringComparison.Ordinal)) continue;
                var key = name[..^4];
                var priority = GetArchiveEntryPriority(entry.Path);
                if (!index.ContainsKey(key) || priority >= priorities[key])
                {
                    index[key] = entry;
                    priorities[key] = priority;
                }
            }
        }
        PropModelIndex = index;
        return index;
    }

    private static object SearchGameProps(string query)
    {
        var tokens = SearchTokens(query);
        return SearchNames(GetPropModelIndex(RequireArchive("game props")).Keys, tokens, "props");
    }

    /// Extracts a game prop as a raw resource file so the ordinary model parser
    /// reads it. The archetype .ytyp naming the prop's texture dictionary is
    /// written beside it; that is how the parser finds a shared dictionary not
    /// named after the model. Existing output is reused.
    private static object ExportGameProp(string name, string outputDir)
    {
        var model = ValidateModelName(name);
        var archive = RequireArchive("game props");
        if (!GetPropModelIndex(archive).TryGetValue(model, out var entry))
        {
            throw new BridgeException($"Prop '{model}' was not found in the game files.");
        }
        var folder = Path.Combine(outputDir, model);
        var targetPath = Path.Combine(folder, model + ".ydr");
        if (File.Exists(targetPath)) return new { path = targetPath, name = model, rpfPath = entry.Path };

        try
        {
            var ytyp = FindArchetypeYtyp(archive, entry, JenkHash.GenHash(model));
            if (ytyp != null) WriteRawEntry(ytyp, Path.Combine(folder, ytyp.NameLower ?? "archetype.ytyp"));
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[props] {model} archetype lookup failed: {ex.Message}");
        }
        // The model goes last: its presence marks a complete export.
        WriteRawEntry(entry, targetPath);
        return new { path = targetPath, name = model, rpfPath = entry.Path };
    }

    /// The .ytyp beside the prop (same archive, then its parents) that gives
    /// it an archetype with a texture dictionary.
    private static RpfFileEntry? FindArchetypeYtyp(SharedTextureArchive archive, RpfFileEntry model, uint modelHash)
    {
        var scanned = 0;
        for (var rpf = model.File; rpf != null && scanned < MaxArchetypeYtyps; rpf = rpf.Parent)
        {
            foreach (var candidate in rpf.AllEntries?.OfType<RpfFileEntry>() ?? Enumerable.Empty<RpfFileEntry>())
            {
                if (!(candidate.NameLower ?? string.Empty).EndsWith(".ytyp", StringComparison.Ordinal)) continue;
                if (++scanned > MaxArchetypeYtyps) break;
                var ytyp = archive.Manager.GetFile<YtypFile>(candidate);
                var match = ytyp?.AllArchetypes?.Any(archetype =>
                    archetype != null && (uint)archetype.Hash == modelHash && (uint)archetype.TextureDict != 0) == true;
                if (match) return candidate;
            }
        }
        return null;
    }

    /// Writes an archive entry the way CodeWalker "Extract raw" does: resources
    /// get the RSC7 header and a deflated body. The temp file keeps a failed
    /// write from leaving a truncated file behind.
    private static void WriteRawEntry(RpfFileEntry entry, string targetPath)
    {
        var data = entry.File.ExtractFile(entry)
            ?? throw new BridgeException($"Failed to extract '{entry.Path}': {entry.File.LastError}");
        if (entry is RpfResourceFileEntry resourceEntry)
        {
            data = ResourceBuilder.AddResourceHeader(resourceEntry, ResourceBuilder.Compress(data));
        }
        Directory.CreateDirectory(Path.GetDirectoryName(targetPath) ?? ".");
        var tempPath = targetPath + ".tmp";
        File.WriteAllBytes(tempPath, data);
        File.Move(tempPath, targetPath, overwrite: true);
    }

    /// DLC packs register in dlclist.xml order, which is release order; ped
    /// clothing collections take their in-game drawable numbers in that order.
    /// setup2.xml `order` only breaks ties for packs missing from the list.
    private static Dictionary<string, int> GetDlcPackOrders(SharedTextureArchive archive)
    {
        if (DlcPackOrders != null) return DlcPackOrders;
        var listPosition = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        try
        {
            var text = archive.Manager.GetFileUTF8Text(@"update\update.rpf\common\data\dlclist.xml");
            if (!string.IsNullOrEmpty(text))
            {
                var doc = new XmlDocument();
                doc.LoadXml(text);
                var items = doc.SelectNodes("//Paths/Item");
                for (var i = 0; i < (items?.Count ?? 0); i++)
                {
                    var match = Regex.Match(items![i]!.InnerText ?? string.Empty, @"dlcpacks[:\\/]+([^\\/]+)", RegexOptions.IgnoreCase);
                    if (match.Success) listPosition.TryAdd(match.Groups[1].Value.ToLowerInvariant(), i);
                }
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[peds] dlclist.xml unreadable: {ex.Message}");
        }

        var orders = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            var match = Regex.Match(rpf.Path ?? string.Empty, @"dlcpacks\\([^\\]+)\\dlc\.rpf$", RegexOptions.IgnoreCase);
            if (!match.Success || rpf.AllEntries == null) continue;
            var pack = match.Groups[1].Value.ToLowerInvariant();
            var setup = rpf.AllEntries.OfType<RpfFileEntry>()
                .FirstOrDefault(entry => entry.NameLower == "setup2.xml" && entry.Parent == rpf.Root);
            var order = 0;
            if (setup != null)
            {
                try
                {
                    var data = setup.File.ExtractFile(setup);
                    var doc = new XmlDocument();
                    doc.LoadXml(System.Text.Encoding.UTF8.GetString(data ?? Array.Empty<byte>()).TrimStart('﻿'));
                    var value = doc.SelectSingleNode("//order")?.Attributes?["value"]?.Value;
                    if (!int.TryParse(value, out order)) order = 0;
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[peds] {pack} setup2.xml unreadable: {ex.Message}");
                }
            }
            var position = listPosition.TryGetValue(pack, out var p) ? p : 99999;
            orders[pack] = position * 1000 + Math.Clamp(order, 0, 999);
        }
        DlcPackOrders = orders;
        return orders;
    }

    /// Every clothing folder for the ped with the earliest DLC that provides it
    /// (the base ped's own folders sort first). Patch packs that replace files
    /// in an existing folder do not move it.
    private static List<object> ListPedCollections(string ped)
    {
        var archive = GetSharedTextureArchive();
        if (archive == null) return new List<object>();
        var orders = GetDlcPackOrders(archive);
        var pedLower = ped.Trim().ToLowerInvariant();
        var pedPrefix = pedLower + "_";
        var best = new Dictionary<string, (long Order, string Pack)>(StringComparer.OrdinalIgnoreCase);

        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                if (!name.EndsWith(".ydd", StringComparison.Ordinal)) continue;
                var folder = entry.Parent?.NameLower ?? string.Empty;
                if (folder != pedLower && !folder.StartsWith(pedPrefix, StringComparison.Ordinal)) continue;

                var packMatch = DlcPackPattern.Match(entry.Path ?? string.Empty);
                var pack = packMatch.Success ? packMatch.Groups[1].Value.ToLowerInvariant() : string.Empty;
                long order = pack.Length == 0 ? -1 : orders.TryGetValue(pack, out var o) ? o : long.MaxValue / 2;
                if (!best.TryGetValue(folder, out var current) || order < current.Order)
                {
                    best[folder] = (order, pack);
                }
            }
        }

        return best
            .OrderBy(kv => kv.Value.Order)
            .ThenBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => (object)new { folder = kv.Key, pack = kv.Value.Pack, order = kv.Value.Order })
            .ToList();
    }
}
