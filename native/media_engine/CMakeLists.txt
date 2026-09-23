set(MEDIA_ENGINE_DSP_SOURCES
  src/resampler.cpp
  src/audio_mix.cpp
)

if(CLIP_STACKER_HOST_TESTS)
  add_library(media_engine_dsp STATIC ${MEDIA_ENGINE_DSP_SOURCES})
  target_include_directories(media_engine_dsp PUBLIC "${CMAKE_CURRENT_SOURCE_DIR}/include")
  clip_stacker_host_target(media_engine_dsp)
  add_subdirectory(tests)
  return()
endif()

add_executable(media_engine
  ${MEDIA_ENGINE_DSP_SOURCES}
  src/bindings.cpp
)
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
)
