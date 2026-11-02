using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using CodeWalker.GameFiles;

namespace CodeWalkerBridge;

public static partial class Program
{
    private const int EngineAudioMaxFiles = 4000;
    private const long EngineAudioMaxFileBytes = 512L * 1024 * 1024;
    private const uint AwcIdMask = 0x1FFFFFFF;
    private const int OneShotLimit = 12;

    private static readonly string[] GranularChannelNames =
    {
        "engine_accel", "exhaust_accel", "engine_decel", "exhaust_decel", "engine_idle", "exhaust_idle",
    };

    private sealed class AudioSourceFile
    {
        public required string RelativePath { get; init; }
        public required Func<byte[]> Read { get; init; }
        public required long Size { get; init; }
        private byte[]? cached;
        public byte[] Bytes => cached ??= Read();
        public string Name => RelativePath.Split('/').Last();
        public string Folder => RelativePath.Contains('/') ? RelativePath[..RelativePath.LastIndexOf('/')] : string.Empty;
    }

    private sealed class AudioSource
    {
        public required string Id { get; init; }
        public required string Kind { get; init; }
        public required string Path { get; init; }
        public required List<AudioSourceFile> Files { get; init; }
        public List<string> Warnings { get; } = new();
        public bool Encrypted { get; set; }
        public string? Manifest { get; set; }
    }

    private sealed class LoadedPack
    {
        public required AudioSource Source { get; init; }
        public List<(AudioSourceFile File, RelFile Rel)> Rels { get; } = new();
        public Dictionary<uint, AudioSourceFile> BanksByContainer { get; } = new();
        public Dictionary<uint, string> ContainerNames { get; } = new();
        public Dictionary<uint, RelData> Sounds { get; } = new();
        public Dictionary<uint, AwcFile> LoadedAwcs { get; } = new();
        public IEnumerable<RelData> GameData => Rels.SelectMany(r => r.Rel.RelDatas ?? Array.Empty<RelData>());
    }

    private static object InspectEngineAudio(string root)
    {
        var sources = DiscoverAudioSources(root);
        return new
        {
            sources = sources.Select(s => DescribePack(LoadPack(s))).ToList(),
            orphanAwcs = OrphanAwcFiles(root, sources),
            escrowed = Directory.EnumerateFiles(root, "*.fxap", SearchOption.AllDirectories).Any(),
        };
    }

    private static object DecodeEngineAudio(string root, string sourceId, string audioName, string outputDir)
    {
        var pack = LoadPack(FindSource(root, sourceId));
        var car = FindCar(pack, audioName) ?? throw new BridgeException($"{audioName} isn't in this pack.");
        var granular = pack.GameData.OfType<Dat151GranularEngineAudioSettings>().FirstOrDefault(g => g.NameHash == car.GranularEngine.Hash)
            ?? throw new BridgeException($"{audioName} has no granular engine, so Studio can't rev it.");
        var sound = pack.Sounds.GetValueOrDefault(granular.EngineAccel.Hash) as Dat54GranularSound
            ?? throw new BridgeException($"{audioName}'s granular sound is missing from its sounds file.");

        Directory.CreateDirectory(outputDir);
        var settings = new[] { sound.ChannelSettings0, sound.ChannelSettings1, sound.ChannelSettings2, sound.ChannelSettings3, sound.ChannelSettings4, sound.ChannelSettings5 };
        var volumes = new[] { sound.ChannelVolume0, sound.ChannelVolume1, sound.ChannelVolume2, sound.ChannelVolume3, sound.ChannelVolume4, sound.ChannelVolume5 };
        var files = GranularFiles(sound);
        var channels = new List<object>();
        for (var i = 0; i < files.Length; i++)
        {
            var stream = FindStream(pack, files[i].ContainerName.Hash, files[i].FileName.Hash);
            if (stream == null)
            {
                channels.Add(new { role = GranularChannelNames[i], available = false });
                continue;
            }
            var wavPath = Path.Combine(outputDir, GranularChannelNames[i] + ".wav");
            File.WriteAllBytes(wavPath, stream.GetWavFile());
            var grains = stream.GranularGrainsChunk?.GranularGrains ?? Array.Empty<AwcGranularGrainsChunk.GranularGrain>();
            channels.Add(new
            {
                role = GranularChannelNames[i],
                available = true,
                wav = wavPath,
                sampleRate = stream.SamplesPerSecond,
                sampleCount = stream.SampleCount,
                outputBuffer = settings[i]?.OutputBuffer ?? (byte)(i % 2),
                granularClockIndex = settings[i]?.GranularClockIndex ?? 0,
                maxLoopProportion = settings[i]?.MaxLoopProportion ?? 1f,
                volume = volumes[i],
                grainRate = stream.GranularGrainsChunk?.UnkFloat1 ?? 1f,
                grains = grains.Select(g => new[] { g.UnkUint1, (double)g.UnkFloat1 }).ToArray(),
                loops = stream.GranularLoopsChunk?.GranularLoops?.Select(l => l.Grains).ToArray() ?? Array.Empty<uint[]>(),
            });
        }

        var engine = pack.GameData.OfType<Dat151VehicleEngineAudioSettings>().FirstOrDefault(e => e.NameHash == car.Engine.Hash);
        var oneShots = new List<object>();
        foreach (var (role, hashes) in OneShotRoles(car, engine, granular))
        {
            var exported = new List<string>();
            var stock = 0;
            foreach (var leaf in hashes.SelectMany(h => SimpleSoundLeaves(pack, h)).DistinctBy(l => (l.ContainerName.Hash, l.FileName.Hash)))
            {
                var stream = FindStream(pack, leaf.ContainerName.Hash, leaf.FileName.Hash);
                if (stream == null)
                {
                    stock++;
                    continue;
                }
                if (exported.Count >= OneShotLimit) continue;
                var path = Path.Combine(outputDir, $"{role}_{exported.Count}.wav");
                File.WriteAllBytes(path, stream.GetWavFile());
                exported.Add(path);
            }
            oneShots.Add(new { role, files = exported, stock });
        }

        return new
        {
            audioName,
            channels,
            oneShots,
            granular = new
            {
                masterVolume = granular.MasterVolume,
                engineVolume = granular.EngineVolume_PostSubmix,
                exhaustVolume = granular.ExhaustVolume_PostSubmix,
                engineIdleVolume = granular.EngineIdleVolume_PostSubmix,
                exhaustIdleVolume = granular.ExhaustIdleVolume_PostSubmix,
                revLimiterGrainsToPlay = granular.RevLimiterGrainsToPlay,
                revLimiterGrainsToSkip = granular.RevLimiterGrainsToSkip,
                revLimiterApplyType = granular.RevLimiterApplyType,
                revLimiterVolumeCut = granular.RevLimiterVolumeCut,
                minRpmOverride = granular.MinRPMOverride,
                maxRpmOverride = granular.MaxRPMOverride,
                gearChangeWobbleLength = granular.GearChangeWobbleLength,
                gearChangeWobblePitch = granular.GearChangeWobblePitch,
                gearChangeWobbleVolume = granular.GearChangeWobbleVolume,
                loopRandomisationChangeRate = sound.LoopRandomisationChangeRate,
                loopRandomisationPitchFraction = sound.LoopRandomisationPitchFraction,
                granularClock = sound.GranularClock?.Select(v => new[] { v.X, v.Y }).ToArray() ?? Array.Empty<float[]>(),
            },
        };
    }

    private static object StageEngineSource(string root, string sourceId, string outputDir)
    {
        var pack = LoadPack(FindSource(root, sourceId));
        if (pack.Source.Files.Count == 0) throw new BridgeException(pack.Source.Warnings.FirstOrDefault() ?? "This pack has no audio files.");
        Directory.CreateDirectory(outputDir);
        var written = new List<object>();
        var dataFiles = new List<(string Type, string Path)>();
        foreach (var (file, rel) in pack.Rels)
        {
            var type = DataFileType(rel.RelType);
            if (type == null) continue;
            WriteNew(Path.Combine(outputDir, "audioconfig", file.Name.ToLowerInvariant()), file.Bytes);
            written.Add(new { path = $"audioconfig/{file.Name.ToLowerInvariant()}", bytes = file.Bytes.Length, sha256 = Sha256(file.Bytes) });
            dataFiles.Add((type, $"audioconfig/{DataFileStem(file.Name.ToLowerInvariant())}"));
        }
        foreach (var bank in pack.BanksByContainer.Values.Distinct())
        {
            var folder = bank.Folder.Split('/').Last().ToLowerInvariant();
            var name = bank.Name.ToLowerInvariant();
            WriteNew(Path.Combine(outputDir, "sfx", folder, name), bank.Bytes);
            written.Add(new { path = $"sfx/{folder}/{name}", bytes = bank.Bytes.Length, sha256 = Sha256(bank.Bytes) });
            if (!dataFiles.Contains(("AUDIO_WAVEPACK", $"sfx/{folder}"))) dataFiles.Add(("AUDIO_WAVEPACK", $"sfx/{folder}"));
        }
        return new { files = written, dataFiles = dataFiles.Select(d => new { type = d.Type, path = d.Path }).ToList() };
    }

    private static object BuildEngineDlc(string stagedDir, string packName, string outputPath)
    {
        if (!Regex.IsMatch(packName, "^[a-z0-9_]{1,40}$"))
        {
            throw new BridgeException("Pack names use lowercase letters, digits and underscores (up to 40).");
        }
        if (File.Exists(outputPath)) throw new BridgeException($"{outputPath} already exists.");
        var configDir = Path.Combine(stagedDir, "audioconfig");
        var sfxDir = Path.Combine(stagedDir, "sfx");
        if (!Directory.Exists(configDir) || !Directory.Exists(sfxDir)) throw new BridgeException("The staged pack is incomplete.");

        var device = $"dlc_{packName}";
        var entries = new List<(string Path, string Type)>();
        foreach (var rel in Directory.GetFiles(configDir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            var name = Path.GetFileName(rel).ToLowerInvariant();
            var type = name.Contains(".dat151.") ? "AUDIO_GAMEDATA" : name.Contains(".dat54.") ? "AUDIO_SOUNDDATA" : name.Contains(".dat10.") ? "AUDIO_SYNTHDATA" : null;
            if (type != null) entries.Add(($"{device}:/%PLATFORM%/audio/{DataFileStem(name)}", type));
        }
        foreach (var bank in Directory.GetDirectories(sfxDir).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            entries.Add(($"{device}:/%PLATFORM%/audio/sfx/{Path.GetFileName(bank).ToLowerInvariant()}", "AUDIO_WAVEPACK"));
        }

        Directory.CreateDirectory(Path.GetDirectoryName(outputPath)!);
        var temp = outputPath + ".partial";
        if (File.Exists(temp)) File.Delete(temp);
        try
        {
            var rpf = RpfFile.CreateNew(string.Empty, temp, RpfEncryption.OPEN);
            RpfFile.CreateFile(rpf.Root, "content.xml", Encoding.UTF8.GetBytes(DlcContentXml(packName, entries)));
            RpfFile.CreateFile(rpf.Root, "setup2.xml", Encoding.UTF8.GetBytes(DlcSetupXml(packName)));
            var audio = RpfFile.CreateDirectory(RpfFile.CreateDirectory(rpf.Root, "x64"), "audio");
            foreach (var rel in Directory.GetFiles(configDir))
            {
                RpfFile.CreateFile(audio, Path.GetFileName(rel).ToLowerInvariant(), File.ReadAllBytes(rel));
            }
            var sfx = RpfFile.CreateDirectory(audio, "sfx");
            foreach (var bank in Directory.GetDirectories(sfxDir))
            {
                var dir = RpfFile.CreateDirectory(sfx, Path.GetFileName(bank).ToLowerInvariant());
                foreach (var awc in Directory.GetFiles(bank, "*.awc"))
                {
                    RpfFile.CreateFile(dir, Path.GetFileName(awc).ToLowerInvariant(), File.ReadAllBytes(awc));
                }
            }
            File.Move(temp, outputPath);
        }
        finally
        {
            if (File.Exists(temp)) File.Delete(temp);
        }
        var bytes = File.ReadAllBytes(outputPath);
        return new { path = outputPath, bytes = bytes.Length, sha256 = Sha256(bytes), device };
    }

    private static string? DataFileType(RelDatFileType type) => type switch
    {
        RelDatFileType.Dat151 => "AUDIO_GAMEDATA",
        RelDatFileType.Dat54DataEntries => "AUDIO_SOUNDDATA",
        RelDatFileType.Dat10ModularSynth => "AUDIO_SYNTHDATA",
        _ => null,
    };

    private static string DlcContentXml(string packName, List<(string Path, string Type)> entries)
    {
        var sb = new StringBuilder();
        sb.Append("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<CDataFileMgr__ContentsOfDataFileXml>\n  <disabledFiles />\n  <includedXmlFiles />\n  <includedDataFiles />\n  <dataFiles>\n");
        foreach (var (path, type) in entries)
        {
            sb.Append($"    <Item>\n      <filename>{path}</filename>\n      <fileType>{type}</fileType>\n      <overlay value=\"false\" />\n      <disabled value=\"true\" />\n      <persistent value=\"false\" />\n    </Item>\n");
        }
        sb.Append($"  </dataFiles>\n  <contentChangeSets>\n    <Item>\n      <changeSetName>{packName.ToUpperInvariant()}_AUTOGEN</changeSetName>\n      <filesToDisable />\n      <filesToEnable>\n");
        foreach (var (path, _) in entries) sb.Append($"        <Item>{path}</Item>\n");
        sb.Append("      </filesToEnable>\n      <txdToLoad />\n      <txdToUnload />\n      <residentResources />\n      <unregisterResources />\n    </Item>\n  </contentChangeSets>\n  <patchFiles />\n</CDataFileMgr__ContentsOfDataFileXml>\n");
        return sb.ToString();
    }

    private static string DlcSetupXml(string packName) =>
        $"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<SSetupData>\n  <deviceName>dlc_{packName}</deviceName>\n  <datFile>content.xml</datFile>\n  <timeStamp>00/00/0000 00:00:00</timeStamp>\n  <nameHash>{packName}</nameHash>\n  <contentChangeSetGroups>\n    <Item>\n      <NameHash>GROUP_STARTUP</NameHash>\n      <ContentChangeSets>\n        <Item>{packName.ToUpperInvariant()}_AUTOGEN</Item>\n      </ContentChangeSets>\n    </Item>\n  </contentChangeSetGroups>\n  <type>EXTRACONTENT_COMPAT_PACK</type>\n  <order value=\"2\" />\n</SSetupData>\n";

    private static string DataFileStem(string fileName)
    {
        var at = fileName.IndexOf(".dat", StringComparison.OrdinalIgnoreCase);
        return at < 0 ? fileName : fileName[..(at + 4)];
    }

    private static void WriteNew(string path, byte[] bytes)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (File.Exists(path)) throw new BridgeException($"Two files in this pack would land at {path}.");
        File.WriteAllBytes(path, bytes);
    }

    private static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    private static AudioSource FindSource(string root, string sourceId) =>
        DiscoverAudioSources(root).FirstOrDefault(s => s.Id == sourceId)
        ?? throw new BridgeException($"The pack {sourceId} isn't in this import any more.");

    private static List<AudioSource> DiscoverAudioSources(string root)
    {
        root = Path.GetFullPath(root).TrimEnd('\\', '/');
        if (!Directory.Exists(root)) throw new BridgeException($"{root} doesn't exist.");
        var all = Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories).Take(EngineAudioMaxFiles + 1).ToList();
        if (all.Count > EngineAudioMaxFiles)
        {
            throw new BridgeException($"This download has more than {EngineAudioMaxFiles} files. Studio reads engine sound packs, not whole mod collections.");
        }
        var oversized = all.FirstOrDefault(p => new FileInfo(p).Length > EngineAudioMaxFileBytes);
        if (oversized != null) throw new BridgeException($"{Path.GetFileName(oversized)} is larger than {EngineAudioMaxFileBytes >> 20} MB.");

        var sources = new List<AudioSource>();
        foreach (var rpfPath in all.Where(p => p.EndsWith(".rpf", StringComparison.OrdinalIgnoreCase)))
        {
            var source = OpenRpfSource(root, rpfPath);
            if (source != null) sources.Add(source);
        }

        var loose = all.Where(p => p.EndsWith(".rel", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".awc", StringComparison.OrdinalIgnoreCase)).ToList();
        var folders = loose.Where(p => p.EndsWith(".dat151.rel", StringComparison.OrdinalIgnoreCase))
            .Select(p => LooseSourceRoot(root, p))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderByDescending(p => p.Length)
            .ToList();
        var claimed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var dir in folders)
        {
            var files = loose.Where(p => IsUnder(p, dir) && claimed.Add(p))
                .Select(p => new AudioSourceFile
                {
                    RelativePath = Path.GetRelativePath(dir, p).Replace('\\', '/'),
                    Read = () => File.ReadAllBytes(p),
                    Size = new FileInfo(p).Length,
                })
                .ToList();
            var manifest = new[] { "fxmanifest.lua", "__resource.lua" }.Select(m => Path.Combine(dir, m)).FirstOrDefault(File.Exists);
            sources.Add(new AudioSource
            {
                Id = "folder:" + Path.GetRelativePath(root, dir).Replace('\\', '/'),
                Kind = "folder",
                Path = dir,
                Files = files,
                Manifest = manifest == null ? null : File.ReadAllText(manifest),
            });
        }
        return sources.OrderBy(s => s.Id, StringComparer.OrdinalIgnoreCase).ToList();
    }

    private static List<string> OrphanAwcFiles(string root, List<AudioSource> sources)
    {
        var folders = sources.Where(s => s.Kind == "folder").Select(s => s.Path).ToList();
        return Directory.EnumerateFiles(root, "*.awc", SearchOption.AllDirectories)
            .Where(p => !folders.Any(f => IsUnder(p, f)))
            .Select(p => Path.GetRelativePath(root, p).Replace('\\', '/'))
            .Take(50)
            .ToList();
    }

    private static bool IsUnder(string path, string dir) =>
        path.StartsWith(dir.TrimEnd('\\', '/') + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private static bool IsAtOrUnder(string path, string dir) =>
        string.Equals(path.TrimEnd('\\', '/'), dir.TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase) || IsUnder(path, dir);

    private static string LooseSourceRoot(string root, string relPath)
    {
        var dir = Path.GetDirectoryName(relPath)!;
        for (var at = dir; at != null && IsAtOrUnder(at, root); at = Path.GetDirectoryName(at))
        {
            if (File.Exists(Path.Combine(at, "fxmanifest.lua")) || File.Exists(Path.Combine(at, "__resource.lua"))) return at;
        }
        var name = Path.GetFileName(dir).ToLowerInvariant();
        var parent = Path.GetDirectoryName(dir);
        var conventional = name is "audioconfig" or "audio" or "data" or "audiodata" or "audiodirectory";
        return conventional && parent != null && IsAtOrUnder(parent, root) ? parent : dir;
    }

    private static AudioSource? OpenRpfSource(string root, string rpfPath)
    {
        var id = "rpf:" + Path.GetRelativePath(root, rpfPath).Replace('\\', '/');
        RpfFile rpf;
        try
        {
            var gta = AutoDetectGtaFolder();
            if (gta != null)
            {
                try { EnsureGtaArchiveKeys(gta); } catch (Exception ex) { Console.Error.WriteLine($"[engine-audio] keys: {ex.Message}"); }
            }
            rpf = new RpfFile(rpfPath, Path.GetFileName(rpfPath));
            rpf.ScanStructure(null, null);
        }
        catch (Exception ex)
        {
            var failed = new AudioSource { Id = id, Kind = "rpf", Path = rpfPath, Files = new() };
            failed.Warnings.Add($"Couldn't open {Path.GetFileName(rpfPath)}: {ex.Message}");
            return failed;
        }
        var entries = (rpf.AllEntries ?? new List<RpfEntry>()).OfType<RpfFileEntry>()
            .Where(e => e.NameLower.EndsWith(".rel") || e.NameLower.EndsWith(".awc"))
            .ToList();
        if (entries.Count == 0) return null;
        var prefix = rpf.Root.Path + "\\";
        return new AudioSource
        {
            Id = id,
            Kind = "rpf",
            Path = rpfPath,
            Encrypted = rpf.Encryption == RpfEncryption.NG,
            Files = entries.Select(e => new AudioSourceFile
            {
                RelativePath = (e.Path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase) ? e.Path[prefix.Length..] : e.Path).Replace('\\', '/').ToLowerInvariant(),
                Read = () => rpf.ExtractFile(e) ?? throw new BridgeException($"Couldn't read {e.Path} from {Path.GetFileName(rpfPath)}."),
                Size = e.GetFileSize(),
            }).ToList(),
        };
    }

    private static LoadedPack LoadPack(AudioSource source)
    {
        var pack = new LoadedPack { Source = source };
        foreach (var file in source.Files.Where(f => f.Name.EndsWith(".rel", StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                var rel = new RelFile();
                rel.Load(file.Bytes, new RpfBinaryFileEntry { Name = file.Name, NameLower = file.Name.ToLowerInvariant() });
                pack.Rels.Add((file, rel));
                if (rel.RelType != RelDatFileType.Dat54DataEntries) continue;
                foreach (var path in rel.NameTable ?? Array.Empty<string>())
                {
                    var normal = path.Replace('\\', '/').ToLowerInvariant();
                    pack.ContainerNames[JenkHash.GenHash(normal)] = normal;
                }
                foreach (var data in rel.RelDatas ?? Array.Empty<RelData>())
                {
                    pack.Sounds[data.NameHash] = data;
                }
            }
            catch (Exception ex)
            {
                source.Warnings.Add($"{file.RelativePath} isn't a readable audio data file: {ex.Message}");
            }
        }
        foreach (var awc in source.Files.Where(f => f.Name.EndsWith(".awc", StringComparison.OrdinalIgnoreCase)))
        {
            var folder = awc.Folder.Split('/').Last().ToLowerInvariant();
            var stem = Path.GetFileNameWithoutExtension(awc.Name).ToLowerInvariant();
            pack.BanksByContainer[JenkHash.GenHash($"{folder}/{stem}")] = awc;
        }
        return pack;
    }

    private static Dat54GranularSoundFile[] GranularFiles(Dat54GranularSound sound) =>
        new[] { sound.Channel0, sound.Channel1, sound.Channel2, sound.Channel3, sound.Channel4, sound.Channel5 };

    private static Dat151CarAudioSettings? FindCar(LoadedPack pack, string audioName)
    {
        var hash = audioName.StartsWith("hash_", StringComparison.OrdinalIgnoreCase)
            ? Convert.ToUInt32(audioName[5..], 16)
            : JenkHash.GenHash(audioName.ToLowerInvariant());
        return pack.GameData.OfType<Dat151CarAudioSettings>().FirstOrDefault(c => c.NameHash == hash);
    }

    private static AwcStream? FindStream(LoadedPack pack, uint containerHash, uint fileHash)
    {
        if (containerHash == 0 || fileHash == 0) return null;
        if (!pack.BanksByContainer.TryGetValue(containerHash, out var bank)) return null;
        if (!pack.LoadedAwcs.TryGetValue(containerHash, out var awc))
        {
            awc = new AwcFile();
            awc.Load(bank.Bytes, new RpfBinaryFileEntry { Name = bank.Name, NameLower = bank.Name.ToLowerInvariant() });
            pack.LoadedAwcs[containerHash] = awc;
        }
        return awc.Streams?.FirstOrDefault(s => (s.StreamInfo?.Id ?? 0) == (fileHash & AwcIdMask));
    }

    private static IEnumerable<(string Role, uint[] Hashes)> OneShotRoles(Dat151CarAudioSettings car, Dat151VehicleEngineAudioSettings? engine, Dat151GranularEngineAudioSettings granular)
    {
        yield return ("limiter_pop", new[] { granular.RevLimiterPopSound.Hash, granular.UpgradedRevLimiterPop.Hash });
        if (engine != null)
        {
            yield return ("exhaust_pops", new[] { engine.ExhaustPops.Hash, engine.UpgradedExhaustPops.Hash });
            yield return ("startup", new[] { engine.EngineStartUp.Hash, engine.Ignition.Hash });
            yield return ("shutdown", new[] { engine.EngineShutdown.Hash });
            yield return ("dump_valve", new[] { engine.DumpValve.Hash, engine.UpgradedDumpValve.Hash });
        }
        yield return ("startup_revs", new[] { car.StartupRevs.Hash });
    }

    private static List<Dat54SimpleSound> SimpleSoundLeaves(LoadedPack pack, uint hash)
    {
        var leaves = new List<Dat54SimpleSound>();
        var seen = new HashSet<uint>();
        void Walk(uint h, int depth)
        {
            if (h == 0 || depth > 12 || !seen.Add(h) || leaves.Count > 64) return;
            if (!pack.Sounds.TryGetValue(h, out var data)) return;
            if (data is Dat54SimpleSound simple)
            {
                leaves.Add(simple);
                return;
            }
            if (data is RelSound sound && sound.ChildSoundsHashes != null)
            {
                foreach (var child in sound.ChildSoundsHashes) Walk(child.Hash, depth + 1);
            }
        }
        Walk(hash, 0);
        return leaves;
    }

    private static object DescribeChannel(LoadedPack pack, Dat54GranularSoundFile file, int index)
    {
        var stream = FindStream(pack, file.ContainerName.Hash, file.FileName.Hash);
        var grains = stream?.GranularGrainsChunk?.GranularGrains ?? Array.Empty<AwcGranularGrainsChunk.GranularGrain>();
        return new
        {
            role = GranularChannelNames[index],
            bank = pack.ContainerNames.GetValueOrDefault(file.ContainerName.Hash),
            available = stream != null,
            sampleRate = stream?.SamplesPerSecond ?? 0,
            seconds = stream == null ? 0 : Math.Round(stream.SampleCount / (double)Math.Max(1, stream.SamplesPerSecond), 2),
            grains = grains.Length,
            pitchLow = grains.Length == 0 ? 0 : Math.Round(grains.Min(g => g.UnkFloat1), 2),
            pitchHigh = grains.Length == 0 ? 0 : Math.Round(grains.Max(g => g.UnkFloat1), 2),
        };
    }

    private static object DescribePack(LoadedPack pack)
    {
        var candidates = NameCandidates(pack);
        var data = pack.GameData.ToList();
        var engines = data.OfType<Dat151CarAudioSettings>().Select(car =>
        {
            var name = candidates.GetValueOrDefault(car.NameHash);
            var granular = data.OfType<Dat151GranularEngineAudioSettings>().FirstOrDefault(g => g.NameHash == car.GranularEngine.Hash);
            var sound = granular == null ? null : pack.Sounds.GetValueOrDefault(granular.EngineAccel.Hash) as Dat54GranularSound;
            var files = sound == null ? Array.Empty<Dat54GranularSoundFile>() : GranularFiles(sound);
            var previewable = files.Length > 0 && files.Any(f => (FindStream(pack, f.ContainerName.Hash, f.FileName.Hash)?.GranularGrainsChunk?.GranularGrains?.Length ?? 0) > 0);
            return new
            {
                audioName = name ?? $"hash_{car.NameHash:X8}",
                named = name != null,
                granular = granular != null,
                previewable,
                banks = files.Where(f => f.ContainerName.Hash != 0)
                    .Select(f => pack.ContainerNames.GetValueOrDefault(f.ContainerName.Hash) ?? $"hash_{f.ContainerName.Hash:X8}")
                    .Distinct().ToList(),
                channels = files.Select((f, i) => DescribeChannel(pack, f, i)).ToList(),
            };
        }).ToList();
        var missingBanks = pack.Sounds.Values.OfType<Dat54GranularSound>()
            .SelectMany(GranularFiles)
            .Select(f => f.ContainerName.Hash)
            .Where(h => h != 0 && !pack.BanksByContainer.ContainsKey(h))
            .Distinct()
            .Select(h => pack.ContainerNames.GetValueOrDefault(h) ?? $"hash_{h:X8}")
            .Where(n => n.Any(char.IsLetter))
            .ToList();
        return new
        {
            id = pack.Source.Id,
            kind = pack.Source.Kind,
            path = pack.Source.Path,
            encrypted = pack.Source.Encrypted,
            warnings = pack.Source.Warnings,
            hasManifest = pack.Source.Manifest != null,
            relFiles = pack.Rels.Select(r => new { path = r.File.RelativePath, type = DataFileType(r.Rel.RelType), bytes = r.File.Size }).ToList(),
            awcFiles = pack.Source.Files.Where(f => f.Name.EndsWith(".awc", StringComparison.OrdinalIgnoreCase))
                .Select(f => new { path = f.RelativePath, bytes = f.Size, sha256 = Sha256(f.Bytes) }).ToList(),
            missingBanks,
            engines,
        };
    }

    private static Dictionary<uint, string> NameCandidates(LoadedPack pack)
    {
        var words = new HashSet<string>(StringComparer.Ordinal);
        void Add(string? value)
        {
            if (string.IsNullOrWhiteSpace(value)) return;
            var lower = value.Trim().ToLowerInvariant();
            foreach (var piece in new[] { lower, lower.Replace(' ', '_') })
            {
                if (!words.Add(piece)) continue;
                foreach (var prefix in new[] { "dlc_", "sound_", "sounds_", "audio_" })
                {
                    if (piece.StartsWith(prefix)) Add(piece[prefix.Length..]);
                }
                foreach (var suffix in new[] { "_game", "_sounds", "_amp", "_npc", "_engine", "_granular_engine", "_sound", "_audio" })
                {
                    if (piece.EndsWith(suffix)) Add(piece[..^suffix.Length]);
                }
            }
        }
        foreach (var segment in pack.Source.Path.Split('\\', '/')) Add(Path.GetFileNameWithoutExtension(segment));
        foreach (var file in pack.Source.Files)
        {
            foreach (var segment in file.RelativePath.Split('/')) Add(segment.Split('.')[0]);
        }
        foreach (var container in pack.ContainerNames.Values)
        {
            foreach (var segment in container.Split('/')) Add(segment);
        }
        if (pack.Source.Manifest != null)
        {
            foreach (Match m in Regex.Matches(pack.Source.Manifest, "['\"]([^'\"]+)['\"]"))
            {
                foreach (var segment in m.Groups[1].Value.Split('/', '\\')) Add(segment.Split('.')[0]);
            }
        }
        var map = new Dictionary<uint, string>();
        foreach (var w in words) map.TryAdd(JenkHash.GenHash(w), w);
        return map;
    }
}
