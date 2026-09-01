// weave-audio-capture — capture ONE process's audio, not the whole desktop mix.
//
// The problem this exists for: a screen share captures Electron's `audio: 'loopback'`, which
// is the system's entire output mix. That mix contains Weave's own playback — the call — so a
// viewer hears their own voice returned through the streamer's share. Routing playback to
// another device only helps if the streamer HAS another device; the real fix is to capture the
// shared program's audio directly.
//
// Windows exposes exactly that: WASAPI "process loopback" (ActivateAudioInterfaceAsync with
// AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, Windows 10 build 19041+). Given a process id it
// captures either that process tree's audio (INCLUDE) or everything EXCEPT it (EXCLUDE — which,
// pointed at Weave's own pid, is "the desktop minus the call").
//
// This is a standalone sidecar on purpose: no Node/Electron ABI coupling, no node-gyp, no
// electron-rebuild. Electron spawns it and reads PCM from stdout. It is also directly testable —
// `--wav out.wav --seconds 5` writes a file so the capture can be proven in isolation before any
// of the streaming plumbing exists.
//
//   weave-audio-capture --include <pid> [--wav <path> --seconds <n>]
//   weave-audio-capture --exclude <pid> [...]
//
// Format is fixed at 48 kHz / 2ch / 32-bit float — what Web Audio wants, so the renderer feeds
// it straight into an AudioWorklet with no resampling. Raw interleaved float32 goes to stdout in
// streaming mode; a WAV (IEEE float) in --wav mode.

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <wrl/implements.h>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <string>
#include <io.h>
#include <fcntl.h>

using namespace Microsoft::WRL;

// Defined by the SDK in newer headers; declare it if the toolchain's headers are older, so the
// build does not depend on which SDK revision is installed.
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

static const int kSampleRate = 48000;
static const int kChannels = 2;
static const int kBytesPerSample = 4; // float32
static const int kBlockAlign = kChannels * kBytesPerSample;

static void logline(const char* fmt, ...) {
    va_list ap; va_start(ap, fmt);
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    fflush(stderr);
}

// The activation is asynchronous COM; this handler is signalled when the IAudioClient is ready.
class ActivateHandler
    : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
public:
    HANDLE done = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    ComPtr<IAudioClient> client;

    STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
        ComPtr<IUnknown> unk;
        HRESULT hr = op->GetActivateResult(&result, &unk);
        if (SUCCEEDED(hr) && SUCCEEDED(result)) unk.As(&client);
        else if (SUCCEEDED(hr)) hr = result;
        if (FAILED(hr) && SUCCEEDED(result)) result = hr;
        SetEvent(done);
        return S_OK;
    }
};

// A minimal WAV (IEEE float) header. Sizes are patched in once the total is known.
#pragma pack(push, 1)
struct WavHeader {
    char riff[4] = { 'R','I','F','F' };
    uint32_t riffSize = 0;
    char wave[4] = { 'W','A','V','E' };
    char fmt_[4] = { 'f','m','t',' ' };
    uint32_t fmtSize = 16;
    uint16_t audioFormat = 3; // IEEE float
    uint16_t channels = kChannels;
    uint32_t sampleRate = kSampleRate;
    uint32_t byteRate = kSampleRate * kBlockAlign;
    uint16_t blockAlign = kBlockAlign;
    uint16_t bitsPerSample = 32;
    char data[4] = { 'd','a','t','a' };
    uint32_t dataSize = 0;
};
#pragma pack(pop)

int wmain(int argc, wchar_t** argv) {
    DWORD targetPid = 0;
    PROCESS_LOOPBACK_MODE mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    bool haveTarget = false;
    std::wstring wavPath;
    double seconds = 0.0; // 0 = run until stdin closes (streaming mode)

    for (int i = 1; i < argc; i++) {
        std::wstring a = argv[i];
        auto next = [&](DWORD def) -> std::wstring { return (i + 1 < argc) ? argv[++i] : std::wstring(); };
        if (a == L"--include") { targetPid = _wtoi(next(0).c_str()); mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE; haveTarget = true; }
        else if (a == L"--exclude") { targetPid = _wtoi(next(0).c_str()); mode = PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE; haveTarget = true; }
        else if (a == L"--include-hwnd") {
            // A shared WINDOW is identified by its handle; resolve the owning process here so
            // the caller (Electron, which has no native calls) does not have to. The tree is
            // captured, so a game whose audio lives in a child process is still covered.
            HWND h = reinterpret_cast<HWND>(static_cast<uintptr_t>(_wcstoui64(next(0).c_str(), nullptr, 0)));
            DWORD pid = 0;
            if (h) GetWindowThreadProcessId(h, &pid);
            targetPid = pid; mode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE; haveTarget = (pid != 0);
            if (pid == 0) logline("could not resolve a process from window handle");
        }
        else if (a == L"--wav") { wavPath = next(0); }
        else if (a == L"--seconds") { seconds = _wtof(next(0).c_str()); }
    }
    if (!haveTarget) {
        logline("usage: weave-audio-capture --include|--exclude <pid> [--wav <path>] [--seconds <n>]");
        return 2;
    }

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { logline("CoInitializeEx failed: 0x%08X", hr); return 1; }

    // Process-loopback activation carries its target and mode in a BLOB PROPVARIANT.
    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize = sizeof(params);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ComPtr<ActivateHandler> handler = Make<ActivateHandler>();
    ComPtr<IActivateAudioInterfaceAsyncOperation> op;
    hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &pv, handler.Get(), &op);
    if (FAILED(hr)) { logline("ActivateAudioInterfaceAsync failed: 0x%08X", hr); return 1; }
    WaitForSingleObject(handler->done, INFINITE);
    if (FAILED(handler->result) || !handler->client) { logline("process-loopback activation failed: 0x%08X", handler->result); return 1; }

    ComPtr<IAudioClient> audioClient = handler->client;

    // We DICTATE the format for process loopback (there is no endpoint mix format to query).
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels = kChannels;
    fmt.nSamplesPerSec = kSampleRate;
    fmt.wBitsPerSample = 32;
    fmt.nBlockAlign = kBlockAlign;
    fmt.nAvgBytesPerSec = kSampleRate * kBlockAlign;
    fmt.cbSize = 0;

    // Event-driven shared-mode loopback. 20 ms buffer is a steady, low-latency period.
    const REFERENCE_TIME bufferDuration = 200000; // 20 ms in 100-ns units
    hr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration, 0, &fmt, nullptr);
    if (FAILED(hr)) { logline("IAudioClient::Initialize failed: 0x%08X", hr); return 1; }

    HANDLE sampleReady = CreateEvent(nullptr, FALSE, FALSE, nullptr);
    hr = audioClient->SetEventHandle(sampleReady);
    if (FAILED(hr)) { logline("SetEventHandle failed: 0x%08X", hr); return 1; }

    ComPtr<IAudioCaptureClient> capture;
    hr = audioClient->GetService(__uuidof(IAudioCaptureClient), &capture);
    if (FAILED(hr)) { logline("GetService(IAudioCaptureClient) failed: 0x%08X", hr); return 1; }

    // Where the PCM goes: a WAV file for a test, or stdout for streaming.
    FILE* out = nullptr;
    bool toWav = !wavPath.empty();
    WavHeader wav;
    uint64_t bytesWritten = 0;
    if (toWav) {
        out = _wfopen(wavPath.c_str(), L"wb");
        if (!out) { logline("could not open wav: %ls", wavPath.c_str()); return 1; }
        fwrite(&wav, sizeof(wav), 1, out); // placeholder; patched at the end
    } else {
        _setmode(_fileno(stdout), _O_BINARY); // no CRLF translation on binary PCM
        out = stdout;
    }

    hr = audioClient->Start();
    if (FAILED(hr)) { logline("IAudioClient::Start failed: 0x%08X", hr); return 1; }
    logline("capturing pid=%lu mode=%s fmt=48000/2/f32 -> %s",
        targetPid, mode == PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE ? "include" : "exclude",
        toWav ? "wav" : "stdout");

    ULONGLONG startTick = GetTickCount64();
    // In streaming mode the parent (Electron) stops us by closing our stdin; poll it so a killed
    // parent does not leave an orphan capturing forever.
    HANDLE hStdin = GetStdHandle(STD_INPUT_HANDLE);

    for (;;) {
        DWORD wait = WaitForSingleObject(sampleReady, 200);
        // Drain every packet currently available.
        UINT32 packet = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&packet)) && packet > 0) {
            BYTE* data = nullptr;
            UINT32 frames = 0;
            DWORD flags = 0;
            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) { logline("GetBuffer failed: 0x%08X", hr); goto stop; }
            const UINT32 bytes = frames * kBlockAlign;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Silence is delivered as a flag with no real data; emit zeros so the timeline
                // and the downstream buffer stay continuous.
                static BYTE zero[9600];
                UINT32 left = bytes;
                while (left > 0) {
                    UINT32 chunk = left < sizeof(zero) ? left : sizeof(zero);
                    fwrite(zero, 1, chunk, out); left -= chunk;
                }
            } else if (data && bytes) {
                fwrite(data, 1, bytes, out);
            }
            bytesWritten += bytes;
            capture->ReleaseBuffer(frames);
        }
        if (!toWav) fflush(out);

        if (seconds > 0.0 && (GetTickCount64() - startTick) >= (ULONGLONG)(seconds * 1000)) break;
        if (!toWav && seconds <= 0.0) {
            // Streaming: has the parent gone? A closed stdin peeks as a broken pipe / EOF.
            DWORD avail = 0;
            if (!PeekNamedPipe(hStdin, nullptr, 0, nullptr, &avail, nullptr) && GetLastError() == ERROR_BROKEN_PIPE) break;
        }
        (void)wait;
    }
stop:
    audioClient->Stop();

    if (toWav && out) {
        wav.dataSize = (uint32_t)bytesWritten;
        wav.riffSize = (uint32_t)(bytesWritten + sizeof(WavHeader) - 8);
        fseek(out, 0, SEEK_SET);
        fwrite(&wav, sizeof(wav), 1, out);
        fclose(out);
    }
    logline("done: %llu bytes (%.2f s of audio)", (unsigned long long)bytesWritten,
        (double)bytesWritten / (kSampleRate * kBlockAlign));
    CoUninitialize();
    return 0;
}
