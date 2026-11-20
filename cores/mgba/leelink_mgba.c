/* Lee Link — minimal single-threaded mGBA frontend for WebAssembly.
 *
 * Our own frontend around libmgba (MPL-2.0). JavaScript drives the frame loop,
 * so there is no SDL, no pthreads, and no cross-origin-isolation requirement.
 * Memory regions are exposed as raw pointers so JS can build zero-copy views
 * into the emulated RAM for auto-tracking.
 */
#include <mgba/core/core.h>
#include <mgba/core/config.h>
#include <mgba/core/serialize.h>
#include <mgba-util/audio-buffer.h>
#include <mgba-util/audio-resampler.h>
#include <mgba/core/log.h>
#include <mgba-util/vfs.h>
#ifdef M_CORE_GBA
#include <mgba/internal/gba/gba.h>
#endif
#ifdef M_CORE_GB
#include <mgba/internal/gb/gb.h>
#endif

#include <emscripten/emscripten.h>
#include <stdlib.h>
#include <string.h>

#define EXPORT EMSCRIPTEN_KEEPALIVE

#define VIDEO_MAX_W 256
#define VIDEO_MAX_H 224
#define AUDIO_CAPACITY 0x4000           /* stereo frames */

enum {
	LL_PLATFORM_NONE = 0,
	LL_PLATFORM_GBA = 1,
	LL_PLATFORM_GB = 2,
};

/* Memory region ids, stable across platforms (JS mirrors these). */
enum {
	LL_REGION_WRAM = 0,  /* GBA: EWRAM 0x02000000 (256K). GB: WRAM 0xC000 all banks (8K/32K) */
	LL_REGION_IWRAM = 1, /* GBA: IWRAM 0x03000000 (32K).  GB: HRAM 0xFF80 (127B) */
	LL_REGION_SAVE = 2,  /* cartridge save memory */
	LL_REGION_ROM = 3,   /* ROM image */
	LL_REGION_COUNT
};

static struct mCore* core = NULL;
static void* romData = NULL;
static size_t romSize = 0;
static mColor* videoBuffer = NULL;
static int16_t* audioOut = NULL;
static void* stateBuffer = NULL;
static size_t stateBufferSize = 0;
static void* saveClone = NULL;
static struct mAudioResampler resampler;
static struct mAudioBuffer resampled;
static bool audioReady = false;
static double outputRate = 48000;

static void _nullLog(struct mLogger* logger, int category, enum mLogLevel level, const char* format, va_list args) {
	(void) logger; (void) category; (void) level; (void) format; (void) args;
}
static struct mLogger nullLogger = { .log = _nullLog };

static void _freeAll(void) {
	if (core) {
		core->deinit(core);
		core = NULL;
	}
	free(romData); romData = NULL; romSize = 0;
	free(videoBuffer); videoBuffer = NULL;
	free(audioOut); audioOut = NULL;
	if (audioReady) {
		mAudioResamplerDeinit(&resampler);
		mAudioBufferDeinit(&resampled);
		audioReady = false;
	}
	free(stateBuffer); stateBuffer = NULL; stateBufferSize = 0;
	free(saveClone); saveClone = NULL;
}

/* Allocate a buffer JS can fill (e.g. with ROM bytes) before calling ll_load. */
EXPORT void* ll_alloc(size_t size) { return malloc(size); }
EXPORT void ll_free(void* ptr) { free(ptr); }

/* Takes ownership of rom (from ll_alloc). save may be NULL; its bytes are copied.
 * Returns platform id, or 0 on failure. */
EXPORT int ll_load(void* rom, size_t size, const void* save, size_t saveSize) {
	_freeAll();
	mLogSetDefaultLogger(&nullLogger);
	romData = rom;
	romSize = size;

	struct VFile* vf = VFileFromMemory(romData, romSize);
	if (!vf) return LL_PLATFORM_NONE;
	core = mCoreFindVF(vf);
	if (!core) {
		vf->close(vf);
		return LL_PLATFORM_NONE;
	}
	mCoreInitConfig(core, NULL);
	core->init(core);

	struct mCoreOptions opts = {
		.useBios = false,
		.skipBios = true,
		.volume = 0x100,
		.sampleRate = 48000,
	};
	mCoreConfigLoadDefaults(&core->config, &opts);
	mCoreConfigSetDefaultValue(&core->config, "idleOptimization", "remove");
	mCoreLoadConfig(core);

	videoBuffer = calloc(VIDEO_MAX_W * VIDEO_MAX_H, sizeof(mColor));
	core->setVideoBuffer(core, videoBuffer, VIDEO_MAX_W);
	core->setAudioBufferSize(core, AUDIO_CAPACITY);
	audioOut = malloc(AUDIO_CAPACITY * 2 * sizeof(int16_t));
	mAudioBufferInit(&resampled, AUDIO_CAPACITY, 2);
	mAudioResamplerInit(&resampler, mINTERPOLATOR_SINC);
	mAudioResamplerSetDestination(&resampler, &resampled, outputRate);
	audioReady = true;

	if (!core->loadROM(core, vf)) {
		_freeAll();
		return LL_PLATFORM_NONE;
	}

	/* Growable in-memory save file: starts empty (or with the player's .sav) so the core
	 * sizes it for the detected save type. A padded buffer would be misread as RTC data. */
	struct VFile* sv = VFileMemChunk(saveSize ? save : NULL, saveSize);
	if (!core->loadSave(core, sv)) sv->close(sv);

	core->reset(core);

	switch (core->platform(core)) {
	case mPLATFORM_GBA: return LL_PLATFORM_GBA;
	case mPLATFORM_GB: return LL_PLATFORM_GB;
	default: return LL_PLATFORM_NONE;
	}
}

EXPORT void ll_unload(void) { _freeAll(); }
EXPORT void ll_reset(void) { if (core) core->reset(core); }
EXPORT void ll_set_keys(uint32_t keys) { if (core) core->setKeys(core, keys); }
EXPORT void ll_run_frame(void) { if (core) core->runFrame(core); }
EXPORT uint32_t ll_frame_counter(void) { return core ? core->frameCounter(core) : 0; }

EXPORT mColor* ll_video_buffer(void) { return videoBuffer; }
EXPORT int ll_video_stride(void) { return VIDEO_MAX_W; }
EXPORT int ll_video_width(void) {
	unsigned w = 0, h = 0;
	if (core) core->currentVideoSize(core, &w, &h);
	return (int) w;
}
EXPORT int ll_video_height(void) {
	unsigned w = 0, h = 0;
	if (core) core->currentVideoSize(core, &w, &h);
	return (int) h;
}

/* Output rate for ll_audio_drain (match the AudioContext's sampleRate). */
EXPORT void ll_set_output_rate(int rate) {
	outputRate = rate > 0 ? rate : 48000;
	if (audioReady) mAudioResamplerSetDestination(&resampler, &resampled, outputRate);
}
/* Resamples whatever the core produced to the output rate and drains it into the
 * interleaved stereo buffer. Returns the number of stereo frames written. */
EXPORT int ll_audio_drain(void) {
	if (!core || !audioReady) return 0;
	/* The core's native rate can change at runtime (games reprogram SOUNDBIAS). */
	mAudioResamplerSetSource(&resampler, core->getAudioBuffer(core), core->audioSampleRate(core), true);
	mAudioResamplerProcess(&resampler);
	size_t avail = mAudioBufferAvailable(&resampled);
	if (avail > AUDIO_CAPACITY) avail = AUDIO_CAPACITY;
	return (int) mAudioBufferRead(&resampled, audioOut, avail);
}
EXPORT int16_t* ll_audio_buffer(void) { return audioOut; }

/* --- Memory access for auto-tracking --- */

EXPORT void* ll_region_ptr(int region) {
	if (!core) return NULL;
	switch (core->platform(core)) {
#ifdef M_CORE_GBA
	case mPLATFORM_GBA: {
		struct GBA* gba = core->board;
		switch (region) {
		case LL_REGION_WRAM: return gba->memory.wram;
		case LL_REGION_IWRAM: return gba->memory.iwram;
		case LL_REGION_SAVE: return gba->memory.savedata.data;
		case LL_REGION_ROM: return gba->memory.rom;
		}
		break;
	}
#endif
#ifdef M_CORE_GB
	case mPLATFORM_GB: {
		struct GB* gb = core->board;
		switch (region) {
		case LL_REGION_WRAM: return gb->memory.wram;
		case LL_REGION_IWRAM: return gb->memory.hram;
		case LL_REGION_SAVE: return gb->memory.sram;
		case LL_REGION_ROM: return gb->memory.rom;
		}
		break;
	}
#endif
	default: break;
	}
	return NULL;
}

EXPORT size_t ll_region_size(int region) {
	if (!core) return 0;
	switch (core->platform(core)) {
#ifdef M_CORE_GBA
	case mPLATFORM_GBA:
		switch (region) {
		case LL_REGION_WRAM: return GBA_SIZE_EWRAM;
		case LL_REGION_IWRAM: return GBA_SIZE_IWRAM;
		case LL_REGION_SAVE: return GBASavedataSize(&((struct GBA*) core->board)->memory.savedata);
		case LL_REGION_ROM: return ((struct GBA*) core->board)->memory.romSize;
		}
		break;
#endif
#ifdef M_CORE_GB
	case mPLATFORM_GB: {
		struct GB* gb = core->board;
		switch (region) {
		case LL_REGION_WRAM: return GB_SIZE_WORKING_RAM;
		case LL_REGION_IWRAM: return GB_SIZE_HRAM;
		case LL_REGION_SAVE: return gb->sramSize;
		case LL_REGION_ROM: return gb->memory.romSize;
		}
		break;
	}
#endif
	default: break;
	}
	return 0;
}

/* Side-effect-free read of any mapped address (current bank for banked regions). */
EXPORT uint32_t ll_read8(uint32_t address) {
	return core ? core->rawRead8(core, address, -1) : 0;
}
EXPORT void ll_read_block(uint32_t address, uint8_t* out, size_t len) {
	if (!core) return;
	for (size_t i = 0; i < len; ++i) out[i] = (uint8_t) core->rawRead8(core, address + i, -1);
}

/* --- Battery saves --- */

/* Copies current save into an internal buffer; returns its size (pointer via ll_save_clone_ptr). */
EXPORT size_t ll_save_clone(void) {
	if (!core) return 0;
	free(saveClone);
	saveClone = NULL;
	return core->savedataClone(core, &saveClone);
}
EXPORT void* ll_save_clone_ptr(void) { return saveClone; }

/* --- Save states (used for snapshots/tests; gated off by run rules in the UI) --- */

EXPORT size_t ll_state_save(void) {
	if (!core) return 0;
	size_t size = core->stateSize(core);
	if (size > stateBufferSize) {
		free(stateBuffer);
		stateBuffer = malloc(size);
		stateBufferSize = size;
	}
	return core->saveState(core, stateBuffer) ? size : 0;
}
EXPORT void* ll_state_ptr(void) { return stateBuffer; }
EXPORT int ll_state_load(const void* state, size_t size) {
	if (!core || size != core->stateSize(core)) return 0;
	return core->loadState(core, state) ? 1 : 0;
}
