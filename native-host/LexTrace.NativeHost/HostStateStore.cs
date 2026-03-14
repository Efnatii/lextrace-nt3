using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class HostStateStore
{
    private readonly string _stateFilePath;
    private readonly JsonSerializerOptions _serializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    public HostStateStore()
    {
        var stateDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "LexTraceNt3"
        );

        Directory.CreateDirectory(stateDirectory);
        _stateFilePath = Path.Combine(stateDirectory, "native-host-state.json");
    }

    public async Task<HostJournal> LoadAsync(CancellationToken cancellationToken)
    {
        if (!File.Exists(_stateFilePath))
        {
            return new HostJournal();
        }

        try
        {
            await using var stream = File.OpenRead(_stateFilePath);
            return await JsonSerializer.DeserializeAsync<HostJournal>(stream, _serializerOptions, cancellationToken)
                ?? new HostJournal();
        }
        catch
        {
            var corruptPath = $"{_stateFilePath}.corrupt-{DateTimeOffset.UtcNow:yyyyMMddHHmmss}";
            File.Move(_stateFilePath, corruptPath, overwrite: true);
            return new HostJournal();
        }
    }

    public async Task SaveAsync(HostJournal journal, CancellationToken cancellationToken)
    {
        var tempFilePath = $"{_stateFilePath}.tmp";
        await using (var stream = File.Create(tempFilePath))
        {
            await JsonSerializer.SerializeAsync(stream, journal, _serializerOptions, cancellationToken);
        }

        File.Move(tempFilePath, _stateFilePath, overwrite: true);
    }
}

