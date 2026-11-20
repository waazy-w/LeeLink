/* Lee Link — minimal single-threaded melonDS frontend for WebAssembly.
 *
 * Our own frontend around melonDS's core (GPL-3.0). JavaScript drives the frame
 * loop; there is no Qt/SDL, no pthreads and no cross-origin-isolation requirement.
 * Boots with melonDS's FreeBIOS + generated firmware via direct boot, so no
 * BIOS/firmware dumps are needed. Main RAM is exposed as a raw pointer so JS can
 * build zero-copy views into it for auto-tracking.
 *
 * Exported API mirrors cores/mgba/leelink_mgba.c (ll_* names).
 */
#include "NDS.h"
#include "NDSCart.h"
#include "GPU.h"
#include "GPU_Soft.h"
#include "SPU.h"
#include "RTC.h"
#include "Savestate.h"
#include "Platform.h"
#include "Args.h"

#include <emscripten/emscripten.h>
#include <chrono>
#include <cstdarg>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <memory>
#include <new>

using namespace melonDS;

#define EXPORT extern "C" EMSCRIPTEN_KEEPALIVE

static constexpr int SCREEN_W = 256;
static constexpr int SCREEN_H = 192;
static constexpr int AUDIO_CAPACITY = 4096; /* stereo frames per drain */

enum {
	LL_PLATFORM_NONE = 0,
	LL_PLATFORM_NDS = 3,
};

/* Memory region ids (JS mirrors these). */
enum {
	LL_REGION_MAIN_RAM = 0,    /* 0x02000000, 4 MiB */
	LL_REGION_SHARED_WRAM = 1, /* 0x03000000, 32 KiB */
	LL_REGION_SAVE = 2,        /* cartridge save memory */
	LL_REGION_ROM = 3,         /* cartridge ROM image */
	LL_REGION_ARM7_WRAM = 4,   /* ARM7 private WRAM, 64 KiB */
};

static NDS* nds = nullptr;
static u32 videoOut[SCREEN_W * SCREEN_H * 2]; /* RGBA8888, top screen then bottom */
static s16 audioOut[AUDIO_CAPACITY * 2];
static double outputRate = 48000.0;
static u32 saveWrites = 0;
static Savestate* lastState = nullptr;
static u8* saveClone = nullptr;

/* melonDS leaves some members uninitialised in its constructors (e.g.
 * GPU::VRAMCaptureBlockFlags is read by GPU::SetRenderer before Reset()). Desktop
 * builds usually get fresh zeroed pages; our wasm heap recycles memory, so the NDS
 * is always constructed in zeroed storage. */
static NDS* _newNDS(NDSArgs&& args) {
	void* mem = calloc(1, sizeof(NDS));
	return new (mem) NDS(std::move(args), nullptr);
}

static void _freeAll() {
	if (nds) {
		nds->~NDS();
		free(nds);
	}
	nds = nullptr;
	delete lastState;
	lastState = nullptr;
	free(saveClone);
	saveClone = nullptr;
	saveWrites = 0;
}

static void _syncClock() {
	time_t now = time(nullptr);
	struct tm t;
	localtime_r(&now, &t);
	nds->RTC.SetDateTime(t.tm_year + 1900, t.tm_mon + 1, t.tm_mday, t.tm_hour, t.tm_min, t.tm_sec);
}

EXPORT void* ll_alloc(size_t size) { return malloc(size); }
EXPORT void ll_free(void* ptr) { free(ptr); }

/* Takes ownership of rom (from ll_alloc). save may be NULL; its bytes are copied.
 * Returns LL_PLATFORM_NDS (3), or 0 on failure. */
EXPORT int ll_load(u8* rom, u32 size, const u8* save, u32 saveSize) {
	_freeAll();

	std::unique_ptr<u8[]> romData(rom);
	NDSCart::NDSCartArgs cartArgs {};
	if (save && saveSize) {
		cartArgs.SRAM = std::make_unique<u8[]>(saveSize);
		memcpy(cartArgs.SRAM.get(), save, saveSize);
		cartArgs.SRAMLength = saveSize;
	}
	auto cart = NDSCart::ParseROM(std::move(romData), size, nullptr, std::move(cartArgs));
	if (!cart) return LL_PLATFORM_NONE;

	NDSArgs args {};
	args.JIT = std::nullopt;
	args.Interpolation = AudioInterpolation::Cubic;
	args.OutputSampleRate = outputRate;
	nds = _newNDS(std::move(args));

	/* NDS creates the software renderer when none is supplied; keep it unthreaded. */
	RendererSettings settings {};
	settings.ScaleFactor = 1;
	settings.Threaded = false;
	nds->GetRenderer().SetRenderSettings(settings);

	nds->Reset();
	nds->SetNDSCart(std::move(cart));
	nds->SetupDirectBoot("game.nds");
	_syncClock();
	nds->Start();
	return LL_PLATFORM_NDS;
}

EXPORT void ll_unload(void) { _freeAll(); }

EXPORT void ll_reset(void) {
	if (!nds) return;
	nds->Reset();
	nds->SetupDirectBoot("game.nds");
	_syncClock();
	nds->Start();
}

/* Keys are active-high here (1 = pressed). Bit layout:
 * 0 A, 1 B, 2 Select, 3 Start, 4 Right, 5 Left, 6 Up, 7 Down, 8 R, 9 L, 10 X, 11 Y
 * (bits 0-9 match the GBA/mGBA layout). Bit 16 = lid closed. */
EXPORT void ll_set_keys(u32 keys) {
	if (!nds) return;
	nds->SetKeyMask(~keys & 0xFFF);
	bool lid = (keys >> 16) & 1;
	if (lid != nds->IsLidClosed()) nds->SetLidClosed(lid);
}

/* Touch on the bottom screen in screen pixels (0-255, 0-191). */
EXPORT void ll_touch(int x, int y, int down) {
	if (!nds) return;
	if (down) {
		if (x < 0) x = 0;
		if (x > 255) x = 255;
		if (y < 0) y = 0;
		if (y > 191) y = 191;
		nds->TouchScreen((u16) x, (u16) y);
	} else {
		nds->ReleaseScreen();
	}
}

EXPORT void ll_run_frame(void) {
	if (!nds) return;
	nds->RunFrame();
	void* top = nullptr;
	void* bottom = nullptr;
	if (!nds->GetRenderer().GetFramebuffers(&top, &bottom) || !top || !bottom) return;
	/* melonDS framebuffers are BGRA8888 (u32 0xAARRGGBB). Convert to RGBA bytes
	 * (u32 0xAABBGGRR little-endian) so JS can hand them straight to ImageData. */
	const u32* src[2] = { (const u32*) top, (const u32*) bottom };
	for (int s = 0; s < 2; ++s) {
		u32* dst = videoOut + s * SCREEN_W * SCREEN_H;
		const u32* in = src[s];
		for (int i = 0; i < SCREEN_W * SCREEN_H; ++i) {
			u32 c = in[i];
			dst[i] = 0xFF000000u | ((c & 0xFF) << 16) | (c & 0xFF00) | ((c >> 16) & 0xFF);
		}
	}
}

EXPORT u32 ll_frame_counter(void) { return nds ? nds->NumFrames : 0; }

/* RGBA8888, 256x384: top screen rows 0-191, bottom screen rows 192-383. */
EXPORT u32* ll_video_buffer(void) { return videoOut; }
EXPORT int ll_video_stride(void) { return SCREEN_W; }
EXPORT int ll_video_width(void) { return SCREEN_W; }
EXPORT int ll_video_height(void) { return SCREEN_H * 2; }

EXPORT void ll_set_output_rate(int rate) {
	outputRate = rate > 0 ? rate : 48000;
	if (nds) nds->SPU.SetOutputSampleRate(outputRate);
}
/* Drains resampled audio (already at the output rate) as interleaved int16 stereo.
 * Returns the number of stereo frames written to ll_audio_buffer(). */
EXPORT int ll_audio_drain(void) {
	if (!nds) return 0;
	int total = 0;
	while (total < AUDIO_CAPACITY) {
		int n = nds->SPU.ReadOutput(audioOut + total * 2, AUDIO_CAPACITY - total);
		if (n <= 0) break;
		total += n;
	}
	return total;
}
EXPORT s16* ll_audio_buffer(void) { return audioOut; }

/* --- Memory access for auto-tracking --- */

EXPORT void* ll_region_ptr(int region) {
	if (!nds) return nullptr;
	switch (region) {
	case LL_REGION_MAIN_RAM: return nds->MainRAM;
	case LL_REGION_SHARED_WRAM: return nds->SharedWRAM;
	case LL_REGION_SAVE: return nds->GetNDSSave();
	case LL_REGION_ROM: return nds->GetNDSCart() ? (void*) nds->GetNDSCart()->GetROM() : nullptr;
	case LL_REGION_ARM7_WRAM: return nds->ARM7WRAM;
	}
	return nullptr;
}

EXPORT u32 ll_region_size(int region) {
	if (!nds) return 0;
	switch (region) {
	case LL_REGION_MAIN_RAM: return nds->MainRAMMask + 1;
	case LL_REGION_SHARED_WRAM: return nds->SharedWRAMSize;
	case LL_REGION_SAVE: return nds->GetNDSSaveLength();
	case LL_REGION_ROM: return nds->GetNDSCart() ? nds->GetNDSCart()->GetROMLength() : 0;
	case LL_REGION_ARM7_WRAM: return nds->ARM7WRAMSize;
	}
	return 0;
}

/* Side-effect-free read from the ARM9's view of memory. Only RAM-like regions are
 * readable (main RAM, WRAM, palette, VRAM, OAM); I/O and others return 0 so a stray
 * read can never acknowledge an IRQ or pop a FIFO. */
EXPORT u32 ll_read8(u32 address) {
	if (!nds) return 0;
	switch (address >> 24) {
	case 0x02: return nds->MainRAM[address & nds->MainRAMMask];
	case 0x03:
	case 0x05:
	case 0x06:
	case 0x07: return nds->ARM9Read8(address);
	default: return 0;
	}
}
EXPORT void ll_read_block(u32 address, u8* out, u32 len) {
	for (u32 i = 0; i < len; ++i) out[i] = (u8) ll_read8(address + i);
}

/* --- Cartridge saves --- */

/* Copies the current save into an internal buffer; returns its size. */
EXPORT u32 ll_save_clone(void) {
	if (!nds) return 0;
	u32 len = nds->GetNDSSaveLength();
	free(saveClone);
	saveClone = nullptr;
	if (!len || !nds->GetNDSSave()) return 0;
	saveClone = (u8*) malloc(len);
	memcpy(saveClone, nds->GetNDSSave(), len);
	return len;
}
EXPORT void* ll_save_clone_ptr(void) { return saveClone; }
/* Increments every time the game writes its save; poll to know when to sync. */
EXPORT u32 ll_save_write_count(void) { return saveWrites; }
EXPORT void ll_save_restore(const u8* data, u32 len) {
	if (nds && data && len) nds->SetNDSSave(data, len);
}

/* --- Save states --- */

EXPORT u32 ll_state_save(void) {
	if (!nds) return 0;
	delete lastState;
	lastState = new Savestate();
	if (lastState->Error || !nds->DoSavestate(lastState) || lastState->Error) return 0;
	lastState->Finish();
	return lastState->Length();
}
EXPORT void* ll_state_ptr(void) { return lastState ? lastState->Buffer() : nullptr; }
EXPORT int ll_state_load(void* state, u32 size) {
	if (!nds) return 0;
	Savestate st(state, size, false);
	if (st.Error) return 0;
	return nds->DoSavestate(&st) && !st.Error ? 1 : 0;
}

/* ------------------------------------------------------------------------- */
/* Platform layer: everything the core asks of a frontend, single-threaded.   */
/* ------------------------------------------------------------------------- */
namespace melonDS::Platform {

void SignalStop(StopReason, void*) {}

std::string GetLocalFilePath(const std::string& filename) { return filename; }
FileHandle* OpenFile(const std::string&, FileMode) { return nullptr; }
FileHandle* OpenLocalFile(const std::string&, FileMode) { return nullptr; }
bool FileExists(const std::string&) { return false; }
bool LocalFileExists(const std::string&) { return false; }
bool CheckFileWritable(const std::string&) { return false; }
bool CheckLocalFileWritable(const std::string&) { return false; }
bool CloseFile(FileHandle*) { return true; }
bool IsEndOfFile(FileHandle*) { return true; }
bool FileReadLine(char*, int, FileHandle*) { return false; }
u64 FilePosition(FileHandle*) { return 0; }
bool FileSeek(FileHandle*, s64, FileSeekOrigin) { return false; }
void FileRewind(FileHandle*) {}
u64 FileRead(void*, u64, u64, FileHandle*) { return 0; }
bool FileFlush(FileHandle*) { return true; }
u64 FileWrite(const void*, u64, u64, FileHandle*) { return 0; }
u64 FileWriteFormatted(FileHandle*, const char*, ...) { return 0; }
u64 FileLength(FileHandle*) { return 0; }

void Log(LogLevel, const char*, ...) {}

/* Threads are never created: the 3D renderer runs unthreaded. */
struct Thread { std::function<void()> fn; };
Thread* Thread_Create(std::function<void()> func) { return new Thread { std::move(func) }; }
void Thread_Free(Thread* t) { delete t; }
void Thread_Wait(Thread*) {}

struct Semaphore { int count = 0; };
Semaphore* Semaphore_Create() { return new Semaphore(); }
void Semaphore_Free(Semaphore* s) { delete s; }
void Semaphore_Reset(Semaphore* s) { s->count = 0; }
void Semaphore_Wait(Semaphore* s) { if (s->count > 0) --s->count; }
bool Semaphore_TryWait(Semaphore* s, int) { if (s->count > 0) { --s->count; return true; } return false; }
void Semaphore_Post(Semaphore* s, int count) { s->count += count; }

struct Mutex {};
Mutex* Mutex_Create() { return new Mutex(); }
void Mutex_Free(Mutex* m) { delete m; }
void Mutex_Lock(Mutex*) {}
void Mutex_Unlock(Mutex*) {}
bool Mutex_TryLock(Mutex*) { return true; }

void Sleep(u64) {}
u64 GetMSCount() {
	using namespace std::chrono;
	return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}
u64 GetUSCount() {
	using namespace std::chrono;
	return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

void WriteNDSSave(const u8*, u32, u32, u32, void*) { ++saveWrites; }
void WriteGBASave(const u8*, u32, u32, u32, void*) {}
void WriteFirmware(const Firmware&, u32, u32, void*) {}
void WriteDateTime(int, int, int, int, int, int, void*) {}

void MP_Begin(void*) {}
void MP_End(void*) {}
int MP_SendPacket(u8*, int, u64, void*) { return 0; }
int MP_RecvPacket(u8*, u64*, void*) { return 0; }
int MP_SendCmd(u8*, int, u64, void*) { return 0; }
int MP_SendReply(u8*, int, u64, u16, void*) { return 0; }
int MP_SendAck(u8*, int, u64, void*) { return 0; }
int MP_RecvHostPacket(u8*, u64*, void*) { return 0; }
u16 MP_RecvReplies(u8*, u64, u16, void*) { return 0; }
int Net_SendPacket(u8*, int, void*) { return 0; }
int Net_RecvPacket(u8*, void*) { return 0; }

void Camera_Start(int, void*) {}
void Camera_Stop(int, void*) {}
void Camera_CaptureFrame(int, u32*, int, int, bool, void*) {}

void Mic_Start(void*) {}
void Mic_Stop(void*) {}
int Mic_ReadInput(s16*, int, void*) { return 0; }

struct AACDecoder {};
AACDecoder* AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder*) {}
bool AAC_Configure(AACDecoder*, int, int) { return false; }
bool AAC_DecodeFrame(AACDecoder*, const void*, int, void*, int) { return false; }

bool Addon_KeyDown(KeyType, void*) { return false; }
void Addon_RumbleStart(u32, void*) {}
void Addon_RumbleStop(void*) {}
float Addon_MotionQuery(MotionQueryType, void*) { return 0.0f; }

struct DynamicLibrary {};
DynamicLibrary* DynamicLibrary_Load(const char*) { return nullptr; }
void DynamicLibrary_Unload(DynamicLibrary*) {}
void* DynamicLibrary_LoadFunction(DynamicLibrary*, const char*) { return nullptr; }

} // namespace melonDS::Platform
