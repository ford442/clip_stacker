# Opt-in auto-caption module (-DCLIP_STACKER_WHISPER=ON; scripts/build-whisper.sh).
#
# whisper.cpp's own CMake builds whisper + ggml, so a layout change upstream
# (the CPU backend moved to ggml/src/ggml-cpu/ in 1.7) needs no edit here, and
# its sources land in compile_commands.json with everything else. Release
# builds get -O3 -DNDEBUG from CMAKE_BUILD_TYPE; ggml's asserts are hot.
#
# The one module with threads: ggml splits each graph across a pthread pool
# (~3-4x on a 4-core machine). The pool is created when the module loads,
# because a worker blocked inside whisperTranscribe cannot wait for new
# pthread workers to start. COOP/COEP (SharedArrayBuffer) is already on for
# FFmpeg.

set(CLIP_STACKER_WHISPER_DIR "${CMAKE_CURRENT_SOURCE_DIR}/third_party/whisper.cpp"
    CACHE PATH "whisper.cpp checkout (cloned by scripts/build-whisper.sh)")
set(CLIP_STACKER_WHISPER_THREADS "4" CACHE STRING "pthread pool size for the whisper module")

if(NOT EXISTS "${CLIP_STACKER_WHISPER_DIR}/CMakeLists.txt")
  message(FATAL_ERROR "CLIP_STACKER_WHISPER=ON but no whisper.cpp at ${CLIP_STACKER_WHISPER_DIR}; run scripts/build-whisper.sh")
endif()

set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(WHISPER_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(GGML_OPENMP OFF CACHE BOOL "" FORCE)
set(GGML_NATIVE OFF CACHE BOOL "" FORCE)
add_subdirectory("${CLIP_STACKER_WHISPER_DIR}" whisper.cpp EXCLUDE_FROM_ALL)

foreach(lib whisper ggml ggml-base ggml-cpu)
  if(TARGET ${lib})
    target_compile_options(${lib} PRIVATE -msimd128)
  endif()
endforeach()

# `whisper` is upstream's library target; the module is whisper.js all the same.
add_executable(whisper_captions EXCLUDE_FROM_ALL whisper_captions.cpp)
set_target_properties(whisper_captions PROPERTIES OUTPUT_NAME whisper)
target_link_libraries(whisper_captions PRIVATE whisper)
target_compile_definitions(whisper_captions PRIVATE
  CLIP_STACKER_WHISPER_THREADS=${CLIP_STACKER_WHISPER_THREADS})

clip_stacker_wasm_module(whisper_captions
  EXPORT_NAME createWhisperModule
  INITIAL_MEMORY 67108864
  MAXIMUM_MEMORY 2147483648
  THREADS
  EXCEPTIONS
  # A speech-model runtime, not a DSP kernel: the 200 KB budget does not apply.
  GZIP_BUDGET 0
  EXPORTED_FUNCTIONS
    _whisperInit
    _whisperFree
    _whisperTranscribe
    _whisperSegmentStartMs
    _whisperSegmentEndMs
    _whisperSegmentText
  EXTRA_RUNTIME_METHODS
    UTF8ToString
    stringToUTF8
    lengthBytesUTF8
  EXTRA_LINK_OPTIONS
    "SHELL:-s PTHREAD_POOL_SIZE=${CLIP_STACKER_WHISPER_THREADS}"
    "SHELL:-s STACK_SIZE=5242880"
)
