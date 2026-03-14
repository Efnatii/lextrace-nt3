using System.Text.Json;

namespace LexTrace.NativeHost;

internal static class Program
{
    private static async Task<int> Main()
    {
        using var cts = new CancellationTokenSource();
        Console.CancelKeyPress += (_, eventArgs) =>
        {
            eventArgs.Cancel = true;
            cts.Cancel();
        };

        var transport = new NativeMessagingTransport();
        var stateStore = new HostStateStore();
        var runtime = new RuntimeEngine(transport, stateStore);

        try
        {
            await runtime.InitializeAsync(cts.Token);

            while (!cts.IsCancellationRequested)
            {
                using var document = await transport.ReadAsync(cts.Token);
                if (document is null)
                {
                    break;
                }

                ProtocolEnvelope envelope;
                try
                {
                    envelope = ParseEnvelope(document.RootElement);
                }
                catch (Exception error)
                {
                    await transport.SendAsync(
                        new ProtocolResponse(
                            Id: Guid.NewGuid().ToString("D"),
                            Ok: false,
                            Result: null,
                            Error: new ProtocolError("invalid_envelope", error.Message, null),
                            Ts: DateTimeOffset.UtcNow.ToString("O")
                        ),
                        cts.Token
                    );
                    continue;
                }

                try
                {
                    var result = await runtime.HandleCommandAsync(envelope, cts.Token);
                    await transport.SendAsync(
                        new ProtocolResponse(
                            envelope.Id,
                            Ok: true,
                            Result: result,
                            Error: null,
                            Ts: DateTimeOffset.UtcNow.ToString("O")
                        ),
                        cts.Token
                    );
                }
                catch (Exception error)
                {
                    await transport.SendAsync(
                        new ProtocolResponse(
                            envelope.Id,
                            Ok: false,
                            Result: null,
                            Error: new ProtocolError(
                                "native_host_error",
                                error.Message,
                                new
                                {
                                    error.StackTrace
                                }
                            ),
                            Ts: DateTimeOffset.UtcNow.ToString("O")
                        ),
                        cts.Token
                    );
                }
            }

            await runtime.ShutdownAsync(CancellationToken.None);
            return 0;
        }
        catch (OperationCanceledException)
        {
            await runtime.ShutdownAsync(CancellationToken.None);
            return 0;
        }
        catch (Exception error)
        {
            try
            {
                await transport.SendAsync(
                    new ProtocolResponse(
                        Guid.NewGuid().ToString("D"),
                        Ok: false,
                        Result: null,
                        Error: new ProtocolError(
                            "fatal_native_host_error",
                            error.Message,
                            new
                            {
                                error.StackTrace
                            }
                        ),
                        Ts: DateTimeOffset.UtcNow.ToString("O")
                    ),
                    CancellationToken.None
                );
            }
            catch
            {
                // Ignore final write errors.
            }

            return 1;
        }
    }

    private static ProtocolEnvelope ParseEnvelope(JsonElement root)
    {
        if (root.ValueKind != JsonValueKind.Object)
        {
            throw new InvalidDataException("Native message root must be a JSON object.");
        }

        return new ProtocolEnvelope(
            Id: GetRequiredString(root, "id"),
            Version: GetRequiredInt(root, "version"),
            Scope: GetRequiredString(root, "scope"),
            Action: GetRequiredString(root, "action"),
            Source: GetRequiredString(root, "source"),
            Target: GetRequiredString(root, "target"),
            Ts: GetOptionalDateTimeOffset(root, "ts") ?? DateTimeOffset.UtcNow,
            Payload: GetOptionalPayload(root, "payload"),
            CorrelationId: GetOptionalString(root, "correlationId")
        );
    }

    private static string GetRequiredString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            throw new InvalidDataException($"Missing string property '{propertyName}'.");
        }

        return property.GetString() ?? throw new InvalidDataException($"Property '{propertyName}' is null.");
    }

    private static string? GetOptionalString(JsonElement element, string propertyName)
    {
        return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
    }

    private static int GetRequiredInt(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Number)
        {
            throw new InvalidDataException($"Missing numeric property '{propertyName}'.");
        }

        return property.GetInt32();
    }

    private static DateTimeOffset? GetOptionalDateTimeOffset(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.String)
        {
            return null;
        }

        return DateTimeOffset.TryParse(property.GetString(), out var parsedValue)
            ? parsedValue
            : null;
    }

    private static JsonElement GetOptionalPayload(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out var property))
        {
            return default;
        }

        return property.Clone();
    }
}
