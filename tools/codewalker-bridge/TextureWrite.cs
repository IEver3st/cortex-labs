using System.Text.Json;
using CodeWalker.GameFiles;
using CodeWalker.Utils;

namespace CodeWalkerBridge;

// Writes textures into a copy of a texture dictionary, for the lens colour
// write and the livery write. The input is only read: the rebuilt dictionary
// goes to `output`, and the app replaces the user's file (after a backup) once
// every dictionary in the write has been built and read back.
//   replace: a texture the dictionary holds, keeping its name and use.
//   add:     a recoloured lens copy of one in `source`, a dictionary of the
//            vehicle's own resource (the app checks where it is); it must hold
//            a texture of that name.
//   insert:  a new texture made from the user's own image, such as another
//            livery; `like` names a texture already in the dictionary whose
//            use it takes, so a new livery is used as the others are.
//   delete:  removes a texture the dictionary holds, such as a livery the
//            user no longer wants; it has no `path`.
public static partial class Program
{
    private const uint ResourceMagic = 0x37435352; // "RSC7"
    private const int LegacyYtdVersion = 13;

    private static object WriteYtdTextures(JsonElement request)
    {
        var input = RequireString(request, "input");
        var output = RequireString(request, "output");
        if (!request.TryGetProperty("textures", out var list) || list.ValueKind != JsonValueKind.Array || list.GetArrayLength() == 0)
        {
            throw new BridgeException("Missing textures to write.");
        }
        var fileName = Path.GetFileName(input);
        if (!File.Exists(input)) throw new BridgeException($"Texture dictionary not found: {input}");

        var data = File.ReadAllBytes(input);
        // CodeWalker saves the legacy format; rebuilding an Enhanced dictionary
        // that way would silently convert it.
        if (data.Length < 16 || BitConverter.ToUInt32(data, 0) != ResourceMagic || BitConverter.ToInt32(data, 4) != LegacyYtdVersion)
        {
            throw new BridgeException($"{fileName} is not a legacy GTA V texture dictionary, so it cannot be written.");
        }
        var ytd = new YtdFile();
        try
        {
            ytd.Load(data);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Failed to load texture dictionary {fileName}: {ShortReason(ex)}");
        }
        var textures = ytd.TextureDict?.Textures?.data_items?.Where(texture => texture != null).ToList()
            ?? throw new BridgeException($"{fileName} has no textures.");

        var written = new List<object>();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var sourceNames = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);
        foreach (var item in list.EnumerateArray())
        {
            var name = RequireString(item, "name").Trim();
            var mode = RequireString(item, "mode");
            if (!names.Add(name)) throw new BridgeException($"{name} is listed twice for {fileName}.");

            if (mode == "delete")
            {
                // As CodeWalker's Remove does: the dictionary is rebuilt without it.
                var held = textures.FindIndex(existing => string.Equals(GetTextureName(existing), name, StringComparison.OrdinalIgnoreCase));
                if (held < 0) throw new BridgeException($"{fileName} no longer holds {name}, so it cannot be removed.");
                written.Add(new { name = GetTextureName(textures[held]), removed = true });
                textures.RemoveAt(held);
                continue;
            }

            var path = RequireString(item, "path");
            Texture? texture;
            try
            {
                texture = DDSIO.GetTexture(File.ReadAllBytes(path));
            }
            catch (Exception ex)
            {
                throw new BridgeException($"The new {name} could not be read: {ShortReason(ex)}");
            }
            if (texture == null) throw new BridgeException($"The new {name} is not a DDS file CodeWalker reads.");

            var index = textures.FindIndex(existing => string.Equals(GetTextureName(existing), name, StringComparison.OrdinalIgnoreCase));
            switch (mode)
            {
                case "replace":
                {
                    if (index < 0) throw new BridgeException($"{fileName} no longer holds {name}, so it cannot be replaced.");
                    // As CodeWalker's Replace does: the game finds it by the same name and use.
                    var existing = textures[index];
                    texture.Name = existing.Name;
                    texture.NameHash = existing.NameHash;
                    texture.Usage = existing.Usage;
                    texture.UsageFlags = existing.UsageFlags;
                    texture.Unknown_32h = existing.Unknown_32h;
                    textures[index] = texture;
                    break;
                }
                case "add":
                {
                    if (index >= 0) throw new BridgeException($"{fileName} already holds {name}, so it cannot be added again.");
                    var source = item.TryGetProperty("source", out var sourceValue) && sourceValue.ValueKind == JsonValueKind.String
                        ? sourceValue.GetString()
                        : null;
                    if (string.IsNullOrWhiteSpace(source)) throw new BridgeException($"{name} is added without the dictionary it is copied from.");
                    if (!TextureNamesOf(source, sourceNames).Contains(name))
                    {
                        throw new BridgeException($"{Path.GetFileName(source)} does not hold {name}, so it cannot be copied. Check the lenses again.");
                    }
                    texture.Name = name;
                    texture.NameHash = JenkHash.GenHash(name.ToLowerInvariant());
                    JenkIndex.Ensure(name.ToLowerInvariant());
                    textures.Add(texture);
                    break;
                }
                case "insert":
                {
                    if (index >= 0) throw new BridgeException($"{fileName} already holds {name}, so it cannot be added again.");
                    var like = item.TryGetProperty("like", out var likeValue) && likeValue.ValueKind == JsonValueKind.String
                        ? likeValue.GetString()
                        : null;
                    if (!string.IsNullOrWhiteSpace(like))
                    {
                        var model = textures.Find(existing => string.Equals(GetTextureName(existing), like, StringComparison.OrdinalIgnoreCase))
                            ?? throw new BridgeException($"{fileName} no longer holds {like}, the texture {name} is modelled on.");
                        texture.Usage = model.Usage;
                        texture.UsageFlags = model.UsageFlags;
                        texture.Unknown_32h = model.Unknown_32h;
                    }
                    texture.Name = name;
                    texture.NameHash = JenkHash.GenHash(name.ToLowerInvariant());
                    JenkIndex.Ensure(name.ToLowerInvariant());
                    textures.Add(texture);
                    break;
                }
                default:
                    throw new BridgeException($"Unknown texture write mode '{mode}'.");
            }
            written.Add(new { name = texture.Name, replaced = mode == "replace", width = (int)texture.Width, height = (int)texture.Height, levels = (int)texture.Levels, format = texture.Format.ToString() });
        }

        if (textures.Count == 0) throw new BridgeException($"Removing these would leave {fileName} with no textures, so it is not written.");
        ytd.TextureDict!.BuildFromTextureList(textures);
        byte[] saved;
        try
        {
            saved = ytd.Save();
        }
        catch (Exception ex)
        {
            throw new BridgeException($"{fileName} could not be rebuilt: {ShortReason(ex)}");
        }

        // Read the result back: a dictionary that does not load, or lost a
        // texture, never replaces the user's file.
        var check = new YtdFile();
        try
        {
            check.Load(saved);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"The rebuilt {fileName} does not read back: {ShortReason(ex)}");
        }
        var readBack = check.TextureDict?.Textures?.data_items?.Where(texture => texture != null).Select(GetTextureName)
            .ToHashSet(StringComparer.OrdinalIgnoreCase) ?? new HashSet<string>();
        if (readBack.Count != textures.Count || textures.Any(texture => !readBack.Contains(GetTextureName(texture))))
        {
            throw new BridgeException($"The rebuilt {fileName} does not hold every texture it should.");
        }

        var outputDir = Path.GetDirectoryName(Path.GetFullPath(output));
        if (!string.IsNullOrEmpty(outputDir)) Directory.CreateDirectory(outputDir);
        File.WriteAllBytes(output, saved);
        return new { output, size = saved.Length, textureCount = textures.Count, textures = written };
    }

    // The texture names a copy source holds, read once per write.
    private static HashSet<string> TextureNamesOf(string path, Dictionary<string, HashSet<string>> cache)
    {
        var full = Path.GetFullPath(path);
        if (cache.TryGetValue(full, out var known)) return known;
        if (!File.Exists(full)) throw new BridgeException($"Texture dictionary not found: {full}");
        var ytd = new YtdFile();
        try
        {
            ytd.Load(File.ReadAllBytes(full));
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Failed to load texture dictionary {Path.GetFileName(full)}: {ShortReason(ex)}");
        }
        var names = ytd.TextureDict?.Textures?.data_items?.Where(texture => texture != null).Select(GetTextureName)
            .ToHashSet(StringComparer.OrdinalIgnoreCase) ?? new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        cache[full] = names;
        return names;
    }
}
