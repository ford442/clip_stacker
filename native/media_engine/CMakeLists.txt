# The bus DSP on its own: what the preview's AudioWorklet runs
# (media_engine_fx.wasm) and a subset of the full module.
set(MEDIA_ENGINE_FX_SOURCES
  src/resampler.cpp
  src/eq.cpp
  src/dynamics.cpp
  src/fx/limiter.cpp
  src/fx/loudness.cpp
  src/fx/bus.cpp
)

set(MEDIA_ENGINE_DSP_SOURCES
  ${MEDIA_ENGINE_FX_SOURCES}
  src/audio_mix.cpp
  src/time_stretch.cpp
)

if(CLIP_STACKER_HOST_TESTS)
  add_library(media_engine_dsp STATIC ${MEDIA_ENGINE_DSP_SOURCES})
  target_include_directories(media_engine_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
  clip_stacker_host_target(media_engine_dsp)
  # Writes src/fx/true_peak_taps.inc (scripts/gen-true-peak-taps.sh).
  add_executable(gen_true_peak_taps tools/gen_true_peak_taps.cpp)
  target_link_libraries(gen_true_peak_taps PRIVATE media_engine_dsp)
  clip_stacker_host_target(gen_true_peak_taps)
  add_subdirectory(tests)
  return()
endif()

# The C API has no Embind: EXPORTED_FUNCTIONS below is the whole binding layer.
add_executable(media_engine ${MEDIA_ENGINE_DSP_SOURCES})
target_include_directories(media_engine PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

clip_stacker_wasm_module(media_engine
  EXPORT_NAME createMediaEngineModule
  INITIAL_MEMORY 16777216
  MAXIMUM_MEMORY 536870912
  EXPORTED_FUNCTIONS
    _mix_timeline_audio
    _mix_timeline_audio_range
    _mix_fx_session_create
    _mix_bus_session_create
    _mix_fx_session_destroy
    _mix_fx_session_latency
    _mix_fx_session_range
    _mix_fx_session_meters
    _insert_chain_create
    _insert_chain_process
    _insert_chain_destroy
    _time_stretch_remap
    _time_stretch_session_create
    _time_stretch_session_process
    _time_stretch_session_hop
    _time_stretch_session_destroy
)

# AudioWorkletGlobalScope has no fetch / importScripts, so the worklet gets a
# glue-free module: plain extern "C" exports, instantiated from a
# WebAssembly.Module the main thread compiles and posts over.
add_executable(media_engine_fx ${MEDIA_ENGINE_FX_SOURCES})
target_include_directories(media_engine_fx PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

# emmalloc: the worklet allocates only when a graph is built (never per
# quantum: rt_safety_tests), so dlmalloc's speed buys nothing over a smaller module.
clip_stacker_standalone_wasm(media_engine_fx
  MALLOC emmalloc
  INITIAL_MEMORY 1048576
  MAXIMUM_MEMORY 33554432
  EXPORTED_FUNCTIONS
    _bus_graph_create
    _bus_graph_update
    _bus_graph_latency
    _bus_graph_process
    _bus_graph_meters
    _bus_graph_reset_meter
    _bus_graph_reset
    _bus_graph_destroy
    _loudness_meter_create
    _loudness_meter_process
    _loudness_meter_read
    _loudness_meter_destroy
)
