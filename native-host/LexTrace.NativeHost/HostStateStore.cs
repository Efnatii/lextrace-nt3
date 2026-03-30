using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class HostStateStore : IHostStateStore
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
        var stateDirectory = Path.GetDirectoryName(_stateFilePath)
            ?? throw new InvalidOperationException("Native host state directory is unavailable.");
        var tempFilePath = Path.Combine(
            stateDirectory,
            $"{Path.GetFileName(_stateFilePath)}.{Environment.ProcessId}.{Guid.NewGuid():N}.tmp");

        await using (var stream = File.Create(tempFilePath))
        {
            await JsonSerializer.SerializeAsync(stream, journal, _serializerOptions, cancellationToken);
        }

        try
        {
            File.Move(tempFilePath, _stateFilePath, overwrite: true);
        }
        finally
        {
            if (File.Exists(tempFilePath))
            {
                File.Delete(tempFilePath);
            }
        }
    }
}

