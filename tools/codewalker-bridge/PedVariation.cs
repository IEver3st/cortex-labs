using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Xml;
using CodeWalker.GameFiles;

namespace CodeWalkerBridge;

// A clothing pack's ped variation file (`<ped>_<dlc>.ymt`, CPedVariationInfo)
// as CodeWalker's XML, which the app reads and edits (src/lib/
// ped-variation-xml.js). The write builds the binary file from that XML into
// `output` and reads it back; the app puts it in place after a backup, as it
// does with texture dictionaries. The input file is only read.
public static partial class Program
{
    private const int MetaResourceVersion = 2;
    private const long MaxPedVariationBytes = 16 * 1024 * 1024;
    private const int MaxPedVariationXmlChars = 32 * 1024 * 1024;

    // Hash fields: MetaXml prints a name it knows and hash_XXXXXXXX otherwise,
    // so a read-back is compared by hash value.
    private static readonly Regex HashField = new(@"<(dlcName|pedXml_audioID|pedXml_audioID2|audioId)>([^<]*)</\1>", RegexOptions.Compiled);

    private static object ReadPedVariation(string path)
    {
        var fileName = Path.GetFileName(path);
        if (!File.Exists(path)) throw new BridgeException($"Ped variation file not found: {path}");
        if (new FileInfo(path).Length > MaxPedVariationBytes) throw new BridgeException($"{fileName} is too large to be a ped variation file.");
        var data = File.ReadAllBytes(path);
        // Escrow-encrypted and Enhanced files have other headers; they are never decrypted.
        if (data.Length < 16 || BitConverter.ToUInt32(data, 0) != ResourceMagic || BitConverter.ToInt32(data, 4) != MetaResourceVersion)
        {
            throw new BridgeException($"{fileName} is not a legacy GTA V metadata file, so Cortex cannot read it.");
        }
        var ymt = new YmtFile();
        try
        {
            ymt.Load(data);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Failed to read {fileName}: {ShortReason(ex)}");
        }
        if (ymt.Meta == null) throw new BridgeException($"{fileName} is not stored in the format Cortex reads.");
        string xml;
        try
        {
            xml = MetaXml.GetXml(ymt, out _);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"Failed to read {fileName}: {ShortReason(ex)}");
        }
        if (!xml.Contains("<CPedVariationInfo", StringComparison.Ordinal))
        {
            throw new BridgeException($"{fileName} is not a ped variation file.");
        }
        return new { path, xml };
    }

    private static object WritePedVariation(JsonElement request) =>
        WriteMetaResource(request, "CPedVariationInfo", "a ped variation file", "The ped variation XML is too large.");

    private static object WriteCreatureMetadata(JsonElement request) =>
        WriteMetaResource(request, "CCreatureMetaData", "creature metadata", "The creature metadata XML is too large.");

    private static object WriteMetaResource(JsonElement request, string root, string kind, string tooLarge)
    {
        var xml = RequireString(request, "xml");
        var output = RequireString(request, "output");
        if (xml.Length > MaxPedVariationXmlChars) throw new BridgeException(tooLarge);
        var fileName = Path.GetFileName(output);

        var document = new XmlDocument { XmlResolver = null };
        try
        {
            using var reader = XmlReader.Create(new StringReader(xml), new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null });
            document.Load(reader);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"The XML for {fileName} is not valid: {ShortReason(ex)}");
        }
        if (document.DocumentElement?.Name != root) throw new BridgeException($"The XML for {fileName} is not {kind}.");

        byte[] data;
        try
        {
            data = ResourceBuilder.Build(XmlMeta.GetMeta(document), MetaResourceVersion);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"{fileName} could not be built: {ShortReason(ex)}");
        }

        // Read the result back: a file that does not load, or reads back
        // other than what was asked for, never replaces the user's.
        string readBack;
        try
        {
            var check = new YmtFile();
            check.Load(data);
            readBack = MetaXml.GetXml(check, out _);
        }
        catch (Exception ex)
        {
            throw new BridgeException($"The rebuilt {fileName} does not read back: {ShortReason(ex)}");
        }
        var expected = ComparableMetaXml(xml);
        var actual = ComparableMetaXml(readBack);
        if (!string.Equals(expected, actual, StringComparison.Ordinal))
        {
            var wanted = expected.Split('\n');
            var got = actual.Split('\n');
            var line = Enumerable.Range(0, Math.Max(wanted.Length, got.Length))
                .FirstOrDefault(index => index >= wanted.Length || index >= got.Length || wanted[index] != got[index]);
            throw new BridgeException($"The rebuilt {fileName} reads back differently at line {line + 1}, so it is not written.");
        }

        var outputDir = Path.GetDirectoryName(Path.GetFullPath(output));
        if (!string.IsNullOrEmpty(outputDir)) Directory.CreateDirectory(outputDir);
        File.WriteAllBytes(output, data);
        return new { output, size = data.Length };
    }

    // The XML with line endings, the declaration and hash spellings made uniform.
    private static string ComparableMetaXml(string xml)
    {
        var lines = xml.Replace("\r\n", "\n").Trim().Split('\n')
            .Select(line => line.TrimEnd())
            .Where(line => !line.StartsWith("<?xml", StringComparison.Ordinal));
        var text = string.Join("\n", lines);
        return HashField.Replace(text, match =>
        {
            var value = match.Groups[2].Value.Trim();
            var hash = value.StartsWith("hash_", StringComparison.Ordinal)
                ? Convert.ToUInt32(value.Substring(5), 16)
                : JenkHash.GenHash(value);
            return $"<{match.Groups[1].Value}>hash_{hash:X8}</{match.Groups[1].Value}>";
        });
    }
}
