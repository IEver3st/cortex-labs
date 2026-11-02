using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using CodeWalker.GameFiles;
using Microsoft.Win32;

namespace CodeWalkerBridge;

public static partial class Program
{
    private const string EscrowedDownloadMessage = "This download contains an escrowed (.fxap) resource. Studio doesn't open escrowed resources; install it the way its seller describes.";
    private const double SirenMutedSeconds = 0.05;
    private const int SirenSilentPeak = 33;
    private const int SirenMinBuildSamples = 4096;
    private const int SirenBankLimit = 7;
    private const long SirenXmlMaxBytes = 1024 * 1024;
    private static readonly Regex SirenNamePattern = new("^[a-z0-9_]{1,40}$");
    private static readonly Regex SirenWordPattern = new("siren|wail|yelp|horn|priority|phaser|hilo|hi_lo|pcall|powercall|piercer|rumbler|quick|warning|manual|tone|zzz", RegexOptions.IgnoreCase);
    private static bool SirenKeysLoaded;
    private static readonly Dictionary<string, Dictionary<uint, string>> StockSirenSignatures = new(StringComparer.OrdinalIgnoreCase);

    private static readonly Dictionary<uint, (string Name, string Role)> StockSirenStreams = new (string Name, string Role)[]
    {
        ("airhorn_eqd", "horn"),
        ("siren_pa20a_wail", "wail"),
        ("siren_2", "yelp"),
        ("police_warning", "priority"),
        ("siren_wail_01", "wail"),
        ("siren_wail_02", "wail"),
        ("siren_wail_03", "wail"),
        ("siren_wail_04", "wail"),
        ("siren_quick_01", "yelp"),
        ("siren_quick_02", "yelp"),
        ("siren_quick_03", "yelp"),
        ("siren_quick_04", "yelp"),
        ("ambulance_warning", "powercall"),
        ("fire_truck_horn", "horn"),
        ("siren_firetruck_wail_01", "fire"),
        ("siren_firetruck_quick_01", "fire"),
    }.ToDictionary(s => JenkHash.GenHash(s.Name) & AwcIdMask);

    private sealed class SirenTone
    {
        public required string Id { get; init; }
        public required string Name { get; set; }
        public required string Role { get; init; }
        public required double Seconds { get; init; }
        public required int SampleRate { get; init; }
        public string? Stock { get; init; }
        public string? SirenType { get; init; }
        public required Func<byte[]> Wav { get; init; }
    }

    private sealed class SirenSource
    {
        public required string Id { get; init; }
        public required string Kind { get; init; }
        public required string Path { get; init; }
        public required string Label { get; init; }
        public List<SirenTone> Tones { get; } = new();
        public bool NeedsGame { get; set; }
        public List<string> Warnings { get; } = new();
    }

    private sealed class WavInfo
    {
        public int Format { get; init; }
        public int Channels { get; init; }
        public int SampleRate { get; init; }
        public int Bits { get; init; }
        public int DataOffset { get; init; }
        public int DataLength { get; init; }
        public bool Canonical { get; init; }
        public int Frames => Channels * Bits == 0 ? 0 : DataLength / (Channels * (Bits / 8));
    }

    private static object InspectSirenAudio(string root, string? gtaFolder)
    {
        var sources = DiscoverSirenSources(root, gtaFolder, null);
        return new { sources = sources.Select(DescribeSirenSource).ToList() };
    }

    private static object DecodeSirenAudio(string root, string sourceId, string outputDir, string? gtaFolder)
    {
        var rootFull = Path.GetFullPath(root).TrimEnd('\\', '/');
        var outFull = Path.GetFullPath(outputDir).TrimEnd('\\', '/');
        if (IsAtOrUnder(outFull, rootFull)) throw new BridgeException("Studio writes siren previews to its cache, not into the download itself.");
        var source = DiscoverSirenSources(root, gtaFolder, sourceId).FirstOrDefault()
            ?? throw new BridgeException($"The siren source {sourceId} isn't in this import any more.");
        if (source.NeedsGame) throw new BridgeException("Studio needs your GTA V install to read this RESIDENT.rpf. Pick it in Settings.");
        if (source.Tones.Count == 0) throw new BridgeException(source.Warnings.FirstOrDefault() ?? "This source has no siren tones.");

        Directory.CreateDirectory(outFull);
        var tones = new List<object>();
        foreach (var tone in source.Tones)
        {
            var wav = tone.Wav();
            var info = ReadWavInfo(wav, tone.Name);
            if (!info.Canonical) throw new BridgeException($"{tone.Name} didn't decode to a mono 16-bit PCM WAV.");
            var file = tone.Name + ".wav";
            File.WriteAllBytes(Path.Combine(outFull, file), wav);
            tones.Add(new
            {
                name = tone.Name,
                role = tone.Role,
                seconds = Math.Round(info.Frames / (double)Math.Max(1, info.SampleRate), 2),
                sampleRate = info.SampleRate,
                file,
            });
        }
        File.WriteAllText(Path.Combine(outFull, "tones.json"), JsonSerializer.Serialize(tones, new JsonSerializerOptions(JsonOptions) { WriteIndented = true }));
        return new { tones };
    }

    private static object BuildSirenPack(JsonElement request)
    {
        var outputDir = Path.GetFullPath(RequireString(request, "outputDir"));
        var dlcName = RequireString(request, "dlcName");
        if (!SirenNamePattern.IsMatch(dlcName)) throw new BridgeException("The resource's audio name uses lowercase letters, digits and underscores (up to 40).");
        if (dlcName.StartsWith("dlc_")) throw new BridgeException("Leave dlc_ off the audio name; Studio adds it.");
        if (!request.TryGetProperty("banks", out var banksElement) || banksElement.ValueKind != JsonValueKind.Array || banksElement.GetArrayLength() == 0)
        {
            throw new BridgeException("A siren pack needs at least one bank.");
        }

        var banks = new List<(string Name, List<(string Name, byte[] Pcm, int Rate)> Tones)>();
        var itemNames = new HashSet<string>(StringComparer.Ordinal);
        var toneOwners = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var bankElement in banksElement.EnumerateArray())
        {
            var bankName = RequireString(bankElement, "name");
            if (!SirenNamePattern.IsMatch(bankName)) throw new BridgeException($"Bank \"{bankName}\" must use lowercase letters, digits and underscores (up to 40).");
            if (banks.Any(b => b.Name == bankName)) throw new BridgeException($"Two banks are named {bankName}.");
            if (!itemNames.Add(bankName + "_soundset")) throw new BridgeException($"Bank {bankName} clashes with a tone's sound name.");
            if (!bankElement.TryGetProperty("tones", out var tonesElement) || tonesElement.ValueKind != JsonValueKind.Array || tonesElement.GetArrayLength() == 0)
            {
                throw new BridgeException($"Bank {bankName} has no tones.");
            }
            var tones = new List<(string Name, byte[] Pcm, int Rate)>();
            var streamIds = new HashSet<uint>();
            foreach (var toneElement in tonesElement.EnumerateArray())
            {
                var toneName = RequireString(toneElement, "name");
                if (!SirenNamePattern.IsMatch(toneName)) throw new BridgeException($"Tone \"{toneName}\" in {bankName} must use lowercase letters, digits and underscores (up to 40).");
                if (tones.Any(t => t.Name == toneName)) throw new BridgeException($"Bank {bankName} has two tones named {toneName}.");
                if (toneOwners.TryGetValue(toneName, out var owner))
                {
                    throw new BridgeException($"Tone {toneName} is in both {owner} and {bankName}. Sound names share one table, so give each tone its own name.");
                }
                if (!itemNames.Add($"{dlcName}_{toneName}_s") || !itemNames.Add($"{dlcName}_{toneName}_d")) throw new BridgeException($"Tone {toneName} clashes with another sound name in this pack.");
                if (!streamIds.Add(JenkHash.GenHash(toneName) & AwcIdMask)) throw new BridgeException($"Tone {toneName} hashes to the same wave id as another tone in {bankName}; rename one of them.");
                toneOwners[toneName] = bankName;
                var (pcm, rate) = ReadBuildWav(RequireString(toneElement, "wav"), toneName);
                tones.Add((toneName, pcm, rate));
            }
            banks.Add((bankName, tones));
        }

        var relPath = $"data/{dlcName}.dat54.rel";
        var nametablePath = $"data/{dlcName}.dat54.nametable";
        var outputs = new List<(string Path, byte[] Bytes)>();
        foreach (var bank in banks)
        {
            outputs.Add(($"dlc_{dlcName}/{bank.Name}.awc", BuildSirenAwc(bank.Tones)));
        }
        outputs.Add((relPath, BuildSirenRel(dlcName, banks.Select(b => (b.Name, b.Tones.Select(t => t.Name).ToList())).ToList())));
        outputs.Add((nametablePath, Encoding.ASCII.GetBytes(string.Concat(banks.Select(b => string.Concat(b.Tones.Select(t => $"{dlcName}_{t.Name}_s\0")) + b.Name + "_soundset\0")))));

        foreach (var (path, _) in outputs)
        {
            var full = Path.Combine(outputDir, path.Replace('/', Path.DirectorySeparatorChar));
            if (File.Exists(full)) throw new BridgeException($"{full} already exists. Build into an empty folder.");
        }
        var written = new List<string>();
        try
        {
            foreach (var (path, bytes) in outputs)
            {
                var full = Path.Combine(outputDir, path.Replace('/', Path.DirectorySeparatorChar));
                Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                File.WriteAllBytes(full, bytes);
                written.Add(full);
            }
            VerifySirenPack(outputDir, dlcName, banks.Select(b => (b.Name, b.Tones.Select(t => (t.Name, t.Pcm.Length / 2, t.Rate)).ToList())).ToList());
        }
        catch
        {
            foreach (var full in written)
            {
                try { File.Delete(full); } catch (Exception ex) { Console.Error.WriteLine($"[sirens] cleanup {full}: {ex.Message}"); }
            }
            throw;
        }

        var warnings = new List<string>();
        if (banks.Count > SirenBankLimit)
        {
            warnings.Add($"This pack has {banks.Count} banks. FiveM only keeps a few custom audio banks loaded at once, so more than {SirenBankLimit} can leave some sirens silent.");
        }
        return new
        {
            files = outputs.Select(o =>
            {
                var bytes = File.ReadAllBytes(Path.Combine(outputDir, o.Path));
                return new { path = o.Path, bytes = bytes.Length, sha256 = Sha256(bytes) };
            }).ToList(),
            banks = banks.Select(b => new
            {
                name = b.Name,
                soundSet = b.Name + "_soundset",
                container = $"dlc_{dlcName}/{b.Name}",
                tones = b.Tones.Select(t => new
                {
                    name = t.Name,
                    sampleRate = t.Rate,
                    samples = t.Pcm.Length / 2,
                    seconds = Math.Round(t.Pcm.Length / 2 / (double)t.Rate, 2),
                }).ToList(),
            }).ToList(),
            dataFiles = new[]
            {
                new { type = "AUDIO_WAVEPACK", path = $"dlc_{dlcName}" },
                new { type = "AUDIO_SOUNDDATA", path = $"data/{dlcName}.dat" },
            },
            warnings,
        };
    }

    private static string? OptionalString(JsonElement request, string name) =>
        request.TryGetProperty(name, out var element) && element.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(element.GetString())
            ? element.GetString()
            : null;

    private static (byte[] Pcm, int Rate) ReadBuildWav(string path, string toneName)
    {
        if (!File.Exists(path)) throw new BridgeException($"The WAV for {toneName} ({path}) doesn't exist.");
        if (new FileInfo(path).Length > EngineAudioMaxFileBytes) throw new BridgeException($"The WAV for {toneName} is larger than {EngineAudioMaxFileBytes >> 20} MB.");
        var bytes = File.ReadAllBytes(path);
        var info = ReadWavInfo(bytes, toneName);
        if (!info.Canonical)
        {
            throw new BridgeException($"The WAV for {toneName} must be a plain mono 16-bit PCM WAV (a fmt chunk followed by the data chunk); it is {DescribeWavFormat(info)}.");
        }
        if (info.SampleRate < 8000 || info.SampleRate > 48000) throw new BridgeException($"The WAV for {toneName} is {info.SampleRate} Hz; use 8000 to 48000 Hz.");
        if (info.Frames < SirenMinBuildSamples) throw new BridgeException($"The WAV for {toneName} is shorter than {SirenMinBuildSamples} samples (about 0.1 s); loop it longer before building.");
        var pcm = bytes.AsSpan(info.DataOffset, info.Frames * 2).ToArray();
        var (peak, _) = PcmLevels(pcm);
        if (peak < SirenSilentPeak) throw new BridgeException($"The WAV for {toneName} is silent.");
        return (pcm, info.SampleRate);
    }

    private static byte[] BuildSirenAwc(List<(string Name, byte[] Pcm, int Rate)> tones)
    {
        var awc = new AwcFile
        {
            Magic = 0x54414441,
            Version = 1,
            MultiChannelFlag = false,
            ChunkIndicesFlag = true,
        };
        var streams = new List<AwcStream>();
        foreach (var tone in tones)
        {
            var stream = new AwcStream(awc) { Hash = JenkHash.GenHash(tone.Name) };
            var format = new AwcFormatChunk(new AwcChunkInfo { Type = AwcChunkType.format })
            {
                Codec = AwcCodecType.PCM,
                Headroom = -200,
                LoopPoint = 0,
                PlayBegin = 0,
                PlayEnd = 0,
                LoopBegin = 0,
                LoopEnd = 0,
                Peak = 0,
            };
            var data = new AwcDataChunk(new AwcChunkInfo { Type = AwcChunkType.data });
            stream.Chunks = new AwcChunk[] { format, data };
            stream.ExpandChunks();
            stream.ParseWavFile(CanonicalWav(tone.Pcm, tone.Rate));
            format.Samples = (uint)(tone.Pcm.Length / 2);
            streams.Add(stream);
        }
        streams.Sort((a, b) => a.Hash.Hash.CompareTo(b.Hash.Hash));
        awc.Streams = streams.ToArray();
        awc.StreamCount = streams.Count;
        awc.BuildPeakChunks();
        awc.BuildChunkIndices();
        awc.BuildStreamInfos();
        var bytes = awc.Save();
        if (bytes == null || bytes.Length == 0) throw new BridgeException("CodeWalker produced an empty wave bank.");
        return bytes;
    }

    private static byte[] BuildSirenRel(string dlcName, List<(string Bank, List<string> Tones)> banks)
    {
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Dat54>\n <Version value=\"7126027\" />\n <ContainerPaths>\n");
        foreach (var (bank, _) in banks) sb.Append($"  <Item>DLC_{dlcName.ToUpperInvariant()}\\{bank.ToUpperInvariant()}</Item>\n");
        sb.Append(" </ContainerPaths>\n <Items>\n");
        foreach (var (bank, tones) in banks)
        {
            sb.Append($"  <Item type=\"SoundSet\">\n   <Name>{bank}_soundset</Name>\n   <Header>\n    <Flags value=\"0xAAAAAAAA\" />\n   </Header>\n   <SoundSets>\n");
            foreach (var tone in tones.OrderBy(t => JenkHash.GenHash(t)))
            {
                sb.Append($"    <Item>\n     <ScriptName>{tone}</ScriptName>\n     <ChildSound>{dlcName}_{tone}_d</ChildSound>\n    </Item>\n");
            }
            sb.Append("   </SoundSets>\n  </Item>\n");
            foreach (var tone in tones)
            {
                sb.Append($"  <Item type=\"SimpleSound\">\n   <Name>{dlcName}_{tone}_s</Name>\n   <Header>\n    <Flags value=\"0x0820E010\" />\n    <Pitch value=\"0\" />\n    <ReleaseTime value=\"0\" />\n    <DopplerFactor value=\"0\" />\n    <Category>vehicles_sirens</Category>\n    <VolumeCurveScale value=\"300\" />\n    <SmallReverbSend value=\"50\" />\n   </Header>\n   <ContainerName>dlc_{dlcName}/{bank}</ContainerName>\n   <FileName>{tone}</FileName>\n   <WaveSlotIndex value=\"0\" />\n  </Item>\n");
                sb.Append($"  <Item type=\"DirectionalSound\">\n   <Name>{dlcName}_{tone}_d</Name>\n   <Header>\n    <Flags value=\"0x00008004\" />\n    <Volume value=\"0\" />\n    <Category>vehicles_sirens</Category>\n   </Header>\n   <ChildSound>{dlcName}_{tone}_s</ChildSound>\n   <InnerAngle value=\"20\" />\n   <OuterAngle value=\"65\" />\n   <RearAttenuation value=\"-3\" />\n   <YawAngle value=\"0\" />\n   <PitchAngle value=\"0\" />\n  </Item>\n");
            }
        }
        sb.Append(" </Items>\n</Dat54>\n");
        var doc = new XmlDocument();
        doc.LoadXml(sb.ToString());
        var bytes = XmlMeta.GetData(doc, MetaFormat.AudioRel, string.Empty);
        if (bytes == null || bytes.Length == 0) throw new BridgeException("CodeWalker couldn't build the siren sounds file.");
        return bytes;
    }

    private static void VerifySirenPack(string outputDir, string dlcName, List<(string Bank, List<(string Name, int Samples, int Rate)> Tones)> banks)
    {
        var relName = $"{dlcName}.dat54.rel";
        var rel = new RelFile();
        rel.Load(File.ReadAllBytes(Path.Combine(outputDir, "data", relName)), new RpfBinaryFileEntry { Name = relName, NameLower = relName });
        if (rel.RelType != RelDatFileType.Dat54DataEntries) throw new BridgeException($"{relName} didn't reload as a sounds file.");
        var sounds = (rel.RelDatas ?? Array.Empty<RelData>()).ToDictionary(d => d.NameHash.Hash, d => d);
        var containerPaths = new HashSet<string>((rel.NameTable ?? Array.Empty<string>()).Select(n => n.Replace('/', '\\')), StringComparer.OrdinalIgnoreCase);
        foreach (var (bank, tones) in banks)
        {
            var awcName = bank + ".awc";
            var awc = new AwcFile();
            awc.Load(File.ReadAllBytes(Path.Combine(outputDir, $"dlc_{dlcName}", awcName)), new RpfBinaryFileEntry { Name = awcName, NameLower = awcName });
            if (!string.IsNullOrEmpty(awc.ErrorMessage)) throw new BridgeException($"{awcName} didn't reload: {awc.ErrorMessage}");
            if (!containerPaths.Contains($"dlc_{dlcName}\\{bank}")) throw new BridgeException($"{relName} doesn't list the wave bank dlc_{dlcName}\\{bank}.");
            if (sounds.GetValueOrDefault(JenkHash.GenHash(bank + "_soundset")) is not Dat54SoundSet set) throw new BridgeException($"{relName} is missing {bank}_soundset.");
            var container = JenkHash.GenHash($"dlc_{dlcName}/{bank}");
            foreach (var (name, samples, rate) in tones)
            {
                var stream = awc.Streams?.FirstOrDefault(s => (s.StreamInfo?.Id ?? 0) == (JenkHash.GenHash(name) & AwcIdMask))
                    ?? throw new BridgeException($"{awcName} is missing the wave for {name}.");
                if (stream.SampleCount != samples || stream.SamplesPerSecond != rate || stream.GetPcmData().Length != samples * 2)
                {
                    throw new BridgeException($"The wave for {name} reloaded as {stream.SampleCount} samples at {stream.SamplesPerSecond} Hz instead of {samples} at {rate} Hz.");
                }
                var item = set.SoundSets?.FirstOrDefault(i => i.ScriptName.Hash == JenkHash.GenHash(name))
                    ?? throw new BridgeException($"{bank}_soundset has no script name {name}.");
                if (item.ChildSound.Hash != JenkHash.GenHash($"{dlcName}_{name}_d")
                    || sounds.GetValueOrDefault(item.ChildSound.Hash) is not Dat54DirectionalSound directional
                    || directional.ChildSound.Hash != JenkHash.GenHash($"{dlcName}_{name}_s")
                    || sounds.GetValueOrDefault(directional.ChildSound.Hash) is not Dat54SimpleSound simple
                    || simple.ContainerName.Hash != container
                    || simple.FileName.Hash != JenkHash.GenHash(name))
                {
                    throw new BridgeException($"{name} in {bank}_soundset doesn't resolve to its wave in dlc_{dlcName}/{bank}.");
                }
            }
        }
    }

    private static object DescribeSirenSource(SirenSource source) => new
    {
        id = source.Id,
        kind = source.Kind,
        path = source.Path,
        label = source.Label,
        tones = source.Tones.Select(t => new
        {
            id = t.Id,
            name = t.Name,
            role = t.Role,
            seconds = t.Seconds,
            sampleRate = t.SampleRate,
            stock = t.Stock,
            sirenType = t.SirenType,
        }).ToList(),
        needsGame = source.NeedsGame,
        warnings = source.Warnings,
    };

    private static List<SirenSource> DiscoverSirenSources(string root, string? gtaFolder, string? onlyId)
    {
        root = Path.GetFullPath(root).TrimEnd('\\', '/');
        if (!Directory.Exists(root)) throw new BridgeException($"{root} doesn't exist.");
        var all = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Take(EngineAudioMaxFiles + 1).ToList();
        if (all.Count > EngineAudioMaxFiles)
        {
            throw new BridgeException($"This download has more than {EngineAudioMaxFiles} files. Studio reads siren packs, not whole mod collections.");
        }
        var oversized = all.FirstOrDefault(p => new FileInfo(p).Length > EngineAudioMaxFileBytes);
        if (oversized != null) throw new BridgeException($"{Path.GetFileName(oversized)} is larger than {EngineAudioMaxFileBytes >> 20} MB.");
        if (all.Any(p => p.EndsWith(".fxap", StringComparison.OrdinalIgnoreCase))) throw new BridgeException(EscrowedDownloadMessage);

        var sources = new List<SirenSource>();
        bool Wanted(string id) => onlyId == null || onlyId == id;

        foreach (var rpfPath in all.Where(p => string.Equals(Path.GetFileName(p), "resident.rpf", StringComparison.OrdinalIgnoreCase)))
        {
            var rel = Path.GetRelativePath(root, rpfPath).Replace('\\', '/');
            var id = "resident:" + rel;
            if (!Wanted(id)) continue;
            var parent = Path.GetDirectoryName(rpfPath)!;
            var source = new SirenSource
            {
                Id = id,
                Kind = "resident",
                Path = rpfPath,
                Label = IsAtOrUnder(root, parent) ? Path.GetFileName(root) : Path.GetFileName(parent),
            };
            var gta = ResolveSirenGtaFolder(gtaFolder, source.Warnings);
            if (gta == null)
            {
                source.NeedsGame = true;
                source.Warnings.Add("Studio compares this RESIDENT.rpf with your own copy of the game to find the sirens its author changed. Point Studio at your GTA V install to read it.");
            }
            else
            {
                LoadResidentTones(source, gta);
            }
            sources.Add(source);
        }

        var manifestRoots = all.Where(p => Path.GetFileName(p).Equals("fxmanifest.lua", StringComparison.OrdinalIgnoreCase) || Path.GetFileName(p).Equals("__resource.lua", StringComparison.OrdinalIgnoreCase))
            .Select(p => Path.GetDirectoryName(p)!)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToList();

        foreach (var resource in all.Where(p => p.EndsWith(".dat54.rel", StringComparison.OrdinalIgnoreCase))
            .Select(p => LooseSourceRoot(root, p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            sources.AddRange(LoadFivemSirenSources(root, resource, all, Wanted));
        }

        var sirenXml = LoadSirenMasteryXml(root, all);
        foreach (var group in all.Where(p => p.EndsWith(".wav", StringComparison.OrdinalIgnoreCase) && !manifestRoots.Any(m => IsUnder(p, m)))
            .GroupBy(p => Path.GetDirectoryName(p)!, StringComparer.OrdinalIgnoreCase)
            .OrderBy(g => g.Key, StringComparer.OrdinalIgnoreCase))
        {
            var dir = group.Key;
            var rel = Path.GetRelativePath(root, dir).Replace('\\', '/');
            var id = "wavs:" + rel;
            if (!Wanted(id)) continue;
            var types = sirenXml.Where(x => IsAtOrUnder(dir, x.Folder)).SelectMany(x => x.Types).ToList();
            var files = group.OrderBy(p => p, StringComparer.OrdinalIgnoreCase).ToList();
            bool Listed(string p) => types.Any(t => string.Equals(t.Name, Path.GetFileNameWithoutExtension(p), StringComparison.OrdinalIgnoreCase));
            if (!files.Any(p => Listed(p) || SirenWordPattern.IsMatch(Path.GetFileNameWithoutExtension(p)))) continue;
            var source = new SirenSource
            {
                Id = id,
                Kind = "wavs",
                Path = dir,
                Label = string.Equals(dir, root, StringComparison.OrdinalIgnoreCase) ? Path.GetFileName(root) : Path.GetFileName(dir),
            };
            var used = new HashSet<string>(StringComparer.Ordinal);
            foreach (var file in files)
            {
                var stem = Path.GetFileNameWithoutExtension(file);
                var bytes = File.ReadAllBytes(file);
                WavInfo info;
                try
                {
                    info = ReadWavInfo(bytes, Path.GetFileName(file));
                }
                catch (BridgeException ex)
                {
                    source.Warnings.Add(ex.Message);
                    continue;
                }
                if (!CanConvertWav(info))
                {
                    source.Warnings.Add($"{Path.GetFileName(file)} is {DescribeWavFormat(info)}, which Studio can't read.");
                    continue;
                }
                var sirenTypes = types.Where(t => string.Equals(t.Name, stem, StringComparison.OrdinalIgnoreCase)).Select(t => t.Type).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
                var name = UniqueSirenName(SnakeSirenName(stem), used);
                source.Tones.Add(new SirenTone
                {
                    Id = Path.GetFileName(file),
                    Name = name,
                    Role = RoleFromSirenTypes(sirenTypes, name),
                    Seconds = Math.Round(info.Frames / (double)Math.Max(1, info.SampleRate), 2),
                    SampleRate = info.SampleRate,
                    SirenType = sirenTypes.Count == 0 ? null : string.Join(",", sirenTypes),
                    Wav = () => ConvertToCanonicalWav(bytes, info),
                });
            }
            if (sirenXml.Count > 0 && types.Count == 0) source.Warnings.Add("The Siren Mastery setup doesn't cover this folder, so roles come from file names.");
            sources.Add(source);
        }
        return sources;
    }

    private static List<(string Folder, List<(string Name, string Type)> Types)> LoadSirenMasteryXml(string root, List<string> all)
    {
        var result = new List<(string, List<(string, string)>)>();
        foreach (var path in all.Where(p => p.EndsWith(".xml", StringComparison.OrdinalIgnoreCase) && new FileInfo(p).Length <= SirenXmlMaxBytes))
        {
            var text = File.ReadAllText(path);
            if (!text.Contains("SirenType", StringComparison.Ordinal)) continue;
            try
            {
                var doc = new XmlDocument { XmlResolver = null };
                using var reader = XmlReader.Create(new StringReader(text), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
                doc.Load(reader);
                var types = doc.SelectNodes("//*[@SirenType]")?.Cast<XmlElement>()
                    .Select(e => (Name: e.InnerText.Trim(), Type: e.GetAttribute("SirenType").Trim()))
                    .Where(t => t.Name.Length > 0)
                    .ToList() ?? new();
                if (types.Count > 0) result.Add((Path.GetDirectoryName(path)!, types));
            }
            catch (XmlException ex)
            {
                Console.Error.WriteLine($"[sirens] {Path.GetRelativePath(root, path)}: {ex.Message}");
            }
        }
        return result;
    }

    private static IEnumerable<SirenSource> LoadFivemSirenSources(string root, string dir, List<string> all, Func<string, bool> wanted)
    {
        var files = all.Where(p => IsUnder(p, dir) && (p.EndsWith(".rel", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".awc", StringComparison.OrdinalIgnoreCase)))
            .Select(p => new AudioSourceFile
            {
                RelativePath = Path.GetRelativePath(dir, p).Replace('\\', '/'),
                Read = () => File.ReadAllBytes(p),
                Size = new FileInfo(p).Length,
            })
            .ToList();
        var manifest = new[] { "fxmanifest.lua", "__resource.lua" }.Select(m => Path.Combine(dir, m)).FirstOrDefault(File.Exists);
        var audio = new AudioSource
        {
            Id = "fivem:" + Path.GetRelativePath(root, dir).Replace('\\', '/'),
            Kind = "fivem",
            Path = dir,
            Files = files,
            Manifest = manifest == null ? null : File.ReadAllText(manifest),
        };
        var pack = LoadPack(audio);
        var names = SirenNameCandidates(pack, all.Where(p => IsUnder(p, dir)).ToList());
        var sources = new List<SirenSource>();
        foreach (var set in pack.Sounds.Values.OfType<Dat54SoundSet>())
        {
            var setName = names.GetValueOrDefault(set.NameHash.Hash) ?? $"hash_{set.NameHash.Hash:X8}";
            var id = $"{audio.Id}#{setName}";
            if (!wanted(id)) continue;
            var source = new SirenSource { Id = id, Kind = "fivem", Path = dir, Label = setName };
            source.Warnings.AddRange(audio.Warnings);
            var used = new HashSet<string>(StringComparer.Ordinal);
            foreach (var item in set.SoundSets ?? Array.Empty<Dat54SoundSetItem>())
            {
                var scriptName = names.GetValueOrDefault(item.ScriptName.Hash) ?? $"hash_{item.ScriptName.Hash:X8}";
                var stream = SimpleSoundLeaves(pack, item.ChildSound.Hash)
                    .Select(leaf => FindStream(pack, leaf.ContainerName.Hash, leaf.FileName.Hash))
                    .FirstOrDefault(s => s != null);
                if (stream == null)
                {
                    source.Warnings.Add($"{scriptName} points at a wave this resource doesn't carry.");
                    continue;
                }
                var name = UniqueSirenName(scriptName, used);
                source.Tones.Add(new SirenTone
                {
                    Id = $"{item.ScriptName.Hash:X8}",
                    Name = name,
                    Role = SirenRoleFromName(name),
                    Seconds = Math.Round(stream.SampleCount / (double)Math.Max(1, stream.SamplesPerSecond), 2),
                    SampleRate = stream.SamplesPerSecond,
                    Wav = stream.GetWavFile,
                });
            }
            sources.Add(source);
        }
        return sources;
    }

    private static Dictionary<uint, string> SirenNameCandidates(LoadedPack pack, List<string> files)
    {
        var words = new HashSet<string>(StringComparer.Ordinal);
        void Add(string? value, int depth)
        {
            if (string.IsNullOrWhiteSpace(value) || depth > 4) return;
            var lower = value.Trim().ToLowerInvariant().Replace(' ', '_').Replace('-', '_');
            if (!words.Add(lower)) return;
            foreach (var suffix in new[] { "_s", "_d", "_soundset", "_soundsets", "_sounds", "_sound" })
            {
                if (lower.EndsWith(suffix) && lower.Length > suffix.Length) Add(lower[..^suffix.Length], depth + 1);
            }
            var underscore = lower.IndexOf('_');
            if (underscore > 0 && underscore < lower.Length - 1) Add(lower[(underscore + 1)..], depth + 1);
            Add(lower + "_soundset", depth + 2);
        }
        foreach (var path in files)
        {
            var name = Path.GetFileName(path);
            if (name.EndsWith(".nametable", StringComparison.OrdinalIgnoreCase) && new FileInfo(path).Length <= SirenXmlMaxBytes)
            {
                foreach (var entry in Encoding.ASCII.GetString(File.ReadAllBytes(path)).Split('\0', StringSplitOptions.RemoveEmptyEntries)) Add(entry, 0);
            }
            Add(name.Split('.')[0], 0);
        }
        foreach (var segment in pack.Source.Path.Split('\\', '/')) Add(segment, 0);
        foreach (var container in pack.ContainerNames.Values)
        {
            foreach (var segment in container.Split('/')) Add(segment, 0);
        }
        if (pack.Source.Manifest != null)
        {
            foreach (Match m in Regex.Matches(pack.Source.Manifest, "['\"]([^'\"]+)['\"]"))
            {
                foreach (var segment in m.Groups[1].Value.Split('/', '\\')) Add(segment.Split('.')[0], 0);
            }
        }
        var map = new Dictionary<uint, string>();
        foreach (var w in words.OrderBy(w => w.Length)) map.TryAdd(JenkHash.GenHash(w), w);
        return map;
    }

    private static void LoadResidentTones(SirenSource source, string gta)
    {
        EnsureSirenKeys(gta);
        var mod = ReadVehiclesAwc(source.Path, "this RESIDENT.rpf");
        var stockRpf = Path.Combine(gta, "x64", "audio", "sfx", "RESIDENT.rpf");
        var stock = StockVehicleSignatures(stockRpf);
        var streams = mod.Streams ?? Array.Empty<AwcStream>();
        var changed = new List<(AwcStream Stream, byte[] Wav)>();
        foreach (var stream in streams)
        {
            byte[] wav;
            try
            {
                wav = stream.GetWavFile();
            }
            catch (Exception ex)
            {
                source.Warnings.Add($"Couldn't decode wave {stream.Hash.Hash:X8}: {ex.Message}");
                continue;
            }
            if (stock.TryGetValue(stream.Hash.Hash, out var signature) && signature == WavSignature(wav)) continue;
            changed.Add((stream, wav));
        }
        if (streams.Length > 0 && changed.Count * 2 > streams.Length)
        {
            source.Warnings.Add($"{changed.Count} of {streams.Length} vehicle sounds differ from your game's copy, so this RESIDENT.rpf was made from a different game version. Studio can't tell which sounds are the author's.");
            return;
        }
        var muted = 0;
        foreach (var (stream, wav) in changed.OrderBy(c => c.Stream.Hash.Hash))
        {
            var rate = stream.SamplesPerSecond;
            var frames = (wav.Length - 44) / 2;
            var seconds = frames / (double)Math.Max(1, rate);
            var (peak, _) = PcmLevels(wav.AsSpan(44).ToArray());
            if (seconds < SirenMutedSeconds || peak < SirenSilentPeak)
            {
                muted++;
                continue;
            }
            var id = stream.Hash.Hash & AwcIdMask;
            var known = StockSirenStreams.TryGetValue(id, out var stockTone);
            var name = known ? stockTone.Name : $"tone_{id:x8}";
            source.Tones.Add(new SirenTone
            {
                Id = $"{id:X8}",
                Name = name,
                Role = known ? stockTone.Role : "other",
                Seconds = Math.Round(seconds, 2),
                SampleRate = rate,
                Stock = known ? stockTone.Name : null,
                Wav = () => wav,
            });
        }
        if (muted > 0) source.Warnings.Add($"{muted} replaced sound{(muted == 1 ? " is" : "s are")} silent or shorter than {SirenMutedSeconds * 1000:0} ms (the author muted a stock sound), so {(muted == 1 ? "it isn't" : "they aren't")} listed as tones.");
        if (source.Tones.Count == 0 && muted == 0) source.Warnings.Add("This RESIDENT.rpf doesn't change any vehicle sounds.");
    }

    private static AwcFile ReadVehiclesAwc(string rpfPath, string label)
    {
        RpfFile rpf;
        try
        {
            rpf = new RpfFile(rpfPath, Path.GetFileName(rpfPath));
            rpf.ScanStructure(null, null);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Couldn't open {label}: {ex.Message}");
        }
        var entry = (rpf.AllEntries ?? new List<RpfEntry>()).OfType<RpfFileEntry>()
            .FirstOrDefault(e => e.NameLower == "vehicles.awc" && e.Parent == rpf.Root)
            ?? throw new BridgeException($"{label} has no vehicles.awc, so it isn't a siren pack.");
        var bytes = rpf.ExtractFile(entry) ?? throw new BridgeException($"Couldn't read vehicles.awc from {label}.");
        var awc = new AwcFile();
        awc.Load(bytes, new RpfBinaryFileEntry { Name = "vehicles.awc", NameLower = "vehicles.awc" });
        if (!string.IsNullOrEmpty(awc.ErrorMessage) || awc.Streams == null) throw new BridgeException($"vehicles.awc in {label} isn't readable: {awc.ErrorMessage ?? "no streams"}.");
        return awc;
    }

    private static Dictionary<uint, string> StockVehicleSignatures(string stockRpf)
    {
        var info = new FileInfo(stockRpf);
        var key = $"{info.FullName}|{info.Length}|{info.LastWriteTimeUtc.Ticks}";
        if (StockSirenSignatures.TryGetValue(key, out var cached)) return cached;
        var awc = ReadVehiclesAwc(stockRpf, "your game's RESIDENT.rpf");
        var map = new Dictionary<uint, string>();
        foreach (var stream in awc.Streams)
        {
            try
            {
                map.TryAdd(stream.Hash.Hash, WavSignature(stream.GetWavFile()));
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[sirens] stock wave {stream.Hash.Hash:X8}: {ex.Message}");
            }
        }
        StockSirenSignatures[key] = map;
        return map;
    }

    private static string WavSignature(byte[] wav) => Convert.ToHexString(SHA1.HashData(wav));

    private static void EnsureSirenKeys(string gta)
    {
        if (SirenKeysLoaded || !string.IsNullOrWhiteSpace(LoadedGtaKeyFolder))
        {
            GTA5Hash.LUT = GTA5Keys.PC_LUT;
            return;
        }
        var legacy = File.Exists(Path.Combine(gta, "gta5.exe"));
        try
        {
            GTA5Keys.LoadFromPath(Path.GetFullPath(gta), gen9: !legacy, key: null);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Couldn't read the game's archive keys from {gta}: {ex.Message}");
        }
        GTA5Hash.LUT = GTA5Keys.PC_LUT;
        SirenKeysLoaded = true;
    }

    private static string? ResolveSirenGtaFolder(string? explicitFolder, List<string> warnings)
    {
        if (!string.IsNullOrWhiteSpace(explicitFolder))
        {
            if (IsSirenGtaFolder(explicitFolder)) return Path.GetFullPath(explicitFolder);
            warnings.Add($"{explicitFolder} isn't a GTA V install (it needs gta5.exe or GTA5_Enhanced.exe and x64\\audio\\sfx\\RESIDENT.rpf).");
            return null;
        }
        return DetectSirenGtaFolder();
    }

    private static bool IsSirenGtaFolder(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder)) return false;
        try
        {
            return Directory.Exists(folder)
                && (File.Exists(Path.Combine(folder, "gta5.exe")) || File.Exists(Path.Combine(folder, "gta5_enhanced.exe")))
                && File.Exists(Path.Combine(folder, "x64", "audio", "sfx", "RESIDENT.rpf"));
        }
        catch
        {
            return false;
        }
    }

    private static string? DetectSirenGtaFolder()
    {
        var candidates = new List<string?>();
        candidates.AddRange(EpicGtaInstallLocations());
        if (OperatingSystem.IsWindows())
        {
            foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
            {
                foreach (var subKey in new[] { @"Software\Rockstar Games\Grand Theft Auto V Enhanced", @"Software\Rockstar Games\GTAV Enhanced", @"Software\Rockstar Games\Grand Theft Auto V", @"Software\Rockstar Games\GTAV" })
                {
                    foreach (var value in new[] { "InstallFolder", "InstallFolderSteam", "InstallFolderEpic", "InstallLocation" })
                    {
                        candidates.Add(TryReadRegistryString(RegistryHive.LocalMachine, view, subKey, value));
                    }
                }
            }
            candidates.AddRange(UninstallGtaInstallLocations());
            candidates.Add(TryReadRegistryString(RegistryHive.CurrentUser, RegistryView.Default, @"Software\NewTechnologyStudio\OpenIV.exe\BrowseForFolder", "game_path_Five_pc"));
        }
        foreach (var library in EnumerateSteamLibraryPaths())
        {
            candidates.Add(Path.Combine(library, "steamapps", "common", "Grand Theft Auto V Enhanced"));
            candidates.Add(Path.Combine(library, "steamapps", "common", "Grand Theft Auto V"));
        }
        foreach (var programFiles in new[] { Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86) })
        {
            if (string.IsNullOrEmpty(programFiles)) continue;
            candidates.Add(Path.Combine(programFiles, "Rockstar Games", "Grand Theft Auto V Enhanced"));
            candidates.Add(Path.Combine(programFiles, "Rockstar Games", "Grand Theft Auto V"));
            candidates.Add(Path.Combine(programFiles, "Epic Games", "GTAVEnhanced"));
            candidates.Add(Path.Combine(programFiles, "Epic Games", "GTAV"));
            candidates.Add(Path.Combine(programFiles, "Steam", "steamapps", "common", "Grand Theft Auto V Enhanced"));
            candidates.Add(Path.Combine(programFiles, "Steam", "steamapps", "common", "Grand Theft Auto V"));
        }
        foreach (var drive in DriveInfo.GetDrives())
        {
            if (drive.DriveType != DriveType.Fixed || !drive.IsReady) continue;
            var at = drive.RootDirectory.FullName;
            foreach (var relative in new[]
            {
                @"EpicGames\GTAVEnhanced", @"Epic Games\GTAVEnhanced", @"EpicGames\GTAV", @"Epic Games\GTAV",
                @"SteamLibrary\steamapps\common\Grand Theft Auto V Enhanced", @"SteamLibrary\steamapps\common\Grand Theft Auto V",
                @"Rockstar Games\Grand Theft Auto V Enhanced", @"Rockstar Games\Grand Theft Auto V",
                @"Games\Grand Theft Auto V Enhanced", @"Games\Grand Theft Auto V", @"Games\GTAVEnhanced", @"Games\GTAV",
            })
            {
                candidates.Add(Path.Combine(at, relative));
            }
        }
        return candidates.FirstOrDefault(IsSirenGtaFolder) is { } found ? Path.GetFullPath(found) : null;
    }

    private static IEnumerable<string> EpicGtaInstallLocations()
    {
        var manifests = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Epic", "EpicGamesLauncher", "Data", "Manifests");
        if (!Directory.Exists(manifests)) yield break;
        string[] items;
        try { items = Directory.GetFiles(manifests, "*.item"); } catch { yield break; }
        foreach (var item in items)
        {
            string? location = null;
            try
            {
                if (new FileInfo(item).Length > SirenXmlMaxBytes) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(item));
                if (doc.RootElement.TryGetProperty("InstallLocation", out var value) && value.ValueKind == JsonValueKind.String) location = value.GetString();
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[sirens] epic manifest {Path.GetFileName(item)}: {ex.Message}");
            }
            if (!string.IsNullOrWhiteSpace(location)) yield return location;
        }
    }

    private static IEnumerable<string> UninstallGtaInstallLocations()
    {
        if (!OperatingSystem.IsWindows()) yield break;
        var found = new List<string>();
        foreach (var view in new[] { RegistryView.Registry32, RegistryView.Registry64 })
        {
            try
            {
                using var baseKey = RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, view);
                using var uninstall = baseKey.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Uninstall");
                if (uninstall == null) continue;
                foreach (var name in uninstall.GetSubKeyNames())
                {
                    using var app = uninstall.OpenSubKey(name);
                    if (app?.GetValue("DisplayName") is string display && display.Contains("Grand Theft Auto V", StringComparison.OrdinalIgnoreCase)
                        && app.GetValue("InstallLocation") is string location && !string.IsNullOrWhiteSpace(location))
                    {
                        found.Add(location.Trim('"'));
                    }
                }
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[sirens] uninstall registry: {ex.Message}");
            }
        }
        foreach (var location in found) yield return location;
    }

    private static string SirenRoleFromName(string name)
    {
        var lower = name.ToLowerInvariant();
        if (StockSirenStreams.TryGetValue(JenkHash.GenHash(lower) & AwcIdMask, out var stock) && stock.Name == lower) return stock.Role;
        if (Regex.IsMatch(lower, "horn")) return "horn";
        if (Regex.IsMatch(lower, "pcall|powercall|power_call|ambulance_warning|rumbler")) return "powercall";
        if (Regex.IsMatch(lower, "priority|hilo|hi_lo|piercer|police_warning|warning")) return "priority";
        if (Regex.IsMatch(lower, "yelp|quick|phaser|zzz|siren_2")) return "yelp";
        if (Regex.IsMatch(lower, "wail")) return "wail";
        if (Regex.IsMatch(lower, "fire")) return "fire";
        return "other";
    }

    private static string RoleFromSirenTypes(List<string> types, string name)
    {
        if (types.Any(t => t.Equals("Horn", StringComparison.OrdinalIgnoreCase))) return "horn";
        if (types.Any(t => t.Equals("Primary", StringComparison.OrdinalIgnoreCase))) return "wail";
        var byName = SirenRoleFromName(name);
        if (byName != "other" || types.Count == 0) return byName;
        return types.Any(t => t.Equals("Secondary", StringComparison.OrdinalIgnoreCase)) ? "yelp" : "priority";
    }

    private static string SnakeSirenName(string stem)
    {
        var spaced = Regex.Replace(stem, "(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])", "_");
        var name = Regex.Replace(spaced.ToLowerInvariant(), "[^a-z0-9]+", "_").Trim('_');
        if (name.Length == 0) name = "tone";
        return name.Length > 40 ? name[..40].TrimEnd('_') : name;
    }

    private static string UniqueSirenName(string name, HashSet<string> used)
    {
        var candidate = name;
        for (var n = 2; !used.Add(candidate); n++) candidate = $"{name}_{n}";
        return candidate;
    }

    private static WavInfo ReadWavInfo(byte[] bytes, string label)
    {
        if (bytes.Length < 44 || Encoding.ASCII.GetString(bytes, 0, 4) != "RIFF" || Encoding.ASCII.GetString(bytes, 8, 4) != "WAVE")
        {
            throw new BridgeException($"{label} isn't a RIFF WAVE file.");
        }
        int format = 0, channels = 0, rate = 0, bits = 0, dataOffset = -1, dataLength = 0;
        var fmtFirst = false;
        var chunkIndex = 0;
        var at = 12;
        while (at + 8 <= bytes.Length)
        {
            var id = Encoding.ASCII.GetString(bytes, at, 4);
            var size = BitConverter.ToUInt32(bytes, at + 4);
            var body = at + 8;
            if (size > (uint)(bytes.Length - body))
            {
                if (id != "data") throw new BridgeException($"{label} has a {id.Trim()} chunk that runs past the end of the file.");
                size = (uint)(bytes.Length - body);
            }
            if (id == "fmt ")
            {
                if (size < 16) throw new BridgeException($"{label} has a truncated fmt chunk.");
                format = BitConverter.ToUInt16(bytes, body);
                channels = BitConverter.ToUInt16(bytes, body + 2);
                rate = BitConverter.ToInt32(bytes, body + 4);
                bits = BitConverter.ToUInt16(bytes, body + 14);
                if (format == 0xFFFE && size >= 40) format = BitConverter.ToUInt16(bytes, body + 24);
                fmtFirst = chunkIndex == 0 && size == 16;
            }
            else if (id == "data")
            {
                dataOffset = body;
                dataLength = (int)size;
                break;
            }
            chunkIndex++;
            at = body + (int)size + (int)(size & 1);
        }
        if (channels == 0 || rate <= 0 || bits == 0) throw new BridgeException($"{label} has no usable fmt chunk.");
        if (dataOffset < 0) throw new BridgeException($"{label} has no data chunk.");
        var canonical = fmtFirst && chunkIndex == 1 && format == 1 && channels == 1 && bits == 16 && dataOffset == 44
            && dataOffset + dataLength == bytes.Length && dataLength % 2 == 0
            && BitConverter.ToInt32(bytes, 28) == rate * 2 && BitConverter.ToUInt16(bytes, 32) == 2;
        return new WavInfo { Format = format, Channels = channels, SampleRate = rate, Bits = bits, DataOffset = dataOffset, DataLength = dataLength, Canonical = canonical };
    }

    private static bool CanConvertWav(WavInfo info) =>
        info.Channels is >= 1 and <= 8 && info.SampleRate is >= 4000 and <= 192000
        && ((info.Format == 1 && info.Bits is 8 or 16 or 24 or 32) || (info.Format == 3 && info.Bits is 32 or 64));

    private static string DescribeWavFormat(WavInfo info)
    {
        var codec = info.Format switch { 1 => "PCM", 3 => "float", 2 => "MS ADPCM", 0x11 => "IMA ADPCM", 0x55 => "MP3", _ => $"format 0x{info.Format:X4}" };
        return $"{info.Channels}-channel {info.Bits}-bit {codec} at {info.SampleRate} Hz{(info.Canonical || info.Format != 1 || info.Channels != 1 || info.Bits != 16 ? "" : " with extra chunks")}";
    }

    private static byte[] ConvertToCanonicalWav(byte[] bytes, WavInfo info)
    {
        if (info.Canonical) return bytes;
        var width = info.Bits / 8;
        var frames = info.Frames;
        var pcm = new byte[frames * 2];
        for (var f = 0; f < frames; f++)
        {
            double sum = 0;
            for (var c = 0; c < info.Channels; c++)
            {
                var at = info.DataOffset + (f * info.Channels + c) * width;
                sum += (info.Format, info.Bits) switch
                {
                    (1, 8) => (bytes[at] - 128) / 128.0,
                    (1, 16) => BitConverter.ToInt16(bytes, at) / 32768.0,
                    (1, 24) => ((bytes[at] | (bytes[at + 1] << 8) | ((sbyte)bytes[at + 2] << 16))) / 8388608.0,
                    (1, 32) => BitConverter.ToInt32(bytes, at) / 2147483648.0,
                    (3, 32) => BitConverter.ToSingle(bytes, at),
                    _ => BitConverter.ToDouble(bytes, at),
                };
            }
            var sample = (short)Math.Clamp(Math.Round(sum / info.Channels * 32767.0), short.MinValue, short.MaxValue);
            pcm[f * 2] = (byte)(sample & 0xFF);
            pcm[f * 2 + 1] = (byte)((sample >> 8) & 0xFF);
        }
        return CanonicalWav(pcm, info.SampleRate);
    }

    private static byte[] CanonicalWav(byte[] pcm, int rate)
    {
        using var ms = new MemoryStream(44 + pcm.Length);
        using var w = new BinaryWriter(ms);
        w.Write(Encoding.ASCII.GetBytes("RIFF"));
        w.Write(36 + pcm.Length);
        w.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
        w.Write(16);
        w.Write((short)1);
        w.Write((short)1);
        w.Write(rate);
        w.Write(rate * 2);
        w.Write((short)2);
        w.Write((short)16);
        w.Write(Encoding.ASCII.GetBytes("data"));
        w.Write(pcm.Length);
        w.Write(pcm);
        w.Flush();
        return ms.ToArray();
    }

    private static (int Peak, double Rms) PcmLevels(byte[] pcm)
    {
        var peak = 0;
        double sum = 0;
        var count = pcm.Length / 2;
        for (var i = 0; i < count; i++)
        {
            int s = BitConverter.ToInt16(pcm, i * 2);
            var a = Math.Abs(s);
            if (a > peak) peak = a;
            sum += (double)s * s;
        }
        return (peak, count == 0 ? 0 : Math.Sqrt(sum / count));
    }
}
