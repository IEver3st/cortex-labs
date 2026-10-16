using System.Text;
using System.Text.Json;
using System.Xml;
using CodeWalker.GameFiles;

namespace CodeWalkerBridge;

// Base-game vehicles for Photo Mode: a catalogue built from every vehicles.meta
// in the archives, and an export that lays one vehicle out as a minimal
// resource (fxmanifest.lua, data/vehicles.meta, carvariations.meta and
// carcols.meta, stream/<model>.yft and its .ytd) inside the app cache.
// ParseYft and the app's resource meta reader then treat it exactly like a
// FiveM vehicle resource; nothing here changes how user models are read.
public static partial class Program
{
    private sealed record GameVehicle(
        string Model,
        string GameName,
        string Make,
        string VehicleClass,
        string Type,
        string Pack,
        RpfFileEntry Meta,
        RpfFileEntry Model3d);

    private static Dictionary<string, GameVehicle>? GameVehicleIndex;
    private static Dictionary<string, RpfFileEntry>? GameYftIndex;

    // A vehicle's variation entry, every mod kit, and the carcols light and
    // siren settings by id, from the highest-priority carvariations/carcols file.
    private sealed record VehicleMetaIndex(
        Dictionary<string, string> Variations,
        Dictionary<string, string> Kits,
        Dictionary<string, string> Lights,
        Dictionary<string, string> Sirens);

    // Bumped when the exported meta gains content, so older exports are rewritten.
    private const string VehicleMetaVersion = "<!-- Cortex Studio game vehicle meta v2 -->";
    private static VehicleMetaIndex? GameVehicleMetaIndex;

    private static Dictionary<string, GameVehicle> GetGameVehicleIndex(SharedTextureArchive archive)
    {
        if (GameVehicleIndex != null) return GameVehicleIndex;

        var yfts = new Dictionary<string, RpfFileEntry>(StringComparer.OrdinalIgnoreCase);
        var yftPriority = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var metas = new List<(RpfFileEntry Entry, int Priority)>();
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                if (name == "vehicles.meta")
                {
                    metas.Add((entry, GetArchiveEntryPriority(entry.Path)));
                }
                else if (name.EndsWith(".yft", StringComparison.Ordinal))
                {
                    var key = name[..^4];
                    var priority = GetArchiveEntryPriority(entry.Path);
                    if (!yfts.ContainsKey(key) || priority >= yftPriority[key])
                    {
                        yfts[key] = entry;
                        yftPriority[key] = priority;
                    }
                }
            }
        }

        var index = new Dictionary<string, GameVehicle>(StringComparer.OrdinalIgnoreCase);
        var indexPriority = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        foreach (var (metaEntry, priority) in metas)
        {
            VehiclesFile? file;
            try
            {
                file = archive.Manager.GetFile<VehiclesFile>(metaEntry);
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[vehicles] {metaEntry.Path} unreadable: {ex.Message}");
                continue;
            }
            if (file?.InitDatas == null) continue;
            var packMatch = DlcPackPattern.Match(metaEntry.Path ?? string.Empty);
            var pack = packMatch.Success ? packMatch.Groups[1].Value.ToLowerInvariant() : string.Empty;
            foreach (var init in file.InitDatas)
            {
                var model = (init?.modelName ?? string.Empty).Trim().ToLowerInvariant();
                if (model.Length == 0 || !ModelNamePattern.IsMatch(model)) continue;
                // The high-detail fragment when the game ships one.
                if (!yfts.TryGetValue(model + "_hi", out var model3d) && !yfts.TryGetValue(model, out model3d)) continue;
                if (index.ContainsKey(model) && priority < indexPriority[model]) continue;
                index[model] = new GameVehicle(
                    model,
                    (init!.gameName ?? string.Empty).Trim(),
                    (init.vehicleMakeName ?? string.Empty).Trim(),
                    (init.vehicleClass ?? string.Empty).Trim(),
                    (init.type ?? string.Empty).Trim(),
                    pack,
                    metaEntry,
                    model3d);
                indexPriority[model] = priority;
            }
        }

        GameVehicleIndex = index;
        GameYftIndex = yfts;
        return index;
    }

    // dlc_patch files patch a DLC pack's own data, so they outrank it.
    private static int GetMetaPriority(string path) =>
        GetArchiveEntryPriority(path) + ((path ?? string.Empty).Contains("dlc_patch", StringComparison.OrdinalIgnoreCase) ? 15 : 0);

    private static VehicleMetaIndex GetVehicleMetaIndex(SharedTextureArchive archive)
    {
        if (GameVehicleMetaIndex != null) return GameVehicleMetaIndex;
        GetGameVehicleIndex(archive);
        LoadJenkIndexStrings();
        // Base-game .ymt files store model names as hashes; knowing every model
        // name lets the XML conversion write names the app can match to files.
        foreach (var stem in GameYftIndex!.Keys) JenkIndex.Ensure(stem);

        var variations = new Dictionary<string, (int Priority, string Xml)>(StringComparer.OrdinalIgnoreCase);
        var kits = new Dictionary<string, (int Priority, string Xml)>(StringComparer.OrdinalIgnoreCase);
        var lights = new Dictionary<string, (int Priority, string Xml)>(StringComparer.OrdinalIgnoreCase);
        var sirens = new Dictionary<string, (int Priority, string Xml)>(StringComparer.OrdinalIgnoreCase);
        void keep(Dictionary<string, (int Priority, string Xml)> into, string? key, int priority, XmlNode node)
        {
            var name = (key ?? string.Empty).Trim().ToLowerInvariant();
            if (name.Length == 0) return;
            if (into.TryGetValue(name, out var existing) && existing.Priority > priority) return;
            into[name] = (priority, node.OuterXml);
        }

        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                var name = entry.NameLower ?? string.Empty;
                var isVariation = name == "carvariations.meta" || name == "carvariations.ymt";
                var isCarcols = name == "carcols.meta" || name == "carcols.ymt";
                if (!isVariation && !isCarcols) continue;
                var document = new XmlDocument();
                try
                {
                    var data = entry.File.ExtractFile(entry) ?? throw new BridgeException(entry.File.LastError ?? "empty entry");
                    var xml = name.EndsWith(".ymt", StringComparison.Ordinal)
                        ? MetaXml.GetXml(entry, data, out _)
                        : Encoding.UTF8.GetString(data).TrimStart('\uFEFF');
                    document.LoadXml(xml);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[vehicles] {entry.Path} unreadable: {ex.Message}");
                    continue;
                }
                var priority = GetMetaPriority(entry.Path);
                if (isVariation)
                {
                    foreach (XmlNode item in document.SelectNodes("//variationData/Item")!)
                        keep(variations, item.SelectSingleNode("modelName")?.InnerText, priority, item);
                }
                else
                {
                    foreach (XmlNode item in document.SelectNodes("//Kits/Item")!)
                        keep(kits, item.SelectSingleNode("kitName")?.InnerText, priority, item);
                    foreach (XmlNode item in document.SelectNodes("/*/Lights/Item")!)
                        keep(lights, item.SelectSingleNode("id")?.Attributes?["value"]?.Value, priority, item);
                    foreach (XmlNode item in document.SelectNodes("/*/Sirens/Item")!)
                        keep(sirens, item.SelectSingleNode("id")?.Attributes?["value"]?.Value, priority, item);
                }
            }
        }

        static Dictionary<string, string> flatten(Dictionary<string, (int Priority, string Xml)> source) =>
            source.ToDictionary(pair => pair.Key, pair => pair.Value.Xml, StringComparer.OrdinalIgnoreCase);
        GameVehicleMetaIndex = new VehicleMetaIndex(flatten(variations), flatten(kits), flatten(lights), flatten(sirens));
        return GameVehicleMetaIndex;
    }

    /// The vehicle's variation entry (or null) and the kits it names, in order.
    private static (XmlElement? Variation, List<XmlElement> Kits) GetVehicleKits(VehicleMetaIndex meta, string model)
    {
        var kits = new List<XmlElement>();
        if (!meta.Variations.TryGetValue(model, out var variationXml)) return (null, kits);
        var document = new XmlDocument();
        document.LoadXml(variationXml);
        var variation = document.DocumentElement;
        var kitNames = variation?.SelectNodes("kits/Item");
        if (kitNames == null) return (variation, kits);
        foreach (XmlNode kitName in kitNames)
        {
            if (!meta.Kits.TryGetValue(kitName.InnerText.Trim().ToLowerInvariant(), out var kitXml)) continue;
            var kitDocument = new XmlDocument();
            kitDocument.LoadXml(kitXml);
            if (kitDocument.DocumentElement != null) kits.Add(kitDocument.DocumentElement);
        }
        return (variation, kits);
    }

    /// Writes the vehicle's carvariations entry and kits as resource meta files.
    private static void WriteVehicleKitMeta(SharedTextureArchive archive, string model, string dataFolder)
    {
        var (variation, kits) = GetVehicleKits(GetVehicleMetaIndex(archive), model);
        var variations = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CVehicleModelInfoVariation>\n  <variationData>\n");
        if (variation != null) variations.Append(variation.OuterXml).Append('\n');
        variations.Append("  </variationData>\n</CVehicleModelInfoVariation>\n");
        var meta = GetVehicleMetaIndex(archive);
        string settingXml(Dictionary<string, string> index, string element)
        {
            var id = variation?.SelectSingleNode(element)?.Attributes?["value"]?.Value;
            return id != null && index.TryGetValue(id.Trim(), out var xml) ? xml + "\n" : string.Empty;
        }
        var carcols = new StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n" + VehicleMetaVersion + "\n<CVehicleModelInfoVarGlobal>\n  <Kits>\n");
        foreach (var kit in kits) carcols.Append(kit.OuterXml).Append('\n');
        carcols.Append("  </Kits>\n  <Lights>\n").Append(settingXml(meta.Lights, "lightSettings"));
        carcols.Append("  </Lights>\n  <Sirens>\n").Append(settingXml(meta.Sirens, "sirenSettings"));
        carcols.Append("  </Sirens>\n</CVehicleModelInfoVarGlobal>\n");
        WriteTextAtomically(Path.Combine(dataFolder, "carvariations.meta"), variations.ToString());
        WriteTextAtomically(Path.Combine(dataFolder, "carcols.meta"), carcols.ToString());
    }

    private static void WriteTextAtomically(string path, string text)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path) ?? ".");
        var tempPath = path + ".tmp";
        File.WriteAllText(tempPath, text, new UTF8Encoding(false));
        File.Move(tempPath, path, overwrite: true);
    }

    /// Every vehicle the installed game defines, sorted by model name.
    private static object ListGameVehicles()
    {
        var index = GetGameVehicleIndex(RequireArchive("game vehicles"));
        var vehicles = index.Values
            .OrderBy(vehicle => vehicle.Model, StringComparer.Ordinal)
            .Select(vehicle => new
            {
                name = vehicle.Model,
                gameName = vehicle.GameName,
                make = vehicle.Make,
                vehicleClass = vehicle.VehicleClass,
                type = vehicle.Type,
                pack = vehicle.Pack,
            })
            .ToList();
        return new { vehicles, total = vehicles.Count };
    }

    /// Extracts a game vehicle into `<outputDir>/<model>/` as a minimal resource.
    /// The fragment is written last, so its presence marks a complete export
    /// and an existing one is reused.
    private static object ExportGameVehicle(string name, string outputDir)
    {
        var model = ValidateModelName(name);
        var archive = RequireArchive("game vehicles");
        if (!GetGameVehicleIndex(archive).TryGetValue(model, out var vehicle))
        {
            throw new BridgeException($"Vehicle '{model}' was not found in the game files.");
        }

        var folder = Path.Combine(outputDir, model);
        var stream = Path.Combine(folder, "stream");
        var data = Path.Combine(folder, "data");
        var targetPath = Path.Combine(stream, vehicle.Model3d.NameLower ?? model + ".yft");
        // Exports made by an older version gain the current meta here.
        var carcolsPath = Path.Combine(data, "carcols.meta");
        if (!File.Exists(carcolsPath) || !File.ReadAllText(carcolsPath).Contains(VehicleMetaVersion, StringComparison.Ordinal))
        {
            WriteVehicleKitMeta(archive, model, data);
        }
        if (File.Exists(targetPath)) return new { path = targetPath, name = model, rpfPath = vehicle.Model3d.Path };

        Directory.CreateDirectory(data);
        File.WriteAllText(
            Path.Combine(folder, "fxmanifest.lua"),
            $"-- Cortex Studio cache: the base-game vehicle '{model}', extracted from the GTA V archives\n" +
            "-- for preview. Laid out as a resource so its vehicles.meta texture chain resolves.\n" +
            "fx_version 'cerulean'\ngame 'gta5'\n");
        WriteRawEntry(vehicle.Meta, Path.Combine(folder, "data", "vehicles.meta"));
        foreach (var txd in new[] { model, model + "+hi" })
        {
            if (archive.YtdEntries.TryGetValue(txd, out var ytd))
            {
                WriteRawEntry(ytd, Path.Combine(stream, txd + ".ytd"));
            }
        }
        WriteRawEntry(vehicle.Model3d, targetPath);
        return new { path = targetPath, name = model, rpfPath = vehicle.Model3d.Path };
    }

    /// Extracts every model the vehicle's mod kits use (each mod and its linked
    /// models) into `<outputDir>/<model>/stream/mods/`, so the app's mod kit
    /// reader finds them like a resource's own. Existing files are reused.
    private static object ExportGameVehicleMods(string name, string outputDir)
    {
        var model = ValidateModelName(name);
        var archive = RequireArchive("game vehicles");
        if (!GetGameVehicleIndex(archive).ContainsKey(model))
        {
            throw new BridgeException($"Vehicle '{model}' was not found in the game files.");
        }
        var (_, kits) = GetVehicleKits(GetVehicleMetaIndex(archive), model);
        var names = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var kit in kits)
        {
            foreach (XmlNode mod in kit.SelectNodes("visibleMods/Item")!)
            {
                var modelName = mod.SelectSingleNode("modelName")?.InnerText;
                if (!string.IsNullOrWhiteSpace(modelName)) names.Add(modelName.Trim().ToLowerInvariant());
                foreach (XmlNode linked in mod.SelectNodes("linkedModels/Item")!)
                {
                    if (!string.IsNullOrWhiteSpace(linked.InnerText)) names.Add(linked.InnerText.Trim().ToLowerInvariant());
                }
            }
        }

        var folder = Path.Combine(outputDir, model, "stream", "mods");
        var missing = new List<string>();
        var written = 0;
        var reused = 0;
        foreach (var modName in names)
        {
            if (!ModelNamePattern.IsMatch(modName) || !GameYftIndex!.TryGetValue(modName, out var entry))
            {
                missing.Add(modName);
                continue;
            }
            var target = Path.Combine(folder, modName + ".yft");
            if (File.Exists(target))
            {
                reused += 1;
                continue;
            }
            WriteRawEntry(entry, target);
            written += 1;
        }
        return new { name = model, kits = kits.Count, models = names.Count, written, reused, missing };
    }

    private const int MaxTextLookups = 2048;
    private static Dictionary<uint, string>? GameTextIndex;

    /// English game text by label hash, from every american .gxt2 (base game,
    /// update and DLC; the higher-priority archive wins a duplicate label).
    private static Dictionary<uint, string> GetGameTextIndex(SharedTextureArchive archive)
    {
        if (GameTextIndex != null) return GameTextIndex;
        var index = new Dictionary<uint, string>();
        var priorities = new Dictionary<uint, int>();
        foreach (var rpf in archive.Manager.AllRpfs ?? Enumerable.Empty<RpfFile>())
        {
            if (rpf.AllEntries == null) continue;
            foreach (var rawEntry in rpf.AllEntries)
            {
                if (rawEntry is not RpfFileEntry entry) continue;
                if (!(entry.NameLower ?? string.Empty).EndsWith(".gxt2", StringComparison.Ordinal)) continue;
                if (!(entry.Path ?? string.Empty).Contains("american", StringComparison.OrdinalIgnoreCase)) continue;
                Gxt2File? file;
                try
                {
                    file = archive.Manager.GetFile<Gxt2File>(entry);
                }
                catch (Exception ex)
                {
                    Console.Error.WriteLine($"[text] {entry.Path} unreadable: {ex.Message}");
                    continue;
                }
                var priority = GetMetaPriority(entry.Path ?? string.Empty);
                foreach (var text in file?.TextEntries ?? Array.Empty<Gxt2Entry>())
                {
                    if (text == null || string.IsNullOrEmpty(text.Text)) continue;
                    if (priorities.TryGetValue(text.Hash, out var existing) && existing > priority) continue;
                    index[text.Hash] = text.Text;
                    priorities[text.Hash] = priority;
                }
            }
        }
        GameTextIndex = index;
        return index;
    }

    /// The game's English text for label hashes (joaat of the label key), as
    /// { "<hash>": "text" }; labels the game has no text for are left out.
    private static object LookupGameText(JsonElement request)
    {
        if (!request.TryGetProperty("hashes", out var hashes) || hashes.ValueKind != JsonValueKind.Array)
        {
            throw new BridgeException("Missing array parameter 'hashes'.");
        }
        if (hashes.GetArrayLength() > MaxTextLookups)
        {
            throw new BridgeException($"At most {MaxTextLookups} labels can be looked up at once.");
        }
        var index = GetGameTextIndex(RequireArchive("game text"));
        var texts = new Dictionary<string, string>();
        foreach (var element in hashes.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Number || !element.TryGetUInt32(out var hash)) continue;
            if (index.TryGetValue(hash, out var text)) texts[hash.ToString(System.Globalization.CultureInfo.InvariantCulture)] = text;
        }
        return new { texts };
    }
}
