using System.Net;
using System.Text;
using Xunit;

namespace LexTrace.NativeHost.Tests;

public sealed class OpenAiCatalogFallbackTests
{
    [Fact]
    public async Task ListChatModelsAsync_FallsBackToPricingCatalog_WhenRegionIsUnsupported()
    {
        var previousApiKey = Environment.GetEnvironmentVariable(OpenAiClient.ApiKeyEnvironmentVariableName, EnvironmentVariableTarget.Process);
        Environment.SetEnvironmentVariable(OpenAiClient.ApiKeyEnvironmentVariableName, "sk-test", EnvironmentVariableTarget.Process);

        try
        {
            using var httpClient = new HttpClient(new StubHandler());
            var client = new OpenAiClient(httpClient);

            var catalog = await client.ListChatModelsAsync(CancellationToken.None);

            Assert.NotEmpty(catalog.Models);
            Assert.Contains(catalog.Models, model => model.Id == "gpt-5-mini");
            Assert.Equal(
                "Каталог открыт из локального fallback по прайс-листу: OpenAI API недоступен для текущей страны, региона или территории.",
                catalog.Warning
            );
        }
        finally
        {
            Environment.SetEnvironmentVariable(OpenAiClient.ApiKeyEnvironmentVariableName, previousApiKey, EnvironmentVariableTarget.Process);
        }
    }

    private sealed class StubHandler : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            if (request.RequestUri?.AbsoluteUri == "https://api.openai.com/v1/models")
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden)
                {
                    Content = new StringContent(
                        "{\"error\":{\"code\":\"unsupported_country_region_territory\",\"message\":\"Country, region, or territory not supported\",\"param\":null,\"type\":\"request_forbidden\"}}",
                        Encoding.UTF8,
                        "application/json"
                    )
                });
            }

            if (request.RequestUri?.AbsoluteUri == "https://developers.openai.com/api/docs/pricing")
            {
                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        """
                        <div data-content-switcher-pane="true" data-value="standard">
                          <table>
                            <tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
                            <tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
                            <tr><td>gpt-5-mini</td><td>$0.25 / 1M</td><td>$0.025 / 1M</td><td>$2 / 1M</td><td>$0.125 / 1M</td><td>$0.0125 / 1M</td><td>$1 / 1M</td></tr>
                            <tr><td>gpt-4.1</td><td>$2 / 1M</td><td>$0.5 / 1M</td><td>$8 / 1M</td><td>$1 / 1M</td><td>$0.25 / 1M</td><td>$4 / 1M</td></tr>
                          </table>
                        </div>
                        """,
                        Encoding.UTF8,
                        "text/html"
                    )
                });
            }

            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.NotFound)
            {
                Content = new StringContent("not found", Encoding.UTF8, "text/plain")
            });
        }
    }
}
