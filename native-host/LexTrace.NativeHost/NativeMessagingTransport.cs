using System.Text.Json;

namespace LexTrace.NativeHost;

internal sealed class NativeMessagingTransport : INativeMessagingTransport
{
    private readonly Stream _input = Console.OpenStandardInput();
    private readonly Stream _output = Console.OpenStandardOutput();
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private readonly JsonSerializerOptions _serializerOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase
    };

    public async Task<JsonDocument?> ReadAsync(CancellationToken cancellationToken)
    {
        var header = new byte[4];
        var headerBytesRead = await ReadExactOrEofAsync(header, cancellationToken);
        if (headerBytesRead == 0)
        {
            return null;
        }

        if (headerBytesRead < header.Length)
        {
            throw new InvalidDataException("Unexpected EOF while reading native message header.");
        }

        var messageLength = BitConverter.ToInt32(header, 0);
        if (messageLength <= 0)
        {
            throw new InvalidDataException($"Invalid native message length: {messageLength}");
        }

        var messageBuffer = new byte[messageLength];
        await ReadExactlyAsync(messageBuffer, cancellationToken);
        return JsonDocument.Parse(messageBuffer);
    }

    public async Task SendAsync(object payload, CancellationToken cancellationToken)
    {
        var body = JsonSerializer.SerializeToUtf8Bytes(payload, _serializerOptions);
        var header = BitConverter.GetBytes(body.Length);

        await _writeLock.WaitAsync(cancellationToken);
        try
        {
            await _output.WriteAsync(header, cancellationToken);
            await _output.WriteAsync(body, cancellationToken);
            await _output.FlushAsync(cancellationToken);
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private async Task<int> ReadExactOrEofAsync(byte[] buffer, CancellationToken cancellationToken)
    {
        var totalRead = 0;
        while (totalRead < buffer.Length)
        {
            var bytesRead = await _input.ReadAsync(
                buffer.AsMemory(totalRead, buffer.Length - totalRead),
                cancellationToken
            );

            if (bytesRead == 0)
            {
                return totalRead;
            }

            totalRead += bytesRead;
        }

        return totalRead;
    }

    private async Task ReadExactlyAsync(byte[] buffer, CancellationToken cancellationToken)
    {
        var totalRead = 0;
        while (totalRead < buffer.Length)
        {
            var bytesRead = await _input.ReadAsync(
                buffer.AsMemory(totalRead, buffer.Length - totalRead),
                cancellationToken
            );

            if (bytesRead == 0)
            {
                throw new EndOfStreamException("Unexpected EOF while reading native message body.");
            }

            totalRead += bytesRead;
        }
    }
}

