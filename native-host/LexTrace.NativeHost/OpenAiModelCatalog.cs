using System.Globalization;
using System.Net;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace LexTrace.NativeHost;

internal sealed record OpenAiModelCatalogResult(string FetchedAt, IReadOnlyList<OpenAiModelCatalogItem> Models);

internal sealed record OpenAiModelCatalogItem(
    string Id,
    long? Created,
    string? OwnedBy,
    OpenAiModelPricing Pricing,
    string Family,
    OpenAiModelPricingMatch MatchedBy
);

internal sealed record OpenAiModelPricing(
    string SourceUrl,
    OpenAiModelPricingTier Standard,
    OpenAiModelPricingTier Flex,
    OpenAiModelPricingTier Priority
);

internal sealed record OpenAiModelPricingTier(
    string Tier,
    string? PricingModelId,
    decimal? InputUsdPer1M,
    decimal? CachedInputUsdPer1M,
    decimal? OutputUsdPer1M,
    decimal? TrainingUsdPer1M,
    decimal? TrainingUsdPerHour,
    decimal? SummaryUsdPer1M
);

internal sealed record OpenAiModelPricingMatch(
    string Standard,
    string Flex,
    string Priority
);

internal sealed record OpenAiApiModelInfo(string Id, long? Created, string? OwnedBy);

internal static class OpenAiModelCatalogBuilder
{
    private const string PricingSourceUrl = "https://developers.openai.com/api/docs/pricing";

    private static readonly Regex StandardPaneRegex = new(
        "data-content-switcher-pane=\"true\"[^>]*data-value=\"standard\"[^>]*>(?<content>.*?)(?=<div data-content-switcher-pane=\"true\"|<script>)",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex TableRegex = new(
        "<table\\b[^>]*>(?<content>.*?)</table>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex RowRegex = new(
        "<tr\\b[^>]*>(?<content>.*?)</tr>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex CellRegex = new(
        "<t[dh]\\b[^>]*>(?<content>.*?)</t[dh]>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex StripTagsRegex = new(
        "<[^>]+>",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex PropsBlockRegex = new(
        "component-export=\"TextTokenPricingTables\"[^>]*props=\"(?<props>.*?)\"",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex SerializedTokenRegex = new(
        "\\[0,(?<value>[^\\]]+)\\]",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex TierRegex = new(
        "\"tier\":\\[0,\"(?<tier>standard|flex|priority)\"\\]",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.Compiled
    );

    private static readonly Regex TrailingDateRegex = new(
        "-\\d{4}-\\d{2}-\\d{2}$",
        RegexOptions.Compiled
    );

    private static readonly Regex TrailingLegacyVersionRegex = new(
        "-\\d{4}$",
        RegexOptions.Compiled
    );

    public static OpenAiModelCatalogResult Build(
        IReadOnlyList<OpenAiApiModelInfo> models,
        string pricingHtml,
        DateTimeOffset fetchedAt
    )
    {
        var pricingLookup = ParsePricing(pricingHtml);
        var catalogItems = new List<OpenAiModelCatalogItem>();

        foreach (var model in models.Where(model => IsChatModelId(model.Id)).OrderBy(model => model.Id, StringComparer.OrdinalIgnoreCase))
        {
            var family = NormalizeFamily(model.Id);
            var resolvedPricing = ResolvePricing(pricingLookup, model.Id, family);

            catalogItems.Add(new OpenAiModelCatalogItem(
                model.Id,
                model.Created,
                model.OwnedBy,
                resolvedPricing.Pricing,
                family,
                resolvedPricing.Match
            ));
        }

        return new OpenAiModelCatalogResult(
            fetchedAt.ToString("O"),
            catalogItems
        );
    }

    public static IReadOnlyList<OpenAiApiModelInfo> ParseModelsJson(string json)
    {
        using var document = JsonDocument.Parse(json);
        if (!document.RootElement.TryGetProperty("data", out var dataElement) || dataElement.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        var models = new List<OpenAiApiModelInfo>();
        foreach (var item in dataElement.EnumerateArray())
        {
            var id = GetOptionalString(item, "id");
            if (string.IsNullOrWhiteSpace(id))
            {
                continue;
            }

            models.Add(new OpenAiApiModelInfo(
                id,
                item.TryGetProperty("created", out var createdElement) && createdElement.ValueKind == JsonValueKind.Number
                    ? createdElement.GetInt64()
                    : null,
                GetOptionalString(item, "owned_by")
            ));
        }

        return models;
    }

    private static Dictionary<string, OpenAiPricingAccumulator> ParsePricing(string html)
    {
        var pricingByModel = new Dictionary<string, OpenAiPricingAccumulator>(StringComparer.OrdinalIgnoreCase);
        foreach (Match paneMatch in StandardPaneRegex.Matches(html))
        {
            var paneContent = paneMatch.Groups["content"].Value;
            foreach (Match tableMatch in TableRegex.Matches(paneContent))
            {
                ParseStandardTable(tableMatch.Groups["content"].Value, pricingByModel);
            }
        }

        ParseEmbeddedPropsPricing(html, pricingByModel);
        return pricingByModel;
    }

    private static void ParseEmbeddedPropsPricing(string html, IDictionary<string, OpenAiPricingAccumulator> pricingByModel)
    {
        foreach (Match propsMatch in PropsBlockRegex.Matches(html))
        {
            var decodedProps = WebUtility.HtmlDecode(propsMatch.Groups["props"].Value);
            var tierMatch = TierRegex.Match(decodedProps);
            if (!tierMatch.Success)
            {
                continue;
            }

            var tier = tierMatch.Groups["tier"].Value.ToLowerInvariant();
            var rowChunks = decodedProps.Split("[1,[[0,\"", StringSplitOptions.None);
            foreach (var rowChunk in rowChunks.Skip(1))
            {
                var modelTerminator = rowChunk.IndexOf("\"],[", StringComparison.Ordinal);
                if (modelTerminator <= 0)
                {
                    continue;
                }

                var modelId = ExtractModelId(rowChunk[..modelTerminator]);
                if (string.IsNullOrWhiteSpace(modelId) || !IsChatModelId(modelId))
                {
                    continue;
                }

                var tokenMatches = SerializedTokenRegex.Matches(rowChunk);
                if (tokenMatches.Count < 3)
                {
                    continue;
                }

                var inputValue = ParseSerializedToken(tokenMatches[0].Groups["value"].Value);
                var cachedValue = ParseSerializedToken(tokenMatches[1].Groups["value"].Value);
                var outputValue = ParseSerializedToken(tokenMatches[2].Groups["value"].Value);

                MergeTierPricing(
                    pricingByModel,
                    modelId,
                    CreateTierPricing(
                        tier,
                        modelId,
                        inputValue,
                        cachedValue,
                        outputValue,
                        trainingUsdPer1M: null,
                        trainingUsdPerHour: null
                    )
                );
            }
        }
    }

    private static void ParseStandardTable(string tableHtml, IDictionary<string, OpenAiPricingAccumulator> pricingByModel)
    {
        var rows = RowRegex.Matches(tableHtml)
            .Select(match => ParseCells(match.Groups["content"].Value))
            .Where(cells => cells.Count > 0)
            .ToList();

        if (rows.Count < 2)
        {
            return;
        }

        var headerCells = rows.Take(2).SelectMany(row => row).ToList();
        var looksLikeLatestTable =
            headerCells.Contains("Model", StringComparer.OrdinalIgnoreCase) &&
            headerCells.Count(header => string.Equals(header, "Input", StringComparison.OrdinalIgnoreCase)) >= 2 &&
            headerCells.Count(header => string.Equals(header, "Output", StringComparison.OrdinalIgnoreCase)) >= 2;
        var looksLikeStandardTextTable =
            headerCells.Contains("Model", StringComparer.OrdinalIgnoreCase) &&
            headerCells.Contains("Training", StringComparer.OrdinalIgnoreCase) &&
            headerCells.Contains("Input", StringComparer.OrdinalIgnoreCase) &&
            headerCells.Contains("Output", StringComparer.OrdinalIgnoreCase);

        if (!looksLikeLatestTable && !looksLikeStandardTextTable)
        {
            return;
        }

        var headerRowCount = looksLikeLatestTable ? 2 : 1;
        foreach (var row in rows.Skip(headerRowCount))
        {
            if (row.Count < 4)
            {
                continue;
            }

            var rawModel = row[0];
            if (rawModel.Contains("with data sharing", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var modelId = ExtractModelId(rawModel);
            if (string.IsNullOrWhiteSpace(modelId) || !IsChatModelId(modelId))
            {
                continue;
            }

            OpenAiModelPricingTier pricing;
            if (looksLikeLatestTable && row.Count >= 7)
            {
                pricing = CreateTierPricing(
                    "standard",
                    modelId,
                    ParseDollarAmount(row[1]),
                    ParseDollarAmount(row[2]),
                    ParseDollarAmount(row[3]),
                    trainingUsdPer1M: null,
                    trainingUsdPerHour: null
                );
            }
            else if (looksLikeStandardTextTable && row.Count >= 5)
            {
                var trainingPrice = ParseDollarAmount(row[1]);
                pricing = CreateTierPricing(
                    "standard",
                    modelId,
                    ParseDollarAmount(row[2]),
                    ParseDollarAmount(row[3]),
                    ParseDollarAmount(row[4]),
                    trainingUsdPer1M: row[1].Contains("/ hour", StringComparison.OrdinalIgnoreCase) ? null : trainingPrice,
                    trainingUsdPerHour: row[1].Contains("/ hour", StringComparison.OrdinalIgnoreCase) ? trainingPrice : null
                );
            }
            else
            {
                continue;
            }

            MergeTierPricing(pricingByModel, modelId, pricing);
        }
    }

    private static ResolvedModelPricing ResolvePricing(
        IReadOnlyDictionary<string, OpenAiPricingAccumulator> pricingLookup,
        string modelId,
        string family
    )
    {
        var standard = ResolveTierPricing(pricingLookup, modelId, family, "standard");
        var flex = ResolveTierPricing(pricingLookup, modelId, family, "flex");
        var priority = ResolveTierPricing(pricingLookup, modelId, family, "priority");

        return new ResolvedModelPricing(
            new OpenAiModelPricing(
                PricingSourceUrl,
                standard.Pricing,
                flex.Pricing,
                priority.Pricing
            ),
            new OpenAiModelPricingMatch(
                standard.MatchedBy,
                flex.MatchedBy,
                priority.MatchedBy
            )
        );
    }

    private static ResolvedTierPricing ResolveTierPricing(
        IReadOnlyDictionary<string, OpenAiPricingAccumulator> pricingLookup,
        string modelId,
        string family,
        string tier
    )
    {
        if (pricingLookup.TryGetValue(modelId, out var exactAccumulator) &&
            GetTierPricing(exactAccumulator, tier) is { } exactPricing)
        {
            return new ResolvedTierPricing(exactPricing, "exact");
        }

        if (!string.Equals(modelId, family, StringComparison.OrdinalIgnoreCase) &&
            pricingLookup.TryGetValue(family, out var familyAccumulator) &&
            GetTierPricing(familyAccumulator, tier) is { } familyPricing)
        {
            return new ResolvedTierPricing(familyPricing, "family");
        }

        return new ResolvedTierPricing(CreateUnavailableTierPricing(tier), "unavailable");
    }

    private static OpenAiModelPricingTier? GetTierPricing(OpenAiPricingAccumulator accumulator, string tier) =>
        tier switch
        {
            "standard" => accumulator.Standard,
            "flex" => accumulator.Flex,
            "priority" => accumulator.Priority,
            _ => null
        };

    private static void MergeTierPricing(
        IDictionary<string, OpenAiPricingAccumulator> pricingByModel,
        string modelId,
        OpenAiModelPricingTier pricing
    )
    {
        if (!pricingByModel.TryGetValue(modelId, out var accumulator))
        {
            accumulator = new OpenAiPricingAccumulator();
            pricingByModel[modelId] = accumulator;
        }

        switch (pricing.Tier)
        {
            case "standard":
                accumulator.Standard = MergeTier(accumulator.Standard, pricing);
                break;
            case "flex":
                accumulator.Flex = MergeTier(accumulator.Flex, pricing);
                break;
            case "priority":
                accumulator.Priority = MergeTier(accumulator.Priority, pricing);
                break;
        }
    }

    private static OpenAiModelPricingTier MergeTier(OpenAiModelPricingTier? existing, OpenAiModelPricingTier next)
    {
        if (existing is null)
        {
            return next;
        }

        return existing with
        {
            InputUsdPer1M = existing.InputUsdPer1M ?? next.InputUsdPer1M,
            CachedInputUsdPer1M = existing.CachedInputUsdPer1M ?? next.CachedInputUsdPer1M,
            OutputUsdPer1M = existing.OutputUsdPer1M ?? next.OutputUsdPer1M,
            TrainingUsdPer1M = existing.TrainingUsdPer1M ?? next.TrainingUsdPer1M,
            TrainingUsdPerHour = existing.TrainingUsdPerHour ?? next.TrainingUsdPerHour,
            SummaryUsdPer1M = existing.SummaryUsdPer1M ?? next.SummaryUsdPer1M
        };
    }

    private static OpenAiModelPricingTier CreateTierPricing(
        string tier,
        string? pricingModelId,
        decimal? inputUsdPer1M,
        decimal? cachedInputUsdPer1M,
        decimal? outputUsdPer1M,
        decimal? trainingUsdPer1M,
        decimal? trainingUsdPerHour
    ) =>
        new(
            Tier: tier,
            PricingModelId: pricingModelId,
            InputUsdPer1M: inputUsdPer1M,
            CachedInputUsdPer1M: cachedInputUsdPer1M,
            OutputUsdPer1M: outputUsdPer1M,
            TrainingUsdPer1M: trainingUsdPer1M,
            TrainingUsdPerHour: trainingUsdPerHour,
            SummaryUsdPer1M: SumPrices(inputUsdPer1M, outputUsdPer1M)
        );

    private static OpenAiModelPricingTier CreateUnavailableTierPricing(string tier) =>
        new(
            Tier: tier,
            PricingModelId: null,
            InputUsdPer1M: null,
            CachedInputUsdPer1M: null,
            OutputUsdPer1M: null,
            TrainingUsdPer1M: null,
            TrainingUsdPerHour: null,
            SummaryUsdPer1M: null
        );

    private static List<string> ParseCells(string rowHtml) =>
        CellRegex.Matches(rowHtml)
            .Select(match => NormalizeCellText(match.Groups["content"].Value))
            .Where(cell => !string.IsNullOrWhiteSpace(cell))
            .ToList();

    private static string NormalizeCellText(string html)
    {
        var withoutBreaks = html.Replace("<br/>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("<br>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("</p>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("</span>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("</small>", " ", StringComparison.OrdinalIgnoreCase)
            .Replace("</li>", " ", StringComparison.OrdinalIgnoreCase);
        var stripped = StripTagsRegex.Replace(withoutBreaks, " ");
        var decoded = WebUtility.HtmlDecode(stripped)
            .Replace('\u00A0', ' ')
            .Trim();
        return Regex.Replace(decoded, "\\s+", " ").Trim();
    }

    private static string ExtractModelId(string cellText)
    {
        var normalized = cellText.Split('(', 2)[0].Trim();
        if (string.IsNullOrWhiteSpace(normalized))
        {
            return string.Empty;
        }

        return normalized;
    }

    private static decimal? ParseDollarAmount(string rawValue)
    {
        var trimmed = rawValue.Trim();
        if (trimmed.Length == 0 || trimmed == "-" || trimmed == "/" || !trimmed.StartsWith('$'))
        {
            return null;
        }

        var numeric = trimmed[1..]
            .Split(' ', 2)[0]
            .Replace(",", string.Empty, StringComparison.Ordinal);

        return decimal.TryParse(
            numeric,
            NumberStyles.AllowDecimalPoint,
            CultureInfo.InvariantCulture,
            out var parsedValue
        )
            ? parsedValue
            : null;
    }

    private static decimal? ParseSerializedToken(string rawValue)
    {
        var trimmed = rawValue.Trim().Trim('"');
        if (trimmed.Length == 0 || trimmed is "-" or "/" or "null")
        {
            return null;
        }

        return decimal.TryParse(
            trimmed,
            NumberStyles.AllowDecimalPoint,
            CultureInfo.InvariantCulture,
            out var parsedValue
        )
            ? parsedValue
            : null;
    }

    private static decimal? SumPrices(decimal? left, decimal? right) =>
        left is not null && right is not null ? left.Value + right.Value : null;

    private static bool IsChatModelId(string modelId)
    {
        var normalized = modelId.Trim().ToLowerInvariant();
        var isTextFamily =
            normalized.StartsWith("gpt-", StringComparison.Ordinal) ||
            normalized.StartsWith("o1", StringComparison.Ordinal) ||
            normalized.StartsWith("o3", StringComparison.Ordinal) ||
            normalized.StartsWith("o4", StringComparison.Ordinal) ||
            normalized is "davinci-002" or "babbage-002";

        if (!isTextFamily)
        {
            return false;
        }

        string[] excludedFragments =
        [
            "audio",
            "realtime",
            "transcribe",
            "tts",
            "image",
            "search",
            "embedding",
            "moderation",
            "whisper",
            "dall-e",
            "sora",
            "codex",
            "deep-research"
        ];

        return excludedFragments.All(fragment => !normalized.Contains(fragment, StringComparison.Ordinal));
    }

    private static string NormalizeFamily(string modelId)
    {
        var family = TrailingDateRegex.Replace(modelId, string.Empty);
        family = TrailingLegacyVersionRegex.Replace(family, string.Empty);

        if (family.EndsWith("-chat-latest", StringComparison.OrdinalIgnoreCase))
        {
            family = family[..^"-chat-latest".Length];
        }

        return family;
    }

    private static string? GetOptionalString(JsonElement payload, string propertyName)
    {
        if (payload.ValueKind == JsonValueKind.Object &&
            payload.TryGetProperty(propertyName, out var property) &&
            property.ValueKind == JsonValueKind.String)
        {
            return property.GetString();
        }

        return null;
    }

    private sealed class OpenAiPricingAccumulator
    {
        public OpenAiModelPricingTier? Standard { get; set; }

        public OpenAiModelPricingTier? Flex { get; set; }

        public OpenAiModelPricingTier? Priority { get; set; }
    }

    private sealed record ResolvedTierPricing(OpenAiModelPricingTier Pricing, string MatchedBy);

    private sealed record ResolvedModelPricing(OpenAiModelPricing Pricing, OpenAiModelPricingMatch Match);
}
